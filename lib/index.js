/**
 * Let the model judge how hard this turn is, then set the thinking level from
 * that judgement.
 *
 * ## Why a second model call, and why it is cheaper than it looks
 *
 * `dsh-thinking-levels`' auto scheduler reads the last eight `tool/call`
 * events. That is a rear-view mirror: a turn's first step has no tool history
 * at all, so the scheduler opens every turn at `low`; steps whose operations
 * look cheap (a small `edit`, a `grep`) keep the simple-tool ratio above the
 * downgrade threshold. On a measured 27-step turn it stayed at `low` for 23
 * steps and only lifted to `high` at step 24, well past the decisions that
 * needed the budget. A one-line `edit` inside a hard refactor is
 * *syntactically* cheap and *semantically* expensive.
 *
 * The fix is to judge the request itself, before any tool runs. That needs one
 * extra model call per turn — not per step — and it is cheap when it shares
 * the conversation's prompt prefix (cache hits) and runs with thinking off,
 * because the answer is a single level word and reasoning tokens are billed at
 * the output rate.
 *
 * ## Why two hooks and not one
 *
 * `agent/request` fires after `step/start`, and the loop's own documentation
 * states that neither it nor `prepareCall()` sees the pending accepted users
 * committed to history. The user's message for this turn is therefore *not*
 * readable there. `agent/pre-step` does receive `messages`, so the judgement
 * happens there and `agent/request` only consumes its result.
 *
 * ## What it does not do
 *
 * It never sends `auto`, `on`, `minimal`, `medium` or `xhigh`: adapters reject
 * levels they do not advertise with `UNSUPPORTED_REASONING_EFFORT`, and the
 * safe intersection across models is `low` / `high` / `max`. The judgement is
 * clamped to the levels the model actually advertises, mirroring the host's
 * own capability guard.
 *
 * Every failure path falls through to `next()` untouched. A scheduler whose
 * classification call throws must not fail the turn: the host ends the turn on
 * a middleware throw, so an outage in a *helpful* plugin would become an
 * outage in the conversation.
 *
 * @module dsh-reasoning-judge
 */

import { appendFileSync } from 'node:fs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'reasoning-judge'

/**
 * Services read by this plugin.
 *
 * `llm` sends the classification call. `sessionProjections` is optional on
 * purpose — it is read defensively so an older host without the registry still
 * mounts the plugin; declaring it here would make the mount fail instead.
 */
export const inject = ['llm']

/**
 * The judgement prompt.
 *
 * Deliberately narrow: one word out of a fixed vocabulary, no explanation. Any
 * prose in the answer is wasted output tokens and a parsing risk, and the
 * level set is kept to the three levels every reasoning adapter shares.
 */
export const JUDGE_SYSTEM_PROMPT = [
  'You classify the thinking budget one coding-agent turn needs.',
  'Answer with exactly one word: low, high, or max.',
  '',
  'low  — chat, lookups, reading a file, a trivial one-line change.',
  'high — ordinary implementation: editing code, debugging, running tests,',
  '       investigating a failure, writing a small feature.',
  'max  — hard reasoning: architecture or design decisions, subtle bugs,',
  '       multi-file refactors, concurrency/performance work, unclear root causes.',
  '',
  'Judge the work the request implies, not how few characters it takes to say.',
  'A two-sentence request to restructure a module is max, not low.',
].join('\n')

/** Levels this plugin will ever send, in ascending cost. */
export const LEVELS = ['low', 'high', 'max']

/**
 * Default configuration.
 *
 * `fallback` is what an unreadable answer resolves to. `high` is the official
 * hub and the least surprising default: `low` would silently degrade quality
 * and `max` would reintroduce the over-thinking this exists to avoid.
 */
export const DEFAULTS = {
  enabled: true,
  fallback: 'high',
  model: undefined,
  judgeEffort: undefined,
  maxJudgeChars: 8000,
  timeoutMs: 20000,
  logFile: undefined,
  // Uncapped by default: the judge reads the previous exchange in full, since
  // a truncated answer can hide exactly the detail (which files changed, what
  // was proposed next) that a follow-up refers to. Set a positive value to cap
  // both halves for a very long-running session.
  historyReplyChars: 0,
  historyToolWindow: 8,
}

/** Reading order for `chooseLevel`, ascending. */
const RANK = { low: 0, high: 1, max: 2 }

