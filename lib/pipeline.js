/**
 * Board pipeline: collect → merge → window → score → describe → rank.
 *
 * The whole recommendation decision lives here so the host tool, the HTTP route
 * and the tests all observe one behaviour. No DSH imports.
 */

import {
  assignHeat,
  collectDouban,
  collectItunes,
  collectJustwatch,
  collectTvmaze,
  enrichOmdb,
  enrichRottenTomatoes,
} from './providers.js'
import {
  clamp01,
  daysBetween,
  logScaled,
  mergeKey,
  percentileRank,
  pickTitle,
  splitSentences,
  toIsoDate,
} from './util.js'

/** JustWatch genre short names plus the full spellings other sources emit. */
/**
 * Genre labels. The SHORT CODES are JustWatch's, verified against real payloads in
 * research/samples: fnt = Fantasy, hst = History, fml = Family, rma = Romance,
 * msc = Music, wsn = Western, trl = Thriller. The older guesses ("fan", "his",
 * "fam", "rom", "wes", "thr") never matched what the source emits — that mismatch
 * is why Fantasy and History used to leak into the copy as raw codes.
 */
const GENRES = {
  act: { en: 'Action', zh: '动作' },
  ani: { en: 'Animation', zh: '动画' },
  bio: { en: 'Biography', zh: '传记' },
  cmy: { en: 'Comedy', zh: '喜剧' },
  crm: { en: 'Crime', zh: '犯罪' },
  doc: { en: 'Documentary', zh: '纪录片' },
  drm: { en: 'Drama', zh: '剧情' },
  fml: { en: 'Family', zh: '家庭' },
  fam: { en: 'Family', zh: '家庭' },
  fnt: { en: 'Fantasy', zh: '奇幻' },
  fan: { en: 'Fantasy', zh: '奇幻' },
  hrr: { en: 'Horror', zh: '恐怖' },
  hst: { en: 'History', zh: '历史' },
  his: { en: 'History', zh: '历史' },
  mis: { en: 'Mystery', zh: '悬疑' },
  mst: { en: 'Mystery', zh: '悬疑' },
  msc: { en: 'Music', zh: '音乐' },
  mus: { en: 'Musical', zh: '歌舞' },
  rma: { en: 'Romance', zh: '爱情' },
  rom: { en: 'Romance', zh: '爱情' },
  scf: { en: 'Sci-Fi', zh: '科幻' },
  sho: { en: 'Short', zh: '短片' },
  spt: { en: 'Sport', zh: '运动' },
  trl: { en: 'Thriller', zh: '惊悚' },
  thr: { en: 'Thriller', zh: '惊悚' },
  war: { en: 'War', zh: '战争' },
  wsn: { en: 'Western', zh: '西部' },
  wes: { en: 'Western', zh: '西部' },
}

/** Full genre spellings (iTunes, TVMaze, Douban) mapped onto the same labels. */
const GENRES_BY_NAME = {
  action: GENRES.act,
  'action & adventure': GENRES.act,
  adventure: { en: 'Adventure', zh: '冒险' },
  animation: GENRES.ani,
  anime: GENRES.ani,
  biography: GENRES.bio,
  comedy: GENRES.cmy,
  crime: GENRES.crm,
  documentary: GENRES.doc,
  drama: GENRES.drm,
  family: GENRES.fam,
  fantasy: GENRES.fan,
  horror: GENRES.hrr,
  history: GENRES.his,
  mystery: GENRES.mis,
  musical: GENRES.mus,
  romance: GENRES.rom,
  'science fiction': GENRES.scf,
  'science-fiction': GENRES.scf,
  'sci-fi': GENRES.scf,
  // The iTunes storefront chart uses compound Apple genre names.
  'sci-fi & fantasy': GENRES.scf,
  'kids & family': GENRES.fam,
  'action & adventure': GENRES.act,
  'mystery & thriller': GENRES.mis,
  'documentary & nonfiction': GENRES.doc,
  short: GENRES.sho,
  sport: GENRES.spt,
  sports: GENRES.spt,
  thriller: GENRES.thr,
  war: GENRES.war,
  western: GENRES.wes,
  kids: GENRES.fam,
  reality: { en: 'Reality', zh: '真人秀' },
  talk: { en: 'Talk Show', zh: '脱口秀' },
  news: { en: 'News', zh: '新闻' },
  'tv film': { en: 'TV Movie', zh: '电视电影' },
  holiday: { en: 'Holiday', zh: '节日' },
  music: GENRES.mus,
  travel: { en: 'Travel', zh: '旅行' },
  food: { en: 'Food', zh: '美食' },
  nature: { en: 'Nature', zh: '自然' },
}

