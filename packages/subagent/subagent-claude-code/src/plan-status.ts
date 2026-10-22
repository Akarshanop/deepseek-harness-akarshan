/**
 * Sign-in state of the Claude Code that serves the Claude-plan route, read
 * from its own `claude auth status --json`. Anthropic permits an end user to
 * sign in to the unmodified Claude Code binary with their own plan but not a
 * third-party app to offer Claude.ai login or handle its credentials, so this
 * module only reports what Claude Code says about itself: whether it is signed
 * in, how, which plan, and the account email. It starts no sign-in and reads no
 * credential; signing in happens in Claude Code (`claude auth login`).
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/plan-status
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Where a user reviews their Claude plan usage. */
export const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage'

/** Path of the Host route below the shared `/api` channel. */
export const CLAUDE_PLAN_ROUTE_PATH = '/api/subagent-claude-code.plan'

/** What Claude Code reports about its sign-in, plus the route the plan serves. */
export interface ClaudePlanStatus {
  /** Whether the Claude Code executable the route runs was found and answered. */
  readonly installed: boolean
  /** Whether Claude Code is signed in by any method. */
  readonly loggedIn: boolean
  /** Claude Code's sign-in method: `claude.ai` for a plan login, otherwise an API key, token, or cloud provider. */
  readonly authMethod?: string
  /** Plan of a `claude.ai` login, such as `pro` or `max`. */
  readonly subscriptionType?: string
  /** Account email of the sign-in. */
  readonly email?: string
  /** Whether requests on the route would draw on a Claude plan rather than bill an API account. */
  readonly usesPlan: boolean
  /** The model-picker route and the models it offers. */
  readonly route: { readonly id: string; readonly name: string; readonly models: readonly { id: string; name: string }[] }
  /** Command the user runs in a terminal to sign in to Claude Code with their plan. */
  readonly signInCommand: string
  /** Claude plan usage settings. */
  readonly usageUrl: string
  /** Why the status could not be read. */
  readonly error?: string
}

/** Result of running the status command. */
export interface StatusRun {
  readonly exitCode: number | null
  readonly stdout: string
}

/** Runs the Claude Code executable with arguments and environment. */
export type StatusRunner = (executable: string, args: readonly string[], env: Record<string, string>) => Promise<StatusRun>

const SIGN_IN_COMMAND = 'claude auth login --claudeai'
const STATUS_TIMEOUT_MS = 15_000

/**
 * The native Claude Code binary the Agent SDK runs on this platform: the
 * SDK's platform package, resolved the way the SDK resolves its default.
 * @returns the absolute path, or undefined when this platform has no bundled binary.
 */
export function bundledClaudeExecutable(): string | undefined {
  try {
    const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const platformPackage = createRequire(sdk).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    )
    const binary = join(dirname(platformPackage), process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(binary) ? binary : undefined
  } catch {
    // No platform package for this OS/architecture: the route cannot run here either.
    return undefined
  }
}

/**
 * Production runner: `execFile` with a timeout; a non-zero exit still yields its output.
 * @param executable - the Claude Code binary.
 * @param args - its arguments.
 * @param env - the child environment.
 * @returns the exit code (null when killed or not started) and standard output.
 */
export const execStatus: StatusRunner = (executable, args, env) => new Promise((resolve) => {
  execFile(executable, [...args], { env, timeout: STATUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
    resolve({ exitCode: code, stdout })
  })
})

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read Claude Code's sign-in state.
 * @param input - executable, environment, route facts, and the runner.
 * @param input.executable - the Claude Code binary, or undefined when none was found.
 * @param input.env - the environment the route runs Claude Code with.
 * @param input.route - the model-picker route the plan serves.
 * @param input.run - runs the status command.
 * @returns the status; a missing binary or unreadable answer is reported, never thrown.
 */
export async function readClaudePlanStatus(input: {
  readonly executable: string | undefined
  readonly env: Record<string, string>
  readonly route: ClaudePlanStatus['route']
  readonly run: StatusRunner
}): Promise<ClaudePlanStatus> {
  const base = { route: input.route, signInCommand: SIGN_IN_COMMAND, usageUrl: CLAUDE_USAGE_URL }
  if (input.executable === undefined) {
    return { ...base, installed: false, loggedIn: false, usesPlan: false, error: 'Claude Code is not available on this platform' }
  }
  const result = await input.run(input.executable, ['auth', 'status', '--json'], input.env)
  let parsed: Record<string, unknown> | undefined
  try {
    const value: unknown = JSON.parse(result.stdout)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    // Reported below: the command produced no JSON (an old or broken Claude Code).
  }
  if (parsed === undefined) {
    return {
      ...base,
      installed: result.exitCode !== null,
      loggedIn: false,
      usesPlan: false,
      error: `Claude Code did not report its sign-in state (exit ${String(result.exitCode)})`,
    }
  }
  const loggedIn = parsed.loggedIn === true
  const authMethod = text(parsed.authMethod)
  const subscriptionType = text(parsed.subscriptionType)
  const email = text(parsed.email)
  return {
    ...base,
    installed: true,
    loggedIn,
    ...authMethod === undefined ? {} : { authMethod },
    ...subscriptionType === undefined ? {} : { subscriptionType },
    ...email === undefined ? {} : { email },
    usesPlan: loggedIn && authMethod === 'claude.ai',
  }
}
