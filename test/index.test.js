import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEVELS,
  assemblePrompt,
  clampLevel,
  chooseLevel,
  judgePrompt,
  readCompletion,
  readHistory,
  truncate,
} from '../lib/index.js'

test('chooseLevel reads a bare level', () => {
  assert.equal(chooseLevel('low'), 'low')
  assert.equal(chooseLevel('high'), 'high')
  assert.equal(chooseLevel('max'), 'max')
})

test('chooseLevel tolerates noise around one level', () => {
  assert.equal(chooseLevel('  HIGH.\n'), 'high')
  assert.equal(chooseLevel('`max`'), 'max')
  assert.equal(chooseLevel('I would say high here.'), 'high')
  assert.equal(chooseLevel('**low**'), 'low')
})

test('chooseLevel falls back when no level is named', () => {
  assert.equal(chooseLevel(''), 'high')
  assert.equal(chooseLevel('unclear'), 'high')
  assert.equal(chooseLevel(undefined), 'high')
  assert.equal(chooseLevel(null, 'low'), 'low')
})

test('chooseLevel refuses an ambiguous answer naming two levels', () => {
  // A judge that hedges gave no judgement; picking one arbitrarily would be a
  // guess dressed up as a decision.
  assert.equal(chooseLevel('low or high'), 'high')
  assert.equal(chooseLevel('high or max', 'low'), 'low')
})

test('chooseLevel ignores an invalid fallback', () => {
  assert.equal(chooseLevel('nonsense', 'medium'), 'high')
})

test('clampLevel passes through an advertised level', () => {
  assert.equal(clampLevel('max', ['off', 'low', 'high', 'max']), 'max')
  assert.equal(clampLevel('high', ['low', 'high']), 'high')
})

test('clampLevel clamps down to the strongest advertised level', () => {
  // A model offering only low/high must not be sent max.
  assert.equal(clampLevel('max', ['off', 'low', 'high']), 'high')
  assert.equal(clampLevel('high', ['off', 'low']), 'low')
})

test('clampLevel lifts a level the model does not advertise below', () => {
  // Asking for `low` from a model whose floor is `high` still has to name a
  // level it accepts.
  assert.equal(clampLevel('low', ['high', 'max']), 'high')
})

test('clampLevel yields nothing for a model advertising no levels', () => {
  assert.equal(clampLevel('high', []), undefined)
  assert.equal(clampLevel('high', undefined), undefined)
})

test('judgePrompt reads only the human message, not injected context', () => {
  // The same pre-step batch also carries runtime-context snapshots and memory
  // recall blocks. Judging those instead of the request is the bug this guards.
  const messages = [
    { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context: cwd=/x' }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: 'refactor the auth module' }] },
    { source: { kind: 'model-selection' }, content: [{ type: 'text', text: 'Model switched to X' }] },
  ]
  assert.equal(judgePrompt(messages), 'refactor the auth module')
})

test('judgePrompt returns empty when the batch holds no human message', () => {
  const messages = [
    { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'harness prose' }] },
  ]
  assert.equal(judgePrompt(messages), '')
})

test('judgePrompt flattens text blocks and skips everything else', () => {
  const messages = [
    { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'x' }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: '  second  ' }] },
  ]
  assert.equal(judgePrompt(messages), 'first\n\nsecond')
})

test('judgePrompt keeps the tail, where the request sits', () => {
  const long = 'a'.repeat(50) + 'REQUEST'
  const out = judgePrompt([{ source: { kind: 'user' }, content: [{ type: 'text', text: long }] }], 10)
  // The last 10 characters: 3 dropped 'a's remain ahead of the request text.
  assert.equal(out, 'aaaREQUEST')
  assert.ok(out.endsWith('REQUEST'))
  assert.equal(out.length, 10)
})

test('judgePrompt returns empty for absent or non-text input', () => {
  assert.equal(judgePrompt(undefined), '')
  assert.equal(judgePrompt([]), '')
  assert.equal(judgePrompt([{ source: { kind: 'user' }, content: 'plain string' }]), '')
  assert.equal(judgePrompt([{ source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] }]), '')
})

test('readCompletion concatenates text deltas', async () => {
  async function* stream() {
    yield { type: 'text-delta', text: 'ma' }
    yield { type: 'text-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  }
  assert.equal(await readCompletion(stream()), 'max')
})

test('readCompletion rejects a failed completion instead of judging partials', async () => {
  async function* stream() {
    yield { type: 'text-delta', text: 'ma' }
    yield { type: 'finish', reason: { kind: 'error' } }
  }
  await assert.rejects(() => readCompletion(stream()), /judge completion error/u)
})

test('readCompletion surfaces the adapter failure, not just its kind', async () => {
  // The original message said only "ended: error" and sent the first
  // diagnosis down the wrong path; the cause was a refused reasoning effort.
  async function* stream() {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'route refuses off' } },
    }
  }
  await assert.rejects(
    () => readCompletion(stream()),
    /UNSUPPORTED_REASONING_EFFORT route refuses off/u,
  )
})

