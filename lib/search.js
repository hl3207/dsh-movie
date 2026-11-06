/**
 * Free-text title search.
 *
 * The board answers "what should I watch"; this answers "tell me about this one
 * thing". A query goes to three keyless sources at once — Douban (Chinese
 * naming, synopsis, genres, score), TVMaze (series truth) and the iTunes
 * storefront search (release dates and artwork) — and their answers are merged
 * into one comparable record per title rather than three separate lists.
 *
 * The merged records reuse the poster pipeline from lib/covers.js, so a search
 * result looks exactly like a board tile: same proxy path, same fallbacks.
 *
 * @module dsh-movie/lib/search
 */
import { doubanDetail, isChinese, toSentences } from './enrich.js'
import { coverPath, normalizePosterUrl } from './covers.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 12000
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 60
const MIN_QUERY_LENGTH = 2
/** How long the whole search may spend fetching synopses before answering. */
const ENRICH_DEADLINE_MS = 4500

const cache = new Map()

async function fetchJson(url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: Object.assign({ 'user-agent': UA, accept: 'application/json,text/plain,*/*' }, headers),
      signal: controller.signal,
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function stripHtml(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** A comparison key: case and punctuation must not split the same title. */
function keyOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\-_:：·・,，.。!！?？'"“”‘’()（）\[\]【】]/g, '')
    .trim()
}

function yearOf(value) {
  const match = String(value ?? '').match(/(19|20)\d{2}/)
  return match ? Number(match[0]) : null
}

/** Does this result answer the query, or is it only related to it? */
function relevance(candidate, query) {
  const wanted = keyOf(query)
  if (wanted === '') return 0
  const keys = [keyOf(candidate.title), keyOf(candidate.originalTitle)].filter(Boolean)
  if (keys.some((key) => key === wanted)) return 100
  if (keys.some((key) => key.startsWith(wanted))) return 70
  if (keys.some((key) => key.includes(wanted))) return 45
  if (keys.some((key) => wanted.includes(key))) return 30
  return 0
}

async function searchDouban(query) {
  // Douban answers a burst of board traffic with an empty body rather than an
  // error, so one empty answer is not "no such title" — it is worth one retry.
  let rows = null
  const backoff = [450, 1300, 2600]
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    const answer = await fetchJson(
      'https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(query),
      { referer: 'https://movie.douban.com/' },
    )
    if (Array.isArray(answer) && answer.length > 0) {
      rows = answer
      break
    }
    if (attempt < backoff.length) await new Promise((resolve) => setTimeout(resolve, backoff[attempt]))
  }
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && (row.id || row.url) && row.title)
    .map((row) => ({
      source: 'douban',
      id: row.id ? String(row.id) : null,
      title: String(row.title),
      originalTitle: row.sub_title ? String(row.sub_title) : null,
      year: row.year ? Number(row.year) : null,
      mediaType: row.type === 'tv' || row.type === 'series' ? 'series' : 'movie',
      cover: row.img ? normalizePosterUrl(String(row.img)) : null,
      url: row.url ? String(row.url) : row.id ? 'https://movie.douban.com/subject/' + row.id + '/' : null,
    }))
}

async function searchItunes(query, media, mediaType) {
  const data = await fetchJson(
    'https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&media=' + media + '&limit=8',
  )
  const rows = data && Array.isArray(data.results) ? data.results : []
  return rows.map((row) => ({
    source: 'itunes',
    id: row.trackId ? String(row.trackId) : null,
    title: String(row.trackName || row.collectionName || ''),
    originalTitle: null,
    year: yearOf(row.releaseDate),
    mediaType: mediaType,
    cover: row.artworkUrl100 ? String(row.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x600bb.') : null,
    url: row.trackViewUrl ? String(row.trackViewUrl) : null,
    synopsis: row.longDescription ? stripHtml(row.longDescription) : null,
    releaseDate: row.releaseDate ? String(row.releaseDate).slice(0, 10) : null,
  }))
}

async function searchTvmaze(query) {
  const rows = await fetchJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(query))
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row && row.show && row.show.name)
    .map((row) => ({
      source: 'tvmaze',
      id: row.show.id ? String(row.show.id) : null,
      title: String(row.show.name),
      originalTitle: null,
      year: yearOf(row.show.premiered),
      mediaType: 'series',
      cover: row.show.image ? normalizePosterUrl(row.show.image.medium || row.show.image.original) : null,
      url: row.show.url ? String(row.show.url) : null,
      synopsis: row.show.summary ? stripHtml(row.show.summary) : null,
      genres: Array.isArray(row.show.genres) ? row.show.genres : [],
      rating: typeof row.show.rating?.average === 'number' ? row.show.rating.average : null,
      network:
        row.show.network?.name ? String(row.show.network.name) : row.show.webChannel?.name ? String(row.show.webChannel.name) : null,
    }))
}

