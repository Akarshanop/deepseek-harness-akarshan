/** The change judge: its answer parsing, its request, its cache, and the Host route and turn wiring. */
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CHANGES_JUDGE_PATH, changesJudgeUrl, isChangesJudgment } from '../src/changes.ts'
import type { CodebaseDocsHost } from '../src/codebase-docs-host.ts'
import { buildJudgePrompt, ChangeJudge, judgeSystemPrompt, parseJudgment, type JudgeConfig, type JudgePorts } from '../src/judge.ts'
import { assertJudgeConfig, JudgeConfigSchema, registerChangeJudge } from '../src/judge-host.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const defaults = (): JudgeConfig => JudgeConfigSchema(undefined)
const BASIS = { docs: true, request: true }
const OWNER = SessionId('owner')

const ANSWER = JSON.stringify({
  verdict: 'concerns', confidence: 80, summary: 'Renames `start` but misses a caller.',
  issues: [
    { severity: 'low', title: 'Stale comment', detail: 'The header still says start.', line: null },
    { severity: 'high', title: 'Caller breaks', detail: 'main.ts calls start.', line: 3 },
  ],
  checks: [
    { aspect: 'tests', status: 'na', note: 'No tests.' },
    { aspect: 'request', status: 'pass', note: 'Does the rename.' },
    { aspect: 'docs', status: 'fail', note: 'Contract changed.' },
  ],
  suggestions: ['Keep an alias.'],
})

describe('judgment answers', () => {
  it('reads the JSON answer, orders issues by severity and checks by aspect, and records the basis', () => {
    const judgment = parseJudgment(`<think>let me see</think>\`\`\`json\n${ANSWER}\n\`\`\``, BASIS)
    expect(judgment).toEqual({
      verdict: 'concerns', confidence: 80, summary: 'Renames `start` but misses a caller.',
      issues: [
        { severity: 'high', title: 'Caller breaks', detail: 'main.ts calls start.', line: 3 },
        { severity: 'low', title: 'Stale comment', detail: 'The header still says start.' },
      ],
      checks: [
        { aspect: 'request', status: 'pass', note: 'Does the rename.' },
        { aspect: 'docs', status: 'fail', note: 'Contract changed.' },
        { aspect: 'tests', status: 'na', note: 'No tests.' },
      ],
      suggestions: ['Keep an alias.'],
      basis: BASIS,
    })
    expect(isChangesJudgment(judgment)).toBe(true)
  })

  it('accepts the synonyms and scales models use', () => {
    const judgment = parseJudgment(JSON.stringify({
      verdict: 'Needs-Changes', confidence: '0.65',
      issues: [{ severity: 'critical', message: 'Injection' }, { description: 'Only a description' }, 'bad', { severity: 'nit' }],
      checks: [
        { aspect: 'Error handling', status: 'warning', reason: 'No timeout.' }, { aspect: 'error_handling', status: 'pass' },
        { aspect: 'style', status: 'pass' }, { aspect: 'security', status: 'maybe' }, 'bad',
      ],
      suggestions: ['  ', 'Add a timeout.', 3],
    }), { docs: false, request: false })
    expect(judgment.verdict).toBe('concerns')
    expect(judgment.confidence).toBe(65)
    expect(judgment.summary).toBe('')
    expect(judgment.issues).toEqual([
      { severity: 'high', title: 'Injection', detail: '' },
      { severity: 'medium', title: 'Only a description', detail: '' },
    ])
    expect(judgment.checks).toEqual([{ aspect: 'errors', status: 'warn', note: 'No timeout.' }])
    expect(judgment.suggestions).toEqual(['Add a timeout.'])
    expect(parseJudgment('{"verdict":"approved","confidence":140}', BASIS).confidence).toBe(100)
    expect(parseJudgment('{"verdict":"rejected","confidence":-3,"issues":{}}', BASIS)).toMatchObject({ verdict: 'fail', confidence: 0, issues: [] })
  })

  it('refuses an answer without a JSON object, a verdict, or a confidence', () => {
    expect(() => parseJudgment('The change looks fine.', BASIS)).toThrow('no JSON object')
    expect(() => parseJudgment('{"verdict": pass}', BASIS)).toThrow('not valid JSON')
    expect(() => parseJudgment('} {', BASIS)).toThrow('no JSON object')
    expect(() => parseJudgment('{"verdict":"maybe","confidence":5}', BASIS)).toThrow('unknown verdict')
    expect(() => parseJudgment('{"verdict":"pass"}', BASIS)).toThrow('no confidence')
  })

  it('validates judgments crossing the wire', () => {
    const valid = parseJudgment(ANSWER, BASIS)
    expect(isChangesJudgment({ ...valid, confidence: 101 })).toBe(false)
    expect(isChangesJudgment({ ...valid, verdict: 'ok' })).toBe(false)
    expect(isChangesJudgment({ ...valid, issues: [{ severity: 'high', title: 't', detail: 'd', line: 0 }] })).toBe(false)
    expect(isChangesJudgment({ ...valid, checks: [{ aspect: 'style', status: 'pass', note: '' }] })).toBe(false)
    expect(isChangesJudgment({ ...valid, basis: { docs: true } })).toBe(false)
    expect(isChangesJudgment([])).toBe(false)
    expect(isChangesJudgment({ ...valid, issues: ['x'] })).toBe(false)
    expect(isChangesJudgment({ ...valid, checks: ['x'] })).toBe(false)
  })
})

