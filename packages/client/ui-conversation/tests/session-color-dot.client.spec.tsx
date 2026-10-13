// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionColorDot } from '../src/client/skeleton/SessionColorDot.tsx'
import { SESSION_COLOR_PALETTE } from '../src/client/session-colors.ts'

afterEach(cleanup)

const labels = {
  change: 'Change color',
  custom: 'Custom',
  option: (color: string) => `Color ${color}`,
}

function setup(color: string | undefined) {
  const onChange = vi.fn()
  const ui = render(<SessionColorDot sessionId="s.1" color={color} onChange={onChange} labels={labels} />)
  return { ui, onChange, dot: screen.getByLabelText('Change color') }
}

describe('SessionColorDot', () => {
  it('paints the dot from the Session custom property', () => {
    const { dot } = setup(SESSION_COLOR_PALETTE[2])
    expect(dot.style.background).toContain('--dsh-session-color-s_1')
  })

  it('opens the palette on click and marks the current color', () => {
    const { dot } = setup(SESSION_COLOR_PALETTE[2])
    expect(screen.queryByText('Custom')).toBeNull()
    fireEvent.click(dot)
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(screen.getByLabelText(labels.option(SESSION_COLOR_PALETTE[2]!)).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(SESSION_COLOR_PALETTE.length - 1)
  })

  it('picks a swatch and closes', () => {
    const { dot, onChange } = setup(SESSION_COLOR_PALETTE[2])
    fireEvent.click(dot)
    fireEvent.click(screen.getByLabelText(labels.option(SESSION_COLOR_PALETTE[5]!)))
    expect(onChange).toHaveBeenCalledWith(SESSION_COLOR_PALETTE[5])
    expect(screen.queryByText('Custom')).toBeNull()
  })

  it('reports a custom color and stays open', () => {
    const { dot, onChange } = setup(SESSION_COLOR_PALETTE[2])
    fireEvent.click(dot)
    const input = screen.getByText('Custom').closest('label')!.querySelector('input')!
    fireEvent.change(input, { target: { value: '#123456' } })
    expect(onChange).toHaveBeenCalledWith('#123456')
    expect(screen.getByText('Custom')).toBeTruthy()
  })

  it('offers the first palette color in the custom input before a color exists', () => {
    const { dot } = setup(undefined)
    fireEvent.click(dot)
    expect(screen.getByText('Custom').closest('label')!.querySelector('input')!.value).toBe(SESSION_COLOR_PALETTE[0])
  })

  it('closes on an outside press or Escape, not on an inside press', () => {
    const { dot } = setup(SESSION_COLOR_PALETTE[2])
    fireEvent.click(dot)
    fireEvent.pointerDown(screen.getByText('Custom'))
    expect(screen.getByText('Custom')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('Custom')).toBeNull()
    fireEvent.click(dot)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByText('Custom')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Custom')).toBeNull()
  })

  it('toggles from the dot', () => {
    const { dot } = setup(SESSION_COLOR_PALETTE[2])
    fireEvent.click(dot)
    expect(dot.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(dot)
    expect(dot.getAttribute('aria-expanded')).toBe('false')
  })
})