/**
 * One record per title. Douban is the authority on Chinese naming, TVMaze on
 * series data, iTunes on release dates and artwork — each fills what it knows
 * into the first record that owns the title.
 */
function mergeCandidates(lists) {
  const byKey = new Map()
  const ordered = []
  for (const candidate of lists.flat()) {
    if (!candidate || !candidate.title) continue
    const keys = [keyOf(candidate.title), keyOf(candidate.originalTitle)].filter(Boolean)
    const existing = keys.map((key) => byKey.get(key)).find(Boolean)
    if (existing) {
      if (!existing.originalTitle && candidate.originalTitle) existing.originalTitle = candidate.originalTitle
      if (!existing.year && candidate.year) existing.year = candidate.year
      if (!existing.cover && candidate.cover) existing.cover = candidate.cover
      if (!existing.synopsis && candidate.synopsis) existing.synopsis = candidate.synopsis
      if (!existing.url && candidate.url) existing.url = candidate.url
      if (!existing.doubanId && candidate.source === 'douban' && candidate.id) existing.doubanId = candidate.id
      if (!existing.itunesId && candidate.source === 'itunes' && candidate.id) existing.itunesId = candidate.id
      if (!existing.releaseDate && candidate.releaseDate) existing.releaseDate = candidate.releaseDate
      if (candidate.genres && candidate.genres.length > 0 && (!existing.genres || existing.genres.length === 0)) {
        existing.genres = candidate.genres
      }
      if (typeof candidate.rating === 'number' && existing.tvmazeRating == null) existing.tvmazeRating = candidate.rating
      if (candidate.network && !existing.network) existing.network = candidate.network
      existing.sources.add(candidate.source)
      continue
    }
    const record = {
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      mediaType: candidate.mediaType,
      cover: candidate.cover,
      url: candidate.url,
      synopsis: candidate.synopsis,
      genres: candidate.genres || [],
      releaseDate: candidate.releaseDate || null,
      network: candidate.network || null,
      doubanId: candidate.source === 'douban' ? candidate.id : null,
      itunesId: candidate.source === 'itunes' ? candidate.id : null,
      tvmazeRating: candidate.source === 'tvmaze' ? candidate.rating : null,
      sources: new Set([candidate.source]),
    }
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, record)
    ordered.push(record)
  }
  return ordered
}

/** Fill a record from the Douban subject API: synopsis, genres, score, runtime. */
async function enrichFromDouban(record) {
  if (!record.doubanId) return
  const kind = record.mediaType === 'series' ? 'tv' : 'movie'
  const detail = await doubanDetail(kind, record.doubanId)
  if (!detail) return
  if (detail.type === 'tv' || Number(detail.episodes_count) > 0) record.mediaType = 'series'
  else if (detail.type === 'movie') record.mediaType = 'movie'
  if (detail.title) record.title = String(detail.title)
  const original = detail.original_title ? String(detail.original_title) : null
  if (original && keyOf(original) !== keyOf(record.title)) record.originalTitle = original
  if (!record.synopsis && detail.intro) record.synopsis = stripHtml(String(detail.intro))
  if (Array.isArray(detail.genres) && detail.genres.length > 0) record.genres = detail.genres
  if (Array.isArray(detail.countries)) record.countries = detail.countries
  if (Array.isArray(detail.durations) && detail.durations.length > 0) record.durations = detail.durations
  const rating = detail.rating && typeof detail.rating.value === 'number' ? detail.rating.value : null
  if (rating && rating > 0) record.doubanRating = rating
  if (detail.card_subtitle) record.cardSubtitle = String(detail.card_subtitle)
  if (!record.year) record.year = yearOf(detail.release_date) || yearOf(detail.card_subtitle)
  if (!record.url) record.url = 'https://movie.douban.com/subject/' + record.doubanId + '/'
}

