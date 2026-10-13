/**
 * Per-Session identity colors. Every Session gets a random palette color the first time it
 * is seen; the user can replace it. The color is published as a CSS custom property per
 * Session on the document root, so other packages (the sidebar rows) read it through
 * `var(--dsh-session-color-<id>)` without importing this module.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const STORAGE_KEY = 'dsh.sessionColors'
const HEX = /^#[0-9a-f]{6}$/iu

/** Distinguishable hues that read on both the light and dark themes. */
export const SESSION_COLOR_PALETTE: readonly string[] = [
  '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
]

/**
 * Name of the CSS custom property that carries a Session's color.
 * The sidebar rows build the same name; keep the two in step.
 * @param sessionId - Session identity.
 * @returns the custom property name, with characters outside `[A-Za-z0-9_-]` replaced by `_`.
 */
export function sessionColorProperty(sessionId: string): string {
  return `--dsh-session-color-${sessionId.replace(/[^\w-]/gu, '_')}`
}

/** Owns the Session → color map, its persistence, and its CSS custom properties. */
export class SessionColors {
  /** Current color per Session id. */
  readonly source = createSnapshotStore<Readonly<Record<string, string>>>({})
  private colors: Record<string, string> = {}

  /**
   * @param root - element that carries the custom properties.
   * @param random - source of values in [0, 1); injectable for tests.
   */
  constructor(private readonly root: HTMLElement, private readonly random: () => number = Math.random) {
    this.colors = readSavedColors()
    for (const [id, color] of Object.entries(this.colors)) this.root.style.setProperty(sessionColorProperty(id), color)
    this.source.set({ ...this.colors })
  }

  /**
   * Give every listed Session without a color a random one, preferring the least used palette entries.
   * @param ids - Sessions that should have a color.
   */
  ensure(ids: readonly SessionId[]): void {
    const missing = ids.filter(id => this.colors[id] === undefined)
    if (missing.length === 0) return
    for (const id of missing) {
      const color = this.pick()
      this.colors[id] = color
      this.root.style.setProperty(sessionColorProperty(id), color)
    }
    this.publish()
  }

  /**
   * Replace a Session's color.
   * @param sessionId - Session to recolor.
   * @param color - `#rrggbb`; anything else is ignored.
   */
  set(sessionId: SessionId, color: string): void {
    if (!HEX.test(color) || this.colors[sessionId] === color) return
    this.colors[sessionId] = color.toLowerCase()
    this.root.style.setProperty(sessionColorProperty(sessionId), this.colors[sessionId])
    this.publish()
  }

  /** Remove the custom properties this instance wrote. */
  dispose(): void {
    for (const id of Object.keys(this.colors)) this.root.style.removeProperty(sessionColorProperty(id))
  }

  private pick(): string {
    const uses = new Map(SESSION_COLOR_PALETTE.map(color => [color, 0]))
    for (const color of Object.values(this.colors)) uses.set(color, (uses.get(color) ?? 0) + 1)
    const least = Math.min(...uses.values())
    const candidates = SESSION_COLOR_PALETTE.filter(color => uses.get(color) === least)
    return candidates[Math.floor(this.random() * candidates.length)] as string
  }

  private publish(): void {
    this.source.set({ ...this.colors })
    writeSavedColors(this.colors)
  }
}

function readSavedColors(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && HEX.test(entry[1])))
  } catch (error: unknown) {
    // Unavailable storage or malformed JSON means no saved colors.
    void error
    return {}
  }
}

function writeSavedColors(colors: Readonly<Record<string, string>>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
  } catch (error: unknown) {
    // Storage may be unavailable or full; colors then only last for this page load.
    void error
  }
}
