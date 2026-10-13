// detectTrigger word-boundary, position, guard-tier, and span behavior.
// URL rule pinned here: '/' is dead when its predecessor is
// another '/' (second slash of '//') or a ':' itself preceded by a
// non-whitespace char (scheme separator) — this is the concrete rule chosen
// to honor "no trigger inside URLs".
import { describe, expect, it } from 'vitest'
import { detectTrigger } from '../src/core/detect.ts'
import type { TriggerGuard } from '../src/types.ts'

const plain: TriggerGuard = { tier: 'plain' }
const claimed: TriggerGuard = { tier: 'claimed' }
const frozen: TriggerGuard = { tier: 'frozen' }

/** Hit at the end of the draft under the plain tier. */
const atEnd = (draft: string, guard: TriggerGuard = plain) => detectTrigger(draft, draft.length, guard)

describe('detectTrigger word boundaries', () => {
  it('triggers at start of draft', () => {
    expect(atEnd('/go')).toMatchObject({ trigger: '/', query: 'go', position: 'leading' })
    expect(atEnd('@wo')).toMatchObject({ trigger: '@', query: 'wo', position: 'leading' })
  })

  it('triggers after whitespace, newline, and punctuation', () => {
    expect(atEnd('say /co')).toMatchObject({ trigger: '/', query: 'co' })
    expect(atEnd('line1\n/go')).toMatchObject({ trigger: '/', query: 'go', position: 'inline' })
    expect(atEnd('see (/go')).toMatchObject({ trigger: '/', query: 'go' })
    expect(atEnd('ping @wo')).toMatchObject({ trigger: '@', query: 'wo' })
  })

  it('does not trigger after a word character', () => {
    expect(atEnd('user@host')).toBeNull()
    expect(atEnd('a/b')).toBeNull()
    expect(atEnd('foo_1@bar')).toBeNull()
  })

  it('does not trigger on URL slashes', () => {
    // Both '//' slashes: first blocked by the ':' rule, second by the '/' rule.
    expect(atEnd('https://example')).toBeNull()
    expect(atEnd('see https://example')).toBeNull()
    // Path slashes deeper in the URL sit after word chars.
    expect(atEnd('https://a.b/c/d')).toBeNull()
    // Single slash after a scheme-like colon (mailto:/, C:/).
    expect(atEnd('C:/path')).toBeNull()
  })

  it('still triggers when a colon is not a scheme separator', () => {
    // ':' preceded by whitespace / at index 0 is ordinary punctuation.
    expect(atEnd('note: /go')).toMatchObject({ trigger: '/', query: 'go' })
    expect(atEnd(':/go')).toMatchObject({ trigger: '/', query: 'go' })
  })

  it('stops the backward scan at whitespace', () => {
    // Space after the token: no trigger at the caret anymore.
    expect(atEnd('/goal x')).toBeNull()
    expect(atEnd('@worker done')).toBeNull()
  })

  it('finds the nearest trigger left of the caret', () => {
    expect(atEnd('/goal @wor')).toMatchObject({ trigger: '@', query: 'wor' })
  })
})

describe('detectTrigger position', () => {
  it('treats a draft whose leading trim (incl. newlines) starts at the token as leading', () => {
    expect(atEnd('\n\n/goal')).toMatchObject({ position: 'leading' })
    expect(atEnd('  \n /goal')).toMatchObject({ position: 'leading' })
  })

  it('treats a token after non-whitespace text as inline', () => {
    expect(atEnd('第一行\n/goal')).toMatchObject({ position: 'inline' })
    expect(atEnd('a /goal')).toMatchObject({ position: 'inline' })
  })
})

describe('detectTrigger guard tiers', () => {
  it('claimed suppresses "/" everywhere but keeps "@"', () => {
    expect(atEnd('/co', claimed)).toBeNull()
    expect(atEnd('args /path', claimed)).toBeNull()
    expect(atEnd('/goal @wor', claimed)).toMatchObject({ trigger: '@', query: 'wor' })
  })

  it('a suppressed "/" is scanned through like an ordinary char', () => {
    // '/x' right of the caret path: scan passes the dead '/' and hits nothing.
    expect(detectTrigger('/goal /x', 8, claimed)).toBeNull()
  })

  it('frozen suppresses both triggers', () => {
    expect(atEnd('/co', frozen)).toBeNull()
    expect(atEnd('@wo', frozen)).toBeNull()
  })
})

