/**
 * Poster resolution and delivery.
 *
 * Two problems are solved here, both observed on a real board:
 *
 *  1. Douban's image CDN answers `418 I'm a teapot` to any request without a
 *     `Referer`, so every Douban poster came back blank in the panel. The
 *     browser cannot fix that (the panel sends no referrer on purpose); the Host
 *     can, because it chooses the headers.
 *  2. A page can only render images it is allowed to load. Serving posters from
 *     the plugin's own origin sidesteps remote-CSP and hotlink rules entirely.
 *
 * So the board carries `poster` (a same-origin proxy path) beside the original
 * `cover` URL, and bytes for the board already sit in memory by the time the
 * panel asks for them. When a pick has no usable cover, the resolver goes and
 * finds one by title (Douban suggest → iTunes → TVMaze).
 *
 * @module dsh-movie/lib/covers
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 12000
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_CACHE_ENTRIES = 160

/**
 * Only fetch images from services this plugin already trusts. The proxy takes a
 * URL from a query string, so an allowlist is the difference between "poster
 * proxy" and "fetch anything for anyone".
 */
const ALLOWED_HOSTS = [
  'doubanio.com',
  'douban.com',
  'justwatch.com',
  'tvmaze.com',
  'mzstatic.com',
  'wikimedia.org',
  'wikipedia.org',
]

const imageCache = new Map()
let cacheBytes = 0

/**
 * Hosts that never answer. One poster CDN is blocked on some networks; the board
 * should stop asking it after a few rounds instead of paying a timeout per row
 * on every rebuild.
 *
 * A host that has ever delivered an image is never treated as blocked — a burst
 * of slow downloads must not cost every later poster from a healthy CDN.
 */
const hostStats = new Map()
const HOST_FAILURE_LIMIT = 3
const HOST_STATS_TTL_MS = 10 * 60 * 1000

function hostKeyOf(rawUrl) {
  try {
    return new URL(String(rawUrl)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function hostIsBlocked(rawUrl) {
  const key = hostKeyOf(rawUrl)
  if (key === '') return true
  const record = hostStats.get(key)
  if (!record) return false
  if (Date.now() - record.at > HOST_STATS_TTL_MS) {
    hostStats.delete(key)
    return false
  }
  return record.successes === 0 && record.failures >= HOST_FAILURE_LIMIT
}

function noteHost(rawUrl, outcome) {
  const key = hostKeyOf(rawUrl)
  if (key === '') return
  const record = hostStats.get(key)
  if (!record || Date.now() - record.at > HOST_STATS_TTL_MS) {
    hostStats.set(key, { failures: outcome === 'fail' ? 1 : 0, successes: outcome === 'ok' ? 1 : 0, at: Date.now() })
    return
  }
  if (outcome === 'fail') record.failures += 1
  else record.successes += 1
  record.at = Date.now()
}

export function coverPath(url) {
  return '/dsh-movie/api/cover?u=' + encodeURIComponent(url)
}

export function allowedImageHost(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl))
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith('.' + suffix))
  } catch {
    return false
  }
}

/** Per-host headers the CDN actually requires. */
function headersFor(rawUrl) {
  const headers = {
    'user-agent': UA,
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  }
  if (/doubanio\.com$|doubanio\.com[:/]/.test(rawUrl)) headers.referer = 'https://movie.douban.com/'
  else if (/justwatch\.com/.test(rawUrl)) headers.referer = 'https://www.justwatch.com/'
  return headers
}

/**
 * Ask for the biggest variant that still makes sense for a 200-300px poster, so
 * the grid stays sharp without dragging the TVMaze original down for every row.
 */
