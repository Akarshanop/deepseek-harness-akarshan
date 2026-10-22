// @vitest-environment jsdom
/** Claude-plan card over a scripted Host route. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { ClaudePlanFooter } from '../src/client/ClaudePlanCard.tsx'
import type { ClaudePlanFooterProps } from '../src/client/ClaudePlanCard.tsx'
import { CLAUDE_PLAN_ROUTE, ClaudePlanStore } from '../src/client/claude-plan.ts'
import type { ClaudePlanStatus } from '../src/client/claude-plan.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const BASE: ClaudePlanStatus = {
  installed: true,
  loggedIn: false,
  usesPlan: false,
  route: { id: 'claude-plan', name: 'Claude (your Claude plan)', models: [{ id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet' }] },
  signInCommand: 'claude auth login --claudeai',
  usageUrl: 'https://claude.ai/settings/usage',
}

function harness(answers: Array<ClaudePlanStatus | Response>) {
  const calls: string[] = []
  const fetcher: typeof fetch = (input) => {
    calls.push(input instanceof Request ? input.url : String(input))
    const next = answers.length > 1 ? answers.shift() : answers[0]
    return Promise.resolve(next instanceof Response ? next : Response.json(next))
  }
  const controller = new ClaudePlanStore(fetcher)
  const copied: string[] = []
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: ClaudePlanFooterProps = {
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    usePanelInfo: unusedHook,
    useSessionRetainInfo: unusedHook,
    useResource: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useClaudePlan: bindSnapshotSelector(controller.store),
    copyText: (text) => {
      copied.push(text)
      return Promise.resolve(true)
    },
    t: key => en[key],
  }
  return { props, calls, copied, controller }
}

describe('Claude plan card', () => {
  it('tells the user to turn on the Claude Code plugin when no plugin serves the route', async () => {
    const { props, calls } = harness([new Response('not found', { status: 404 })])
    render(<ClaudePlanFooter {...props} />)

    expect(await screen.findByText(en.claudePluginOff)).toBeTruthy()
    expect(calls).toEqual([CLAUDE_PLAN_ROUTE])
  })

  it('shows the Claude Code sign-in command, copies it, and checks again', async () => {
    const { props, calls, copied } = harness([BASE, { ...BASE, loggedIn: true, authMethod: 'claude.ai', usesPlan: true, subscriptionType: 'pro', email: 'me@example.com' }])
    render(<ClaudePlanFooter {...props} />)

    expect(await screen.findByText(en.claudeSignInIntro)).toBeTruthy()
    expect(screen.getByText('claude auth login --claudeai')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.claudeCopyCommand }))
    expect(await screen.findByRole('button', { name: en.claudeCopied })).toBeTruthy()
    expect(copied).toEqual(['claude auth login --claudeai'])

    fireEvent.click(screen.getByRole('button', { name: en.claudeCheckAgain }))
    expect(await screen.findByText('Claude Code is signed in as me@example.com (Pro plan)')).toBeTruthy()
    expect(calls).toEqual([CLAUDE_PLAN_ROUTE, CLAUDE_PLAN_ROUTE])
  })

  it('points a signed-in plan at the Claude-plan route and its usage page', async () => {
    const { props } = harness([{ ...BASE, loggedIn: true, authMethod: 'claude.ai', usesPlan: true, subscriptionType: 'max', email: 'me@example.com' }])
    render(<ClaudePlanFooter {...props} />)

    expect(await screen.findByText('Claude Code is signed in as me@example.com (Max plan)')).toBeTruthy()
    expect(screen.getByText(/Pick “Claude \(your Claude plan\)” in the model picker \(Claude Opus, Claude Sonnet\)/)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.chatGptManageUsage }).getAttribute('href')).toBe('https://claude.ai/settings/usage')
    expect(screen.queryByText('claude auth login --claudeai')).toBeNull()
  })

  it('warns that an API-key login is not the plan and offers the plan sign-in', async () => {
    const { props } = harness([{ ...BASE, loggedIn: true, authMethod: 'api_key' }])
    render(<ClaudePlanFooter {...props} />)

    expect(await screen.findByText(/Claude Code is signed in with api_key, which bills an API account/)).toBeTruthy()
    expect(screen.getByText('claude auth login --claudeai')).toBeTruthy()
  })

  it('reports a platform without Claude Code and a status the Host could not read', async () => {
    const { props } = harness([{ ...BASE, installed: false, error: 'Claude Code is not available on this platform' }])
    render(<ClaudePlanFooter {...props} />)

    expect(await screen.findByText(en.claudeUnavailable)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Could not read Claude Code’s sign-in state: Claude Code is not available on this platform')
  })

  it('shows a request failure with a way to try again', async () => {
    const { props, controller } = harness([new Response('{}', { status: 500, statusText: 'Internal Server Error' })])
    render(<ClaudePlanFooter {...props} />)

    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('error') })
    expect(screen.getByRole('alert').textContent).toBe('Could not read Claude Code’s sign-in state: 500 Internal Server Error')
    expect(screen.getByRole('button', { name: en.claudeCheckAgain })).toBeTruthy()
  })
})
