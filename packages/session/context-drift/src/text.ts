/**
 * Deterministic text features for the drift fold: salient keywords for topic
 * comparison and correction matching. Pure functions of their inputs.
 *
 * @module @deepseek-ai/dsh-context-drift/text
 */

/**
 * English function words and conversational filler that carry no topic. The
 * list is part of the keyword extractor's definition, not a deployment choice.
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'also', 'always', 'another', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'cannot', 'could', 'does', 'doing', 'done', 'down', 'each', 'even', 'every', 'from', 'further',
  'give', 'going', 'good', 'great', 'have', 'having', 'here', 'into', 'itself', 'just', 'know', 'like', 'look',
  'make', 'many', 'maybe', 'more', 'most', 'much', 'must', 'need', 'next', 'nice', 'okay', 'once', 'only', 'other',
  'over', 'please', 'really', 'right', 'same', 'should', 'show', 'some', 'something', 'still', 'such', 'sure',
  'take', 'tell', 'than', 'thank', 'thanks', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'think', 'this', 'those', 'through', 'under', 'until', 'very', 'want', 'well', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'would', 'yeah', 'your', 'yours',
])

/** Runs of Han, kana, and Hangul characters, which are keyed by character bigrams. */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯]+/gu

/** Latin keyword candidates: identifiers, dotted names, and slash paths. */
const WORD = /[a-z0-9_][a-z0-9_./-]*[a-z0-9_]/gu

/** Minimum Latin keyword length. */
const MIN_WORD_LENGTH = 4

/**
 * Extract the distinct salient keywords of a text in first-seen order.
 * Latin words of at least four characters that are not stopwords or plain
 * numbers count; a slash path also contributes its final segment; CJK runs
 * contribute their character bigrams (a single character counts alone).
 * @param text - raw message or tool-argument text.
 * @returns distinct lowercase keywords.
 */
export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase()
  const keywords = new Set<string>()
  for (const match of lower.matchAll(WORD)) {
    const word = match[0]
    addWord(keywords, word)
    if (word.includes('/')) addWord(keywords, word.slice(word.lastIndexOf('/') + 1))
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    // Code points are the unit here: CJK keywords are character bigrams, and these ranges hold no combining sequences.
    const run = match[0].match(/./gsu) ?? []
    if (run.length === 1) keywords.add(match[0])
    for (let index = 1; index < run.length; index++) keywords.add(`${run[index - 1] ?? ''}${run[index] ?? ''}`)
  }
  return [...keywords]
}

function addWord(keywords: Set<string>, word: string): void {
  if (word.length < MIN_WORD_LENGTH || STOPWORDS.has(word) || /^[0-9._/-]+$/u.test(word)) return
  keywords.add(word)
}

/**
 * Report whether a human message reads as a correction of the previous reply.
 * @param text - the human message text.
 * @param patterns - compiled correction patterns.
 * @returns whether any pattern matches.
 */
export function isCorrection(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

/**
 * Merge keywords into a topic set, keeping the newest `max` entries.
 * @param topic - current topic keywords, oldest first.
 * @param added - keywords to add; ones already present move to the newest end.
 * @param max - retained keyword cap.
 * @returns the merged keyword list, oldest first; `topic` itself when nothing changes.
 */
export function mergeKeywords(topic: readonly string[], added: readonly string[], max: number): readonly string[] {
  if (added.length === 0) return topic
  const addedSet = new Set(added)
  const merged = [...topic.filter(keyword => !addedSet.has(keyword)), ...addedSet]
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/**
 * Fraction of a message's keywords already present in the topic.
 * @param keywords - the message keywords (non-empty).
 * @param topic - current topic keywords.
 * @returns overlap in [0, 1].
 */
export function keywordOverlap(keywords: readonly string[], topic: readonly string[]): number {
  const topicSet = new Set(topic)
  let shared = 0
  for (const keyword of keywords) if (topicSet.has(keyword)) shared++
  return shared / keywords.length
}