/**
 * @param {string} rawQuery
 * @param {{locale?: 'zh'|'en', limit?: number, translate?: (texts: string[], target: string) => Promise<string[]>}} options
 */
export async function searchTitles(rawQuery, options = {}) {
  const query = String(rawQuery ?? '').trim().replace(/\s+/g, ' ')
  const locale = options.locale === 'en' ? 'en' : 'zh'
  const limit = Math.max(1, Math.min(20, options.limit ?? 8))

  if (query.length < MIN_QUERY_LENGTH) {
    return { query, locale, results: [], note: 'too-short', took: 0 }
  }

  const key = locale + '|' + query.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Object.assign({}, hit.payload, { cached: true })
  }

  const started = Date.now()
  const [doubanRows, itunesMovies, itunesShows, tvmazeRows] = await Promise.all([
    searchDouban(query).catch(() => []),
    searchItunes(query, 'movie', 'movie').catch(() => []),
    searchItunes(query, 'tvShow', 'series').catch(() => []),
    searchTvmaze(query).catch(() => []),
  ])

  const merged = mergeCandidates([doubanRows, tvmazeRows, itunesMovies, itunesShows])
  for (const record of merged) record.score = relevance(record, query)

  const relevant = merged
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score || (b.year ?? 0) - (a.year ?? 0))
    .slice(0, Math.max(limit, 6))

  // Douban detail fills synopsis, genres and scores for the strongest few: it is
  // one request per title, so the tail keeps only what the search calls gave.
  const enrichments = Promise.all(relevant.slice(0, 3).map((record) => enrichFromDouban(record).catch(() => {})))
  await Promise.race([enrichments, new Promise((resolve) => setTimeout(resolve, ENRICH_DEADLINE_MS))])

  const results = relevant.slice(0, limit)
  for (const record of results) {
    // No image fetch here: the panel loads posters through /api/cover, which
    // already handles the per-CDN headers and caching. That keeps a search under
    // the enrichment deadline instead of waiting on several hundred kilobytes.
    record.cover = record.cover ? coverPath(normalizePosterUrl(record.cover)) : null
    record.synopsisSentences = record.synopsis ? toSentences(record.synopsis, 3) : []
    delete record.synopsis
    delete record.score
    record.sources = [...record.sources]

    // A Douban record leads with the Chinese name. Readers of the English panel
    // want the Latin title in front, so the pair is swapped, never dropped.
    if (locale === 'en' && isChinese(record.title) && record.originalTitle && !isChinese(record.originalTitle)) {
      const chinese = record.title
      record.title = record.originalTitle
      record.originalTitle = chinese
    }
  }

  if (options.translate) {
    const needsTranslation = (text) => (locale === 'en' ? isChinese(text) : !isChinese(text))
    const synopsisTargets = []
    for (const record of results) {
      for (const sentence of record.synopsisSentences) {
        if (needsTranslation(sentence)) synopsisTargets.push(sentence)
      }
    }
    if (synopsisTargets.length > 0) {
      const translated = await options.translate(synopsisTargets, locale).catch(() => [])
      let cursor = 0
      for (const record of results) {
        record.synopsisSentences = record.synopsisSentences.map((sentence) => {
          if (!needsTranslation(sentence)) return sentence
          const next = translated[cursor]
          cursor += 1
          return typeof next === 'string' && next.trim() !== '' ? next : sentence
        })
        record.translated = true
      }
    }
  }

  const payload = {
    query,
    locale,
    results,
    took: Date.now() - started,
    sources: {
      douban: doubanRows.length,
      tvmaze: tvmazeRows.length,
      itunes: itunesMovies.length + itunesShows.length,
    },
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { at: Date.now(), payload })

  return payload
}

export function clearSearchCache() {
  cache.clear()
}
