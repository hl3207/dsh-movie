/**
 * dsh-movie — host half.
 *
 * One ranked board of the movies and series that are in cinemas now or open
 * within the next month across China, the US, Europe, Japan and Korea, built by
 * the vendored pipeline (lib/pipeline.js + lib/providers.js), enriched with real
 * synopses, popular comments and both-language titles (lib/enrich.js), and
 * translated through the Host `llm` service into the language the reader picked.
 *
 * Owns:
 *   - the `movie_board` tool,
 *   - the per-locale board snapshot with a single-flight cache,
 *   - /dsh-movie/api/{board,refresh,health,cover,wiring} for the panels,
 *   - /dsh-movie/api/search for the panel's title search.
 *
 * Both the Desktop app and the browser build of the Web GUI talk to the same
 * relative routes on whatever origin serves the page, so nothing here depends on
 * a fixed port, and nothing depends on an Electron-only API.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildRecommendations, normalizeLocale } from './lib/pipeline.js'
import { enrichItems } from './lib/enrich.js'
import { attachPosters, serveImage } from './lib/covers.js'
import { searchTitles } from './lib/search.js'

export const name = '@hl3207/dsh-movie'

/** The panel reads the board over HTTP, so the webserver is a hard dependency. */
export const inject = ['tools', 'webServer']

const API_PREFIX = '/dsh-movie/api'
const TOOL_NAME = 'movie_board'
const LOCALES = ['zh', 'en']

/** Friendly region names accepted in config, resolved to ISO codes. */
const REGION_ALIASES = {
  us: 'US',
  usa: 'US',
  'united states': 'US',
  america: 'US',
  cn: 'CN',
  china: 'CN',
  chinese: 'CN',
  jp: 'JP',
  japan: 'JP',
  japanese: 'JP',
  kr: 'KR',
  korea: 'KR',
  korean: 'KR',
  'south korea': 'KR',
  gb: 'GB',
  uk: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  england: 'GB',
  de: 'DE',
  germany: 'DE',
  fr: 'FR',
  france: 'FR',
  es: 'ES',
  spain: 'ES',
  it: 'IT',
  italy: 'IT',
  europe: 'EU',
}

export const Config = Schema.object({
  regions: Schema.array(Schema.string()).default(['china', 'us', 'europe', 'japan', 'korea']),
  lookbackDays: Schema.number().default(21).min(0).max(120),
  upcomingDays: Schema.number().default(31).min(1).max(120),
  limit: Schema.number().default(20).min(1).max(60),
  language: Schema.union(['auto', 'zh', 'en']).default('auto'),
  translate: Schema.boolean().default(true),
  translateProvider: Schema.string().default('auto'),
  translateModel: Schema.string().default(''),
  includeSeries: Schema.boolean().default(true),
  doubanEnabled: Schema.boolean().default(true),
  doubanEnrichLimit: Schema.number().default(10).min(0).max(30),
  commentLimit: Schema.number().default(3).min(0).max(6),
  weights: Schema.object({
    heat: Schema.number().default(0.28).min(0).max(1),
    rt: Schema.number().default(0.22).min(0).max(1),
    douban: Schema.number().default(0.28).min(0).max(1),
    anticipation: Schema.number().default(0.22).min(0).max(1),
  }),
  cacheTtlMinutes: Schema.number().default(60).min(0).max(1440),
})

/**
 * Fold the friendly region names into ISO codes and drop anything the providers
 * cannot serve, so a config written as ["us","europe","japan"] still works.
 * @param {string[]} regions
 * @returns {{codes: string[], europe: boolean}}
 */
function resolveRegions(regions) {
  const codes = []
  let europe = false
  for (const raw of regions ?? []) {
    const key = String(raw).trim().toLowerCase()
    if (key === 'eu' || key === 'europe') {
      europe = true
      continue
    }
    const code = REGION_ALIASES[key] ?? (/^[A-Za-z]{2}$/.test(raw) ? String(raw).toUpperCase() : null)
    if (code && !codes.includes(code)) codes.push(code)
  }
  if (europe) for (const code of ['GB', 'DE', 'FR', 'ES', 'IT']) if (!codes.includes(code)) codes.push(code)
  if (codes.length === 0) codes.push('US', 'GB', 'DE', 'FR', 'JP', 'KR')
  return { codes, europe }
}

const writeJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** A tool result crosses the host as lossless JSON: drop undefined and exotic values. */
const lossless = (value) => JSON.parse(JSON.stringify(value))

/**
 * Render one board as plain text for the tool row.
 * @param {object} board @param {'zh'|'en'} locale @returns {string}
 */
function renderBoard(board, locale) {
  const zh = locale === 'zh'
  const lines = []
  const picks = board.picks ?? []
  lines.push(
    `${zh ? '影视雷达' : 'Screen Radar'} — ${picks.length} ${zh ? '部' : 'titles'} · ${board.window?.from ?? '?'} → ${board.window?.to ?? '?'}`,
  )
  if (board.sources?.length > 0) {
    lines.push(board.sources.map((s) => `${s.id}${s.ok ? ` ok(${s.items ?? 0})` : ' failed'}`).join(' | '))
  }
  if (board.degraded) lines.push(zh ? '! 数据源不足，已降级显示' : '! Providers degraded')
  if (board.translation?.enabled) {
    lines.push(
      zh
        ? `翻译：${board.translation.translated} 条成功 / ${board.translation.failed} 条失败`
        : `Translation: ${board.translation.translated} ok / ${board.translation.failed} failed`,
    )
  }
  for (const pick of picks) {
    const bits = []
    const m = pick.metrics ?? {}
    if (m.douban != null) bits.push(`${zh ? '豆瓣' : 'Douban'} ${m.douban}`)
    if (m.rottenTomatoes != null) bits.push(`${zh ? '烂番茄' : 'RT'} ${m.rottenTomatoes}%`)
    if (m.imdb != null) bits.push(`IMDb ${m.imdb}`)
    if (m.buzz != null) bits.push(`${zh ? '热度' : 'Buzz'} ${m.buzz}`)
    if (m.anticipation != null) bits.push(`${zh ? '期待' : 'Hype'} ${m.anticipation}`)
    const status =
      pick.releaseStatus === 'now' ? (zh ? '上映中' : 'now') : pick.releaseStatus === 'upcoming' ? (zh ? '待映' : 'upcoming') : ''
    const secondary = pick.originalTitle ? ` / ${pick.originalTitle}` : ''
    lines.push(
      `${pick.rank}. ${pick.title}${secondary} [${status}${pick.region ? `, ${pick.region}` : ''}${
        pick.releaseDate ? `, ${pick.releaseDate}` : ''
      }] ${zh ? '综合' : 'score'} ${pick.composite}${bits.length > 0 ? ` (${bits.join(' / ')})` : ''}`,
    )
    if (pick.synopsis?.length > 0) lines.push(`   ${pick.synopsis.join(zh ? '' : ' ')}`)
    for (const comment of pick.comments ?? []) {
      lines.push(`   · ${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
    }
  }
  if (picks.length === 0) lines.push(zh ? '(空榜单 — 执行 action=refresh)' : '(empty board — run action=refresh)')
  return lines.join('\n')
}

export function apply(ctx, config) {
  const resolved = resolveRegions(config.regions)
  const runtimeConfig = {
    ...config,
    regions: resolved.codes,
    language: normalizeLocale(config.language === 'auto' ? 'zh' : config.language),
  }

  /** Per-locale snapshots: switching the panel's language must never rebuild. */
  const boards = new Map()
  const inflight = new Map()
  const rtCache = new Map()
  const translationCache = new Map()
  const resolvedTranslateLimit = 20
  /** Hard ceiling for one batch of native translations, ms. */
  const resolvedTranslateBudgetMs = 45000

  const logger = (message) => ctx.logger?.debug?.(message)

  /** @param {string} locale @returns {'zh'|'en'} */
  const pickLocale = (locale) => {
    const value = String(locale ?? '').trim().toLowerCase()
    if (value.startsWith('zh')) return 'zh'
    if (value.startsWith('en')) return 'en'
    return runtimeConfig.language
  }

  const isFresh = (entry) =>
    entry != null && config.cacheTtlMinutes > 0 && (entry.board.picks?.length ?? 0) > 0 &&
    Date.now() - entry.at < config.cacheTtlMinutes * 60000

  /**
   * Translate text through the session's own model route.
   *
   * The anonymous HTTP translators are unreachable from this network, and the
   * configured model route always is, so the board borrows it: one call per
   * chunk of strings, strict JSON-out, and a per-string cache so switching the
   * board language twice costs nothing.
   *
   * @param {string[]} texts @param {'zh'|'en'} target
   * @returns {Promise<(string|null)[]>}
   */
  /**
   * Translate through the Host `translator` service, which owns the native
   * keyless Google/Bing routes plus their cancellation and retention rules.
   * One request per string, three in flight, and a failure never escapes.
   */
  /**
   * Read the numbered-line reply the model fallback asks for.
   * @param {string} reply @param {number} expected
   * @returns {(string|null)[] | null}
   */
  const parseNumberedLines = (reply, expected) => {
    if (!reply) return null
    const found = new Map()
    for (const rawLine of reply.split(/\r?\n/)) {
      const match = /^\s*(\d{1,3})\s*[.)、:]\s*(.+)$/.exec(rawLine)
      if (!match) continue
      const index = Number(match[1]) - 1
      if (index < 0 || index >= expected || found.has(index)) continue
      found.set(index, match[2].trim())
    }
    if (found.size === 0) return null
    const out = []
    for (let index = 0; index < expected; index += 1) out.push(found.get(index) ?? '')
    return out
  }

  /**
   * Translate through the Host `translator` service, which owns the keyless
   * Google/Bing routes together with their cancellation and retention rules.
   *
   * One string per request, three in flight, one probe before committing so a
   * blocked route costs a single timeout instead of one per string, and a hard
   * time budget so a slow route cannot hold the board open. Failure never
   * escapes: the source text is kept and counted instead.
   *
   * @param {string[]} texts @param {'zh'|'en'} target
   */
  const translateViaService = async (texts, target) => {
    const translator = ctx.get('translator')
    if (!translator || typeof translator.translate !== 'function' || typeof translator.resolve !== 'function') {
      logger('dsh-movie: no translator service; falling back to the model route')
      return
    }
    let providers = []
    try {
      providers = (await translator.availableProviders?.()) ?? []
    } catch (error) {
      logger(`dsh-movie: translation providers unavailable: ${error?.message ?? error}`)
      return
    }
    // Only the keyless routes work without a Session; the paid ones need an
    // active Session id, which a panel-initiated build does not have.
    const preferred = config.translateProvider && config.translateProvider !== 'auto' ? config.translateProvider : null
    const order = preferred && providers.includes(preferred)
      ? [preferred]
      : providers.filter((entry) => entry === 'bing' || entry === 'google')
    if (order.length === 0) {
      logger('dsh-movie: no keyless translation provider is available')
      return
    }

    const language = target === 'zh' ? 'zh-Hans' : 'en'
    const cacheKey = (text) => `${target}\u0000${text}`

    let working = []
    for (const provider of order) {
      try {
        const spec = translator.resolve({ text: texts[0], targetLanguage: language, provider })
        const translated = await translator.translate(spec)
        if (typeof translated === 'string' && translated.trim()) {
          translationCache.set(cacheKey(texts[0]), translated.trim())
          working = order.slice(order.indexOf(provider))
          break
        }
      } catch (error) {
        logger(`dsh-movie: translation route ${provider} refused a probe: ${error?.message ?? error}`)
      }
    }
    if (working.length === 0) {
      logger('dsh-movie: no keyless translation route is reachable')
      return
    }

    const deadline = Date.now() + resolvedTranslateBudgetMs
    const queue = [...texts]
    let failures = 0
    const worker = async () => {
      for (;;) {
        const entry = queue.shift()
        if (entry === undefined || Date.now() > deadline) return
        if (translationCache.has(cacheKey(entry))) continue
        let done = false
        for (const provider of working) {
          try {
            const spec = translator.resolve({ text: entry, targetLanguage: language, provider })
            const translated = await translator.translate(spec)
            if (typeof translated === 'string' && translated.trim()) {
              translationCache.set(cacheKey(entry), translated.trim())
              done = true
              break
            }
          } catch {
            /* try the next route for this string */
          }
        }
        if (!done) failures += 1
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (failures > 0) logger(`dsh-movie: ${failures} strings kept in their source language`)
  }

  /**
   * Fallback route: the session's own model, one chunk of numbered lines at a
   * time. Kept for a deployment with no keyless translator at all.
   * @param {string[]} texts @param {'zh'|'en'} target
   */
  const translateViaModel = async (texts, target) => {
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = config.translateProvider && config.translateProvider !== 'auto'
      ? config.translateProvider
      : selection?.provider
    const model = config.translateModel || selection?.model
    if (!llm?.stream || !provider || !model) {
      logger('dsh-movie: no model route for translation')
      return
    }

    const system = [
      'You are a translation engine. The user sends numbered lines of text.',
      'Reply with exactly the same number of numbered lines, each holding only the translation',
      'of that line into ' + (target === 'zh' ? 'Simplified Chinese' : 'English') + '.',
      'Never merge, drop, reorder, explain or comment. No headings, no tables, no prose outside the lines.',
      'Keep titles, names and numbers as they are normally written in the target language.',
    ].join(' ')

    for (let start = 0; start < texts.length; start += resolvedTranslateLimit) {
      const chunk = texts.slice(start, start + resolvedTranslateLimit)
      const parts = []
      const blocks = []
      try {
        const stream = llm.stream({
          provider,
          model,
          temperature: 0,
          maxTokens: 4000,
          system,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: chunk.map((entry, index) => index + 1 + '. ' + entry).join('\n') }],
            },
          ],
        })
        for await (const part of stream) {
          const kind = part?.type
          if (kind === 'text-delta' && typeof part.text === 'string') parts.push(part.text)
          else if (kind === 'block-end' && part.block?.type === 'text') blocks.push(part.block.text)
          else if (kind === 'finish' && part.reason?.kind === 'error') {
            throw new Error(part.reason.failure?.message ?? 'model error')
          }
        }
        const reply = parts.join('') || blocks.join('\n')
        const parsed = parseNumberedLines(reply, chunk.length) ?? parseTranslationArray(reply)
        chunk.forEach((entry, index) => {
          const value = parsed?.[index]
          if (typeof value === 'string' && value.trim()) {
            translationCache.set(`${target}\u0000${entry}`, value.trim())
          }
        })
      } catch (error) {
        logger(`dsh-movie: model translation chunk failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Translate a batch of strings into the board language.
   * @param {string[]} texts @param {'zh'|'en'} target
   * @returns {Promise<(string|null)[]>}
   */
  const translateTexts = async (texts, target) => {
    const key = (text) => `${target}\u0000${text}`
    const missing = texts.filter((text) => !translationCache.has(key(text)))
    if (missing.length > 0) {
      await translateViaService(missing, target)
      const left = missing.filter((text) => !translationCache.has(key(text)))
      if (left.length > 0) await translateViaModel(left, target)
      if (translationCache.size > 800) {
        for (const stale of [...translationCache.keys()].slice(0, translationCache.size - 800)) {
          translationCache.delete(stale)
        }
      }
    }
    return texts.map((text) => translationCache.get(key(text)) ?? null)
  }

  /**
   * Build the board for one locale, single-flight.
   * @param {'zh'|'en'} locale @param {{force?: boolean}} [options]
   * @returns {Promise<{board: object, cached: boolean}>}
   */
  const buildBoard = (locale, options = {}) => {
    const existing = boards.get(locale)
    if (!options.force && isFresh(existing)) return Promise.resolve({ board: existing.board, cached: true })
    const running = inflight.get(locale)
    if (running) return running

    const run = (async () => {
      const started = Date.now()
      const result = await buildRecommendations({
        config: { ...runtimeConfig, language: locale },
        locale,
        limit: config.limit,
        rtCache,
        logger,
      })

      const adapted = result.items.map((item) => ({
        ...item,
        mediaType: item.type === 'series' ? 'series' : 'movie',
        releaseStatus: item.status === 'now' ? 'now' : 'upcoming',
      }))

      const enriched = await enrichItems(adapted, {
        locale,
        enrichLimit: config.doubanEnrichLimit,
        commentLimit: config.commentLimit,
        doubanEnabled: config.doubanEnabled,
        translate: config.translate ? translateTexts : null,
        logger,
      })

      const picks = enriched.rows
      // Posters are fetched here, not lazily: the panel must never wait on an
      // image round trip, and Douban's CDN only answers with a Host-set Referer.
      const posters = await attachPosters(picks, { logger }).catch(() => null)
      const now = picks.filter((pick) => pick.releaseStatus === 'now').length
      const today = new Date()
      const to = new Date(today.getTime() + config.upcomingDays * 86400000)
      const board = {
        generatedAt: new Date().toISOString(),
        locale,
        counts: {
          total: picks.length,
          now,
          upcoming: picks.length - now,
          movie: picks.filter((pick) => pick.mediaType === 'movie').length,
          series: picks.filter((pick) => pick.mediaType === 'series').length,
        },
        window: { from: today.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        sources: result.sourceStatus ?? [],
        translation: enriched.translation,
        posters: posters ? { resolved: posters.resolved, failed: posters.failed } : null,
        degraded: picks.length === 0 || (result.sourceStatus ?? []).every((source) => !source?.ok),
        buildMs: Date.now() - started,
        picks,
      }
      boards.set(locale, { board, at: Date.now() })
      logger(`dsh-movie: built ${locale} board in ${board.buildMs}ms`)
      return { board, cached: false }
    })().finally(() => {
      inflight.delete(locale)
    })

    inflight.set(locale, run)
    return run
  }

  /** A cleared or never-built board must fill itself on first paint. */
  const ensureBoard = async (locale) => {
    const existing = boards.get(locale)
    if (existing) return { board: existing.board, cached: isFresh(existing) }
    return buildBoard(locale)
  }

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: [
      'Read or refresh the dsh-movie board shown in the DeepSeek Harness left sidebar: movies and series',
      'in cinemas now or opening within the next month across China, the US, Europe, Japan and Korea,',
      'ranked by a composite of buzz, Rotten Tomatoes, Douban and audience anticipation, each with a cover,',
      'a synopsis of at most five sentences, popular comments and a Chinese/English title pair.',
      'The plugin fetches every metric itself from keyless sources (Douban, JustWatch, iTunes, TVMaze),',
      'translates synopses, comments and missing titles through the Host translator service, and resolves a',
      'real poster for every title (falling back to a title search when a source cover is dead), so use',
      'action=refresh and then report what came back. action=read returns the current board without',
      'touching the network; action=clear empties it. 影视雷达：refresh 由插件联网出榜，read 读取当前榜单，支持中英文。',
    ].join(' '),
    parameters: {
      action: { type: 'string', description: 'refresh (default) | read | clear', enum: ['refresh', 'read', 'clear'] },
      force: { type: 'boolean', description: 'With refresh: ignore the cache and hit the sources again.' },
      limit: { type: 'number', description: 'How many titles to return (1-60). Defaults to the plugin config.' },
      locale: { type: 'string', description: 'zh | en — language of titles, synopses and comments.', enum: LOCALES },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        const locale = pickLocale(args?.locale)
        return [{ type: 'text', text: renderBoard(value.board ?? value, locale) }]
      },
    },
    async execute(args) {
      const locale = pickLocale(args?.locale)
      const action = typeof args?.action === 'string' ? args.action : 'refresh'
      if (action === 'clear') {
        boards.delete(locale)
        return lossless({
          kind: 'board',
          board: { picks: [], counts: { total: 0, now: 0, upcoming: 0 }, sources: [], window: {} },
        })
      }
      if (action === 'read' && boards.has(locale)) {
        return lossless({ kind: 'board', board: boards.get(locale).board, cached: true })
      }
      const result = await buildBoard(locale, { force: action === 'refresh' && args?.force === true })
      return lossless({
        kind: 'board',
        board: result.board,
        cached: result.cached === true,
        ...(result.board.degraded
          ? { error: 'providers could not fill the board; retry later or report the sources that failed' }
          : {}),
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const locale = pickLocale(url.searchParams.get('locale'))
        if (req.method === 'GET' && url.pathname === `${API_PREFIX}/board`) {
          const filled = await ensureBoard(locale)
          writeJson(res, 200, { ok: true, cached: filled.cached === true, board: filled.board })
          return
        }
        if (req.method === 'POST' && url.pathname === `${API_PREFIX}/refresh`) {
          const result = await buildBoard(locale, { force: true })
          writeJson(res, 200, { ok: true, cached: result.cached, board: result.board })
          return
        }
        if (req.method === 'GET' && url.pathname === `${API_PREFIX}/search`) {
          const query = url.searchParams.get('q') ?? ''
          const limit = Number(url.searchParams.get('limit') ?? '8')
          let payload
          try {
            payload = await searchTitles(query, {
              locale,
              limit: Number.isFinite(limit) ? limit : 8,
              translate: config.translate ? translateTexts : null,
            })
          } catch (error) {
            logger('dsh-movie: search failed: ' + String(error?.message ?? error))
            payload = { query, locale, results: [], error: String(error?.message ?? error) }
          }
          writeJson(res, 200, Object.assign({ ok: true }, payload))
          return
        }
        if (req.method === 'GET' && url.pathname === `${API_PREFIX}/wiring`) {
          const rowId = name
          // Self-diagnostic: report how this bundle appears in the browser boot
          // graph, so the panel's wiring is inspectable without a browser.
          let wiring = null
          try {
            const modules = ctx.get('clientModules')
            const graph = modules && typeof modules.graph === 'function' ? modules.graph() : null
            if (graph) {
              const entries = Array.isArray(graph.entries) ? graph.entries : []
              const entry = entries.find((item) => item.id === rowId) ?? null
              wiring = {
                inGraph: Boolean(entry),
                entry,
                batches: (Array.isArray(graph.batches) ? graph.batches : [])
                  .filter((batch) => Array.isArray(batch.entries) && batch.entries.includes(rowId)),
                clientPath: typeof modules.clientPath === 'function' ? modules.clientPath(rowId) ?? null : null,
                total: entries.length,
              }
            }
          } catch (error) {
            wiring = { error: String(error?.message ?? error) }
          }
          writeJson(res, 200, { ok: true, wiring })
          return
        }
        if (req.method === 'GET' && url.pathname === `${API_PREFIX}/cover`) {
          // Poster proxy: same-origin, so the page never depends on a remote
          // CDN's hotlink or CSP rules, and Douban's Referer requirement is met.
          const target = url.searchParams.get('u') ?? ''
          const image = await serveImage(target)
          if (!image) {
            res.statusCode = 404
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end('no-poster')
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', image.type)
          res.setHeader('content-length', String(image.bytes.length))
          res.setHeader('cache-control', 'public, max-age=604800, immutable')
          res.end(Buffer.from(image.bytes))
          return
        }
        if (req.method === 'GET' && url.pathname === `${API_PREFIX}/health`) {
          const entry = boards.get(locale)
          writeJson(res, 200, {
            ok: true,
            locale,
            builtAt: entry ? new Date(entry.at).toISOString() : null,
            picks: entry?.board?.picks?.length ?? 0,
            locales: [...boards.keys()],
            regions: resolved.codes,
            europe: resolved.europe,
            translate: config.translate,
            translationCache: translationCache.size,
          })
          return
        }
        writeJson(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, {
          ok: false,
          error: req.method === 'GET' || req.method === 'POST' ? 'not-found' : 'method-not-allowed',
        })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-movie: board routes')
}

/**
 * Models sometimes wrap JSON in prose or a code fence. Take the first array in
 * the reply and only accept it when every entry is a string.
 * @param {string} text @returns {string[] | null}
 */
function parseTranslationArray(text) {
  if (!text) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    return parsed.every((entry) => typeof entry === 'string') ? parsed : null
  } catch {
    return null
  }
}

export default { name, inject, Config, apply }