/** iTunes storefront → region label used when no JustWatch region applies. */
const DEFAULT_ITUNES_STORES = {
  us: 'US',
  gb: 'GB',
  de: 'DE',
  fr: 'FR',
  jp: 'JP',
  kr: 'KR',
}

/**
 * @param {string[]} codes @param {'en'|'zh'} locale @returns {string[]}
 */
function genreLabels(codes, locale) {
  const labels = []
  for (const code of codes ?? []) {
    if (!code) continue
    const key = String(code).trim().toLowerCase()
    const entry = GENRES[key] ?? GENRES_BY_NAME[key]
    if (entry) {
      const label = entry[locale] ?? entry.en
      if (!labels.includes(label)) labels.push(label)
    } else if (!/^[a-z]{2,4}$/.test(key)) {
      // A readable name we simply do not know yet — keep it. A short lowercase
      // token is an unmapped source CODE ("fnt", "hst"); printing that into a
      // sentence is worse than leaving the genre out.
      if (!labels.includes(code)) labels.push(code)
    }
  }
  return labels
}

/** @param {string} text @returns {boolean} true when the text is meaningfully Chinese. */
function isChinese(text) {
  if (!text) return false
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  return cjk > 0 && cjk >= latin / 3
}

/**
 * Merge candidates that describe the same work, preferring the richer record.
 * Score fields are combined field-by-field so a Douban rating survives a merge
 * with a JustWatch row that only knows popularity.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
export function mergeCandidates(items) {
  const groups = new Map()
  for (const item of items) {
    const key = mergeKey(item)
    if (!key) continue
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { ...item, aliases: new Set(item.aliases ?? []) })
      continue
    }
    existing.aliases.add(item.source)
    const merged = existing
    for (const field of [
      'poster',
      'url',
      'description',
      'rt',
      'rtCount',
      'douban',
      'doubanCount',
      'imdb',
      'imdbVotes',
      'heatRaw',
      'wishCount',
      'jwRating',
    ]) {
      const incoming = item[field]
      if (incoming == null) continue
      const current = merged[field]
      if (current == null) merged[field] = incoming
      else if (field === 'heatRaw' && typeof incoming === 'number' && typeof current === 'number') {
        merged[field] = Math.max(current, incoming)
      } else if (field === 'poster' && String(current).length < String(incoming).length) {
        merged[field] = incoming
      }
    }
    if (!merged.titleLocal && item.titleLocal) merged.titleLocal = item.titleLocal
    if (!merged.originalTitle && item.originalTitle) merged.originalTitle = item.originalTitle
    if (!merged.year && item.year) merged.year = item.year
    if (!merged.releaseDate && item.releaseDate) merged.releaseDate = item.releaseDate
    if (!merged.region && item.region) merged.region = item.region
    if (!merged.rt && item.rt) merged.rt = item.rt
    if (merged.genres.length === 0 && item.genres.length > 0) merged.genres = item.genres
    if (merged.chartRank == null && item.chartRank != null) merged.chartRank = item.chartRank
    if (!merged.statusHint && item.statusHint) merged.statusHint = item.statusHint
    merged.sources = [...new Set([...(merged.sources ?? [merged.source]), item.source])]
  }
  return [...groups.values()].map((item) => ({
    ...item,
    sources: [...new Set([...(item.sources ?? []), item.source])],
  }))
}

/**
 * Decide whether a work is in the "now" bucket or the "upcoming" window, and
 * drop anything outside both.
 *
 * @param {object} item @param {{now: Date, lookbackDays: number, upcomingDays: number}} options
 * @returns {'now' | 'upcoming' | null}
 */
