/**
 * Source providers for the screen radar (dsh-movie).
 *
 * Every provider resolves to a flat list of raw candidates and reports its own
 * health, so one unreachable source degrades the list instead of failing the
 * request. Nothing here imports DSH: the pipeline is plain Node.
 *
 * Verified against live endpoints on 2026-10-27 (see research/data-sources.md).
 */

import {
  fetchJson,
  fetchText,
  normalizeTitle,
  parseDate,
  percentileRank,
  stripHtml,
  DEFAULT_UA,
} from './util.js'

/** JustWatch country ↔ content language. CN has no JustWatch locale, so it is absent. */
export const REGION_LANGUAGES = Object.freeze({
  US: 'en',
  GB: 'en',
  AU: 'en',
  CA: 'en',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  IT: 'it',
  JP: 'ja',
  KR: 'ko',
})

/** The subset reached through Douban rather than JustWatch. */
export const DOUBAN_REGION = 'CN'

const DOUBAN_HEADERS = {
  Referer: 'https://m.douban.com/',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
}

/**
 * Resolve JustWatch's poster template into a real image URL.
 * @param {string | null} template @returns {string | null}
 */
export function resolveJustwatchPoster(template) {
  if (!template) return null
  return `https://images.justwatch.com${template
    .replace('{profile}', 's332')
    .replace('{format}', 'jpg')}`
}

/** @param {string} path @param {string} [base] @returns {string} */
export function absoluteUrl(path, base = 'https://www.justwatch.com') {
  if (!path) return base
  return path.startsWith('http') ? path : `${base}${path}`
}

const JW_QUERY = `query Movies($country: Country!, $language: Language!, $first: Int!, $offset: Int!, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, offset: $offset, filter: $filter) {
    totalCount
    edges {
      node {
        id
        objectType
        content(country: $country, language: $language) {
          title
          originalTitle
          originalReleaseYear
          originalReleaseDate
          isReleased
          runtime
          posterUrl
          fullPath
          shortDescription
          genres { shortName }
          productionCountries
          externalIds { tmdbId imdbId }
          scoring { imdbScore imdbVotes tmdbScore tmdbPopularity tomatoMeter jwRating }
        }
      }
    }
  }
}`

/**
 * One JustWatch GraphQL page.
 *
 * @param {string} country
 * @param {'MOVIE'|'SHOW'} objectType
 * @param {number} offset
 * @param {number} first
 * @returns {Promise<any[]>}
 */
async function justwatchPage(country, objectType, offset, first) {
  const body = JSON.stringify({
    query: JW_QUERY,
    variables: {
      country,
      language: REGION_LANGUAGES[country] ?? 'en',
      first,
      offset,
      filter: { objectTypes: [objectType] },
    },
  })
  const payload = await fetchJson('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 14000,
  })
  if (payload.errors?.length) throw new Error(payload.errors[0].message)
  return payload.data?.popularTitles?.edges ?? []
}

/**
 * Discover candidates across the configured JustWatch regions.
 *
 * Popularity ordering means upcoming titles are rare in page 0, so the pages are
 * scanned and the caller's release-date window keeps what matters.
 *
 * @param {{regions: string[], pages: number, pageSize: number}} options
 * @returns {Promise<{items: object[], status: {id: string, ok: boolean, items: number, error?: string}}>}
 */
