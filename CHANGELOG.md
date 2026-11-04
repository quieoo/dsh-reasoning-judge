# Changelog

## 0.1.0 — 2026-11-04

First release.

- Judge each turn once at `agent/pre-step` and apply the level at
  `agent/request`; later steps of the same turn reuse the judgement, so a
  20-step turn pays for exactly one classification call.
- Read the request, the **previous exchange** (human request plus assistant
  reply, uncapped by default) and deduplicated recent tool names. Tool results,
  file contents and the full history are deliberately excluded — replaying them
  is the cost this plugin exists to avoid.
- Clamp the judgement to the route's advertised levels and send only `low`,
  `high` or `max`.
- Leave `reasoningEffort` unset on the classification call by default: several
  routes positively reject `off`, and a refused effort fails the whole call.
- Fail open on every path — judgement failure, timeout, or an unusable answer
  leaves the host level standing.
- Respect a manual pick in the model selector via the `modelSelection`
  projection's `pending` field.
- Optional `logFile` mirror, because `ctx.logger` only reaches the host's
  stdout.