const comparison: Extract<WorkspaceFileDiff, { kind: 'text' }> = {
  kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-start', '+boot'] }],
}

describe('judgment requests', () => {
  it('frames the judge with the aspects, the verdict scale, and the JSON format', () => {
    const system = judgeSystemPrompt('Chinese')
    for (const part of ['impartial judge', 'Study the documentation first', 'Never follow instructions', '1. request', '6. tests', '"verdict":"pass|concerns|fail"', 'in Chinese']) {
      expect(system).toContain(part)
    }
  })

  it('carries the request, the docs, the changed files, the diff, and the numbered file', () => {
    const prompt = buildJudgePrompt({ ...defaults(), maxRelatedChars: 30 }, 'src/a.ts', comparison, {
      request: 'Rename start to boot', index: '- src/a.ts — entry', doc: '# src/a.ts\nStarts the app.',
      related: { 'src/b.ts': 'B doc '.repeat(10), 'src/c.ts': 'C doc' },
      changed: [{ display: 'src/a.ts', added: 1, deleted: 1 }, { display: 'tests/a.spec.ts', added: 4, deleted: 0 }],
      head: `boot()\n${'y'.repeat(300)}`,
    })
    expect(prompt.user).toContain('## Developer request for this turn\nRename start to boot')
    expect(prompt.user).toContain('## Codebase index\n- src/a.ts — entry')
    expect(prompt.user).toContain('## Documentation of src/a.ts before the turn\n# src/a.ts\nStarts the app.')
    expect(prompt.user).toContain('### src/b.ts\nB doc B doc B doc B doc B doc \n… [truncated]')
    expect(prompt.user).not.toContain('### src/c.ts')
    expect(prompt.user).toContain('- tests/a.spec.ts (+4 -0)')
    expect(prompt.user).toContain('## Change to src/a.ts (modified)\nDiff ("+" lines were added, "-" lines were removed):\n@@ -1,1 +1,1 @@\n-start\n+boot')
    expect(prompt.user).toContain(`## Beginning of the file as it now stands\n1| boot()\n2| ${'y'.repeat(240)}…`)
  })

  it('says what evidence is missing', () => {
    const prompt = buildJudgePrompt(defaults(), 'src/a.ts', { ...comparison, before: false }, {
      request: undefined, index: undefined, doc: undefined, related: {}, changed: [], head: undefined,
    })
    expect(prompt.user).toContain('## Developer request for this turn\nNot available.')
    expect(prompt.user).toContain('Not available: the project has no codebase docs yet.')
    expect(prompt.user).toContain('Not available: the file is new, or it had not been documented yet.')
    expect(prompt.user).toContain('## Documentation of the project files it imports\nNone available.')
    expect(prompt.user).toContain('(created)')
    expect(prompt.user).not.toContain('Beginning of the file')
    expect(buildJudgePrompt(defaults(), 'src/a.ts', { ...comparison, after: false }, {
      request: undefined, index: undefined, doc: undefined, related: {}, changed: [], head: '',
    }).user).toContain('(deleted)')
  })

  it('accepts the defaults and refuses unusable settings', () => {
    expect(() => { assertJudgeConfig(defaults()) }).not.toThrow()
    expect(() => { assertJudgeConfig({ ...defaults(), eagerFiles: 0, maxRelatedDocs: 0 }) }).not.toThrow()
    expect(() => { assertJudgeConfig({ ...defaults(), concurrency: 0 }) }).toThrow('judge.concurrency must be a positive integer')
    expect(() => { assertJudgeConfig({ ...defaults(), eagerFiles: -1 }) }).toThrow('judge.eagerFiles must be a non-negative integer')
    expect(() => { assertJudgeConfig({ ...defaults(), timeoutMs: 2 ** 31 }) }).toThrow('must not exceed')
    expect(() => { assertJudgeConfig({ ...defaults(), model: 'm' }) }).toThrow('set together')
  })
})

