/**
 * Enrichment for dsh-movie.
 *
 * The ranking pipeline (./pipeline.js) decides WHICH titles make the board. This
 * module turns each ranked row into something a reader can act on:
 *
 *   - a real synopsis instead of a template sentence,
 *   - a handful of popular comments,
 *   - the title in both languages, so the panel can lead with the reader's
 *     language and keep the original as the secondary line,
 *   - and a translation of everything into the language the reader picked.
 *
 * Endpoints verified live on 2026-11-03 from this machine:
 *   m.douban.com/rexxar/v2/{movie|tv}/<id>                  → intro, genres, countries
 *   m.douban.com/rexxar/v2/{movie|tv}/<id>/interests?order_by=hot → comments
 *   movie.douban.com/j/subject_suggest?q=<title>            → id + zh title + original title
 *   api.tvmaze.com/shows/<id>                               → English summary
 *   itunes.apple.com/lookup?id=<id>                         → longDescription
 *
 * Translation runs through the Host `llm` service with the session's own
 * default model: the anonymous HTTP translators (google/bing) are not reachable
 * from this network, while the configured model route always is. Every failure
 * degrades to the source text and is counted, never thrown.
 */

import { fetchJson, mapLimit, splitSentences, stripHtml } from './util.js'

const DOUBAN_HEADERS = {
  Referer: 'https://m.douban.com/',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
}

const DOUBAN_API = 'https://m.douban.com/rexxar/api/v2'
const SUGGEST_API = 'https://movie.douban.com/j/subject_suggest'
const TVMAZE_API = 'https://api.tvmaze.com'

/** A synopsis longer than this is cut; the panel never shows a wall of text. */
const MAX_SYNOPSIS_CHARS = 420
/** The brief is explicit: never more than five sentences of synopsis. */
const MAX_SYNOPSIS_SENTENCES = 5

/** @param {string} text @returns {boolean} */
export function isChinese(text) {
  if (!text) return false
  const han = String(text).match(/[\u4e00-\u9fff]/g)
  if (!han) return false
  return han.length >= Math.min(2, String(text).trim().length)
}

/** @param {string} text @param {number} [max] @returns {string[]} */
export function toSentences(text, max = MAX_SYNOPSIS_SENTENCES) {
  const clean = stripHtml(String(text ?? '')).replace(/\s+/g, ' ').trim()
  if (!clean) return []
  let sentences = splitSentences(clean, max)
  // Chinese paragraphs rarely end in '.', so a single over-long "sentence" is
  // re-split on 。！？ before giving up.
  if (sentences.length === 1 && sentences[0].length > MAX_SYNOPSIS_CHARS) {
    sentences = sentences[0]
      .split(/(?<=[。！？!?])/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, max)
  }
  return sentences.slice(0, max).map((line) => (line.length > MAX_SYNOPSIS_CHARS ? `${line.slice(0, MAX_SYNOPSIS_CHARS)}…` : line))
}

/**
 * Find the Douban subject behind a title that was discovered on another source.
 * This is what makes one board out of six sources: JustWatch knows the poster and
 * the score, Douban knows the Chinese title, the synopsis and the comments.
 *
 * @param {string} title @param {number | null} year @param {'movie'|'tv'} kind
 * @returns {Promise<{id: string, title: string, subTitle: string|null, year: number|null} | null>}
 */