export async function collectJustwatch({ regions, pages, pageSize }) {
  const items = []
  const failures = []
  const tasks = []
  const reachable = regions.filter((region) => REGION_LANGUAGES[region])

  for (const country of reachable) {
    for (const objectType of ['MOVIE', 'SHOW']) {
      for (let page = 0; page < pages; page += 1) {
        const offset = page * pageSize
        tasks.push(
          justwatchPage(country, objectType, offset, pageSize)
            .then((edges) => {
              for (const edge of edges) {
                const node = edge?.node
                const content = node?.content
                if (!content?.title) continue
                const scoring = content.scoring ?? {}
                items.push({
                  source: 'justwatch',
                  sourceId: `justwatch:${node.id}`,
                  type: node.objectType === 'SHOW' ? 'series' : 'movie',
                  title: content.title,
                  originalTitle: content.originalTitle ?? null,
                  // Localized titles are only useful to a reader of that language;
                  // a Japanese title is noise for a Chinese-language panel.
                  titleLocal: null,
                  year: content.originalReleaseYear ?? null,
                  releaseDate: parseDate(content.originalReleaseDate),
                  poster: resolveJustwatchPoster(content.posterUrl),
                  url: absoluteUrl(content.fullPath),
                  region: country,
                  genres: (content.genres ?? []).map((genre) => genre.shortName).filter(Boolean),
                  countries: content.productionCountries ?? [],
                  runtime: content.runtime ?? null,
                  description: content.shortDescription ?? null,
                  rt: typeof scoring.tomatoMeter === 'number' ? scoring.tomatoMeter : null,
                  imdb: typeof scoring.imdbScore === 'number' ? scoring.imdbScore : null,
                  imdbVotes: typeof scoring.imdbVotes === 'number' ? scoring.imdbVotes : null,
                  heatRaw: typeof scoring.tmdbPopularity === 'number' ? scoring.tmdbPopularity : null,
                  jwRating: typeof scoring.jwRating === 'number' ? scoring.jwRating : null,
                  released: content.isReleased === true,
                  imdbId: content.externalIds?.imdbId ?? null,
                })
              }
            })
            .catch((error) => {
              failures.push(`${country}/${objectType}/${offset}: ${error.message}`)
            }),
        )
      }
    }
  }

  await Promise.all(tasks)
  const ok = items.length > 0
  return {
    items,
    status: {
      id: 'justwatch',
      ok,
      items: items.length,
      error: ok ? undefined : failures[0] ?? 'no data',
    },
  }
}

/**
 * Read one Douban subject collection.
 * @param {string} collection @param {number} count @returns {Promise<any[]>}
 */
async function doubanCollection(collection, count) {
  const payload = await fetchJson(
    `https://m.douban.com/rexxar/api/v2/subject_collection/${collection}/items?start=0&count=${count}`,
    { headers: DOUBAN_HEADERS, timeoutMs: 14000 },
  )
  return payload.subject_collection_items ?? []
}

/**
 * One Douban subject detail page, used to enrich a collection row with a
 * synopsis, exact release date and country list.
 * @param {'movie'|'tv'} kind @param {string} id @returns {Promise<any | null>}
 */
async function doubanSubject(kind, id) {
  try {
    return await fetchJson(`https://m.douban.com/rexxar/api/v2/${kind}/${id}`, {
      headers: DOUBAN_HEADERS,
      timeoutMs: 12000,
    })
  } catch {
    return null
  }
}

/**
 * Douban is the only usable source for mainland-China releases. The collection
 * rows already carry cover, rating, release date and `wish_count`, so enrichment
 * is best-effort.
 *
 * @param {{enrichLimit: number}} options
 * @returns {Promise<{items: object[], status: object}>}
 */
export async function collectDouban({ enrichLimit = 10 }) {
  const items = []
  const specs = [
    { collection: 'movie_showing', count: 40, type: 'movie', hint: 'now' },
    { collection: 'movie_soon', count: 24, type: 'movie', hint: 'upcoming' },
    { collection: 'tv_hot', count: 30, type: 'series', hint: null },
  ]
  const failures = []

  const lists = await Promise.all(
    specs.map(async (spec) => {
      try {
        return { spec, rows: await doubanCollection(spec.collection, spec.count) }
      } catch (error) {
        failures.push(`${spec.collection}: ${error.message}`)
        return { spec, rows: [] }
      }
    }),
  )

  for (const { spec, rows } of lists) {
    const currentYear = new Date().getUTCFullYear()
    rows.forEach((row, index) => {
      if (!row?.title) return
      const year = row.year ? Number(row.year) : null
      // `movie_showing` mixes new releases with classic re-runs; a 1948 title is
      // not what "in theatres this month" means to the reader.
      if (year != null && Number.isFinite(year) && currentYear - year > 2) return
      const mostRecent = parseDate(row.most_recent_release_date) ?? null
      const collectionDate = parseDate(row.release_date, currentYear)
      // Prefer the re-release date, then the collection's month/day in the current year.
      const releaseDate = mostRecent ?? collectionDate
      const rating = typeof row.rating?.value === 'number' && row.rating.value > 0 ? row.rating.value : null
      items.push({
        source: 'douban',
        sourceId: `douban:${row.id}`,
        doubanId: String(row.id),
        doubanKind: spec.type === 'series' ? 'tv' : 'movie',
        type: spec.type,
        title: row.original_title || row.title,
        titleLocal: row.title,
        originalTitle: row.original_title ?? null,
        year: year != null && Number.isFinite(year) ? year : null,
        releaseDate,
        poster: row.cover?.url ?? row.pic?.large ?? null,
        url: row.url ?? (row.id ? `https://movie.douban.com/subject/${row.id}/` : null),
        region: DOUBAN_REGION,
        genres: [],
        description: row.comment ?? row.description ?? null,
        rt: null,
        imdb: null,
        imdbVotes: null,
        heatRaw: typeof row.rating?.count === 'number' ? row.rating.count : null,
        douban: rating,
        doubanCount: typeof row.rating?.count === 'number' ? row.rating.count : null,
        wishCount: typeof row.wish_count === 'number' ? row.wish_count : null,
        chartRank: index,
        statusHint: spec.hint,
        info: row.info ?? row.card_subtitle ?? null,
      })
    })
  }

  // Best-effort enrichment: exact dates and a real synopsis for the head of the list.
  const enrichable = items
    .filter((item) => item.doubanId)
    .slice(0, Math.max(0, enrichLimit))
  await Promise.all(
    enrichable.map(async (item) => {
      const detail = await doubanSubject(item.doubanKind, item.doubanId)
      if (!detail) return
      if (detail.intro) item.description = stripHtml(detail.intro)
      if (Array.isArray(detail.pubdate) && detail.pubdate[0]) item.releaseDate = parseDate(String(detail.pubdate[0]).split('(')[0]) ?? item.releaseDate
      if (Array.isArray(detail.genres)) item.genres = detail.genres
      if (Array.isArray(detail.countries)) item.countries = detail.countries
      if (detail.pic?.large) item.poster = detail.pic.large
      if (typeof detail.rating?.value === 'number' && detail.rating.value > 0) item.douban = detail.rating.value
      if (typeof detail.rating?.count === 'number') item.doubanCount = detail.rating.count
      if (detail.is_released === false) item.released = false
    }),
  )

  const ok = items.length > 0
  return {
    items,
    status: { id: 'douban', ok, items: items.length, error: ok ? undefined : failures[0] ?? 'no data' },
  }
}