export function windowStatus(item, { now, lookbackDays, upcomingDays }) {
  if (!item.releaseDate) {
    if (item.statusHint === 'now' || item.statusHint === 'upcoming') return item.statusHint
    return null
  }
  const delta = daysBetween(now, item.releaseDate)
  if (delta > upcomingDays) return null
  if (delta >= 0) return 'upcoming'
  if (delta >= -lookbackDays) return 'now'
  return null
}

/**
 * Anticipation: strongest for unreleased works with evidence of pre-release
 * interest (Douban "want to watch" counts, pre-order chart presence, pre-release
 * vote volume), and explicitly weak for something already out.
 *
 * @param {object} item @param {'now'|'upcoming'} status
 * @param {{now: Date, wishRanks: number[], voteRanks: number[], index: number, upcomingDays: number}} context
 * @returns {number} 0..1
 */
function anticipationScore(item, status, context) {
  if (status === 'now') return 0.15 + 0.15 * (item.heat ?? 0)
  const wish = context.wishRanks[context.index] ?? 0
  const votes = context.voteRanks[context.index] ?? 0
  const preorder = item.statusHint === 'upcoming' ? 0.15 : item.chartRank != null ? 0.2 : 0
  const distance =
    item.releaseDate == null
      ? 0.1
      : clamp01(1 - Math.max(0, daysBetween(context.now, item.releaseDate)) / Math.max(1, context.upcomingDays)) * 0.25
  return clamp01(0.35 * (item.heat ?? 0) + 0.3 * wish + 0.2 * votes + preorder + distance)
}

/**
 * Score, order and rank the merged candidates.
 *
 * Each metric contributes only when it exists, and the total is damped by how much
 * of the weight the item could actually be judged on, so a title with no critic
 * score cannot outrank a fully-scored one purely by omission.
 *
 * @param {object[]} items
 * @param {{weights: {heat: number, rt: number, douban: number, anticipation: number}, now: Date, upcomingDays: number}} options
 * @returns {object[]}
 */
export function scoreAndRank(items, { weights, now, upcomingDays }) {
  const wishRanks = percentileRank(items.map((item) => (item.wishCount == null ? Number.NaN : item.wishCount)))
  const voteRanks = percentileRank(items.map((item) => (item.imdbVotes == null ? Number.NaN : item.imdbVotes)))
  const rtPresent = items.some((item) => item.rt != null)

  const scored = items.map((item, index) => {
    const status = item.status
    const anticipation = anticipationScore(item, status, { now, wishRanks, voteRanks, index, upcomingDays })
    // Without a Tomatometer, an IMDb rating stands in at a discount: enough to
    // sink a badly received title, never enough to impersonate a critic score.
    const critic =
      item.rt != null
        ? { value: item.rt / 100, weight: weights.rt }
        : item.imdb != null
          ? { value: clamp01((item.imdb - 3) / 7), weight: weights.rt * 0.6 }
          : { value: null, weight: weights.rt }
    const metrics = {
      heat: { value: item.heat ?? 0.5, weight: weights.heat },
      rt: critic,
      douban: { value: item.douban == null ? null : item.douban / 10, weight: weights.douban },
      anticipation: { value: anticipation, weight: weights.anticipation },
    }
    let weighted = 0
    let available = 0
    let total = 0
    for (const metric of Object.values(metrics)) {
      total += metric.weight
      if (metric.value == null) continue
      weighted += metric.weight * clamp01(metric.value)
      available += metric.weight
    }
    const coverage = total > 0 ? available / total : 0
    const base = available > 0 ? weighted / available : 0
    // Damp rather than punish: 60% floor keeps a partially-scored title competitive.
    const composite = clamp01(base * (0.6 + 0.4 * coverage))
    return {
      ...item,
      status,
      rt: item.rt ?? null,
      douban: item.douban ?? null,
      scores: {
        rt: { value: item.rt ?? null, count: item.rtCount ?? null },
        douban: { value: item.douban ?? null, count: item.doubanCount ?? null },
        heat: { value: Number((item.heat ?? 0.5).toFixed(3)) },
        anticipation: { value: Number(anticipation.toFixed(3)) },
      },
      composite: Number(composite.toFixed(4)),
      coverage: Number(coverage.toFixed(2)),
    }
  })

  // A list where no source supplied a critic score should not lean on that axis.
  if (!rtPresent) for (const item of scored) item.coverage = Math.min(item.coverage, 0.99)

  scored.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite
    return (b.heat ?? 0) - (a.heat ?? 0)
  })
  return scored
}

