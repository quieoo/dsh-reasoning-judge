# Changelog

## 0.2.0 — 2026-11-06

Adapt to dsh 0.2.2-rc.1, where `agent/request` can no longer change the
reasoning effort.

- Record the judgement through `agent.model.select()` from `agent/pre-step`
  instead of returning a new `reasoningEffort` from `agent/request`. Since
  0.2.2 the loop fixes its selection *before* dispatching `agent/pre-step` and
  throws `agent/request proposed reasoning effort "high" after step preparation
  fixed "adapter default"; use agent.model.select() before step preparation`
  when a request-time listener disagrees — which ended the turn rather than
  merely ignoring the override.
- Drop the `agent/request` listener entirely, so the plugin takes part in only
  one waterfall. The recorded selection is applied by the following step
  preparation, preserving the original timing: step 1 keeps the host level and
  the classification, started alongside it, is in force from step 2.
- Read manual-pin provenance from the `modelSelection` projection's `pending`
  field, falling back to the locally recorded selection. A host or projection
  that cannot answer now reports "not pinned": treating a missing answer as a
  pin would silently disable the judge for the whole session.

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