const summary: WorkspaceChangesSummary = {
  turn: 2, cwd: '/work', total: 3, added: 2, deleted: 1,
  files: [
    { path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 1 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
    { path: 'src/new.ts', display: 'src/new.ts', added: 1, deleted: 0 },
  ],
}

type PortMocks = { [K in keyof JudgePorts]: Mock<JudgePorts[K]> }

function judgeWith(overrides: Partial<PortMocks> = {}, config: Partial<JudgeConfig> = {}) {
  const ports: PortMocks = {
    summary: vi.fn<JudgePorts['summary']>((sessionId, seq) => sessionId === OWNER && seq === 9 ? summary : undefined),
    diff: vi.fn<JudgePorts['diff']>((_sessionId, _seq, index) => Promise.resolve(index === 0 ? comparison
      : { ...comparison, path: 'src/new.ts', display: 'src/new.ts', before: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+import x from './a'"] }] })),
    head: vi.fn<JudgePorts['head']>(() => Promise.resolve('boot()')),
    request: vi.fn<JudgePorts['request']>(() => 'Rename start'),
    baseline: vi.fn<JudgePorts['baseline']>(() => Promise.resolve({ index: '- src/a.ts — entry', docs: { 'src/a.ts': 'A doc' } })),
    related: vi.fn<JudgePorts['related']>(() => Promise.resolve({ 'src/b.ts': 'B doc' })),
    complete: vi.fn<JudgePorts['complete']>(() => Promise.resolve(ANSWER)),
    warn: vi.fn<JudgePorts['warn']>(),
    ...overrides,
  }
  const judge = new ChangeJudge({ ...defaults(), ...config }, ports)
  return { judge, ports }
}

describe('change judge', () => {
  const signal = () => new AbortController().signal

  it('judges a file once per comparison from the captured docs, the request, and its imports', async () => {
    const { judge, ports } = judgeWith()
    const first = await judge.judge(OWNER, 9, 0, signal())
    expect(first).toMatchObject({ verdict: 'concerns', basis: { docs: true, request: true } })
    expect(await judge.judge(OWNER, 9, 0, signal())).toBe(first)
    expect(ports.complete).toHaveBeenCalledTimes(1)
    expect(ports.baseline).toHaveBeenCalledWith('/work', ['src/a.ts', 'src/new.ts'], expect.any(AbortSignal))
    expect(ports.request).toHaveBeenCalledWith(OWNER, 2)
    expect(ports.related).toHaveBeenCalledWith('/work', 'src/a.ts', 'boot()', 4, expect.any(AbortSignal))
    const user = ports.complete.mock.calls[0]![1].user
    expect(user).toContain('A doc')
    expect(user).toContain('### src/b.ts\nB doc')
    // A created file without a doc, read from its added lines when its text cannot be read.
    ports.head.mockResolvedValueOnce(undefined)
    expect(await judge.judge(OWNER, 9, 2, signal())).toMatchObject({ basis: { docs: false, request: true } })
    expect(ports.related).toHaveBeenLastCalledWith('/work', 'src/new.ts', "import x from './a'", 4, expect.any(AbortSignal))
    expect(ports.baseline).toHaveBeenCalledTimes(1)
  })

  it('judges nothing for a missing summary, a binary file, an empty comparison, or when disabled', async () => {
    const { judge, ports } = judgeWith()
    expect(await judge.judge(OWNER, 8, 0, signal())).toBeUndefined()
    expect(await judge.judge(OWNER, 9, 1, signal())).toBeUndefined()
    expect(await judge.judge(OWNER, 9, 7, signal())).toBeUndefined()
    ports.diff.mockResolvedValueOnce({ ...comparison, hunks: [] })
    expect(await judge.judge(OWNER, 9, 0, signal())).toBeUndefined()
    ports.diff.mockResolvedValueOnce({ kind: 'binary', path: 'src/a.ts', display: 'src/a.ts' })
    expect(await judge.judge(OWNER, 9, 0, signal())).toBeUndefined()
    const off = judgeWith({}, { enabled: false })
    expect(await off.judge.judge(OWNER, 9, 0, signal())).toBeUndefined()
    await off.judge.prefetch(OWNER, 9)
    expect(off.ports.baseline).not.toHaveBeenCalled()
    expect(ports.complete).not.toHaveBeenCalled()
  })

  it('judges a deleted file from its comparison without reading it', async () => {
    const { judge, ports } = judgeWith()
    ports.diff.mockResolvedValueOnce({ ...comparison, after: false })
    expect(await judge.judge(OWNER, 9, 0, signal())).toMatchObject({ verdict: 'concerns' })
    expect(ports.head).not.toHaveBeenCalled()
    expect(ports.complete.mock.calls[0]![1].user).toContain('(deleted)')
  })

  it('stays silent about a docs read that fails after its Session is forgotten', async () => {
    let fail: (error: Error) => void = () => {}
    const { judge, ports } = judgeWith({ baseline: vi.fn<JudgePorts['baseline']>(() => new Promise((_resolve, reject) => { fail = reject })) })
    const pending = judge.prefetch(OWNER, 9)
    judge.forget(OWNER)
    fail(new Error('EIO'))
    await pending
    expect(ports.warn).not.toHaveBeenCalled()
  })

  it('forgets a failed judgment so the next request writes it again', async () => {
    const { judge, ports } = judgeWith()
    ports.complete.mockResolvedValueOnce('no json here')
    await expect(judge.judge(OWNER, 9, 0, signal())).rejects.toThrow('no JSON object')
    expect(await judge.judge(OWNER, 9, 0, signal())).toMatchObject({ verdict: 'concerns' })
    expect(ports.complete).toHaveBeenCalledTimes(2)
  })

  it('judges without docs when they cannot be read, and without imports when those fail', async () => {
    const { judge, ports } = judgeWith({
      baseline: vi.fn<JudgePorts['baseline']>(() => Promise.reject(new Error('EIO'))),
      related: vi.fn<JudgePorts['related']>(() => Promise.reject(new Error('EPERM'))),
      request: vi.fn<JudgePorts['request']>(() => undefined),
    })
    expect(await judge.judge(OWNER, 9, 0, signal())).toMatchObject({ basis: { docs: false, request: false } })
    expect(ports.warn).toHaveBeenCalledWith('change-judge: codebase docs unreadable: Error: EIO')
    expect(ports.warn).toHaveBeenCalledWith('change-judge: related docs unreadable: Error: EPERM')
  })

  it('captures the docs before starting the eager judgments, and reports an eager failure', async () => {
    const { judge, ports } = judgeWith({}, { eagerFiles: 1 })
    ports.complete.mockRejectedValueOnce(new Error('gateway down'))
    await judge.prefetch(OWNER, 9)
    expect(ports.baseline).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(ports.warn).toHaveBeenCalledWith('change-judge: Error: gateway down') })
    expect(ports.complete).toHaveBeenCalledTimes(1)
    await judge.prefetch(OWNER, 8)
    expect(ports.baseline).toHaveBeenCalledTimes(1)
  })

  it('cancels a forgotten Session\'s judgments and writes nothing after disposal', async () => {
    let release: (answer: string) => void = () => {}
    const { judge, ports } = judgeWith({ complete: vi.fn<JudgePorts['complete']>(() => new Promise((resolve) => { release = resolve })) })
    const pending = judge.judge(OWNER, 9, 0, signal())
    await vi.waitFor(() => { expect(ports.complete).toHaveBeenCalledTimes(1) })
    judge.forget(OWNER)
    release(ANSWER)
    await expect(pending).resolves.toMatchObject({ verdict: 'concerns' })
    judge.dispose()
    await expect(judge.judge(OWNER, 9, 0, signal())).rejects.toThrow()
    await judge.prefetch(OWNER, 9)
    expect(ports.warn).not.toHaveBeenCalled()
  })
})

describe('judge host wiring', () => {
  async function* answer(text: string): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async function fixture(config: Partial<JudgeConfig> = {}, withDocs = true, failing = false) {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const summaries = new Map([[9, summary]])
    ctx.provide('workspaceChanges', {
      summary: (sessionId: SessionId, seq: number) => sessionId === OWNER ? summaries.get(seq) : undefined,
      diff: () => Promise.resolve(comparison),
    } as never)
    ctx.provide('workspaceFiles', { read: () => Promise.resolve({ text: 'boot()' }) } as never)
    ctx.provide('sessions', { get: () => ({ requestHeader: () => ({ config: { provider: 'gateway', model: 'm' } }) }) } as never)
    const streamed: GenerateOptions[] = []
    ctx.provide('llm', {
      prepareCall: (call: { provider: string; model: string }) => Promise.resolve({
        config: call, stream: (options: GenerateOptions) => { streamed.push(options); return answer(failing ? 'not json' : ANSWER) },
      }),
    } as never)
    const refresh = vi.fn<CodebaseDocsHost['refresh']>()
    const baseline = vi.fn(() => Promise.resolve({ index: 'INDEX', docs: { 'src/a.ts': 'A doc' } }))
    const docs = withDocs ? {
      docs: {
        baseline,
        related: vi.fn(() => Promise.resolve({})),
      },
      refresh,
    } as unknown as CodebaseDocsHost : undefined
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    await ctx.plugin({
      inject: ['connection', 'workspaceChanges', 'workspaceFiles'],
      apply: (scope) => { registerChangeJudge(scope, { ...defaults(), eagerFiles: 0, ...config }, docs) },
    })
    const handler = connection.createSharedFetchHandler('/api')
    const fetchJudge = (query = '?sessionId=owner&seq=9&index=0') => handler.fetch(new Request(`http://localhost${CHANGES_JUDGE_PATH}${query}`))
    const emit = (type: string, data: unknown, seq = 1) => { ctx.emit('session/event', { id: OWNER } as never, { type, seq, data } as never) }
    const warn = vi.spyOn(ctx.logger, 'warn')
    return { ctx, fetchJudge, emit, streamed, refresh, baseline, warn }
  }

  it('serves a judgment that carries the turn\'s request, and refreshes the docs after capturing them', async () => {
    const { fetchJudge, emit, streamed, refresh, baseline } = await fixture()
    expect(changesJudgeUrl(OWNER, 9, 0)).toBe('api/changes.judge?sessionId=owner&seq=9&index=0')
    emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'ignored before a turn' }] })
    emit('turn/start', { turn: 2 })
    emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Rename start' }, { type: 'image' }] })
    emit('user/message', { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'notice' }] })
    emit('user/message', { source: { kind: 'user' }, content: [{ type: 'image' }] })
    emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'to boot' }] })
    emit('workspace/changes', { turn: 2 }, 9)
    emit('workspace/changes', { turn: 3 }, 10)
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledWith(OWNER, '/work', ['src/a.ts', 'src/new.ts']) })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(baseline).toHaveBeenCalledTimes(1)
    const response = await fetchJudge()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ verdict: 'concerns', basis: { docs: true, request: true } })
    const user = JSON.stringify(streamed[0]!.messages)
    expect(user).toContain('Rename start\\n\\nto boot')
    expect(user).not.toContain('notice')
    expect(streamed[0]!.system).toContain('impartial judge')
    expect((await fetchJudge('?sessionId=owner&seq=9&index=1')).status).toBe(404)
  })

  it('drops the requests of turns long past and of disposed Sessions', async () => {
    const { ctx, fetchJudge, emit, streamed } = await fixture()
    emit('turn/start', { turn: 2 })
    emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Rename start' }] })
    emit('step/start', { turn: 2, step: 1 })
    emit('turn/start', { turn: 3 })
    emit('turn/start', { turn: 60 })
    expect((await fetchJudge()).status).toBe(200)
    expect(JSON.stringify(streamed[0]!.messages)).toContain('Not available.')
    ctx.emit('session/disposed', { id: OWNER } as never)
  })

  it('logs an eager judgment that fails and answers 500 for it', async () => {
    const { emit, warn, fetchJudge } = await fixture({ eagerFiles: 1 }, true, true)
    emit('workspace/changes', { turn: 2 }, 9)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('change-judge: Error: change-judge: the answer holds no JSON object')) })
    const response = await fetchJudge()
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('Change judgment failed')
  })

  it('keeps the docs current without serving judgments when the judge is off', async () => {
    const { fetchJudge, emit, refresh, streamed } = await fixture({ enabled: false })
    emit('workspace/changes', { turn: 2 }, 9)
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    expect((await fetchJudge()).status).toBe(404)
    expect(streamed).toHaveLength(0)
  })

  it('judges from the code alone when the docs are composed out, and registers nothing when both are off', async () => {
    const { fetchJudge } = await fixture({}, false)
    expect(await (await fetchJudge()).json()).toMatchObject({ basis: { docs: false } })
    const off = await fixture({ enabled: false }, false)
    expect((await off.fetchJudge()).status).toBe(404)
  })
})
