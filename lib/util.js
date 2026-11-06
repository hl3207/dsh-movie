/**
 * Shared helpers for the host pipeline.
 *
 * Pure functions only: no DSH imports, no module-level state. Everything here is
 * safe to unit-test without a running harness.
 */

/** A browser-like UA. Public endpoints used here reject obviously automated clients. */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Reported for every outbound request so a failing source is attributable. */
export const SOURCE_IDS = Object.freeze([
  'justwatch',
  'douban',
  'itunes',
  'tvmaze',
  'rottentomatoes',
  'omdb',
  'tmdb',
])

/**
 * `fetch` with an abort deadline. Returns text, never throws on HTTP status so
 * callers can decide whether a 404 is fatal for that particular source.
 *
 * @param {string} url absolute URL.
 * @param {{timeoutMs?: number, headers?: Record<string,string>, method?: string, body?: string}} [options]
 * @returns {Promise<{status: number, ok: boolean, text: string}>}
 */
export async function fetchText(url, options = {}) {
  const { timeoutMs = 12000, headers = {}, method = 'GET', body } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      body,
      headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    })
    const text = await response.text()
    return { status: response.status, ok: response.ok, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and parse JSON. Throws on transport or parse failure, which the caller
 * turns into one degraded source rather than a failed request.
 *
 * @param {string} url absolute URL.
 * @param {object} [options] forwarded to {@link fetchText}.
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const { status, text } = await fetchText(url, options)
  if (status >= 400) throw new Error(`HTTP ${status} for ${url}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON from ${url}`)
  }
}

/** @param {number} value @param {number} min @param {number} max @returns {number} */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** @param {number} value @returns {number} clamped to 0..1 */
export function clamp01(value) {
  return clamp(value, 0, 1)
}

/**
 * Lower-cased, accent-free, punctuation-free form used to match one title across
 * sources. CJK characters are kept; everything that is not a letter, digit or
 * CJK ideograph is dropped.
 *
 * @param {string | null | undefined} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (!title) return ''
  return String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '')
}

/**
 * Merge key for one work: the normalized title, preferring the original title so
 * that a localized name in one source still joins its English original in another.
 *
 * @param {{title?: string|null, originalTitle?: string|null}} item
 * @returns {string}
 */
export function mergeKey(item) {
  const original = normalizeTitle(item.originalTitle)
  const plain = normalizeTitle(item.title)
  if (original && plain && original !== plain) return original
  return original || plain
}

/** @param {string | null | undefined} html @returns {string} */
export function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split prose into at most `limit` sentences, treating CJK terminators as well as
 * Latin ones. A trailing fragment without its own terminator still counts.
 *
 * @param {string | null | undefined} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitSentences(text, limit = 3) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const parts = clean
    .split(/(?<=[.!?。！？；;])\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
  return parts.slice(0, limit)
}

/**
 * Parse a calendar date from the shapes the sources emit.
 * Accepts ISO (`2026-11-14`), `2026-11-14T00:00:00Z`, Douban's `11.14` (which the
 * caller resolves against a known year) and empty values.
 *
 * @param {string | null | undefined} value
 * @param {number} [fallbackYear] year used for a `MM.DD` value.
 * @returns {Date | null}
 */
export function parseDate(value, fallbackYear) {
  if (!value) return null
  const text = String(value).trim()
  const monthDay = /^(\d{1,2})[.\-/](\d{1,2})$/.exec(text)
  if (monthDay) {
    const year = fallbackYear ?? new Date().getUTCFullYear()
    const date = new Date(Date.UTC(year, Number(monthDay[1]) - 1, Number(monthDay[2])))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = new Date(text.length === 10 ? `${text}T00:00:00Z` : text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Normalise a date or an already-serialised date string to `YYYY-MM-DD`.
 * The wire contract carries strings, while the pipeline works in `Date`s, so
 * both shapes arrive here; anything unparseable becomes null rather than throwing.
 *
 * @param {Date | string | number | null | undefined} date
 * @returns {string | null}
 */
export function toIsoDate(date) {
  if (date == null || date === '') return null
  if (typeof date === 'string') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  }
  const parsed = date instanceof Date ? date : new Date(date)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

/**
 * Whole days from `from` to `to` (negative when `to` is in the past).
 * @param {Date} from @param {Date} to @returns {number}
 */
export function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

/**
 * Percentile rank of every value in a list, in 0..1. Equal values share the same
 * rank so ties stay ties, and an all-equal list maps to 0.5.
 *
 * @param {number[]} values
 * @returns {number[]}
 */
export function percentileRank(values) {
  const defined = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (defined.length === 0) return values.map(() => 0.5)
  const sorted = [...defined].sort((a, b) => a - b)
  if (sorted[0] === sorted[sorted.length - 1]) return values.map(() => 0.5)
  return values.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
    let below = 0
    while (below < sorted.length && sorted[below] < value) below += 1
    let above = below
    while (above < sorted.length && sorted[above] === value) above += 1
    return clamp01((below + above) / 2 / sorted.length)
  })
}

/**
 * Log-scaled compression for unbounded counters such as popularity and vote
 * counts, so one runaway title cannot flatten the rest of the list.
 *
 * @param {number[]} values @returns {number[]} each in 0..1
 */
export function logScaled(values) {
  const cleaned = values.map((value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.log1p(value) : 0,
  )
  const max = Math.max(...cleaned, 0)
  return cleaned.map((value) => (max > 0 ? clamp01(value / max) : 0))
}

/**
 * Run tasks with a bounded number in flight, preserving input order.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T, index: number) => Promise<R>} run
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, run) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Pick the localized title for a locale from the pair a source provides.
 * @param {string} locale @param {string | null} title @param {string | null} titleLocal
 * @returns {string}
 */
export function pickTitle(locale, title, titleLocal) {
  if (locale === 'zh' && titleLocal) return titleLocal
  return title || titleLocal || ''
}