/**
 * iTunes storefront charts. The array index is the chart position, which is a
 * usable heat signal and also surfaces pre-orders for unreleased films.
 *
 * @param {{stores: Record<string,string>, zhs: string}} options
 * @returns {Promise<{items: object[], status: object}>}
 */
export async function collectItunes({ stores }) {
  const items = []
  const failures = []
  const tasks = []
  for (const [store, region] of Object.entries(stores)) {
    for (const kind of ['topmovies', 'toptvseasons']) {
      tasks.push(
        fetchJson(`https://itunes.apple.com/${store}/rss/${kind}/limit=25/json`, { timeoutMs: 12000 })
          .then((payload) => {
            const entries = payload?.feed?.entry ?? []
            entries.forEach((entry, index) => {
              const name = entry['im:name']?.label
              if (!name) return
              const images = entry['im:image'] ?? []
              const largest = images[images.length - 1]?.label ?? images[0]?.label ?? null
              const link = Array.isArray(entry.link) ? entry.link[0]?.attributes?.href ?? null : entry.link?.attributes?.href ?? null
              items.push({
                source: 'itunes',
                sourceId: `itunes:${entry.id?.label ?? `${store}:${kind}:${index}`}`,
                type: kind === 'toptvseasons' ? 'series' : 'movie',
                title: name,
                originalTitle: null,
                titleLocal: null,
                year: null,
                releaseDate: parseDate(entry['im:releaseDate']?.label),
                poster: largest ? largest.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null,
                url: link,
                region,
                genres: entry.category?.attributes?.label ? [entry.category.attributes.label] : [],
                description: entry.summary?.label ?? null,
                rt: null,
                imdb: null,
                imdbVotes: null,
                heatRaw: null,
                chartRank: index,
                storeChart: `${store}/${kind}`,
              })
            })
          })
          .catch((error) => failures.push(`${store}/${kind}: ${error.message}`)),
      )
    }
  }

  await Promise.all(tasks)
  const ok = items.length > 0
  return {
    items,
    status: { id: 'itunes', ok, items: items.length, error: ok ? undefined : failures[0] ?? 'no data' },
  }
}

/**
 * TVMaze upcoming web-channel episodes. Sampling a handful of dates inside the
 * window keeps the request count small while still covering the whole period.
 *
 * @param {{days: number[], now: Date, regions: string[]}} options
 * @returns {Promise<{items: object[], status: object}>}
 */