describe('detectTrigger span and query', () => {
  it('keeps an open quoted @file token active across spaces', () => {
    const draft = 'read @"docs/design notes'
    expect(atEnd(draft)).toMatchObject({
      trigger: '@',
      query: 'docs/design notes',
      quoted: true,
      position: 'inline',
      span: { start: 5, end: draft.length },
    })
  })

  it('spans trigger char to caret with a placeholder draftRev', () => {
    const hit = detectTrigger('say /goal', 9, plain)
    expect(hit?.span).toEqual({ start: 4, end: 9, draftRev: 0 })
    expect(hit?.query).toBe('goal')
  })

  it('cuts the query at a mid-token caret', () => {
    const hit = detectTrigger('/goal', 3, plain)
    expect(hit).toMatchObject({ query: 'go', span: { start: 0, end: 3 } })
  })

  it('returns null at caret 0 and on empty drafts', () => {
    expect(detectTrigger('', 0, plain)).toBeNull()
    expect(detectTrigger('/goal', 0, plain)).toBeNull()
  })

  it('handles multi-line drafts with the token on a later line', () => {
    const draft = 'first line\nsecond /com'
    const hit = detectTrigger(draft, draft.length, plain)
    expect(hit).toMatchObject({ trigger: '/', query: 'com', position: 'inline', span: { start: 18, end: 22 } })
  })
})

describe('detectTrigger "#"', () => {
  it('opens at the draft start and after whitespace or a newline', () => {
    expect(atEnd('#lec')).toMatchObject({ trigger: '#', query: 'lec', position: 'leading', quoted: false, span: { start: 0, end: 4 } })
    expect(atEnd('use #lec')).toMatchObject({ trigger: '#', query: 'lec', position: 'inline', span: { start: 4, end: 8 } })
    expect(atEnd('first\n#lec')).toMatchObject({ trigger: '#', query: 'lec', position: 'inline' })
    expect(atEnd('#')).toMatchObject({ trigger: '#', query: '' })
  })

  it('stays closed when the hash is glued to text or punctuation', () => {
    // An anchor, a tag, an issue number, a color, and a URL fragment are not session references.
    for (const draft of ['page#anchor', 'fix#12', 'a_b#c', '(#12', 'see (#12', '"#fff', 'x,#y']) {
      expect(atEnd(draft), draft).toBeNull()
    }
    // A later "/" token may still open on its own; the hash never does.
    expect(atEnd('https://x.dev/#/route')).toMatchObject({ trigger: '/', query: 'route' })
  })

  it('is cut off by whitespace after the token', () => {
    expect(atEnd('#lecture done')).toBeNull()
    expect(atEnd('# heading')).toBeNull()
  })

  it('does not take over a slash or at token that follows it', () => {
    expect(atEnd('/goal #lec')).toMatchObject({ trigger: '#', query: 'lec' })
    expect(atEnd('#lec @wor')).toMatchObject({ trigger: '@', query: 'wor' })
    // A hash inside a slash token leaves the slash token in charge.
    expect(atEnd('/open#frag')).toMatchObject({ trigger: '/', query: 'open#frag' })
  })

  it('is live under the plain and claimed tiers and frozen only by the frozen tier', () => {
    expect(atEnd('#lec', claimed)).toMatchObject({ trigger: '#', query: 'lec' })
    expect(atEnd('/goal fix #lec', claimed)).toMatchObject({ trigger: '#', query: 'lec' })
    expect(atEnd('#lec', frozen)).toBeNull()
  })

  it('cuts the query at a mid-token caret', () => {
    expect(detectTrigger('say #lecture', 7, plain)).toMatchObject({ trigger: '#', query: 'le', span: { start: 4, end: 7 } })
  })
})