export async function doubanSuggest(title, year, kind) {
  if (!title) return null
  let rows
  try {
    rows = await fetchJson(`${SUGGEST_API}?q=${encodeURIComponent(title)}`, {
      headers: DOUBAN_HEADERS,
      timeoutMs: 10000,
    })
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const wanted = String(title).trim().toLowerCase()
  const scored = []
  for (const row of rows) {
    if (!row?.id || !row?.title) continue
    const rowType = row.type === 'tv' || row.type === 'series' ? 'tv' : 'movie'
    if (kind && rowType !== kind) continue
    const rowYear = row.year ? Number(row.year) : null
    let score = 0
    const name = String(row.title).trim().toLowerCase()
    const sub = String(row.sub_title ?? '').trim().toLowerCase()
    if (name === wanted || sub === wanted) score += 10
    else if (sub && (sub.includes(wanted) || wanted.includes(sub))) score += 5
    else if (name.includes(wanted) || wanted.includes(name)) score += 3
    if (year && rowYear && Math.abs(rowYear - year) <= 1) score += 4
    if (score > 0) scored.push({ score, row, rowYear })
  }
  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  return {
    id: String(best.row.id),
    title: String(best.row.title),
    subTitle: best.row.sub_title ? String(best.row.sub_title) : null,
    year: best.rowYear,
  }
}

/**
 * @param {'movie'|'tv'} kind @param {string} id
 * @returns {Promise<object | null>}
 */
export async function doubanDetail(kind, id) {
  try {
    return await fetchJson(`${DOUBAN_API}/${kind}/${id}`, { headers: DOUBAN_HEADERS, timeoutMs: 12000 })
  } catch {
    return null
  }
}

/**
 * Popular comments ("短评"), best first.
 * @param {'movie'|'tv'} kind @param {string} id @param {number} count
 * @returns {Promise<Array<{text: string, author: string, stars: number|null, votes: number|null}>>}
 */
export async function doubanComments(kind, id, count = 3) {
  let payload
  try {
    payload = await fetchJson(`${DOUBAN_API}/${kind}/${id}/interests?count=${Math.max(count, 1) * 2}&order_by=hot`, {
      headers: DOUBAN_HEADERS,
      timeoutMs: 12000,
    })
  } catch {
    return []
  }
  const rows = payload?.interests ?? []
  const out = []
  for (const row of rows) {
    const text = stripHtml(String(row?.comment ?? '')).replace(/\s+/g, ' ').trim()
    if (text.length < 4) continue
    out.push({
      text,
      author: String(row?.user?.name ?? '').trim() || null,
      stars: typeof row?.rating?.value === 'number' ? row.rating.value : null,
      votes: typeof row?.vote_count === 'number' ? row.vote_count : null,
    })
    if (out.length >= count) break
  }
  return out
}

/**
 * TVMaze carries a real English summary, which is the best English synopsis a
 * keyless source offers.
 * @param {string} showId @returns {Promise<object | null>}
 */
export async function tvmazeShow(showId) {
  try {
    return await fetchJson(`${TVMAZE_API}/shows/${encodeURIComponent(showId)}`, { timeoutMs: 12000 })
  } catch {
    return null
  }
}

/**
 * iTunes lookup by track id. `longDescription` is a full English synopsis.
 * @param {string} trackId @param {string} country @returns {Promise<object | null>}
 */
export async function itunesLookup(trackId, country = 'us') {
  try {
    const payload = await fetchJson(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(trackId)}&country=${encodeURIComponent(country.toLowerCase())}`,
      { timeoutMs: 12000 },
    )
    return payload?.results?.[0] ?? null
  } catch {
    return null
  }
}

/** Pull the numeric id out of a provider's `sourceId` (`tvmaze:1234`). */
function sourceRef(sourceId) {
  const match = /^([a-z]+):(.+)$/i.exec(String(sourceId ?? ''))
  return match ? { source: match[1].toLowerCase(), id: match[2] } : null
}

/**
 * Collect the raw, source-language material for one ranked row.
 *
 * @param {object} item a wire item from the pipeline (carries `refs`)
 * @param {object} options
 * @returns {Promise<object>} the enrichment fragment
 */
async function enrichOne(item, { commentLimit, doubanEnabled }) {
  const fragment = { titleZh: null, titleOriginal: null, synopsis: null, comments: [], extra: null }
  const kind = item.type === 'series' ? 'tv' : 'movie'
  const ref = sourceRef(item.refs?.sourceId)
  const originalTitle = item.originalTitle ?? null

  let doubanId = item.refs?.douban?.id ?? null
  let doubanKind = item.refs?.douban?.kind ?? kind

  if (!doubanId && doubanEnabled) {
    const found = await doubanSuggest(originalTitle ?? item.title, item.year ?? null, kind)
    if (found) {
      doubanId = found.id
      doubanKind = kind
      fragment.titleZh = found.title
      if (found.subTitle) fragment.titleOriginal = found.subTitle
    }
  }

  const tasks = []

  if (doubanId) {
    tasks.push(
      doubanDetail(doubanKind, doubanId).then((detail) => {
        if (!detail) return
        fragment.titleZh = detail.title ? String(detail.title) : fragment.titleZh
        const detailOriginal = detail.original_title ? String(detail.original_title) : null
        if (detailOriginal && !isChinese(detailOriginal)) fragment.titleOriginal = detailOriginal
        if (detail.intro) fragment.synopsis = stripHtml(String(detail.intro)).replace(/\s+/g, ' ').trim()
        fragment.extra = {
          genres: Array.isArray(detail.genres) ? detail.genres : [],
          countries: Array.isArray(detail.countries) ? detail.countries : [],
          durations: Array.isArray(detail.durations) ? detail.durations : [],
          cardSubtitle: detail.card_subtitle ?? null,
          lang: 'zh',
        }
      }),
    )
    if (commentLimit > 0) {
      tasks.push(
        doubanComments(doubanKind, doubanId, commentLimit).then((comments) => {
          fragment.comments = comments
        }),
      )
    }
  }

  // English material, so an English board does not depend on translation alone.
  if (ref?.source === 'tvmaze') {
    tasks.push(
      tvmazeShow(ref.id).then((show) => {
        if (!show) return
        if (!fragment.synopsis && show.summary) {
          fragment.synopsis = stripHtml(String(show.summary)).replace(/\s+/g, ' ').trim()
          fragment.extra = { ...(fragment.extra ?? {}), lang: 'en', genres: show.genres ?? [] }
        }
        if (!fragment.titleOriginal && show.name) fragment.titleOriginal = String(show.name)
      }),
    )
  } else if (ref?.source === 'itunes') {
    const country = String(item.region ?? 'US').toLowerCase()
    tasks.push(
      itunesLookup(ref.id, ['us', 'gb', 'jp', 'kr', 'de', 'fr', 'es', 'it', 'cn'].includes(country) ? country : 'us').then(
        (row) => {
          if (!row) return
          const text = row.longDescription ?? row.description ?? null
          if (!fragment.synopsis && text) {
            fragment.synopsis = stripHtml(String(text)).replace(/\s+/g, ' ').trim()
            fragment.extra = { ...(fragment.extra ?? {}), lang: 'en' }
          }
          if (!fragment.titleOriginal && row.trackName) fragment.titleOriginal = String(row.trackName)
        },
      ),
    )
  }

  await Promise.all(tasks)
  return fragment
}

/**
 * Compose a description from what is actually known, for titles with no fetched
 * synopsis. It is generated text, so it follows the board language directly and
 * never needs translating.
 *
 * @param {object} item @param {'zh'|'en'} locale @returns {string}
 */
export function composeDescription(item, locale) {
  const zh = locale === 'zh'
  const type = item.mediaType === 'series' ? (zh ? '剧集' : 'series') : zh ? '电影' : 'film'
  const date = item.releaseDate ? String(item.releaseDate) : null
  const where = item.region ? String(item.region) : null
  const localizedGenres = Array.isArray(item.genres) ? localizeGenres(item.genres, locale) : []
  const genres = localizedGenres.length > 0 ? localizedGenres.join(zh ? '、' : ', ') : null
  const parts = []
  if (zh) {
    parts.push(`${item.title} 是一部${item.year ? `${item.year} 年的` : ''}${type}${genres ? `，类型为${genres}` : ''}。`)
    if (date) {
      parts.push(
        item.releaseStatus === 'now'
          ? `影片目前正在${where ? `${where} ` : ''}上映，值得进影院一看。`
          : `已定档 ${date}${where ? `（${where}）` : ''}，是接下来一个月里值得留意的档期。`,
      )
    }
    parts.push(zhGenrePitch(genres))
  } else {
    parts.push(`A${item.year ? ` ${item.year}` : ''} ${type}${genres ? ` in ${genres}` : ''}.`)
    if (date) {
      parts.push(
        item.releaseStatus === 'now'
          ? `It is in cinemas${where ? ` in ${where}` : ''} right now.`
          : `It opens on ${date}${where ? ` in ${where}` : ''}, inside the next month.`,
      )
    }
    parts.push(enGenrePitch(genres))
  }
  return parts.filter(Boolean).join(zh ? '' : ' ')
}

function zhGenrePitch(genres) {
  if (!genres) return '想看口碑还是想看热闹，它都能对上号。'
  if (/动画|奇幻/.test(genres)) return '奇幻与动画的取向，适合大银幕上的想象力。'
  if (/恐怖|惊悚/.test(genres)) return '惊悚取向，适合喜欢被剧情拽着走的观众。'
  if (/喜剧/.test(genres)) return '喜剧底色，是想轻松一场时的稳妥选择。'
  if (/动作|冒险/.test(genres)) return '动作与冒险撑起的节奏，适合想看爽感的晚上。'
  return '偏作者表达的类型，适合慢慢看、慢慢想。'
}

function enGenrePitch(genres) {
  if (!genres) return 'Worth a look whether you follow reviews or just want a night out.'
  if (/Animation|Fantasy/i.test(genres)) return 'Fantasy and animation made for a big screen.'
  if (/Horror|Thriller/i.test(genres)) return 'A thriller that wants to pull you along by the plot.'
  if (/Comedy/i.test(genres)) return 'A comedy, and a safe pick when you want an easy night.'
  if (/Action|Adventure/i.test(genres)) return 'Action and adventure, built for momentum.'
  return 'More of an authored piece, best taken slowly.'
}

/**
 * Collect every string that has to reach the reader, translate the ones that do
 * not already match the target language, and write the result back.
 *
 * @param {object[]} rows assembled board rows (mutated in place)
 * @param {'zh'|'en'} locale
 * @param {{translate: ((texts: string[], target: string) => Promise<(string|null)[]>) | null}} deps
 * @returns {Promise<{translated: number, failed: number, enabled: boolean}>}
 */
export async function localizeRows(rows, locale, { translate }) {
  const translateCalls = []
  for (const row of rows) {
    // The reader's language leads the title; the source title becomes secondary.
    if (needsTranslation(row.title, locale)) translateCalls.push({ row, kind: 'title', text: row.title })
    for (const sentence of row.synopsisSentences) {
      if (needsTranslation(sentence, locale)) translateCalls.push({ row, kind: 'synopsis', text: sentence })
    }
    for (const comment of row.commentRows) {
      if (needsTranslation(comment.text, locale)) translateCalls.push({ row, kind: 'comment', text: comment.text, comment })
    }
  }
  if (!translate || translateCalls.length === 0) {
    return { translated: 0, failed: 0, enabled: Boolean(translate) }
  }

  const unique = [...new Set(translateCalls.map((call) => call.text))]
  let results = []
  try {
    results = await translate(unique, locale)
  } catch {
    return { translated: 0, failed: unique.length, enabled: true }
  }
  const byText = new Map()
  unique.forEach((text, index) => byText.set(text, results[index] ?? null))

  let translated = 0
  let failed = 0
  for (const call of translateCalls) {
    const value = byText.get(call.text)
    if (!value) {
      failed += 1
      continue
    }
    translated += 1
    call.row.translatedAny = true
    if (call.kind === 'title') {
      // A title is a name: keep the machine rendering only when it stays title
      // shaped, otherwise the source title remains the one the reader sees.
      if (acceptTitle(value, locale)) {
        if (!call.row.originalTitle) call.row.originalTitle = call.row.title
        call.row.title = value
      }
    } else if (call.kind === 'synopsis') {
      call.row.synopsisSentences[call.row.synopsisSentences.indexOf(call.text)] = value
    } else if (call.comment) {
      call.comment.text = value
      call.comment.translated = true
    }
  }
  // A generated description names the title it was composed from; now that the
  // title is translated, keep the two consistent.
  for (const call of translateCalls) {
    if (call.kind !== 'title') continue
    const before = call.text
    const after = call.row.title
    if (!before || !after || before === after) continue
    call.row.synopsisSentences = call.row.synopsisSentences.map((sentence) =>
      sentence.startsWith(before) ? after + sentence.slice(before.length) : sentence,
    )
  }
  return { translated, failed, enabled: true }
}

/**
 * Whether a translated title still reads like a title.
 * @param {string} candidate @param {'zh'|'en'} locale
 * @returns {boolean}
 */
function acceptTitle(candidate, locale) {
  const value = String(candidate ?? '').trim()
  if (!value) return false
  if (locale === 'en') return value.split(/\s+/).length <= 5 && value.length <= 40
  return value.replace(/\s+/g, '').length <= 14
}

/** @param {string} text @param {'zh'|'en'} locale */
function needsTranslation(text, locale) {
  if (!text) return false
  return locale === 'zh' ? !isChinese(text) : isChinese(text)
}

/**
 * Enrich a ranked wire-item list into board rows.
 *
 * @param {object[]} items wire items, best first
 * @param {object} options
 * @param {'zh'|'en'} options.locale board language
 * @param {number} options.enrichLimit how many rows get a real synopsis
 * @param {number} options.commentLimit popular comments per row
 * @param {boolean} options.doubanEnabled
 * @param {boolean} options.translateEnabled
 * @param {((texts: string[], target: string) => Promise<(string|null)[]>) | null} options.translate
 * @param {object[]} options.sourceStatus provider health rows to extend
 * @param {(message: string) => void} [options.logger]
 * @returns {Promise<{rows: object[], translation: object}>}
 */
export async function enrichItems(
  items,
  { locale, enrichLimit, commentLimit, doubanEnabled, translate, logger = () => {} },
) {
  const limit = Math.max(0, Math.min(Number(enrichLimit) || 0, items.length))
  const fragments = await mapLimit(items.slice(0, limit), 4, (item) => enrichOne(item, { commentLimit, doubanEnabled }))

  const rows = items.map((item, index) => {
    const fragment = index < limit ? fragments[index] ?? null : null
    const zhTitle = firstChinese(fragment?.titleZh, item.titleLocal, item.title)
    const originalTitle =
      firstNonChinese(fragment?.titleOriginal, fragment?.titleZh && isChinese(fragment.titleZh) ? null : null) ??
      firstNonChinese(item.originalTitle, item.titleLocal, item.title)

    const primary = locale === 'zh' ? zhTitle ?? originalTitle ?? item.title : originalTitle ?? zhTitle ?? item.title
    const secondaryCandidate = locale === 'zh' ? originalTitle ?? null : zhTitle ?? null
    const secondary = secondaryCandidate && secondaryCandidate !== primary ? secondaryCandidate : null

    let synopsisSentences =
      fragment?.synopsis && fragment.synopsis.length > 8 ? toSentences(fragment.synopsis) : []
    if (synopsisSentences.length === 0) {
      synopsisSentences = toSentences(
        composeDescription(
          { ...item, title: primary, genres: fragment?.extra?.genres?.length ? fragment.extra.genres : item.genres },
          locale,
        ),
      )
    }

    const commentRows = (fragment?.comments ?? []).slice(0, Math.max(0, commentLimit)).map((comment) => ({
      text: comment.text,
      author: comment.author ?? null,
      stars: comment.stars ?? null,
      translated: false,
    }))

    const genres =
      fragment?.extra?.genres?.length > 0
        ? localizeGenres(fragment.extra.genres, locale)
        : Array.isArray(item.genres)
          ? item.genres
          : []

    return {
      id: item.id,
      rank: item.rank,
      composite: Math.round((item.composite ?? 0) * 100),
      title: primary,
      originalTitle: secondary,
      cover: item.poster ?? null,
      url: item.url ?? null,
      mediaType: item.mediaType === 'series' ? 'series' : 'movie',
      releaseStatus: item.releaseStatus ?? 'upcoming',
      releaseDate: item.releaseDate ?? null,
      region: item.region ?? null,
      genres,
      metrics: pickMetrics(item),
      synopsisSentences,
      commentRows,
      sources: item.sources ?? [],
      hasRealSynopsis: Boolean(fragment?.synopsis && fragment.synopsis.length > 8),
      runtime: fragment?.extra?.durations?.[0] ?? null,
    }
  })

  const translation = await localizeRows(rows, locale, { translate })

  logger(
    `dsh-movie: enriched ${limit} rows, ${translation.translated} strings translated, ${translation.failed} failed`,
  )

  return {
    rows: rows.map((row) => ({
      id: row.id,
      rank: row.rank,
      composite: row.composite,
      title: row.title,
      originalTitle: row.originalTitle,
      cover: row.cover,
      url: row.url,
      mediaType: row.mediaType,
      releaseStatus: row.releaseStatus,
      releaseDate: row.releaseDate,
      region: row.region,
      genres: row.genres,
      metrics: row.metrics,
      synopsis: row.synopsisSentences,
      comments: row.commentRows,
      translated: row.translatedAny === true,
      sources: row.sources,
    })),
    translation,
  }
}

/** @param {object} item @returns {Record<string, number>} */
function pickMetrics(item) {
  const scores = item.scores ?? {}
  const metrics = {}
  if (typeof scores.douban?.value === 'number') metrics.douban = Math.round(scores.douban.value * 10) / 10
  if (typeof scores.rt?.value === 'number') metrics.rottenTomatoes = Math.round(scores.rt.value)
  const imdb = item.imdbRaw ?? scores.rt?.imdb
  if (typeof imdb === 'number') metrics.imdb = Math.round(imdb * 10) / 10
  metrics.buzz = Math.round((scores.heat?.value ?? 0) * 100)
  if (typeof scores.anticipation?.value === 'number') metrics.anticipation = Math.round(scores.anticipation.value * 100)
  return metrics
}

/** Douban already emits Chinese genre labels; map the English ones for the zh panel. */
const GENRE_ZH = {
  Action: '动作',
  'Action & Adventure': '动作冒险',
  Adventure: '冒险',
  Biography: '传记',
  Espionage: '谍战',
  'Game-Show': '真人秀',
  Kids: '儿童',
  Musical: '歌舞',
  News: '新闻',
  Reality: '真人秀',
  'Reality-TV': '真人秀',
  Short: '短片',
  Talk: '脱口秀',
  'Talk-Show': '脱口秀',
  'TV Movie': '电视电影',
  'War & Politics': '战争政治',
  Animation: '动画',
  Comedy: '喜剧',
  Crime: '犯罪',
  Documentary: '纪录',
  Drama: '剧情',
  Family: '家庭',
  Fantasy: '奇幻',
  History: '历史',
  Horror: '恐怖',
  Music: '音乐',
  Mystery: '悬疑',
  Romance: '爱情',
  'Science-Fiction': '科幻',
  'Sci-Fi': '科幻',
  Sport: '运动',
  Thriller: '惊悚',
  War: '战争',
  Western: '西部',
}

/** @param {string[]} genres @param {'zh'|'en'} locale @returns {string[]} */
function localizeGenres(genres, locale) {
  const out = []
  for (const genre of genres) {
    const value = String(genre ?? '').trim()
    if (!value) continue
    const label = locale === 'zh' ? GENRE_ZH[value] ?? value : value
    if (!out.includes(label)) out.push(label)
  }
  return out.slice(0, 3)
}

function firstChinese(...values) {
  for (const value of values) if (value && isChinese(value)) return String(value)
  return null
}

function firstNonChinese(...values) {
  for (const value of values) if (value && !isChinese(value)) return String(value)
  return null
}