export async function collectTvmaze({ days, now, regions }) {
  const items = []
  const failures = []
  const seen = new Set()
  const wanted = new Set(regions.filter((region) => region !== DOUBAN_REGION))

  await Promise.all(
    days.map(async (offset) => {
      const date = new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10)
      try {
        const episodes = await fetchJson(`https://api.tvmaze.com/schedule/web?date=${date}`, {
          timeoutMs: 12000,
        })
        for (const episode of episodes ?? []) {
          const show = episode?._embedded?.show
          if (!show?.name) continue
          // Only a season premiere marks a show as newly arriving; a mid-season
          // episode of a 1998 reality series is not an "upcoming release".
          if (episode.number !== 1) continue
          const country = show.network?.country?.code ?? show.webChannel?.country?.code ?? null
          if (country && !wanted.has(country)) continue
          if (seen.has(show.id)) continue
          seen.add(show.id)
          items.push({
            source: 'tvmaze',
            sourceId: `tvmaze:${show.id}`,
            type: 'series',
            title: show.name,
            originalTitle: null,
            titleLocal: null,
            year: show.premiered ? Number(String(show.premiered).slice(0, 4)) : null,
            releaseDate: parseDate(episode.airdate),
            poster: show.image?.original ?? show.image?.medium ?? null,
            url: show.url ?? null,
            region: country ?? null,
            genres: show.genres ?? [],
            description: show.summary ? stripHtml(show.summary) : null,
            rt: null,
            imdb: typeof show.rating?.average === 'number' ? show.rating.average : null,
            imdbVotes: null,
            heatRaw: typeof show.weight === 'number' ? show.weight : null,
            imdbId: show.externals?.imdb ?? null,
            statusHint: 'upcoming',
            episode: { season: episode.season, number: episode.number },
          })
        }
      } catch (error) {
        failures.push(`${date}: ${error.message}`)
      }
    }),
  )

  const ok = items.length > 0
  return {
    items,
    status: { id: 'tvmaze', ok, items: items.length, error: ok ? undefined : failures[0] ?? 'no data' },
  }
}

/**
 * Convert a title into a likely Rotten Tomatoes slug.
 * @param {string} title @returns {string[]} candidate slugs, most likely first
 */
export function rottenTomatoeSlugs(title, year) {
  const base = normalizeTitle(title).replace(/^(the|a|an)/, '')
  if (!base) return []
  const underscored = String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const slugs = new Set()
  if (underscored) slugs.add(underscored)
  if (year) slugs.add(`${underscored}_${year}`)
  return [...slugs]
}

/**
 * Read one RT page defensively: a page is accepted only when its canonical URL
 * still names the slug we asked for, because a look-alike title slug otherwise
 * silently yields another film's score.
 *
 * @param {string} html
 * @param {string} requestedSlug
 * @returns {{rt: number, count: number | null, name: string | null} | null}
 */
export function parseRottenTomatoesPage(html, requestedSlug) {
  const canonical =
    /<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i.exec(html)?.[1] ??
    /<meta[^>]*property="og:url"[^>]*content="([^"]+)"/i.exec(html)?.[1] ??
    null
  if (canonical) {
    const path = canonical.replace(/[?#].*$/, '').replace(/\/+$/, '')
    if (!path.endsWith(`/${requestedSlug}`)) return null
  }

  let name = null
  const ld = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  if (ld) {
    try {
      const parsed = JSON.parse(ld)
      if (typeof parsed?.name === 'string') name = parsed.name
    } catch {
      // The scorecard block below is still usable without LD+JSON.
    }
  }

  const direct = /"criticsScore"\s*:\s*\{[^}]*?"score"\s*:\s*"(\d{1,3})"/.exec(html)
  if (direct) {
    const count = /"criticsScore"\s*:\s*\{[^}]*?"reviewCount"\s*:\s*(\d+)/.exec(html)
    return { rt: Number(direct[1]), count: count ? Number(count[1]) : null, name }
  }
  const slot = /slot="critics-score"[^>]*>\s*(\d{1,3})\s*%</.exec(html)
  if (slot) return { rt: Number(slot[1]), count: null, name }
  const percent = /"scorePercent"\s*:\s*"(\d{1,3})%"/.exec(html)
  if (percent) return { rt: Number(percent[1]), count: null, name }
  return null
}

/**
 * Does the scraped page actually describe the candidate?
 * @param {object} item @param {string | null} pageName @returns {boolean}
 */
export function pageMatchesItem(item, pageName) {
  if (!pageName) return false
  const wanted = [item.title, item.originalTitle, item.titleLocal]
    .map((value) => normalizeTitle(value))
    .filter(Boolean)
  const found = normalizeTitle(pageName)
  if (!found) return false
  return wanted.some((value) => value === found || found.startsWith(value) || value.startsWith(found))
}

/**
 * Fill in the Tomatometer for the items that lack one, scraping RT as a last
 * resort. A title whose pages 404 keeps `rt: null` — the UI shows "no critic
 * score" rather than a guess.
 *
 * @param {object[]} items @param {{limit: number, cache: Map<string, number|null>}} options
 * @returns {Promise<object>} source status
 */
export async function enrichRottenTomatoes(items, { limit = 8, cache }) {
  const missing = items.filter((item) => item.rt == null && item.title).slice(0, limit)
  let resolved = 0
  let attempted = 0
  const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }

  for (const item of missing) {
    const kind = item.type === 'series' ? 'tv' : 'm'
    for (const slug of rottenTomatoeSlugs(item.title, item.year)) {
      const cacheKey = `${kind}/${slug}`
      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey)
        if (cached != null) {
          item.rt = cached
          resolved += 1
        }
        break
      }
      attempted += 1
      try {
        const { status, text } = await fetchText(`https://www.rottentomatoes.com/${kind}/${slug}`, {
          headers,
          timeoutMs: 15000,
        })
        if (status !== 200) continue
        const score = parseRottenTomatoesPage(text, slug)
        if (!score || !pageMatchesItem(item, score.name)) {
          // Slug resolved to something else: remember the miss and stop guessing.
          cache.set(cacheKey, null)
          continue
        }
        cache.set(cacheKey, score.rt)
        item.rt = score.rt
        if (score.count != null) item.rtCount = score.count
        resolved += 1
        break
      } catch {
        cache.set(cacheKey, null)
        break
      }
    }
  }

  return {
    id: 'rottentomatoes',
    ok: resolved > 0 || attempted === 0,
    items: resolved,
    error: resolved === 0 && attempted > 0 ? 'no scores resolved' : undefined,
  }
}