/**
 * Pick a level from one model answer.
 *
 * Tolerates the usual noise (surrounding whitespace, a trailing period, an
 * `` or "backticked" wrapper, or a longer sentence that still names exactly one
 * level). When the answer names none, or names several distinct levels, the
 * answer is not a judgement and `fallback` applies.
 *
 * @param text - raw model output.
 * @param fallback - level used when the answer is unusable.
 * @returns one of {@link LEVELS}.
 */
export function chooseLevel(text, fallback = DEFAULTS.fallback) {
  const safeFallback = LEVELS.includes(fallback) ? fallback : DEFAULTS.fallback
  if (typeof text !== 'string') return safeFallback
  const words = text.toLowerCase().match(/[a-z]+/gu)
  if (words === null) return safeFallback
  const hits = new Set(words.filter((word) => Object.hasOwn(RANK, word)))
  if (hits.size !== 1) return safeFallback
  return [...hits][0]
}

/**
 * Clamp a judged level to what the model advertises.
 *
 * An adapter rejects any level it does not advertise, so a model offering only
 * `low`/`high` must not receive `max`. Clamp downward to the strongest level it
 * does advertise; a model advertising no levels yields `undefined`, meaning
 * "send nothing".
 *
 * @param level - the judged level.
 * @param advertised - the levels the resolved model reports.
 * @returns an advertised level, or undefined when the model takes none.
 */
export function clampLevel(level, advertised) {
  if (!Array.isArray(advertised) || advertised.length === 0) return undefined
  if (advertised.includes(level)) return level
  const want = RANK[level] ?? RANK.high
  const ranked = advertised.filter((entry) => Object.hasOwn(RANK, entry)).sort((a, b) => RANK[b] - RANK[a])
  return ranked.find((entry) => RANK[entry] <= want) ?? ranked[ranked.length - 1]
}

/**
 * Flatten one turn's pending user messages into prompt text.
 *
 * Only text blocks are read: a classification call has no use for images or
 * attachments, and forwarding them would both cost tokens and require the
 * judge route to accept those modalities.
 *
 * @param messages - the `messages` of the `agent/pre-step` payload.
 * @param maxChars - keep the tail, which is where the actual request sits.
 * @returns prompt text, or an empty string when there is nothing to judge.
 */
export function judgePrompt(messages, maxChars = DEFAULTS.maxJudgeChars) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    // Only the human's own words. The same batch also carries injected
    // runtime-context snapshots, memory recall blocks and model-selection
    // notices, which are harness prose, not the request being judged: feeding
    // them in dilutes the signal and, at 8000 chars, would often crowd the
    // actual question out of the tail.
    if (message?.source?.kind !== 'user') continue
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text.trim()
      if (text !== '') parts.push(text)
    }
  }
  const joined = parts.join('\n\n')
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
}

/**
 * Build the full classification prompt from the request plus a bounded
 * account of what the conversation is doing.
 *
 * The bare user text is not enough. "继续" or "好" is an eleven-character
 * prompt that says nothing about whether the work in progress is a rename or a
 * concurrency fix, and reading only that text made the judge open such turns at
 * `low` — the exact failure the history-based scheduler had. Two cheap
 * additions fix it without replaying the conversation:
 *
 *   - the previous assistant reply, truncated: it carries what was just done
 *     and what was proposed next, which is what a short follow-up refers to;
 *   - the recent tool-call names, deduplicated and order-preserving: they say
 *     whether the session is reading files or rewriting modules, at a cost of
 *     a few dozen tokens rather than the full transcripts.
 *
 * Deliberately not included: tool results, file contents, and the whole
 * message history. Those are what a real replay would cost (a full-context
 * classification every turn), and they are not needed to pick a budget.
 *
 * @param request - the current turn's human text.
 * @param context - optional bounds for the account.
 * @param context.previousReply - the last assistant text, already truncated.
 * @param context.tools - recent tool names, newest last.
 * @returns the prompt body, empty when there is no request to judge.
 */
export function assemblePrompt(request, context = {}) {
  if (typeof request !== 'string' || request === '') return ''
  const sections = []
  const tools = Array.isArray(context.tools) ? context.tools.filter((name) => typeof name === 'string' && name !== '') : []
  if (tools.length > 0) sections.push(`Recent tools: ${[...new Set(tools)].join(', ')}`)
  const previousRequest = typeof context.previousRequest === 'string' ? context.previousRequest.trim() : ''
  const reply = typeof context.previousReply === 'string' ? context.previousReply.trim() : ''
  // Both halves of the previous exchange, as a labelled pair: the reply alone
  // does not say what it was answering, and a short follow-up refers to the
  // pair, not to either half.
  if (previousRequest !== '' || reply !== '') {
    const pair = []
    if (previousRequest !== '') pair.push(`user: ${previousRequest}`)
    if (reply !== '') pair.push(`assistant: ${reply}`)
    sections.push(`Previous exchange:\n${pair.join('\n')}`)
  }
  sections.push(`New request:\n${request}`)
  return sections.join('\n\n')
}