/**
 * Build the three-sentence introduction.
 *
 * Source prose is used only when it is already in the reader's language.
 * Otherwise the sentences are composed from the structured fields, which keep
 * the copy factual and correctly localized without a translation service.
 *
 * @param {object} item @param {'en'|'zh'} locale
 * @returns {string[]}
 */
export function buildIntro(item, locale) {
  const zh = locale === 'zh'
  const title = pickTitle(locale, item.title, item.titleLocal)
  const kindWord = item.type === 'series' ? (zh ? '剧集' : 'series') : zh ? '电影' : 'film'
  const genres = genreLabels(item.genres, locale)
  const sentences = []

  if (item.description && isChinese(item.description) === zh) {
    sentences.push(...splitSentences(item.description, 2))
  }

  if (sentences.length === 0) {
    const yearText = item.year ? (zh ? `${item.year} 年的` : `${item.year} `) : ''
    const genreText = genres.length > 0 ? (zh ? `，类型为${genres.slice(0, 3).join('、')}` : ` in ${genres.slice(0, 3).join(', ')}`) : ''
    sentences.push(
      zh
        ? `《${title}》是一部${yearText}${kindWord}${genreText}。`
        : `"${title}" is ${/^[aeiou]/i.test(kindWord) ? 'an' : 'a'} ${yearText}${kindWord}${genreText}.`,
    )
  }

  const praise = []
  if (item.rt != null) praise.push(zh ? `烂番茄新鲜度 ${item.rt}%` : `${item.rt}% on Rotten Tomatoes`)
  if (item.douban != null) praise.push(zh ? `豆瓣 ${item.douban} 分` : `${item.douban}/10 on Douban`)
  if (praise.length === 0 && item.imdb != null) praise.push(zh ? `IMDb ${item.imdb} 分` : `${item.imdb}/10 on IMDb`)
  if (praise.length > 0 && sentences.length < 2) {
    sentences.push(zh ? `口碑方面，${praise.join('，')}。` : `Reception: ${praise.join(' and ')}.`)
  }

  if (sentences.length < 3) {
    const date = toIsoDate(item.releaseDate)
    const where = item.region ? (zh ? `（${item.region}）` : ` (${item.region})`) : ''
    if (item.status === 'upcoming') {
      sentences.push(
        zh
          ? `将于 ${date ?? '近期'} 上映或播出${where}，属于接下来一个月内值得留意的档期。`
          : `It arrives ${date ? `on ${date}` : 'in the next few weeks'}${where}, inside the next month's release calendar.`,
      )
    } else {
      sentences.push(
        zh
          ? `目前正在上映或播出${where}，适合现在就看。`
          : `It is out now${where}, so it is ready to watch today.`,
      )
    }
  }

  if (sentences.length < 3 && item.doubanCount) {
    sentences.push(
      zh
        ? `豆瓣已有 ${item.doubanCount} 人评分，讨论度仍在上升。`
        : `${item.doubanCount} Douban users have rated it, and the conversation is still growing.`,
    )
  }
  if (sentences.length < 3) {
    sentences.push(zh ? '综合热度与口碑，它在本期榜单中排名靠前。' : 'Heat and reception together put it near the top of this list.')
  }

  return sentences.slice(0, 3)
}