/**
 * OMDb lookup, used only when the user supplies a key. It is the authoritative
 * Rotten Tomatoes source for films whose RT page could not be resolved.
 *
 * @param {object[]} items @param {{apiKey: string, limit: number}} options
 * @returns {Promise<object>} source status
 */
export async function enrichOmdb(items, { apiKey, limit = 10 }) {
  if (!apiKey) return { id: 'omdb', ok: true, items: 0, disabled: true }
  const targets = items.filter((item) => item.rt == null && item.title).slice(0, limit)
  let resolved = 0
  for (const item of targets) {
    const query = new URLSearchParams({ apikey: apiKey })
    if (item.imdbId) query.set('i', item.imdbId)
    else {
      query.set('t', item.title)
      if (item.year) query.set('y', String(item.year))
    }
    try {
      const payload = await fetchJson(`https://www.omdbapi.com/?${query.toString()}`, { timeoutMs: 12000 })
      if (payload?.Response === 'False') continue
      const rating = (payload.Ratings ?? []).find((entry) => entry.Source === 'Rotten Tomatoes')
      if (rating?.Value) {
        item.rt = Number(String(rating.Value).replace('%', ''))
        resolved += 1
      }
      if (payload.imdbRating && payload.imdbRating !== 'N/A' && item.imdb == null) {
        item.imdb = Number(payload.imdbRating)
      }
      if (payload.Plot && payload.Plot !== 'N/A' && !item.description) item.description = payload.Plot
    } catch {
      // A single failed lookup must not degrade the whole list.
    }
  }
  return { id: 'omdb', ok: true, items: resolved }
}

/**
 * Normalize heat so mixed scales (TMDB popularity, TVMaze weight, Douban vote
 * counts, chart position) become one comparable 0..1 value.
 *
 * @param {object[]} items @returns {object[]} the same items, mutated in place
 */
export function assignHeat(items) {
  const raw = items.map((item) => item.heatRaw ?? null)
  const present = raw.filter((value) => value != null)
  const scaled = present.length > 0 ? percentileRank(raw.map((value) => value ?? Number.NaN)) : []
  items.forEach((item, index) => {
    const ranked = present.length > 0 ? (scaled[index] ?? 0.5) : 0.5
    const chart = item.chartRank == null ? null : 1 - Math.min(item.chartRank, 30) / 30
    item.heat = clampToUnit(
      0.65 * ranked +
        (chart == null ? 0 : 0.25 * chart) +
        (item.jwRating != null ? 0.1 * item.jwRating : 0),
    )
  })
  return items
}

/** @param {number} value @returns {number} */
function clampToUnit(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export { DEFAULT_UA }
