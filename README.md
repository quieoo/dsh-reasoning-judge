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
   └─ agent/pre-step ──► step 1: read the request + previous exchange + recent
                         tools, ask the model: low, high, or max?
                         later steps: hand the answer to agent.model.select()
```

A 20-step turn pays for **exactly one** classification call, and that call
never delays the start of the turn: step 1 keeps the host's current level (the
previous turn's ending level — a locality prior) while the classification runs
in the background, and the result is applied from step 2 onward. A judgement
that has not resolved yet, or that fails, simply leaves the host level alone.

### Why `agent.model.select()` and not `agent/request`

Up to dsh 0.2.1 the level was returned from `agent/request`. Since 0.2.2 the
loop captures its selection *before* dispatching `agent/pre-step`, so a
request-time listener that proposes a different effort is rejected outright:

```
agent/request proposed reasoning effort "high" after step preparation fixed
"adapter default"; use agent.model.select() before step preparation
```

That error ends the turn rather than ignoring the override, so the plugin no
longer listens on `agent/request` at all. The judgement is recorded from
`agent/pre-step` with `agent.model.select()`, which the host applies to the
**following** step preparation. The observable timing is unchanged: step 1
keeps the host level while the classification runs, and the judged level is in
force from step 2 onward.

`agent/pre-step` is also the only hook that receives the turn's `messages` — the
request is *not readable* from `agent/request`, whose own documentation says it
sees neither the pending users nor anything `prepareCall()` resolves.

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

`reasoningEffort` is left **unset** by default, and that is deliberate rather
than an oversight:

- `off` is positively refused by several routes — workbuddy's
  `deepseek-v4.1-flash` sits in its `REFUSES_OFF_MODEL_IDS` set — and a refused
  effort fails the entire classification call.
- A cheap-looking `low` is not portable either: a route advertising only `high`
  (a single-tier free model, say) rejects it, and models that cannot disable
  reasoning have nothing to lower.

Sending no effort is the one form every route accepts. The answer is a single
word, so the route's own default costs little. Set `judgeEffort` only for a
route you have verified accepts that exact level.

To change the cost profile, point `model` at a cheaper model. Note that the
provider's prefix cache is per model, so a cross-model judge pays full price for
its input.

## Provider-neutral tiers

The judge answers in **tiers** — `low`, `medium`, `high` — never in wire level
names. Providers disagree on the strongest name for the same model family:

| Route | Advertised levels | `high` tier resolves to |
|---|---|---|
| workbuddy `deepseek-v4.1-flash` | `low` / `high` / `max` | `max` |
| trae `deepseek-v4.1-flash` | `low` / `high` / `xhigh` | `xhigh` |

Judging in wire names silently capped every provider lacking the emitted name:
on trae a judged `max` resolved to `high`, so the top tier was unreachable and
the plugin looked like it only ever picked `low`–`high`.

`resolveEffort` translates the tier by rank into whatever the route advertises.
A route advertising nothing receives no `reasoningEffort` at all; one
advertising only toggle levels (`on`/`off`) has no strength to set and is
likewise left alone.

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
broken conversation. A classification timeout (`timeoutMs`, default 45s) leaves
the host level standing.

## Install

From GitHub (no npm publish required):

```sh
cd ~/.dsh/profiles/web
dsh plugin --profile web add https://github.com/quieoo/dsh-reasoning-judge.git -w
dsh web   # restart; new bundle layers do not hot-load
```

From a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-reasoning-judge -w
```

From npm, once published:

```sh
dsh plugin --profile web add dsh-reasoning-judge -w
```

The `-w` flag matters: a profile is a pnpm workspace root, so installing
without it is rejected. A running instance does not hot-load new bundle layers —
restart before expecting the plugin to appear.

## Configuration

```yaml
- id: reasoning-judge
  name: dsh-reasoning-judge
  config:
    enabled: true          # false unmounts both listeners
    fallback: medium       # tier used when the answer is unusable
    model: (agent's own)   # model id for the classification call
    judgeEffort: (unset)   # explicit effort for the judge; unset = route default
    maxJudgeChars: 8000    # how much request text the judge sees (the tail)
    historyReplyChars: 0   # 0 = previous exchange uncapped; >0 caps each half
    historyToolWindow: 8   # recent tool names to include (0 disables)
    timeoutMs: 45000       # abort a stuck classification call
    logFile: (unset)       # append one line per judgement to this path
```

`fallback` defaults to `medium`, which maps onto each route's own hub (`high`
in both DeepSeek wire families) — so a parse failure lands mid-range instead of
silently degrading to the weakest level or claiming a top tier the route may
not have.

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

`dsh-thinking-levels` still injects through `agent/request`, so on dsh 0.2.2 and
later it is refused at startup (`engines.dsh` does not admit the runtime) and,
even if force-exempted, its override would trigger the rejection quoted above.
This plugin supersedes it: run one or the other, and on 0.2.2+ prefer this one.

## Tests

```sh
node --test test/index.test.js
```

40 tests cover the tier parser (noise tolerance, aliases, ambiguous answers),
the async hand-off (step 1 keeps the host level, step 2 applies, once per turn,
stale slots ignored), the tier-to-wire mapping (each provider vocabulary,
no-strength routes), prompt assembly, the bounded history reader (exchange
pairs, tool window, non-human user-role messages), completion reading (adapter
failure surfaced, `max-tokens` accepted), and truncation.

## Requirements

- DSH host `0.2.x`
- Node `^22.19 || >=24`
- A route that advertises `low` / `high` / `max`

## License

MIT
