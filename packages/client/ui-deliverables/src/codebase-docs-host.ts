/**
 * Host wiring of the codebase docs: the filesystem reads and writes, the model
 * route, and the start whenever a top-level Session opens in a project.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodebaseDocs, type CodebaseDocsConfig } from './codebase-docs.ts'
import { assertRoutePair, completeOnRoute, configuredRoute } from './model-call.ts'
import type { ModelRoute } from './model-gate.ts'

/** Schemastery validation for {@link CodebaseDocsConfig}. */
export const CodebaseDocsConfigSchema: z<CodebaseDocsConfig> = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default('codebase_docs'),
  extensions: z.array(z.string()).default([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.scala', '.vue', '.svelte', '.sql', '.sh',
  ]),
  excludeDirectories: z.array(z.string()).default([
    'node_modules', 'dist', 'build', 'lib', 'out', 'coverage', 'target', 'vendor', '__pycache__', 'venv', 'bower_components',
  ]),
  maxFiles: z.number().default(500),
  maxFileBytes: z.number().default(200_000),
  maxFileChars: z.number().default(40_000),
  concurrency: z.number().default(4),
  maxOutputTokens: z.number().default(4096),
  timeoutMs: z.number().default(180_000),
  language: z.string().default('English'),
  ignoreInGit: z.boolean().default(true),
  provider: z.string(),
  model: z.string(),
})

/** Longest delay a timer accepts; a longer `timeoutMs` would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Check the docs settings.
 * @param config - settings from the plugin configuration.
 * @throws when a count or limit is not a positive integer, the timeout exceeds the timer limit, the directory is not
 * one plain relative path, an extension lacks its leading dot, or only one of `provider` and `model` is set.
 */
export function assertCodebaseDocsConfig(config: CodebaseDocsConfig): void {
  for (const field of ['maxFiles', 'maxFileBytes', 'maxFileChars', 'concurrency', 'maxOutputTokens', 'timeoutMs'] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) {
      throw new Error(`ui-deliverables: codebaseDocs.${field} must be a positive integer`)
    }
  }
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`ui-deliverables: codebaseDocs.timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  if (!/^[\w.-]+$/.test(config.directory) || config.directory.startsWith('.')) {
    throw new Error('ui-deliverables: codebaseDocs.directory must be one directory name that does not start with a dot')
  }
  if (!config.extensions.every(extension => /^\.[\w.-]+$/.test(extension))) {
    throw new Error('ui-deliverables: codebaseDocs.extensions must each start with a dot')
  }
  assertRoutePair(config, 'codebaseDocs')
}

/** The working directory of a Session the docs follow: top-level Sessions with a working directory only. */
function projectOf(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/** The live docs and the route a Session's refreshes run on, for the judge wiring. */
export interface CodebaseDocsHost {
  readonly docs: CodebaseDocs
  /**
   * Document again the files one turn changed, after the judge captured the docs it reads.
   * @param sessionId - the Session whose turn changed the files.
   * @param cwd - the project root.
   * @param paths - project-relative changed paths.
   */
  refresh(sessionId: SessionId, cwd: string, paths: readonly string[]): void
}

/**
 * Document every project a top-level Session opens in: start when the Session is created, on the configured
 * route or the default model, or with the Session's first request when neither names one.
 * @param ctx - host context carrying the filesystem, the model service, and the live Sessions.
 * @param config - validated settings.
 * @returns the docs, or undefined when `enabled` is false.
 */
export function registerCodebaseDocs(ctx: Context, config: CodebaseDocsConfig): CodebaseDocsHost | undefined {
  assertCodebaseDocsConfig(config)
  if (!config.enabled) return undefined
  const docs = new CodebaseDocs(config, {
    list: async (root, path, signal) => {
      const target = await ctx.fs.resolve(path === '' ? '.' : path, { cwd: root, signal })
      return (await ctx.fs.listDir(target, signal))
        .map(entry => ({ name: entry.name, type: entry.type, ...entry.size === undefined ? {} : { size: entry.size } }))
    },
    read: async (root, path, signal) => {
      try {
        const target = await ctx.fs.resolve(path, { cwd: root, signal })
        const info = await ctx.fs.stat(target, signal)
        return info?.type === 'file' ? await ctx.fs.readText(target, signal) : undefined
      } catch {
        // An unreadable file has no text to document or to read back.
        signal.throwIfAborted()
        return undefined
      }
    },
    write: async (root, path, text, signal) => {
      // The Host writes for itself, not for a model call, so it grants exactly the project root it documents.
      await ctx.fs.writeText(await ctx.fs.resolve(path, { cwd: root, signal }), text, undefined, signal, { mode: 'workspace-write', workspaceRoot: root })
    },
    complete: (route, prompt, signal) => completeOnRoute(ctx, route, config.maxOutputTokens, prompt, signal, 'codebase-docs'),
    warn: (message) => { ctx.logger.warn(message) },
  })
  ctx.effect(() => () => { docs.dispose() })
  const fromSession = (sessionId: SessionId): ModelRoute | undefined => {
    const route = ctx.get('sessions')?.get(sessionId)?.requestHeader()?.config
    return route === undefined || route.provider === '' || route.model === '' ? undefined : { provider: route.provider, model: route.model }
  }
  const fromDefault = (): ModelRoute | undefined => {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    return selection === undefined || selection.provider === '' || selection.model === '' ? undefined
      : { provider: selection.provider, model: selection.model }
  }
  // Sessions whose project has not started documenting yet, because no route was known at creation.
  const waiting = new Set<SessionId>()
  const start = (session: Session, route: ModelRoute | undefined): void => {
    const cwd = projectOf(session)
    if (cwd === undefined) return
    if (route === undefined) {
      waiting.add(session.id)
      return
    }
    waiting.delete(session.id)
    void docs.ensure(cwd, route)
  }
  ctx.on('session/created', (session) => { start(session, configuredRoute(config) ?? fromDefault()) })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header' && waiting.has(session.id)) start(session, fromSession(session.id))
  })
  ctx.on('session/disposed', (session) => { waiting.delete(session.id) })
  return {
    docs,
    refresh: (sessionId, cwd, paths) => {
      const route = configuredRoute(config) ?? fromSession(sessionId) ?? fromDefault()
      if (route !== undefined) void docs.refresh(cwd, route, paths)
    },
  }
}
