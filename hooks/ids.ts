const REF = 'm\\d{4,}|b[1-9]\\d*'
const BARE = new RegExp(`^(?:${REF})$`)
const AT_END = new RegExp(`\\n<dcp-message-id>(${REF})</dcp-message-id>\\s*$`)
const ALONE = new RegExp(`^<dcp-message-id>(${REF})</dcp-message-id>$`)

/** m + at least 4 digits: m0001, m9999, m10000. */
export function messageRef(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid message number: ${n}`)
  return `m${String(n).padStart(4, '0')}`
}

export function blockRef(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid block number: ${n}`)
  return `b${n}`
}

/** A ref the model typed (any case, padded with space): `block` is set for bN, `number` for mNNNN; null when it is neither or m0000. */
export function parseRef(text: string): { ref: string; block?: number; number?: number } | null {
  const ref = text.trim().toLowerCase()
  if (!BARE.test(ref)) return null
  const n = Number(ref.slice(1))
  if (ref[0] === 'b') return { ref, block: n }
  return n >= 1 && ref === messageRef(n) ? { ref, number: n } : null
}

export const tagLine = (ref: string) => `\n<dcp-message-id>${ref}</dcp-message-id>`

/** The ref of a tag that ends the text, as on a tagged message or block summary. */
export const trailingRef = (text: string): string | null => AT_END.exec(text)?.[1] ?? null

/** The ref of a text that is exactly one tag, as a tool-result context entry is. */
export const loneRef = (text: string): string | null => ALONE.exec(text)?.[1] ?? null