/**
 * Cap a text to `limit` characters.
 *
 * A non-positive or non-finite limit means "no cap": an unbounded answer is a
 * deliberate configuration, not a bug, because the classification prompt is
 * read by a model that benefits from seeing the whole previous exchange.
 *
 * @param text - source text.
 * @param limit - maximum characters, or a non-positive value for no cap.
 * @returns the text, with a trailing ellipsis when it was cut.
 */
export function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(limit) || limit <= 0) return text
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Read the recent history the classification prompt needs from a session log.
 *
 * Walks the log newest-first and stops as soon as both halves of the previous
 * exchange are found, so a long session costs one bounded scan rather than a
 * full replay. Reads the sanctioned `snapshotEvents()` accessor; an older host
 * without it, or any malformed event, yields empty history rather than a
 * broken turn.
 *
 * @param session - the agent's live session.
 * @param options - `{ replyChars, toolWindow }` bounds; `replyChars` <= 0 keeps
 *                  both halves of the exchange uncapped.
 * @returns `{ previousRequest, previousReply, tools }`, each possibly empty.
 */
export function readHistory(session, options = {}) {
  const replyChars = typeof options.replyChars === 'number' ? options.replyChars : DEFAULTS.historyReplyChars
  const toolWindow = typeof options.toolWindow === 'number' ? options.toolWindow : DEFAULTS.historyToolWindow
  const empty = { previousRequest: '', previousReply: '', tools: [] }
  try {
    const events = session?.snapshotEvents?.()
    if (!Array.isArray(events)) return empty
    const tools = []
    let previousReply = ''
    let previousRequest = ''
    // One backward pass, stopping as soon as the previous exchange is
    // complete. Both halves are needed: the answer alone does not say what was
    // asked, and the pair is what a follow-up like "继续" or "不对" refers to.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      const data = event?.data
      if (typeof data !== 'object' || data === null) continue
      if (event.type === 'tool/call') {
        if (tools.length < toolWindow && typeof data.name === 'string' && data.name !== '') tools.push(data.name)
        continue
      }
      if (event.type === 'assistant/message' && previousReply === '') {
        const content = data.message?.content
        if (!Array.isArray(content)) continue
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text.trim())
          .filter((part) => part !== '')
          .join('\n')
        if (text !== '') previousReply = truncate(text, replyChars)
        continue
      }
      // The human turn that produced that answer. `source.kind` is required:
      // the log also stores runtime-context snapshots and model-selection
      // notices as user-role messages, and neither is a human request.
      if (event.type === 'user/message' && previousReply !== '' && previousRequest === '') {
        if (data.source?.kind !== 'user') continue
        const content = data.content
        if (!Array.isArray(content)) continue
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text.trim())
          .filter((part) => part !== '')
          .join('\n')
        if (text !== '') previousRequest = truncate(text, replyChars)
      }
      // Stop once the exchange is complete and the tool window is full: tools
      // are still being collected while walking back, so breaking at the
      // exchange alone would under-report what the session has been doing.
      if (previousReply !== '' && previousRequest !== '' && tools.length >= toolWindow) break
    }
    return { previousRequest, previousReply, tools: tools.reverse() }
  } catch {
    return empty
  }
}

/**
 * Collect the text of one streamed completion.
 *
 * `llm.stream` yields chat chunks; only `text` deltas matter here. A terminal
 * `finish` chunk with an error kind aborts the read with that failure so the
 * caller can fall through to its fallback instead of judging partial output.
 *
 * @param stream - the async iterable returned by `llm.stream`.
 * @returns the concatenated text.
 */
