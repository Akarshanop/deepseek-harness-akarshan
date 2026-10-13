/** Header dot that shows a Session's identity color and lets the user pick another. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { SESSION_COLOR_PALETTE, sessionColorProperty } from '../session-colors.ts'
import css from './SessionColorDot.module.css'

/** Props of the dot and its palette. */
export interface SessionColorDotProps {
  readonly sessionId: string
  /** Current color, or undefined until the Session has been assigned one. */
  readonly color: string | undefined
  readonly onChange: (color: string) => void
  readonly labels: {
    readonly change: string
    readonly custom: string
    /** Accessible name of one palette swatch. */
    readonly option: (color: string) => string
  }
}

/**
 * Render the color dot and, while open, a palette with a custom color input.
 * @param props - Session, its current color, the change callback, and localized labels.
 * @returns the dot control.
 */
export function SessionColorDot({ sessionId, color, onChange, labels }: SessionColorDotProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <span ref={rootRef} className={css.root} data-session-color-dot="">
      <button
        type="button"
        className={css.dot}
        style={{ background: `var(${sessionColorProperty(sessionId)}, transparent)` }}
        aria-label={labels.change}
        aria-expanded={open}
        title={labels.change}
        onClick={() => { setOpen(value => !value) }}
      />
      {open && (
        <div className={css.palette}>
          <div className={css.swatches}>
            {SESSION_COLOR_PALETTE.map(swatch => (
              <button
                key={swatch}
                type="button"
                className={clsx(css.swatch, swatch === color && css.swatchActive)}
                style={{ background: swatch }}
                aria-label={labels.option(swatch)}
                aria-pressed={swatch === color}
                onClick={() => { onChange(swatch); setOpen(false) }}
              />
            ))}
          </div>
          <label className={css.custom}>
            <span>{labels.custom}</span>
            <input
              type="color"
              value={color ?? SESSION_COLOR_PALETTE[0]}
              onChange={(event) => { onChange(event.target.value) }}
            />
          </label>
        </div>
      )}
    </span>
  )
}
