# dsh-reasoning-judge

**Ask the model how hard each turn is, once per turn, and set the thinking
level from that judgement — instead of inferring it from tool-call history.**

A DSH (DeepSeek Harness) plugin. It reads the turn's request plus the previous
exchange, asks a one-word question, and applies the answer to the whole turn.
One extra call per turn, not per step.

---

## Why this exists

`dsh-thinking-levels` schedules `reasoningEffort` from the last eight
`tool/call` events. That is a rear-view mirror, and it has two measured
consequences:

- A turn's **first step has no tool history**, so every turn opens at `low`.
- A small `edit`, a `grep` or a `read` counts as a *simple* tool, so a hard
  refactor built from small edits never lifts the simple-tool ratio out of
  `low`.

In a measured 27-step session it stayed at `low` for **23 steps** and only
reached `high` at step 24 — after the decisions that needed the budget had
already been made. Its `max` rule fires only when a *single* tool call carries
more than 3200 characters of arguments, which a normal code edit never does.

The deeper problem is that **"cheap to type" is not "cheap to answer"**.
Restructuring a module and looking up what a function does are both two
sentences long, and only one of them needs a large budget.

## What this does

Judge the **request**, not the operations.

```
your turn
   │
   ├─ agent/pre-step ──► read the request + previous exchange + recent tools
   │                     ask the model: low, high, or max?
   │
   └─ agent/request  ──► inject that level for step 1
                         later steps of the same turn reuse it
```

A 20-step turn pays for **exactly one** classification call.

### Why two hooks

`agent/request` fires after `step/start`, and the loop's own documentation
states that neither it nor `prepareCall()` sees the pending accepted users
committed to history — the turn's request is *not readable there*.
`agent/pre-step` does receive `messages`, so the judgement happens there and
`agent/request` only consumes the result.

## What the judge sees

Not the whole conversation — replaying the context every turn is the one thing
this plugin is built to avoid. It reads a bounded account:

| Input | Why |
|---|---|
| The turn's request text | the thing being judged |
| The **previous exchange** — the human request *and* the assistant reply, uncapped by default | a short follow-up like "继续" or "不对" refers to the pair; the reply alone does not say what was being answered |
| Recent tool names, deduplicated, order-preserving (capped by `historyToolWindow`) | says whether the session is reading files or rewriting modules |

Deliberately excluded: tool results, file contents, and the full message
history. Those are what a real replay would cost, and they are not needed to
pick a budget.

Measured effect of including the previous exchange: a 51-character follow-up
("已经重启，检查是否生效") is judged `high` once the 1029-character previous
answer is attached; on its own it would be `low`. That is the blind spot this
input closes.

## Cost

The classification call is **not** prefix-cacheable. Its system prompt differs
from the conversation's, so the prefix diverges at the first token and the
provider bills the entire input at the non-cached rate. That is precisely why
the judge does not replay the conversation — it sends roughly a kilobyte, not a
context window.

`reasoningEffort` is left **unset** by default. Pinning it to `off` looks
cheaper, but several routes positively reject `off` — workbuddy's
`deepseek-v4.1-flash` sits in its `REFUSES_OFF_MODEL_IDS` set — and a refused
effort fails the whole call. Set `judgeEffort` only for a route known to accept
it.

To change the cost profile, point `model` at a cheaper model. Note that the
provider's prefix cache is per model, so a cross-model judge pays full price for
its input.

## What it will not send

Only `low`, `high` and `max`. An adapter rejects any level it does not
advertise with `UNSUPPORTED_REASONING_EFFORT`, so the judgement is clamped to
the route's advertised levels; a route advertising none receives no
`reasoningEffort` at all.

## Manual selection wins

A level picked in the model selector outranks the judge. The durable
`modelSelection` projection carries that intent in `pending` — set by the
user-facing selection command and cleared once a matching request header retires
it. The plugin reads only `pending`, never `lastUsed`, because the host seeds
each request from the previous header and `lastUsed` would therefore read this
plugin's own output back.

## Fail-open

Every failure path calls `next()` untouched. The host closes the turn when a
middleware throws, so a judge outage degrades to "no opinion" rather than to a
broken conversation. A classification timeout (`timeoutMs`, default 20s) leaves
the host level standing.

## Install

```sh
cd ~/.dsh/profiles/web
dsh plugin --profile web add dsh-reasoning-judge -w
dsh web   # restart; new bundle layers do not hot-load
```

From a source checkout, add the directory path instead of the package name.

## Configuration

```yaml
- id: reasoning-judge
  name: dsh-reasoning-judge
  config:
    enabled: true          # false unmounts both listeners
    fallback: high         # level used when the answer is unusable
    model: (agent's own)   # model id for the classification call
    judgeEffort: (unset)   # explicit effort for the judge; unset = route default
    maxJudgeChars: 8000    # how much request text the judge sees (the tail)
    historyReplyChars: 0   # 0 = previous exchange uncapped; >0 caps each half
    historyToolWindow: 8   # recent tool names to include (0 disables)
    timeoutMs: 20000       # abort a stuck classification call
    logFile: (unset)       # append one line per judgement to this path
```

`fallback` defaults to `high` — the official hub — so a parse failure matches
the host default instead of silently degrading to `low` or over-spending at
`max`.

### Observability

`ctx.logger` writes to the host process's stdout, which a GUI launch sends to a
terminal you may not be watching. Point `logFile` at a path and every judgement
is mirrored there:

```
turn=30 judged=high raw="high" prompt=1169ch prevReq=51ch reply=1029ch tools=8
turn=30 step=1 same=high (host already there)
```

Read it as: what was judged, what the model actually answered, how large the
input was, then whether the injection changed anything. `same=` means the turn
was already at that level, so no new request header was written — **this is not
evidence the plugin is inactive**, and confusing the two is easy.

## Interaction with dsh-thinking-levels

Both listen on `agent/request`. This plugin uses `prepend` and returns early on
every step except the first. Within a turn: the judge owns step 1, and
thinking-levels' history-driven schedule can keep serving later steps if it also
declares `prepend` and runs after this one.

For a single owner, pick a fixed level in the model selector or disable
thinking-levels, as the two otherwise make the same decision for different
reasons.

## Tests

```sh
node --test test/index.test.js
```

30 tests cover the level parser (noise tolerance, ambiguous answers), the
capability clamp (both directions, no-advertised-levels), prompt assembly, the
bounded history reader (exchange pairs, tool window, non-human user-role
messages), completion reading (adapter failure surfaced, `max-tokens` accepted),
and truncation.

## Requirements

- DSH host `0.2.x`
- Node `^22.19 || >=24`
- A route that advertises `low` / `high` / `max`

## License

MIT