export async function readCompletion(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk?.type === 'finish') {
      const reason = chunk.reason
      if (reason?.kind === 'error' || reason?.kind === 'aborted') {
        // Carry the adapter's own message: "ended: error" alone sent the first
        // diagnosis down the wrong path, because the real cause (a route that
        // refuses the requested effort) was in `failure`.
        const failure = reason.failure
        const detail = failure === undefined ? '' : ` ${failure.code ?? ''} ${failure.message ?? ''}`.trimEnd()
        throw new Error(`judge completion ${reason.kind}:${detail}`)
      }
      // `max-tokens` is not a failure here: the answer is one word and the cap
      // is deliberately tiny, so a cut-off completion still holds the word.
      continue
    }
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * Mount the judge.
 *
 * @param ctx - the plugin context, carrying the LLM service and the logger.
 * @param config - see {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const settings = {
    enabled: config.enabled !== false,
    fallback: LEVELS.includes(config.fallback) ? config.fallback : DEFAULTS.fallback,
    model: typeof config.model === 'string' && config.model !== '' ? config.model : undefined,
    judgeEffort: typeof config.judgeEffort === 'string' && config.judgeEffort !== '' ? config.judgeEffort : undefined,
    maxJudgeChars:
      typeof config.maxJudgeChars === 'number' && config.maxJudgeChars > 0
        ? config.maxJudgeChars
        : DEFAULTS.maxJudgeChars,
    timeoutMs:
      typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs,
    logFile: typeof config.logFile === 'string' && config.logFile !== '' ? config.logFile : undefined,
    historyReplyChars:
      typeof config.historyReplyChars === 'number' && config.historyReplyChars >= 0
        ? config.historyReplyChars
        : DEFAULTS.historyReplyChars,
    historyToolWindow:
      typeof config.historyToolWindow === 'number' && config.historyToolWindow >= 0
        ? config.historyToolWindow
        : DEFAULTS.historyToolWindow,
  }

  if (!settings.enabled) return

  /**
   * Append one diagnostic line to `logFile`, when configured.
   *
   * `ctx.logger` writes to the host process's stdout, which a GUI launch sends
   * to a terminal the user may not be watching. A judgement is a decision the
   * user needs to be able to audit ("why did this turn run at `low`?"), so the
   * plugin can mirror each one to a file. Never throws: a logging problem must
   * not affect a turn.
   */
  function note(line) {
    if (settings.logFile === undefined) return
    try {
      appendFileSync(settings.logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Diagnostics are best-effort; a failed write must not break the turn.
    }
  }

  /**
   * Judgement for the turn currently being admitted, keyed by agent id.
   *
   * A turn's first step is the only place the judge runs, so a single slot per
   * agent suffices; the next turn overwrites it. `pending` deduplicates the
   * concurrent read that a retried first step could trigger, so one turn never
   * pays for two classification calls.
   */
  const judged = new Map()

  /**
   * Route the classification call.
   *
   * Reuses the agent's own provider and (by default) model, which is what makes
   * the call able to share the conversation's prompt prefix on the provider's
   * cache. Reasoning is pinned off: the answer is one word, and reasoning
   * tokens are billed at the output rate.
   */
  async function classify(agent, prompt, signal) {
    const provider = agent?.options?.provider
    const model = settings.model ?? agent?.options?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return undefined
    }

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('judge timeout')), settings.timeoutMs)
    const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal])
    try {
      // The effort is configurable rather than pinned to `off`: several routes
      // positive-refuse `off` — workbuddy's `deepseek-v4.1-flash` is in its
      // `REFUSES_OFF_MODEL_IDS` set — and a refused effort fails the whole
      // classification call. Leaving `judgeEffort` unset sends no effort at
      // all, which every route accepts; the answer is one word, so the route's
      // own default costs little and `maxTokens: 8` bounds it.
      const stream = ctx.llm.stream({
        provider,
        model,
        ...(settings.judgeEffort === undefined ? {} : { reasoningEffort: settings.judgeEffort }),
        maxTokens: 8,
        temperature: 0,
        messages: [
          { role: 'system', content: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT }] },
          { role: 'user', content: [{ type: 'text', text: prompt }] },
        ],
        signal: combined,
      })
      return await readCompletion(stream)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Whether the user pinned a thinking level for this step.
   *
   * A manual pick outranks any scheduler, this one included: the model
   * selector exists precisely so the human can override automatic budgeting,
   * and silently overwriting it would make the control a lie. The durable
   * `modelSelection` projection carries exactly that intent in `pending` — set
   * by the user-facing selection command and cleared once a matching request
   * header retires it. Reading `lastUsed` instead would read this plugin's own
   * output back (the loop seeds each request from the previous header), so only
   * `pending` counts.
   *
   * An absent projection service (older host) reports `false`: the judge then
   * behaves as the only scheduler, which is the documented single-owner case.
   */
  function userPinned(agent, signal) {
    try {
      const state = ctx.sessionProjections?.stateOf?.(agent.session, 'modelSelection')
      return state?.pending?.reasoningEffort !== undefined && state.pending.reasoningEffort !== 'auto'
    } catch {
      return false
    }
  }

  /**
   * Levels the route actually advertises.
   *
   * The `agent/request` payload carries no model metadata, so the capability
   * has to be resolved through the LLM service. A failure here means the route
   * is unknown or does not reason at all; both are answered with `undefined`
   * (send nothing) rather than a guess the adapter would reject.
   */
  async function advertisedLevels(provider, model, signal) {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal)
      return info?.reasoning?.efforts?.map((effort) => effort.id)
    } catch {
      return undefined
    }
  }

  // `agent/pre-step` and `agent/request` are both waterfalls; `agent/request`
  // is one per step and therefore the hot path.
  ctx.effect(() => {
    const offPre = ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        const decision = await next()
        try {
          // Only the first step of a turn is judged: later steps inherit it, so
          // a 20-step turn still pays for exactly one classification call.
          if (payload.step !== 1) return decision
          const request = judgePrompt(decision.messages, settings.maxJudgeChars)
          if (request === '') {
            note(`turn=${payload.turn} pre-step: no human text in ${decision.messages.length} message(s)`)
            return decision
          }

          const agent = payload.agent
          // The bare request cannot say whether a short follow-up continues a
          // rename or a concurrency fix, so bounded context is folded in: the
          // last reply (what was just done) and the recent tool names (what
          // kind of work is in flight). Both are cheap; neither replays the
          // conversation.
          const history = readHistory(agent?.session, {
            replyChars: settings.historyReplyChars,
            toolWindow: settings.historyToolWindow,
          })
          const prompt = assemblePrompt(request, history)
          const key = String(agent?.id ?? '')
          const signature = prompt
          const cached = judged.get(key)
          if (cached?.signature === signature) return decision

          const slot = { signature, level: undefined }
          judged.set(key, slot)
          const answer = await classify(agent, prompt, payload.signal)
          slot.level = chooseLevel(answer, settings.fallback)
          ctx.logger.info(`reasoning-judge: turn ${payload.turn} judged ${slot.level}`)
          note(`turn=${payload.turn} judged=${slot.level} raw=${JSON.stringify(answer)} prompt=${prompt.length}ch prevReq=${history.previousRequest.length}ch reply=${history.previousReply.length}ch tools=${history.tools.length}`)
        } catch (error) {
          // Never let the judge break a turn: the host closes the turn on a
          // middleware throw, so this must degrade to "no opinion".
          ctx.logger.warn(`reasoning-judge: judgement failed, leaving the level alone: ${String(error)}`)
          note(`turn=${payload.turn} JUDGE-FAILED ${String(error)}`)
        }
        return decision
      },
      { prepend: true },
    )

    const offRequest = ctx.on(
      'agent/request',
      async (payload, next) => {
        const base = await next()
        try {
          if (payload.step !== 1) return base
          const agent = payload.agent
          // A manual pick wins over the judgement; see `userPinned`.
          if (userPinned(agent, payload.signal)) {
            note(`turn=${payload.turn} step=1 SKIP user-pinned`)
            return base
          }
          const slot = judged.get(String(agent?.id ?? ''))
          if (slot?.level === undefined) {
            note(`turn=${payload.turn} step=1 SKIP no-judgement`)
            return base
          }

          const level = clampLevel(slot.level, await advertisedLevels(base.provider, base.model, payload.signal))
          if (level === undefined) {
            note(`turn=${payload.turn} step=1 SKIP no-advertised-effort`)
            return base
          }

          // Restating the held level must stay a no-op: the loop compares the
          // config field-wise and logs a new header only on a real change, so
          // returning an identical value avoids a pointless snapshot.
          if (base.reasoningEffort === level) {
            note(`turn=${payload.turn} step=1 same=${level} (host already there)`)
            return base
          }
          note(`turn=${payload.turn} step=1 injected ${base.reasoningEffort} -> ${level}`)
          return { ...base, reasoningEffort: level }
        } catch (error) {
          ctx.logger.warn(`reasoning-judge: injection failed, keeping the host level: ${String(error)}`)
          note(`turn=${payload.turn} step=1 INJECT-FAILED ${String(error)}`)
          return base
        }
      },
      { prepend: true },
    )

    return () => {
      offPre()
      offRequest()
      judged.clear()
    }
  }, 'reasoning-judge: judge each turn once and set its thinking level')
}

export default { name, inject, apply }