/**
 * Shape one scored candidate into the wire contract the sidebar consumes.
 *
 * @param {object} item @param {'en'|'zh'} locale @param {number} rank
 * @returns {object}
 */
export function toWireItem(item, locale, rank) {
  return {
    id: item.sourceId ?? `${item.source}:${mergeKey(item)}`,
    type: item.type === 'series' ? 'series' : 'movie',
    title: item.title ?? pickTitle(locale, item.title, item.titleLocal),
    titleLocal: item.titleLocal ?? null,
    originalTitle: item.originalTitle ?? null,
    year: item.year ?? null,
    releaseDate: toIsoDate(item.releaseDate),
    status: item.status,
    region: item.region ?? null,
    poster: item.poster ?? null,
    url: item.url ?? null,
    intro: buildIntro(item, locale),
    // Both languages are composed here, while the raw score fields still exist:
    // the serialised item exposes them under `scores` and cannot rebuild them.
    intros: { zh: buildIntro(item, 'zh'), en: buildIntro(item, 'en') },
    genres: genreLabels(item.genres, locale),
    sources: item.sources ?? [item.source],
    scores: item.scores,
    composite: item.composite,
    rank,
    // --- dsh-movie local extension -------------------------------------------
    // The Host enrichment step (lib/enrich.js) needs the raw per-source ids and
    // the two scores the merge kept off `scores`, so one board row can be tied
    // back to its Douban subject, its TVMaze show or its iTunes track.
    imdb: typeof item.imdb === 'number' ? item.imdb : null,
    jwRating: typeof item.jwRating === 'number' ? item.jwRating : null,
    refs: {
      sourceId: item.sourceId ?? null,
      douban: item.doubanId
        ? { id: String(item.doubanId), kind: item.doubanKind ?? (item.type === 'series' ? 'tv' : 'movie') }
        : null,
    },
  }
}

/**
 * Keep a ranked list useful rather than monotonous: neither one media type nor
 * one release status may take over the panel. Excess entries are demoted, not
 * dropped, so a short candidate pool still fills the list.
 *
 * @param {object[]} items already sorted best-first
 * @param {{limit: number, maxTypeShare?: number, maxStatusShare?: number}} options
 * @returns {object[]}
 */
export function diversify(items, { limit, maxTypeShare = 0.6, maxStatusShare = 0.7 }) {
  const typeCap = Math.max(1, Math.ceil(limit * maxTypeShare))
  const statusCap = Math.max(1, Math.ceil(limit * maxStatusShare))
  const picked = []
  const overflow = []
  const byType = new Map()
  const byStatus = new Map()

  for (const item of items) {
    if (picked.length >= limit) break
    const typeCount = byType.get(item.type) ?? 0
    const statusCount = byStatus.get(item.status) ?? 0
    if (typeCount >= typeCap || statusCount >= statusCap) {
      overflow.push(item)
      continue
    }
    picked.push(item)
    byType.set(item.type, typeCount + 1)
    byStatus.set(item.status, statusCount + 1)
  }

  for (const item of overflow) {
    if (picked.length >= limit) break
    picked.push(item)
  }

  // Restore descending composite order across the merged result.
  return picked.sort((a, b) => b.composite - a.composite).slice(0, limit)
}

/** @param {string} locale @returns {'en'|'zh'} */
export function normalizeLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Resolve the effective "today" in UTC midnight, so day windows are stable
 * across timezones within one refresh.
 * @param {Date} [date] @returns {Date}
 */
export function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * Run the whole pipeline once.
 *
 * @param {object} options
 * @param {object} options.config resolved plugin config
 * @param {string} [options.locale] requested locale (`auto` follows config)
 * @param {Date} [options.now] injectable clock for tests
 * @param {number} [options.limit] override for the result count
 * @param {boolean} [options.refresh] bypass the cache
 * @param {Map<string, number|null>} [options.rtCache] shared RT slug cache
 * @returns {Promise<{ok: boolean, generatedAt: string, locale: string, items: object[], sourceStatus: object[], cached: boolean}>}
 */
