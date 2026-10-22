import { describe, expect, it } from 'vitest'
import { bundledClaudeExecutable, readClaudePlanStatus, type StatusRunner } from '../src/plan-status.ts'

const ROUTE = { id: 'claude-plan', name: 'Claude (your Claude plan)', models: [{ id: 'opus', name: 'Claude Opus' }] }

interface RecordedRun { executable: string; args: readonly string[]; env: Record<string, string> }

/** A runner answering with fixed output, recording what it ran. */
function runner(exitCode: number | null, stdout: string): StatusRunner & { calls: RecordedRun[] } {
  const calls: RecordedRun[] = []
  const run: StatusRunner = (executable, args, env) => {
    calls.push({ executable, args, env })
    return Promise.resolve({ exitCode, stdout })
  }
  return Object.assign(run, { calls })
}

describe('Claude plan status', () => {
  it('reports a Claude plan login from Claude Code\'s own status, run with the route environment', async () => {
    const run = runner(0, JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', orgId: 'org', subscriptionType: 'max',
    }))
    const status = await readClaudePlanStatus({ executable: '/bin/claude', env: { HOME: '/home/me' }, route: ROUTE, run })

    expect(run.calls).toEqual([{ executable: '/bin/claude', args: ['auth', 'status', '--json'], env: { HOME: '/home/me' } }])
    expect(status).toEqual({
      installed: true,
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'me@example.com',
      usesPlan: true,
      route: ROUTE,
      signInCommand: 'claude auth login --claudeai',
      usageUrl: 'https://claude.ai/settings/usage',
    })
  })

  it('reports a signed-out Claude Code, which exits 1 with its JSON status', async () => {
    const status = await readClaudePlanStatus({
      executable: '/bin/claude', env: {}, route: ROUTE, run: runner(1, JSON.stringify({ loggedIn: false, authMethod: 'none' })),
    })
    expect(status).toMatchObject({ installed: true, loggedIn: false, authMethod: 'none', usesPlan: false })
    expect(status).not.toHaveProperty('error')
  })

  it('does not count an API-key login as the plan', async () => {
    const status = await readClaudePlanStatus({
      executable: '/bin/claude', env: {}, route: ROUTE, run: runner(0, JSON.stringify({ loggedIn: true, authMethod: 'api_key' })),
    })
    expect(status).toMatchObject({ loggedIn: true, authMethod: 'api_key', usesPlan: false })
  })

  it('reports an answer that is not JSON, and a missing executable, without throwing', async () => {
    await expect(readClaudePlanStatus({ executable: '/bin/claude', env: {}, route: ROUTE, run: runner(2, 'unknown command') }))
      .resolves.toMatchObject({ installed: true, loggedIn: false, usesPlan: false, error: 'Claude Code did not report its sign-in state (exit 2)' })
    await expect(readClaudePlanStatus({ executable: '/bin/claude', env: {}, route: ROUTE, run: runner(null, '') }))
      .resolves.toMatchObject({ installed: false, error: 'Claude Code did not report its sign-in state (exit null)' })
    await expect(readClaudePlanStatus({ executable: undefined, env: {}, route: ROUTE, run: runner(0, '') }))
      .resolves.toMatchObject({ installed: false, loggedIn: false, usesPlan: false, error: 'Claude Code is not available on this platform' })
  })

  it('finds the Agent SDK\'s native Claude Code for this platform', () => {
    const executable = bundledClaudeExecutable()
    // The SDK ships a binary per supported platform; elsewhere the route cannot run either.
    if (executable !== undefined) expect(executable).toMatch(/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+[/\\]claude(\.exe)?$/)
  })
})
