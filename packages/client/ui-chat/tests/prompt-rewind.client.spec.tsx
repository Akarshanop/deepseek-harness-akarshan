// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNodeViewProps, ChatRewindAction, ChatRewindOutcome, ChatRewindPreview } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { en } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
})

const t: ChatNodeViewProps['t'] = makeTranslate(en, commonEn)
const CHILD = 'session-child' as SessionId

const ready: ChatRewindPreview = {
  atSeq: 7, running: false, files: ['a.txt', 'src/b.ts'], oversized: [], incomplete: false, shellUntracked: false,
}

function stubRewind(preview: Partial<ChatRewindPreview> = {}, outcome: ChatRewindOutcome = { kind: 'rewound', sessionId: CHILD, skipped: [] }) {
  return {
    preview: vi.fn(async () => ({ ...ready, ...preview })),
    rewind: vi.fn(async () => outcome),
    open: vi.fn(),
  } satisfies ChatRewindAction
}

/** The declared return type keeps the props a spreadable object; assigning `never` to a union-typed const would narrow it to `never`. */
function promptProps(node: ChatConversationViewNode, rewind: ChatRewindAction): ChatNodeViewProps<'user' | 'steering'> {
  return {
    node, t, rewind, renderMessageImages: () => null, openFile: vi.fn(), openSkill: vi.fn(),
  } as never
}

function renderPrompt(rewind: ChatRewindAction, kind: 'user' | 'steering' = 'user') {
  const turn = { turn: 3 }
  const node: ChatConversationViewNode = {
    key: `fixture:${kind}:5`, kind, id: '5', target: 'chat', anchorSeq: 5, visibility: 'visible',
    location: { kind: 'step', turn, step: { step: 1 } },
    data: { kind, seq: 5, time: 1_000, content: [{ type: 'text', text: 'fix the bug' }], source: null },
  } as never
  return render(<UserMessageNodeView {...promptProps(node, rewind)} />)
}

describe('prompt rewind', () => {
  it('rewinds after confirmation and opens the new conversation with the prompt ready to edit', async () => {
    const rewind = stubRewind()
    renderPrompt(rewind)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    expect(screen.getByRole('dialog', { name: 'Rewind to this prompt?' })).toBeTruthy()
    expect(await screen.findByText('2 files will be restored:')).toBeTruthy()
    expect(screen.getByText('src/b.ts')).toBeTruthy()
    expect(rewind.preview).toHaveBeenCalledWith(3, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    await waitFor(() => { expect(rewind.open).toHaveBeenCalledWith(CHILD, 'fix the bug', false) })
    expect(rewind.rewind).toHaveBeenCalledWith(3, 7)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits the prompt inline and sends the edited text after confirmation', async () => {
    const rewind = stubRewind()
    renderPrompt(rewind)
    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt' }))
    const field = screen.getByRole('textbox', { name: 'Edited prompt' })
    fireEvent.change(field, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.change(field, { target: { value: 'fix the other bug' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Rewind and send the edited prompt?' })).toBeTruthy()
    await screen.findByText('2 files will be restored:')
    fireEvent.click(screen.getByRole('button', { name: 'Rewind and send' }))
    await waitFor(() => { expect(rewind.open).toHaveBeenCalledWith(CHILD, 'fix the other bug', true) })
  })

  it('cancels editing with Escape and restores the bubble', () => {
    renderPrompt(stubRewind())
    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('fix the bug')).toBeTruthy()
  })

  it('refuses while a turn runs and explains the gaps in what can be restored', async () => {
    const rewind = stubRewind({ running: true, files: [], oversized: ['big.bin'], incomplete: true, shellUntracked: true })
    renderPrompt(rewind)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    expect(await screen.findByText('A response is still running. Stop it before rewinding.')).toBeTruthy()
    expect(screen.getByText('No recorded file changes to restore.')).toBeTruthy()
    expect(screen.getByText(/big\.bin/)).toBeTruthy()
    expect(screen.getByText(/before the server last restarted/)).toBeTruthy()
    expect(screen.getByText(/shell commands/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rewind' })).toHaveProperty('disabled', true)
  })

  it('reports files left as they are before opening the new conversation', async () => {
    const rewind = stubRewind({}, { kind: 'rewound', sessionId: CHILD, skipped: [{ display: 'big.bin', reason: 'oversized' }] })
    renderPrompt(rewind)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    await screen.findByText('2 files will be restored:')
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(await screen.findByText('big.bin (too large)')).toBeTruthy()
    expect(rewind.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open new conversation' }))
    expect(rewind.open).toHaveBeenCalledWith(CHILD, 'fix the bug', false)
  })

  it('shows a turn that started meanwhile, a failed rewind, and an unreadable preview', async () => {
    const running = stubRewind({}, { kind: 'running' })
    renderPrompt(running)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    await screen.findByText('2 files will be restored:')
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(await screen.findByText('A response is still running. Stop it before rewinding.')).toBeTruthy()
    cleanup()

    const failing = stubRewind()
    failing.rewind.mockRejectedValueOnce(new Error('fork failed'))
    renderPrompt(failing)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    await screen.findByText('2 files will be restored:')
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(await screen.findByText(/The rewind didn’t finish/)).toBeTruthy()
    expect(failing.open).not.toHaveBeenCalled()
    cleanup()

    const unreadable = stubRewind()
    unreadable.preview.mockRejectedValueOnce(new Error('offline'))
    renderPrompt(unreadable)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    expect(await screen.findByText('Couldn’t check which files would be restored.')).toBeTruthy()
    cleanup()

    const uncut = stubRewind({ atSeq: null })
    renderPrompt(uncut)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to this prompt' }))
    expect(await screen.findByText('This prompt can’t be rewound.')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no edit or rewind on a steering message', () => {
    renderPrompt(stubRewind(), 'steering')
    expect(screen.queryByRole('button', { name: 'Rewind to this prompt' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit prompt' })).toBeNull()
  })
})