export async function buildRecommendations({
  config,
  locale,
  now = new Date(),
  limit,
  rtCache = new Map(),
  logger = () => {},
}) {
  const effectiveLocale = normalizeLocale(locale && locale !== 'auto' ? locale : config.language)
  const today = startOfUtcDay(now)
  const regions = Array.isArray(config.regions) && config.regions.length > 0 ? config.regions : ['US', 'GB', 'DE', 'FR', 'JP', 'KR']
  const includeSeries = config.includeSeries !== false
  const pageSize = 100
  const scanPages = Math.max(1, Math.min(Number(config.scanPages) || 2, 8))

  const sourceStatus = []
  const collected = []

  const tasks = [
    collectJustwatch({ regions, pages: scanPages, pageSize }).then((result) => {
      sourceStatus.push(result.status)
      if (includeSeries) collected.push(...result.items)
      else collected.push(...result.items.filter((item) => item.type !== 'series'))
    }),
  ]

  if (config.doubanEnabled !== false) {
    tasks.push(
      collectDouban({ enrichLimit: Number(config.doubanEnrichLimit) || 8 }).then((result) => {
        sourceStatus.push(result.status)
        collected.push(...result.items.filter((item) => includeSeries || item.type !== 'series'))
      }),
    )
  }

  tasks.push(
    collectItunes({ stores: DEFAULT_ITUNES_STORES }).then((result) => {
      sourceStatus.push(result.status)
      collected.push(...result.items.filter((item) => includeSeries || item.type !== 'series'))
    }),
  )

  if (includeSeries) {
    const days = [1, 3, 7, 10, 14, 21, Math.max(2, Math.min(Number(config.upcomingDays) || 30, 30))]
    tasks.push(
      collectTvmaze({ days, now: today, regions }).then((result) => {
        sourceStatus.push(result.status)
        collected.push(...result.items)
      }),
    )
  }

  await Promise.all(tasks.map((task) => task.catch(() => undefined)))
  logger(`dsh-movie: collected ${collected.length} raw candidates`)

  // Window first so normalization and percentiles run over the real candidate set.
  const windowed = []
  for (const item of collected) {
    const status = windowStatus(item, {
      now: today,
      lookbackDays: Math.max(1, Number(config.lookbackDays) || 14),
      upcomingDays: Math.max(1, Number(config.upcomingDays) || 30),
    })
    if (!status) continue
    windowed.push({ ...item, status, genres: item.genres ?? [] })
  }

  const merged = mergeCandidates(windowed)
  assignHeat(merged)

  // Rotten Tomatoes: JustWatch usually has it; scrape only what is missing.
  const rtStatus = await enrichRottenTomatoes(merged, { limit: Number(config.rtScrapeLimit) || 6, cache: rtCache })
  sourceStatus.push(rtStatus)

  if (config.omdbApiKey) {
    sourceStatus.push(await enrichOmdb(merged, { apiKey: config.omdbApiKey, limit: 8 }))
  }

  const weights = {
    heat: Number(config.weights?.heat ?? 0.3),
    rt: Number(config.weights?.rt ?? 0.25),
    douban: Number(config.weights?.douban ?? 0.25),
    anticipation: Number(config.weights?.anticipation ?? 0.2),
  }
  const scored = scoreAndRank(merged, {
    weights,
    now: today,
    upcomingDays: Math.max(1, Number(config.upcomingDays) || 30),
  })

  const max = Math.max(1, Math.min(Number(limit) || Number(config.limit) || 20, 60))
  const balanced = diversify(scored, { limit: max })
  const items = balanced.map((item, index) => toWireItem(item, effectiveLocale, index + 1))

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    locale: effectiveLocale,
    items,
    sourceStatus: sourceStatus.filter(Boolean),
    cached: false,
    total: scored.length,
  }
}
