// @vitest-environment jsdom
/** Sign in with ChatGPT card and store over a scripted Host route. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { ChatGptPlanFooter, ChatGptPlanProviderExtra } from '../src/client/ChatGptPlanCard.tsx'
import type { ChatGptPlanFooterProps, ChatGptPlanProviderProps } from '../src/client/ChatGptPlanCard.tsx'
import { CHATGPT_PLAN_ROUTE, ChatGptPlanStore } from '../src/client/chatgpt-plan.ts'
import type { ChatGptPlanStatus } from '../src/client/chatgpt-plan.ts'
import type { SettingsWriteOutcome } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const SIGNED_OUT: ChatGptPlanStatus = {
  signedIn: false,
  pending: false,
  routeConfigured: false,
  apiKeyConfigured: false,
  usageUrl: 'https://chatgpt.com/settings/usage',
}

/** A scripted Host route: each request answers with the next status, recording what was asked. */
function hostRoute(answers: Array<ChatGptPlanStatus | Response>) {
  const calls: string[] = []
  const fetcher: typeof fetch = (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input instanceof Request ? input.url : String(input)}`)
    const next = answers.length > 1 ? answers.shift() : answers[0]
    if (next instanceof Response) return Promise.resolve(next)
    return Promise.resolve(Response.json(next))
  }
  return { fetcher, calls }
}

function harness(
  answers: Array<ChatGptPlanStatus | Response>,
  written: SettingsWriteOutcome = { kind: 'written', view: {} as never },
  pollMs = 5,
) {
  const route = hostRoute(answers)
  const writeSettings = vi.fn(() => Promise.resolve(written))
  const controller = new ChatGptPlanStore({ fetch: route.fetcher, writeSettings, pollMs })
  const opened: string[] = []
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const injected: ChatGptPlanFooterProps = {
    useSessions: unusedHook,
    useSessionStatus: unusedHook,
    usePanelInfo: unusedHook,
    useSessionRetainInfo: unusedHook,
    useResource: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    usePlan: bindSnapshotSelector(controller.store),
    openPage: (url: string) => {
      opened.push(url)
      return true
    },
    t: (key: keyof typeof en) => en[key],
  }
  return { ...route, controller, writeSettings, opened, injected }
}

describe('ChatGPT plan card', () => {
  it('offers Continue with ChatGPT, opens the authorization page, and adds the openai route once signed in', async () => {
    const authorize = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client'
    const { injected, calls, opened, writeSettings, controller } = harness([
      SIGNED_OUT,
      { ...SIGNED_OUT, pending: true, url: authorize },
      { ...SIGNED_OUT, signedIn: true, email: 'user@example.com', planModels: ['gpt-6.1-sol', 'gpt-6-luna'] },
    ])
    render(<ChatGptPlanFooter {...injected} />)

    expect(await screen.findByText(en.chatGptIntro)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.chatGptContinue }))

    await waitFor(() => { expect(opened).toEqual([authorize]) })
    expect(await screen.findByText('Signed in as user@example.com')).toBeTruthy()
    expect(screen.getByText('Models in your plan: gpt-6.1-sol, gpt-6-luna')).toBeTruthy()
    expect(screen.getByText(en.chatGptConfirmTitle)).toBeTruthy()
    expect(calls.slice(0, 2)).toEqual([`GET ${CHATGPT_PLAN_ROUTE}`, `POST ${CHATGPT_PLAN_ROUTE}?action=start`])
    expect(writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai'], value: {} }])
    expect(screen.getByRole('link', { name: en.chatGptManageUsage }).getAttribute('href')).toBe('https://chatgpt.com/settings/usage')

    fireEvent.click(screen.getByRole('button', { name: en.chatGptConfirmDismiss }))
    expect(screen.queryByText(en.chatGptConfirmTitle)).toBeNull()
    controller.dispose()
  })

  it('never adds the route on a page load that finds an existing sign-in', async () => {
    const { injected, writeSettings, controller } = harness([{ ...SIGNED_OUT, signedIn: true, email: 'user@example.com' }])
    render(<ChatGptPlanFooter {...injected} />)

    expect(await screen.findByText('Signed in as user@example.com')).toBeTruthy()
    expect(screen.getByText(en.chatGptInUse)).toBeTruthy()
    expect(writeSettings).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('warns that an API key on the openai route takes precedence', async () => {
    const { injected, controller } = harness([{ ...SIGNED_OUT, signedIn: true, routeConfigured: true, apiKeyConfigured: true }])
    render(<ChatGptPlanFooter {...injected} />)

    expect(await screen.findByText(en.chatGptApiKeyWins)).toBeTruthy()
    expect(screen.getByText(en.chatGptSignedInNoEmail)).toBeTruthy()
    controller.dispose()
  })

  it('shows a failed attempt and a sign-out OpenAI did not confirm', async () => {
    const { injected, calls, controller } = harness([
      { ...SIGNED_OUT, signedIn: true, email: 'user@example.com' },
      { ...SIGNED_OUT, revocation: 'unconfirmed', error: 'Sign in with ChatGPT: sign-in cancelled' },
    ])
    render(<ChatGptPlanFooter {...injected} />)

    fireEvent.click(await screen.findByRole('button', { name: en.chatGptSignOut }))
    expect(await screen.findByText(en.chatGptRevokeUnconfirmed)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Sign-in did not finish: Sign in with ChatGPT: sign-in cancelled')
    expect(calls[1]).toBe(`POST ${CHATGPT_PLAN_ROUTE}?action=sign-out`)
    controller.dispose()
  })

  it('lets a waiting attempt be cancelled and offers the page as a link', async () => {
    const authorize = 'https://auth.openai.com/api/accounts/authorize?client_id=oaiapp_issued'
    // No poll fires before the cancel, so the second answer is the cancel's.
    const { injected, calls, controller } = harness([{ ...SIGNED_OUT, pending: true, url: authorize }, SIGNED_OUT], undefined, 60_000)
    render(<ChatGptPlanFooter {...injected} />)

    expect((await screen.findByRole('link', { name: en.chatGptOpenPage })).getAttribute('href')).toBe(authorize)
    fireEvent.click(screen.getByRole('button', { name: en.chatGptCancel }))
    expect(await screen.findByRole('button', { name: en.chatGptContinue })).toBeTruthy()
    expect(calls).toContain(`POST ${CHATGPT_PLAN_ROUTE}?action=cancel`)
    controller.dispose()
  })

  it('renders nothing where the Host serves no sign-in route', async () => {
    const { injected, controller } = harness([new Response('not found', { status: 404 })])
    const { container } = render(<ChatGptPlanFooter {...injected} />)

    await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('unavailable') })
    expect(container.textContent).toBe('')
  })

  it('appears in the add-provider card for an unconfigured openai only', async () => {
    const { injected, controller } = harness([SIGNED_OUT])
    const row = { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: false }
    const props = (provider: string, configured: boolean): ChatGptPlanProviderProps => ({
      ...injected,
      provider: { provider, displayName: provider, ...row },
      configured,
      keyConfigured: false,
    })

    const { container, rerender } = render(<ChatGptPlanProviderExtra {...props('anthropic', false)} />)
    expect(container.textContent).toBe('')
    rerender(<ChatGptPlanProviderExtra {...props('openai', true)} />)
    expect(container.textContent).toBe('')
    await act(async () => { await controller.load() })
    rerender(<ChatGptPlanProviderExtra {...props('openai', false)} />)
    expect(await screen.findByRole('button', { name: en.chatGptContinue })).toBeTruthy()
    controller.dispose()
  })
})