export function normalizePosterUrl(rawUrl) {
  if (!rawUrl) return null
  let url = String(rawUrl).trim()
  if (url === '') return null
  if (url.startsWith('//')) url = 'https:' + url
  if (url.includes('doubanio.com')) url = url.replace(/\/(?:s|m)_ratio_poster\//, '/l_ratio_poster/')
  if (url.includes('static.tvmaze.com')) url = url.replace('/original_untouched/', '/medium_portrait/')
  return url
}

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

async function readImage(rawUrl) {
  if (!allowedImageHost(rawUrl)) return null
  if (hostIsBlocked(rawUrl)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(rawUrl, { headers: headersFor(rawUrl), signal: controller.signal })
    if (!response.ok) return null
    const type = String(response.headers.get('content-type') || '').toLowerCase()
    if (type !== '' && !type.startsWith('image/')) return null
    const buffer = await response.arrayBuffer()
    if (!buffer || buffer.byteLength < 2048 || buffer.byteLength > MAX_IMAGE_BYTES) return null
    noteHost(rawUrl, 'ok')
    const image = {
      url: rawUrl,
      type: type === '' ? 'image/jpeg' : type.split(';')[0],
      bytes: new Uint8Array(buffer),
      at: Date.now(),
    }
    putImage(rawUrl, image)
    return image
  } catch {
    noteHost(rawUrl, 'fail')
    return null
  } finally {
    clearTimeout(timer)
  }
}

function putImage(url, image) {
  const existing = imageCache.get(url)
  if (existing) cacheBytes -= existing.bytes.length
  imageCache.set(url, image)
  cacheBytes += image.bytes.length
  while (imageCache.size > MAX_CACHE_ENTRIES || cacheBytes > 48 * 1024 * 1024) {
    const oldest = imageCache.keys().next()
    if (oldest.done) break
    const dropped = imageCache.get(oldest.value)
    imageCache.delete(oldest.value)
    cacheBytes -= dropped ? dropped.bytes.length : 0
  }
}

function getImage(url) {
  const hit = imageCache.get(url)
  if (!hit) return null
  imageCache.delete(url)
  imageCache.set(url, hit)
  return hit
}

export function imageCacheStats() {
  return { entries: imageCache.size, bytes: cacheBytes }
}

/** Serve a poster for the panel: memory first, network second. */
export async function serveImage(rawUrl) {
  const url = normalizePosterUrl(rawUrl)
  if (!url) return null
  const cached = getImage(url)
  if (cached) return cached
  return readImage(url)
}

/**
 * Search fallbacks, used only when the pick's own cover will not load. Each one
 * is keyless and answers with a poster URL this Host can fetch.
 */
let doubanGate = Promise.resolve()

/** One Douban suggest call at a time, spaced out, retried once on silence. */
function suggestSerialized(query) {
  const attempt = async () => {
    for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
      const rows = await fetchJson(
        'https://movie.douban.com/j/subject_suggest?q=' + encodeURIComponent(query),
        { referer: 'https://movie.douban.com/' },
      )
      if (Array.isArray(rows) && rows.length > 0) return rows
      if (Array.isArray(rows)) return rows
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }
  const run = doubanGate.then(async () => {
    const rows = await attempt()
    await new Promise((resolve) => setTimeout(resolve, 250))
    return rows
  })
  doubanGate = run.then(() => undefined, () => undefined)
  return run
}

async function searchDouban(pick) {
  const queries = [pick.originalTitle, pick.title].filter((value) => typeof value === 'string' && value.trim() !== '')
  for (const query of queries) {
    const rows = await suggestSerialized(query)
    if (!Array.isArray(rows)) continue
    const hit = rows.find((row) => row && typeof row.img === 'string' && row.img.includes('/view/photo/'))
    if (hit) return normalizePosterUrl(hit.img)
  }
  return null
}

async function searchItunes(pick) {
  const media = pick.mediaType === 'series' ? 'tvShow' : 'movie'
  const term = pick.originalTitle || pick.title
  if (!term) return null
  const data = await fetchJson(
    'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&media=' + media + '&limit=5',
  )
  const row = data && Array.isArray(data.results) ? data.results.find((item) => item && item.artworkUrl100) : null
  if (!row) return null
  return normalizePosterUrl(String(row.artworkUrl100).replace(/\/\d+x\d+bb\./, '/600x600bb.'))
}

async function searchTvmaze(pick) {
  const term = pick.originalTitle || pick.title
  if (!term) return null
  const rows = await fetchJson('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(term))
  if (!Array.isArray(rows)) return null
  const hit = rows.find((row) => row && row.show && row.show.image && (row.show.image.medium || row.show.image.original))
  if (!hit) return null
  return normalizePosterUrl(hit.show.image.medium || hit.show.image.original)
}

/**
 * Attach a same-origin `poster` path to every pick, fetching the bytes so the
 * panel's first paint already has them. Never throws: a pick that cannot get a
 * poster simply keeps `poster: null` and the panel draws its own plate.
 */
export async function attachPosters(picks, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 5))
  const rows = Array.isArray(picks) ? picks : []
  const stats = { resolved: 0, failed: 0, searched: 0, sources: {} }
  let cursor = 0

  async function one(pick) {
    const primary = normalizePosterUrl(pick.cover)
    let source = 'source'
    let image = primary ? await readImage(primary) : null

    if (!image) {
      const finders = [{ name: 'douban-search', run: searchDouban }]
      if (pick.mediaType === 'series') finders.push({ name: 'tvmaze-search', run: searchTvmaze })
      finders.push({ name: 'itunes-search', run: searchItunes })
      for (const finder of finders) {
        const candidate = await finder.run(pick).catch(() => null)
        if (!candidate) continue
        stats.searched += 1
        image = await readImage(candidate)
        if (image) {
          source = finder.name
          break
        }
      }
    }

    if (image) {
      pick.poster = coverPath(image.url)
      pick.posterSource = source
      stats.resolved += 1
      stats.sources[source] = (stats.sources[source] ?? 0) + 1
    } else {
      pick.poster = null
      pick.posterSource = null
    }
  }

  async function worker() {
    while (cursor < rows.length) {
      const index = cursor
      cursor += 1
      try {
        await one(rows[index])
      } catch (error) {
        rows[index].poster = null
        stats.failed += 1
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker))

  // Second pass, one row at a time: the first pass bursts, and the title search
  // that rescues a dead cover is the call that bursts upset. A handful of slow
  // rows is worth more than a grid with holes in it.
  const leftover = rows.filter((pick) => !pick.poster)
  for (const pick of leftover) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      await one(pick)
    } catch {
      pick.poster = null
    }
  }

  stats.failed = rows.filter((pick) => !pick.poster).length
  if (rows.length > 0) {
    logger(
      'dsh-movie: posters ' + stats.resolved + '/' + rows.length +
      (stats.failed > 0 ? ' (' + stats.failed + ' without)' : '') +
      (stats.searched > 0 ? ', ' + stats.searched + ' searches' : ''),
    )
  }
  return stats
}