test('readCompletion keeps the word from a max-tokens cut-off', async () => {
  // The cap is deliberately tiny, so hitting it is normal and the word survived.
  async function* stream() {
    yield { type: 'text-delta', text: 'high' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  assert.equal(await readCompletion(stream()), 'high')
})

test('LEVELS stays the three the adapters share', () => {
  assert.deepEqual(LEVELS, ['low', 'high', 'max'])
})

test('assemblePrompt carries the request alone when there is no context', () => {
  assert.equal(assemblePrompt('refactor auth'), 'New request:\nrefactor auth')
  assert.equal(assemblePrompt(''), '')
  assert.equal(assemblePrompt(undefined), '')
})

test('assemblePrompt folds in the previous exchange and tools', () => {
  const out = assemblePrompt('继续', {
    tools: ['read', 'edit'],
    previousRequest: '改一下鉴权',
    previousReply: '我已改完 A 文件',
  })
  assert.match(out, /Recent tools: read, edit/u)
  assert.match(out, /Previous exchange:\nuser: 改一下鉴权\nassistant: 我已改完 A 文件/u)
  // The request must stay last: it is the thing being judged.
  assert.ok(out.endsWith('New request:\n继续'))
})

test('assemblePrompt handles a half-known exchange', () => {
  const onlyReply = assemblePrompt('继续', { previousReply: '完成了' })
  assert.match(onlyReply, /Previous exchange:\nassistant: 完成了/u)

  const onlyRequest = assemblePrompt('继续', { previousRequest: '做事' })
  assert.match(onlyRequest, /Previous exchange:\nuser: 做事/u)
})

test('truncate caps only when given a positive limit', () => {
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(truncate('abcdef', 10), 'abcdef')
  assert.equal(truncate('abcdef', 0), 'abcdef')
  assert.equal(truncate('abcdef', -1), 'abcdef')
  assert.equal(truncate(undefined, 5), '')
})

test('assemblePrompt deduplicates tools but keeps their order', () => {
  const out = assemblePrompt('x', { tools: ['read', 'edit', 'read', 'bash'] })
  assert.match(out, /Recent tools: read, edit, bash/u)
})

test('readHistory returns both halves of the previous exchange', () => {
  const session = {
    snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'read' } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看看鉴权' }] } },
      { type: 'tool/call', data: { name: 'edit' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '改完了' }] } } },
    ],
  }
  const out = readHistory(session)
  assert.equal(out.previousRequest, '看看鉴权')
  assert.equal(out.previousReply, '改完了')
  // Tools come back oldest-first for readability.
  assert.deepEqual(out.tools, ['read', 'edit'])
})

test('readHistory keeps the whole reply when uncapped', () => {
  const long = 'x'.repeat(5000)
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } },
    ],
  }
  const out = readHistory(session, { replyChars: 0 })
  assert.equal(out.previousReply.length, 5000)
  assert.equal(out.previousReply, long)
})

test('readHistory ignores non-user user-role messages', () => {
  // runtime-context snapshots are stored as user-role events but are not human.
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd=/x' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    ],
  }
  assert.equal(readHistory(session).previousRequest, '')
})

test('readHistory bounds the reply and the tool window when configured', () => {
  const long = 'a'.repeat(1000)
  const session = {
    snapshotEvents: () => [
      { type: 'tool/call', data: { name: 'a' } },
      { type: 'tool/call', data: { name: 'b' } },
      { type: 'tool/call', data: { name: 'c' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } },
    ],
  }
  const out = readHistory(session, { replyChars: 10, toolWindow: 2 })
  assert.equal(out.previousReply.length, 11) // 10 chars plus the ellipsis
  assert.deepEqual(out.tools, ['b', 'c'])
})

test('readHistory degrades to empty when the log is unavailable', () => {
  const empty = { previousRequest: '', previousReply: '', tools: [] }
  assert.deepEqual(readHistory(undefined), empty)
  assert.deepEqual(readHistory({}), empty)
  assert.deepEqual(readHistory({ snapshotEvents: () => { throw new Error('nope') } }), empty)
})

test('readHistory skips malformed records instead of throwing', () => {
  const session = {
    snapshotEvents: () => [
      null,
      { type: 'tool/call' },
      { type: 'tool/call', data: { name: 'grep' } },
      { type: 'assistant/message', data: {} },
    ],
  }
  assert.deepEqual(readHistory(session), { previousRequest: '', previousReply: '', tools: ['grep'] })
})
