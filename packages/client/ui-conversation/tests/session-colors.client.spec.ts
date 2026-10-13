// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SESSION_COLOR_PALETTE, SessionColors, sessionColorProperty } from '../src/client/session-colors.ts'

const STORAGE_KEY = 'dsh.sessionColors'
const id = (value: string): SessionId => value as SessionId

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function bench(random: () => number = () => 0) {
  const root = document.createElement('div')
  const colors = new SessionColors(root, random)
  const read = (session: string): string => root.style.getPropertyValue(sessionColorProperty(session))
  return { root, colors, read, snapshot: () => colors.source.getSnapshot() }
}

describe('sessionColorProperty', () => {
  it('prefixes the id and replaces characters a custom property name cannot carry', () => {
    expect(sessionColorProperty('abc-123_x')).toBe('--dsh-session-color-abc-123_x')
    expect(sessionColorProperty('a.b/c d')).toBe('--dsh-session-color-a_b_c_d')
  })
})

describe('SessionColors', () => {
  it('assigns a palette color to each new Session and publishes it as a custom property', () => {
    const { colors, read, snapshot } = bench()
    colors.ensure([id('s1'), id('s2')])
    expect(SESSION_COLOR_PALETTE).toContain(snapshot().s1)
    expect(read('s1')).toBe(snapshot().s1)
    expect(read('s2')).toBe(snapshot().s2)
  })

  it('keeps an assigned color and does not republish when nothing is missing', () => {
    const { colors, snapshot } = bench()
    colors.ensure([id('s1')])
    const first = snapshot()
    colors.ensure([id('s1')])
    expect(snapshot()).toBe(first)
  })

  it('uses every palette color once before repeating one', () => {
    const { colors, snapshot } = bench(() => 0.999)
    const ids = SESSION_COLOR_PALETTE.map((_color, index) => id(`s${index}`))
    colors.ensure(ids)
    expect(new Set(Object.values(snapshot())).size).toBe(SESSION_COLOR_PALETTE.length)
    colors.ensure([id('extra')])
    expect(SESSION_COLOR_PALETTE).toContain(snapshot().extra)
  })

  it('lets the user choose a color, normalizing case', () => {
    const { colors, read, snapshot } = bench()
    colors.ensure([id('s1')])
    colors.set(id('s1'), '#ABCDEF')
    expect(snapshot().s1).toBe('#abcdef')
    expect(read('s1')).toBe('#abcdef')
  })

  it.each(['red', '#fff', '#12345g', ''])('ignores %j as a color', (value) => {
    const { colors, snapshot } = bench()
    colors.ensure([id('s1')])
    const before = snapshot()
    colors.set(id('s1'), value)
    expect(snapshot()).toBe(before)
  })

  it('ignores choosing the color a Session already has', () => {
    const { colors, snapshot } = bench()
    colors.set(id('s1'), '#123456')
    const before = snapshot()
    colors.set(id('s1'), '#123456')
    expect(snapshot()).toBe(before)
  })

  it('saves colors and restores them, with their custom properties, in a later instance', () => {
    const first = bench()
    first.colors.ensure([id('s1')])
    first.colors.set(id('s2'), '#010203')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(first.snapshot())
    const second = bench()
    expect(second.snapshot()).toEqual(first.snapshot())
    expect(second.read('s2')).toBe('#010203')
  })

  it('removes its custom properties on dispose', () => {
    const { colors, read } = bench()
    colors.ensure([id('s1')])
    colors.dispose()
    expect(read('s1')).toBe('')
  })

  it.each([
    ['malformed JSON', '{nope'],
    ['an array', '["#112233"]'],
    ['a scalar', '5'],
  ])('starts empty from %s', (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw)
    expect(bench().snapshot()).toEqual({})
  })

  it('drops saved entries that are not #rrggbb strings', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ good: '#112233', bad: 'blue', worse: 3 }))
    expect(bench().snapshot()).toEqual({ good: '#112233' })
  })

  it('keeps working when storage rejects writes', () => {
    const { colors, snapshot } = bench()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    colors.ensure([id('s1')])
    expect(SESSION_COLOR_PALETTE).toContain(snapshot().s1)
  })
})
