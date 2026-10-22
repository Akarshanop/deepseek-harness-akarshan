// Edit and rewind controls of one sent user prompt: the inline editor and
// the confirmation that rewinds files and conversation to before the prompt.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconEditOutlineRegular, IconRefreshOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatRewindAction, ChatRewindPreview, ChatRewindSkipped, ChatViewSlotProps } from '../contract/slots.ts'
import actionCss from './MessageIconActions.module.css'
import css from './PromptRewind.module.css'

type T = ChatViewSlotProps['t']

/** Files listed by name before the rest collapse into a count. */
const LISTED_FILES = 8

/**
 * The edit and rewind icon buttons placed in a user prompt's action row.
 * @param props - the button callbacks and the locale seat.
 * @returns the two buttons.
 */
export function PromptRewindButtons({ onEdit, onRewind, t }: { onEdit: () => void; onRewind: () => void; t: T }): ReactNode {
  return (
    <>
      <Tooltip label={t('message.edit')} side="bottom">
        <button type="button" className={actionCss.action} aria-label={t('message.edit')} onClick={onEdit}>
          <IconEditOutlineRegular />
        </button>
      </Tooltip>
      <Tooltip label={t('message.rewind')} side="bottom">
        <button type="button" className={actionCss.action} aria-label={t('message.rewind')} onClick={onRewind}>
          <IconRefreshOutlineRegular className={css.rewindIcon} />
        </button>
      </Tooltip>
    </>
  )
}

/**
 * Inline editor that replaces a user bubble while its prompt is edited.
 * Enter sends, Shift+Enter breaks the line, Escape cancels.
 * @param props - starting text, the cancel and send callbacks, and the locale seat.
 * @returns the editor.
 */
export function PromptEditor({ initial, onCancel, onSend, t }: {
  initial: string
  onCancel: () => void
  onSend: (text: string) => void
  t: T
}): ReactNode {
  const [text, setText] = useState(initial)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = field.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  const empty = text.trim() === ''
  return (
    <div className={css.editor}>
      <textarea
        ref={field}
        className={css.field}
        aria-label={t('message.edit.label')}
        value={text}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !empty) {
            event.preventDefault()
            onSend(text)
          }
        }}
      />
      <div className={css.editorActions}>
        <Button variant="outline" className={css.button} onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" className={css.button} disabled={empty} onClick={() => { onSend(text) }}>{t('message.edit.send')}</Button>
      </div>
    </div>
  )
}

type PreviewState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; preview: ChatRewindPreview }

type RunState =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'running' }
  | { kind: 'failed' }
  /** Rewound with files left as they are; the forked conversation opens on Continue. */
  | { kind: 'skipped'; sessionId: SessionId; skipped: ChatRewindSkipped[] }

/**
 * Confirmation that rewinds files and conversation to before one prompt,
 * then opens the forked conversation with the prompt sent or ready to edit.
 * @param props - the prompt's turn and text, whether to send it, the rewind face, the close callback, and the locale seat.
 * @returns the dialog.
 */
export function RewindDialog({ turn, prompt, send, rewind, onClose, t }: {
  turn: number
  prompt: string
  send: boolean
  rewind: ChatRewindAction
  onClose: () => void
  t: T
}): ReactNode {
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' })
  const [run, setRun] = useState<RunState>({ kind: 'idle' })
  useEffect(() => {
    const controller = new AbortController()
    rewind.preview(turn, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setPreview({ kind: 'ready', preview: value }) },
      () => { if (!controller.signal.aborted) setPreview({ kind: 'failed' }) },
    )
    return () => { controller.abort() }
  }, [rewind, turn])
  const ready = preview.kind === 'ready' ? preview.preview : undefined
  const blocked = ready === undefined || ready.atSeq === null || ready.running || run.kind === 'running'
  const working = run.kind === 'working'
  const confirm = (): void => {
    if (ready?.atSeq == null || working) return
    setRun({ kind: 'working' })
    rewind.rewind(turn, ready.atSeq).then((outcome) => {
      if (outcome.kind === 'running') {
        setRun({ kind: 'running' })
      } else if (outcome.skipped.length > 0) {
        setRun({ kind: 'skipped', sessionId: outcome.sessionId, skipped: outcome.skipped })
      } else {
        onClose()
        rewind.open(outcome.sessionId, prompt, send)
      }
    }, () => { setRun({ kind: 'failed' }) })
  }
  const footer = run.kind === 'skipped'
    ? (
      <Button
        variant="primary"
        className={css.button}
        data-modal-autofocus=""
        onClick={() => {
          onClose()
          rewind.open(run.sessionId, prompt, send)
        }}
      >
        {t('rewind.continue')}
      </Button>
    )
    : (
      <>
        <Button variant="outline" className={css.button} disabled={working} onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" className={css.button} disabled={blocked || working} data-modal-autofocus="" onClick={confirm}>
          {send ? t('rewind.confirmEdit') : t('rewind.confirm')}
        </Button>
      </>
    )
  return (
    <Modal
      open
      onClose={working ? () => undefined : onClose}
      closeLabel={t('close')}
      title={send ? t('rewind.editTitle') : t('rewind.title')}
      description={t('rewind.description')}
      footer={footer}
    >
      <div className={css.body} data-rewind-dialog="">
        {run.kind === 'skipped'
          ? <FileList heading={t('rewind.skipped')} files={run.skipped.map(item => t(`rewind.skipped.${item.reason}`, { file: item.display }))} t={t} />
          : <PreviewBody preview={preview} t={t} />}
        {(run.kind === 'running' || ready?.running === true) && <p className={css.warning} role="alert">{t('rewind.running')}</p>}
        {run.kind === 'failed' && <p className={css.warning} role="alert">{t('rewind.failed')}</p>}
      </div>
    </Modal>
  )
}

function PreviewBody({ preview, t }: { preview: PreviewState; t: T }): ReactNode {
  if (preview.kind === 'loading') return <p className={css.note}>{t('rewind.loading')}</p>
  if (preview.kind === 'failed') return <p className={css.warning} role="alert">{t('rewind.previewFailed')}</p>
  const { atSeq, files, oversized, incomplete, shellUntracked } = preview.preview
  if (atSeq === null) return <p className={css.warning} role="alert">{t('rewind.unavailable')}</p>
  return (
    <>
      {files.length === 0
        ? <p className={css.note}>{t('rewind.noFiles')}</p>
        : <FileList heading={t(files.length === 1 ? 'rewind.files.one' : 'rewind.files.other', { count: files.length })} files={files} t={t} />}
      {oversized.length > 0 && <p className={css.note}>{t('rewind.oversized', { files: oversized.join(', ') })}</p>}
      {incomplete && <p className={css.note}>{t('rewind.incomplete')}</p>}
      {shellUntracked && <p className={css.note}>{t('rewind.shellUntracked')}</p>}
    </>
  )
}

function FileList({ heading, files, t }: { heading: string; files: readonly string[]; t: T }): ReactNode {
  return (
    <>
      <p className={css.note}>{heading}</p>
      <ul className={css.files}>
        {files.slice(0, LISTED_FILES).map(file => <li key={file} className={css.file}>{file}</li>)}
        {files.length > LISTED_FILES && <li className={css.more}>{t('rewind.more', { count: files.length - LISTED_FILES })}</li>}
      </ul>
    </>
  )
}
