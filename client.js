window.__ModuleLoader__.load({
  id: '@hl3207/dsh-movie',
  factory: (require) => {
    const ReactNS = require('react')
    const React = ReactNS && ReactNS.default ? ReactNS.default : ReactNS
    const h = React.createElement

    /** The panel id doubles as the `main` panel key; the sidebar projects it. */
    const PANEL_ID = 'dsh-movie'
    const API_BOARD = '/dsh-movie/api/board'
    const API_REFRESH = '/dsh-movie/api/refresh'
    const LANG_KEY = 'dsh-movie:lang'

    /**
     * Only the theme tokens the runtime actually publishes, each with a neutral
     * fallback, so a missing token degrades to a readable colour instead of a
     * blank panel. `label-tertiary`, `hairline`, `accent` and `bg-layer-3` do not
     * exist in this build — they are expressed below through real tokens.
     */
    const T = {
      base: 'var(--dsw-alias-bg-base, #15161a)',
      layer1: 'var(--dsw-alias-bg-layer-1, #1c1d22)',
      layer2: 'var(--dsw-alias-bg-layer-2, #24262c)',
      overlay: 'var(--dsw-alias-bg-overlay, #2b2d34)',
      border1: 'var(--dsw-alias-border-l1, #33353d)',
      border2: 'var(--dsw-alias-border-l2, #43454f)',
      brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
      label1: 'var(--dsw-alias-label-primary, #f2f2f5)',
      label2: 'var(--dsw-alias-label-secondary, #b9b9c2)',
      error: 'var(--dsw-alias-state-error-primary, #ff453a)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b8b96)',
      success: 'var(--dsw-alias-state-success-primary, #34c759)',
      warn: 'var(--dsw-alias-state-warn-primary, #ff9f0a)',
      sidebar: 'var(--dsw-specific-sidebar-fill, #1a1b20)',
    }

    const I18N = {
      zh: {
        title: '影视雷达',
        iconLabel: '影视雷达',
        subtitle: '上映中与未来一个月定档',
        refresh: '刷新',
        refreshing: '正在重新抓榜…',
        loading: '正在联网构建榜单…',
        loadingHint: '首次构建需要 20-40 秒，之后走缓存秒开',
        building: '已等待',
        updated: '更新于',
        retry: '重试',
        error: '读取失败',
        errorHint: '数据源可能暂时不可达，稍后再试或点刷新。',
        empty: '榜单还是空的。',
        emptyHint: '点「刷新」让插件联网抓榜。',
        all: '全部',
        nowShowing: '上映中',
        upcoming: '待映',
        score: '综合',
        douban: '豆瓣',
        rt: '烂番茄',
        imdb: 'IMDb',
        buzz: '热度',
        anticipation: '期待',
        movie: '电影',
        series: '剧集',
        degraded: '部分数据源不可用，榜单已降级显示',
        translationFailed: '部分译文缺失，已保留原文',
        noPoster: '暂无海报',
        comments: '热门短评',
        translated: '已翻译',
        synopsis: '简介',
        langToggle: 'English',
        back: '返回',
        openPage: '打开详情页',
        searchPlaceholder: '搜索片名…',
        searchClear: '清除',
        inBoard: '榜单内',
        fromWeb: '全网搜索',
        searching: '正在联网搜索…',
        searchEmpty: '没搜到相关影片，换个片名再试。',
        searchFailed: '搜索失败',
        sources: '数据源',
        picks: '部',
      },
      en: {
        title: 'Screen Radar',
        iconLabel: 'Screen Radar',
        subtitle: 'In cinemas now and opening within a month',
        refresh: 'Refresh',
        refreshing: 'Fetching the charts…',
        loading: 'Building the board…',
        loadingHint: 'The first build takes 20-40s; later reads hit the cache',
        building: 'Waiting',
        updated: 'Updated',
        retry: 'Retry',
        error: 'Load failed',
        errorHint: 'A source may be unreachable right now. Retry, or hit Refresh.',
        empty: 'The board is empty.',
        emptyHint: 'Hit Refresh to fetch the charts.',
        all: 'All',
        nowShowing: 'In cinemas',
        upcoming: 'Upcoming',
        score: 'Score',
        douban: 'Douban',
        rt: 'RT',
        imdb: 'IMDb',
        buzz: 'Buzz',
        anticipation: 'Hype',
        movie: 'Movie',
        series: 'Series',
        degraded: 'Some sources are down — board degraded',
        translationFailed: 'Some translations missing — source text kept',
        noPoster: 'No poster',
        comments: 'Popular comments',
        translated: 'translated',
        synopsis: 'Synopsis',
        langToggle: '中文',
        back: 'Back',
        openPage: 'Open page',
        searchPlaceholder: 'Search titles…',
        searchClear: 'Clear',
        inBoard: 'On the board',
        fromWeb: 'From the web',
        searching: 'Searching the web…',
        searchEmpty: 'Nothing matched — try another title.',
        searchFailed: 'Search failed',
        sources: 'Sources',
        picks: 'titles',
      },
    }

    /* ------------------------------------------------------------------ *
     * Shared board cache + language store
     *
     * The board is expensive to build (network + translation), so both
     * languages are kept for the lifetime of the page: switching language
     * re-renders from memory and only fetches the language that is missing.
     * ------------------------------------------------------------------ */

    const boardCache = { zh: null, en: null }
    const langStore = { lang: null, manual: false, listeners: new Set() }
    let runtime = null

    function emitLang() {
      for (const listener of [...langStore.listeners]) {
        try {
          listener()
        } catch (error) {
          /* one broken listener must not stop the others */
        }
      }
    }

    function setLang(next) {
      if (langStore.lang === next) return
      langStore.lang = next
      emitLang()
    }

    /** localStorage wins, then the harness locale, then the browser. */
    function detectLang(ctx) {
      try {
        const saved = window.localStorage.getItem(LANG_KEY)
        if (saved === 'zh' || saved === 'en') return saved
      } catch (error) {
        /* storage can be unavailable: fall through */
      }
      try {
        const locale = ctx && ctx.locale
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null
        const id = snapshot && (snapshot.id || snapshot.locale || snapshot.name)
        if (typeof id === 'string' && id.length > 0) {
          return /^zh/i.test(id) ? 'zh' : 'en'
        }
      } catch (error) {
        /* no locale service: fall through */
      }
      try {
        if (typeof navigator !== 'undefined' && /^en/i.test(navigator.language || '')) return 'en'
      } catch (error) {
        /* not a browser: fall through */
      }
      return 'zh'
    }

    function useLang(ctx) {
      const pair = React.useState(() => langStore.lang || detectLang(ctx))
      const lang = pair[0]
      const setLocal = pair[1]
      React.useEffect(() => {
        if (langStore.lang !== lang) langStore.lang = lang
        const listener = () => setLocal(langStore.lang || 'zh')
        langStore.listeners.add(listener)
        return () => {
          langStore.listeners.delete(listener)
        }
      }, [lang, setLocal])
      const choose = React.useCallback((next) => {
        langStore.manual = true
        try {
          window.localStorage.setItem(LANG_KEY, next)
        } catch (error) {
          /* storage is optional */
        }
        setLang(next)
      }, [])
      return [lang, choose]
    }

    /** One read or force-rebuild. Throws on transport/shape problems. */
    async function requestBoard(lang, force, signal) {
      const url = (force ? API_REFRESH : API_BOARD) + '?locale=' + encodeURIComponent(lang)
      const response = await fetch(url, {
        method: force ? 'POST' : 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: signal,
      })
      const type = (response.headers.get('content-type') || '').toLowerCase()
      if (!response.ok) throw new Error('HTTP ' + response.status)
      if (type.indexOf('json') === -1) throw new Error('unexpected response')
      const payload = await response.json()
      if (!payload || payload.ok !== true || !payload.board) throw new Error('malformed board payload')
      return payload.board
    }

    /** Title search: the plugin queries Douban / TVMaze / iTunes and merges them. */
    async function requestSearch(term, lang, signal) {
      const url = '/dsh-movie/api/search?locale=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(term)
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal: signal,
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json()
      if (!payload || payload.ok !== true) throw new Error('malformed search payload')
      return payload
    }

    /* ------------------------------------------------------------------ *
     * Small presentational pieces
     * ------------------------------------------------------------------ */

    /** Warm for strong scores, cool for weak ones — the colour is the verdict. */
    function tone(value, scale) {
      if (typeof value !== 'number' || Number.isNaN(value)) return T.idle
      const pct = scale === 10 ? value * 10 : value
      if (pct >= 80) return T.success
      if (pct >= 60) return T.label1
      if (pct >= 40) return T.warn
      return T.error
    }

    function formatDate(iso, lang) {
      if (!iso) return ''
      try {
        const date = new Date(iso + 'T00:00:00')
        if (Number.isNaN(date.getTime())) return iso
        return date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' })
      } catch (error) {
        return iso
      }
    }

    function regionLabel(region) {
      if (!region) return ''
      return String(region).toUpperCase()
    }

    /**
     * A poster plate that fills whatever width its container gives it and keeps
     * the 2:3 ratio, so one component serves the grid tile and the detail header.
     * A missing or broken image degrades to a designed plate — never a blank box.
     */
    function Poster(props) {
      const broken = React.useState(false)
      const isBroken = broken[0]
      const setBroken = broken[1]
      const plate = {
        position: 'relative',
        width: '100%',
        aspectRatio: '2 / 3',
        borderRadius: '10px',
        overflow: 'hidden',
        background: 'linear-gradient(155deg, ' + T.layer2 + ' 0%, ' + T.layer1 + ' 58%, ' + T.layer2 + ' 100%)',
        border: '1px solid ' + T.border1,
        flex: '0 0 auto',
      }
      if (!props.url || isBroken) {
        return h(
          'div',
          {
            style: Object.assign({}, plate, {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              padding: '10px',
              textAlign: 'center',
              color: T.idle,
            }),
            title: props.emptyLabel,
            role: 'img',
            'aria-label': (props.alt ? props.alt + ' — ' : '') + props.emptyLabel,
          },
          h('span', { style: { fontSize: '28px', fontWeight: 600, opacity: 0.45, lineHeight: 1 } }, props.initial),
          h(
            'span',
            { style: { fontSize: '10px', lineHeight: 1.35, opacity: 0.5, maxWidth: '100%' } },
            props.alt || '',
          ),
        )
      }
      return h(
        'div',
        { style: plate },
        h('img', {
          src: props.url,
          alt: props.alt || '',
          loading: props.eager ? 'eager' : 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
          onError: () => setBroken(true),
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          },
        }),
        props.overlay || null,
      )
    }


    function Chip(props) {
      const missing = props.value === undefined || props.value === null
      return h(
        'span',
        {
          title: props.title || '',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '1px 7px',
            borderRadius: '999px',
            fontSize: '10px',
            lineHeight: '17px',
            color: missing ? T.idle : T.label2,
            background: T.layer2,
            border: '1px solid ' + (missing ? T.border1 : T.border2),
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          },
        },
        h('span', { style: { opacity: missing ? 0.8 : 1 } }, props.label),
        h(
          'strong',
          {
            style: {
              color: missing ? T.idle : tone(props.value, props.scale),
              fontWeight: 600,
            },
          },
          props.text,
        ),
      )
    }

    function StarRow(props) {
      if (typeof props.stars !== 'number' || props.stars <= 0) return null
      const full = Math.round(props.stars)
      let glyph = ''
      for (let index = 0; index < full; index += 1) glyph += '★'
      return h(
        'span',
        {
          style: { color: T.warn, fontSize: '10px', letterSpacing: '-1px' },
          title: full + '/5',
          'aria-label': full + '/5',
        },
        glyph,
      )
    }

    /** One poster-forward tile in the grid. Clicking it opens the detail view. */
    function PosterCard(props) {
      const pick = props.pick
      const t = props.t
      const lang = props.lang
      const metrics = pick.metrics || {}
      const now = pick.releaseStatus === 'now'
      const statusLabel = now ? t.nowShowing : t.upcoming
      const statusColor = now ? T.success : T.warn
      const secondary = pick.originalTitle && pick.originalTitle !== pick.title ? pick.originalTitle : null
      const rated =
        typeof metrics.douban === 'number'
          ? metrics.douban.toFixed(1)
          : typeof metrics.rottenTomatoes === 'number'
            ? metrics.rottenTomatoes + '%'
            : typeof metrics.imdb === 'number'
              ? metrics.imdb.toFixed(1)
              : null

      const overlay = h(
        'div',
        {
          style: {
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '7px',
            pointerEvents: 'none',
          },
        },
        h(
          'span',
          {
            style: {
              minWidth: '22px',
              height: '22px',
              padding: '0 6px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 700,
              lineHeight: '21px',
              textAlign: 'center',
              // Always dark glass with white type: a theme whose brand colour
              // is light (or white) must not paint white on white. The brand
              // only rings the top three, where contrast never depends on it.
              color: '#fff',
              background: 'rgba(12,13,17,.82)',
              border: '1px solid ' + (pick.rank <= 3 ? T.brand : 'rgba(255,255,255,.22)'),
              backdropFilter: 'blur(3px)',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          String(pick.rank),
        ),
        h(
          'span',
          {
            style: {
              height: '22px',
              padding: '0 7px',
              borderRadius: '999px',
              fontSize: '11px',
              fontWeight: 600,
              lineHeight: '21px',
              color: '#fff',
              background: 'rgba(16,17,21,.78)',
              border: '1px solid ' + T.border2,
              backdropFilter: 'blur(3px)',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          String(pick.composite ?? '—'),
        ),
      )

      return h(
        'button',
        {
          type: 'button',
          onClick: () => props.onOpen(pick),
          title: pick.title,
          'aria-label': (pick.title || '') + ' — ' + statusLabel,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            width: '100%',
            padding: '9px',
            borderRadius: '13px',
            background: T.layer1,
            border: '1px solid ' + T.border1,
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            minWidth: 0,
          },
        },
        h(Poster, {
          url: pick.poster || pick.cover,
          alt: pick.title,
          initial: String(pick.title || '?').slice(0, 1),
          emptyLabel: t.noPoster,
          overlay: overlay,
        }),
        h(
          'div',
          { style: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column' } },
          h(
            'div',
            {
              title: pick.title,
              style: {
                fontSize: '13px',
                fontWeight: 600,
                lineHeight: '17px',
                height: '34px',
                color: T.label1,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              },
            },
            pick.title || '—',
          ),
          h(
            'div',
            {
              title: secondary || '',
              style: {
                marginTop: '2px',
                height: '15px',
                lineHeight: '15px',
                fontSize: '10.5px',
                color: T.label2,
                // The line is always there, so a title with no second name does
                // not make its card shorter than its neighbours.
                opacity: secondary ? 0.72 : 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            secondary || '\u00A0',
          ),
          h(
            'div',
            {
              style: {
                marginTop: 'auto',
                paddingTop: '5px',
                height: '20px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '10px',
                lineHeight: '15px',
                color: T.label2,
                fontVariantNumeric: 'tabular-nums',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              },
            },
            h('span', { style: { color: statusColor, fontWeight: 600 } }, statusLabel),
            rated ? h('span', { style: { opacity: 0.85 } }, '★ ' + rated) : null,
            pick.releaseDate
              ? h('span', { style: { opacity: 0.7 } }, formatDate(pick.releaseDate, lang))
              : null,
          ),
        ),
      )
    }

    /** The full record for one title: big poster, whole synopsis, every comment. */
    function DetailView(props) {
      const pick = props.pick
      const t = props.t
      const lang = props.lang
      const metrics = pick.metrics || {}
      const synopsis = Array.isArray(pick.synopsis) ? pick.synopsis : []
      const comments = Array.isArray(pick.comments) ? pick.comments : []
      const genres = Array.isArray(pick.genres) ? pick.genres : []
      const now = pick.releaseStatus === 'now'
      const secondary = pick.originalTitle && pick.originalTitle !== pick.title ? pick.originalTitle : null
      const meta = [
        pick.releaseDate ? formatDate(pick.releaseDate, lang) : null,
        pick.region ? regionLabel(pick.region) : null,
        pick.mediaType === 'series' ? t.series : t.movie,
      ].filter(Boolean)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px 16px 28px' } },
        h(
          'button',
          {
            type: 'button',
            onClick: props.onBack,
            style: {
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 9px 3px 6px',
              borderRadius: '999px',
              background: T.layer2,
              border: '1px solid ' + T.border2,
              color: T.label2,
              fontSize: '11.5px',
              font: 'inherit',
              cursor: 'pointer',
            },
          },
          '← ' + t.back,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' } },
          h(
            'div',
            { style: { flex: '0 0 216px', width: '216px', maxWidth: '216px' } },
            h(Poster, {
              url: pick.poster || pick.cover,
              alt: pick.title,
              initial: String(pick.title || '?').slice(0, 1),
              emptyLabel: t.noPoster,
              eager: true,
            }),
          ),
          h(
            'div',
            { style: { flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '9px' } },
            h(
              'div',
              null,
              h(
                'div',
                { style: { fontSize: '19px', fontWeight: 650, lineHeight: 1.25, color: T.label1, letterSpacing: '.01em' } },
                pick.title || '—',
              ),
              secondary
                ? h('div', { style: { marginTop: '3px', fontSize: '12px', color: T.label2, opacity: 0.78 } }, secondary)
                : null,
              h(
                'div',
                {
                  style: {
                    marginTop: '7px',
                    display: 'flex',
                    gap: '7px',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    fontSize: '11px',
                    color: T.label2,
                    fontVariantNumeric: 'tabular-nums',
                  },
                },
                h(
                  'span',
                  { style: { color: now ? T.success : T.warn, fontWeight: 600 } },
                  now ? t.nowShowing : t.upcoming,
                ),
                meta.length > 0 ? h('span', null, meta.join(' · ')) : null,
                genres.length > 0 ? h('span', { style: { opacity: 0.85 } }, genres.join(' / ')) : null,
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h(Chip, {
                label: t.score,
                value: pick.composite,
                text: String(pick.composite ?? '—'),
                scale: 100,
                title: t.score,
              }),
              h(Chip, {
                label: t.douban,
                value: metrics.douban,
                scale: 10,
                text: typeof metrics.douban === 'number' ? metrics.douban.toFixed(1) : '—',
                title: t.douban,
              }),
              h(Chip, {
                label: t.rt,
                value: metrics.rottenTomatoes,
                scale: 100,
                text: typeof metrics.rottenTomatoes === 'number' ? metrics.rottenTomatoes + '%' : '—',
                title: 'Rotten Tomatoes',
              }),
              h(Chip, {
                label: t.imdb,
                value: metrics.imdb,
                scale: 10,
                text: typeof metrics.imdb === 'number' ? metrics.imdb.toFixed(1) : '—',
                title: 'IMDb',
              }),
              h(Chip, {
                label: t.buzz,
                value: metrics.buzz,
                scale: 100,
                text: typeof metrics.buzz === 'number' ? String(metrics.buzz) : '—',
                title: t.buzz,
              }),
              h(Chip, {
                label: t.anticipation,
                value: metrics.anticipation,
                scale: 100,
                text: typeof metrics.anticipation === 'number' ? String(metrics.anticipation) : '—',
                title: t.anticipation,
              }),
            ),
            synopsis.length > 0
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: { fontSize: '10px', letterSpacing: '.05em', color: T.label2, opacity: 0.6, marginBottom: '4px' } },
                    t.synopsis.toUpperCase(),
                  ),
                  h(
                    'p',
                    { style: { margin: 0, fontSize: '12.5px', lineHeight: 1.72, color: T.label2 } },
                    synopsis.join(lang === 'zh' ? '' : ' '),
                  ),
                )
              : null,
            pick.url
              ? h(
                  'a',
                  {
                    href: pick.url,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: {
                      alignSelf: 'flex-start',
                      marginTop: '2px',
                      padding: '5px 11px',
                      borderRadius: '999px',
                      background: T.layer2,
                      border: '1px solid ' + T.border2,
                      color: T.label1,
                      fontSize: '11.5px',
                      textDecoration: 'none',
                    },
                  },
                  t.openPage + ' ↗',
                )
              : null,
          ),
        ),
        comments.length > 0
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { fontSize: '10px', letterSpacing: '.05em', color: T.label2, opacity: 0.6, marginBottom: '6px' } },
                t.comments.toUpperCase(),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                comments.map((comment, index) =>
                  h(
                    'div',
                    {
                      key: index,
                      style: {
                        padding: '8px 10px',
                        borderRadius: '9px',
                        background: T.layer2,
                        border: '1px solid ' + T.border1,
                        fontSize: '12px',
                        lineHeight: 1.6,
                        color: T.label2,
                      },
                    },
                    h('span', { style: { color: T.idle } }, '“'),
                    comment.text,
                    h('span', { style: { color: T.idle } }, '”'),
                    h(
                      'div',
                      {
                        style: {
                          marginTop: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          fontSize: '10px',
                          color: T.idle,
                        },
                      },
                      comment.author ? h('span', null, '— ' + comment.author) : null,
                      h(StarRow, { stars: comment.stars }),
                      comment.translated ? h('span', { title: t.translated }, '⤳') : null,
                    ),
                  ),
                ),
              ),
            )
          : null,
      )
    }


    /** The search field at the right end of the filter row. */
    function SearchBox(props) {
      const value = props.value || ''
      return h(
        'div',
        {
          style: {
            marginLeft: 'auto',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            flex: '0 1 210px',
            minWidth: '116px',
          },
        },
        h(
          'svg',
          {
            width: 12,
            height: 12,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            'aria-hidden': 'true',
            style: {
              position: 'absolute',
              left: '8px',
              opacity: 0.55,
              pointerEvents: 'none',
              color: T.label2,
            },
          },
          h('circle', { cx: 11, cy: 11, r: 7 }),
          h('path', { d: 'M20 20l-3.6-3.6' }),
        ),
        h('input', {
          type: 'text',
          className: 'dsh-movie-search',
          value: value,
          placeholder: props.placeholder,
          'aria-label': props.placeholder,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => props.onChange(event && event.target ? event.target.value : ''),
          onKeyDown: (event) => {
            if (event && event.key === 'Escape') props.onClear()
          },
          style: {
            width: '100%',
            height: '24px',
            padding: '0 22px 0 24px',
            borderRadius: '999px',
            border: '1px solid ' + T.border2,
            background: T.layer2,
            color: T.label1,
            fontSize: '11.5px',
            fontFamily: 'inherit',
            outline: 'none',
          },
        }),
        value
          ? h(
              'button',
              {
                type: 'button',
                onClick: props.onClear,
                title: props.clearLabel,
                'aria-label': props.clearLabel,
                style: {
                  position: 'absolute',
                  right: '3px',
                  width: '18px',
                  height: '18px',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  borderRadius: '999px',
                  background: 'transparent',
                  color: T.label2,
                  fontSize: '13px',
                  lineHeight: 1,
                  cursor: 'pointer',
                },
              },
              '\u00D7',
            )
          : null,
      )
    }

    /** A labelled band inside the search view, with a hairline rule. */
    function SearchSection(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h(
            'span',
            {
              style: {
                fontSize: '10px',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: T.label2,
                opacity: 0.65,
                whiteSpace: 'nowrap',
              },
            },
            props.label,
          ),
          h('span', { style: { flex: '1 1 auto', height: '1px', background: T.border1 } }),
          props.hint
            ? h('span', { style: { fontSize: '10px', color: T.idle, whiteSpace: 'nowrap' } }, props.hint)
            : null,
        ),
        props.body,
      )
    }

    /** One consolidated web result: poster, names, metadata, synopsis, sources. */
    function SearchRow(props) {
      const row = props.row
      const t = props.t
      const lang = props.lang
      const secondary = row.originalTitle && row.originalTitle !== row.title ? row.originalTitle : null
      const meta = [
        row.year ? String(row.year) : null,
        row.mediaType === 'series' ? t.series : t.movie,
        Array.isArray(row.genres) && row.genres.length > 0 ? row.genres.slice(0, 2).join(' / ') : null,
      ].filter(Boolean)
      const sentences = Array.isArray(row.synopsisSentences) ? row.synopsisSentences : []

      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '11px',
            padding: '9px',
            borderRadius: '12px',
            background: T.layer1,
            border: '1px solid ' + T.border1,
          },
        },
        h(
          'div',
          { style: { flex: '0 0 54px', width: '54px' } },
          h(Poster, {
            url: row.cover,
            alt: row.title,
            initial: String(row.title || '?').slice(0, 1),
            emptyLabel: t.noPoster,
          }),
        ),
        h(
          'div',
          { style: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '4px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '13.5px', fontWeight: 600, color: T.label1 } }, row.title || '—'),
            secondary
              ? h(
                  'span',
                  {
                    title: secondary,
                    style: {
                      fontSize: '11px',
                      color: T.label2,
                      opacity: 0.72,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    },
                  },
                  secondary,
                )
              : null,
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                fontSize: '10.5px',
                color: T.label2,
                fontVariantNumeric: 'tabular-nums',
              },
            },
            meta.length > 0 ? h('span', null, meta.join(' \u00B7 ')) : null,
            typeof row.doubanRating === 'number'
              ? h('span', { style: { color: T.success, fontWeight: 600 } }, t.douban + ' ' + row.doubanRating.toFixed(1))
              : null,
          ),
          sentences.length > 0
            ? h(
                'p',
                {
                  style: {
                    margin: 0,
                    fontSize: '11.5px',
                    lineHeight: 1.6,
                    color: T.label2,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  },
                },
                sentences.join(lang === 'zh' ? '' : ' '),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginTop: '2px' } },
            (Array.isArray(row.sources) ? row.sources : []).map((source) =>
              h(
                'span',
                {
                  key: source,
                  style: {
                    fontSize: '9.5px',
                    lineHeight: '14px',
                    padding: '0 5px',
                    borderRadius: '999px',
                    border: '1px solid ' + T.border2,
                    color: T.idle,
                  },
                },
                source,
              ),
            ),
            row.url
              ? h(
                  'a',
                  {
                    href: row.url,
                    target: '_blank',
                    rel: 'noreferrer',
                    style: {
                      marginLeft: 'auto',
                      fontSize: '11px',
                      color: T.label1,
                      textDecoration: 'none',
                      padding: '1px 8px',
                      borderRadius: '999px',
                      background: T.layer2,
                      border: '1px solid ' + T.border2,
                    },
                  },
                  t.openPage + ' \u2197',
                )
              : null,
          ),
        ),
      )
    }

    /** Everything one query turns up: board matches first, then the web results. */
    function SearchResults(props) {
      const t = props.t
      const lang = props.lang
      const web = props.web || { status: 'idle', items: [] }
      const local = Array.isArray(props.local) ? props.local : []
      const sections = []

      if (local.length > 0) {
        sections.push(
          h(SearchSection, {
            key: 'local',
            label: t.inBoard,
            hint: String(local.length),
            body: h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(156px, 1fr))',
                  gap: '12px',
                  alignItems: 'start',
                },
              },
              local.map((pick) =>
                h(
                  'div',
                  { key: pick.id || 'rank-' + pick.rank, style: { display: 'flex', minWidth: 0 } },
                  h(PosterCard, { pick: pick, t: t, lang: lang, onOpen: props.onOpenLocal }),
                ),
              ),
            ),
          }),
        )
      }

      let webBody
      if (web.status === 'error') {
        webBody = h(
          'div',
          { style: { padding: '4px 0 10px', fontSize: '11.5px', color: T.error } },
          t.searchFailed + ': ' + web.error,
        )
      } else if (web.status === 'ready' && web.items.length === 0) {
        webBody = h('div', { style: { padding: '4px 0 12px', fontSize: '11.5px', color: T.label2, opacity: 0.85 } }, t.searchEmpty)
      } else if (web.status !== 'ready') {
        webBody = h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 0 14px',
              fontSize: '11.5px',
              color: T.label2,
            },
          },
          h('span', { style: { animation: 'dshMoviePulse 1.4s ease-in-out infinite' } }, '\u25CF'),
          t.searching,
        )
      } else {
        webBody = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          web.items.map((row, index) =>
            h(SearchRow, { key: (row.title || 'result') + '-' + index, row: row, t: t, lang: lang }),
          ),
        )
      }

      sections.push(
        h(SearchSection, {
          key: 'web',
          label: t.fromWeb,
          hint: web.status === 'ready' && web.took ? (web.took / 1000).toFixed(1) + 's' : null,
          body: webBody,
        }),
      )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px 16px 26px' } },
        sections,
      )
    }

    function Skeleton(props) {
      return h('div', {
        style: {
          height: '84px',
          borderRadius: '12px',
          background: T.layer2,
          border: '1px solid ' + T.border1,
          opacity: 0.55,
          animation: 'dshMoviePulse 1.5s ease-in-out ' + (props.index || 0) * 0.12 + 's infinite',
        },
      })
    }

    function SourceStrip(props) {
      const sources = props.sources || []
      if (sources.length === 0) return null
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '6px 14px',
            fontSize: '10px',
            color: T.label2,
            opacity: 0.85,
            borderBottom: '1px solid ' + T.border1,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        h('span', { style: { letterSpacing: '.04em', opacity: 0.6, textTransform: 'uppercase' } }, props.label),
        sources.map((source) =>
          h(
            'span',
            {
              key: source.id,
              title: source.error ? source.id + ': ' + source.error : source.id,
              style: { display: 'inline-flex', alignItems: 'center', gap: '3px' },
            },
            h('span', {
              style: {
                width: '5px',
                height: '5px',
                borderRadius: '999px',
                background: source.ok ? T.success : T.error,
                display: 'inline-block',
              },
            }),
            source.id,
          ),
        ),
      )
    }

    function ActionButton(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          disabled: Boolean(props.disabled),
          title: props.title || '',
          'aria-label': props.title || props.label,
          'aria-pressed': props.pressed === undefined ? undefined : Boolean(props.pressed),
          style: {
            cursor: props.disabled ? 'default' : 'pointer',
            fontSize: '11px',
            fontFamily: 'inherit',
            color: props.active ? T.label1 : T.label2,
            background: props.active ? T.layer2 : 'transparent',
            border: '1px solid ' + (props.active ? T.brand : T.border2),
            borderRadius: '999px',
            padding: '2px 9px',
            opacity: props.disabled ? 0.5 : 1,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        },
        props.label,
      )
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    function MoviePanel() {
      const ctx = runtime
      const langPair = useLang(ctx)
      const lang = langPair[0]
      const chooseLang = langPair[1]
      const t = I18N[lang] || I18N.zh

      const filterPair = React.useState('all')
      const filter = filterPair[0]
      const setFilter = filterPair[1]

      // The open detail is stored as an id, so a refresh or a language switch
      // re-resolves it against the fresh board instead of showing a stale row.
      const selectedPair = React.useState(null)
      const selectedId = selectedPair[0]
      const setSelectedId = selectedPair[1]

      // Search runs on two levels: the board filters instantly, and the plugin
      // is asked to search the web once the typing pauses.
      const queryPair = React.useState('')
      const query = queryPair[0]
      const setQuery = queryPair[1]
      const webPair = React.useState({ status: 'idle', items: [], error: null, took: 0 })
      const web = webPair[0]
      const setWeb = webPair[1]

      const statePair = React.useState(() => ({
        status: boardCache[lang] ? 'ready' : 'loading',
        board: boardCache[lang],
        error: null,
      }))
      const state = statePair[0]
      const setState = statePair[1]
      const elapsedPair = React.useState(0)
      const elapsed = elapsedPair[0]
      const setElapsed = elapsedPair[1]
      const mounted = React.useRef(true)

      React.useEffect(
        () => () => {
          mounted.current = false
        },
        [],
      )

      const load = React.useCallback(
        (force) => {
          const controller = new AbortController()
          const cached = boardCache[lang]
          setState({
            status: force ? 'refreshing' : cached ? 'ready' : 'loading',
            board: cached || null,
            error: null,
          })
          if (!force && cached) return () => controller.abort()
          requestBoard(lang, Boolean(force), controller.signal)
            .then((board) => {
              boardCache[lang] = board
              if (mounted.current) setState({ status: 'ready', board: board, error: null })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              if (mounted.current) {
                setState({ status: 'error', board: boardCache[lang] || null, error: String(error.message || error) })
              }
            })
          return () => controller.abort()
        },
        [lang],
      )

      React.useEffect(() => {
        const cancel = load(false)
        return cancel
      }, [load])

      const busy = state.status === 'loading' || state.status === 'refreshing'
      React.useEffect(() => {
        if (!busy) {
          setElapsed(0)
          return undefined
        }
        const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000)
        return () => window.clearInterval(timer)
      }, [busy])

      const needle = query.trim().toLowerCase()

      React.useEffect(() => {
        const term = query.trim()
        if (term.length < 2) {
          setWeb({ status: 'idle', items: [], error: null, took: 0 })
          return undefined
        }
        const controller = new AbortController()
        setWeb({ status: 'loading', items: [], error: null, took: 0 })
        const timer = window.setTimeout(() => {
          requestSearch(term, lang, controller.signal)
            .then((payload) => {
              if (controller.signal.aborted || !mounted.current) return
              setWeb({
                status: 'ready',
                items: Array.isArray(payload.results) ? payload.results : [],
                error: null,
                took: typeof payload.took === 'number' ? payload.took : 0,
              })
            })
            .catch((error) => {
              if (controller.signal.aborted || !mounted.current) return
              setWeb({ status: 'error', items: [], error: String(error.message || error), took: 0 })
            })
        }, 320)
        return () => {
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [query, lang])

      const board = state.board
      const picks = (board && board.picks) || []
      const counts = (board && board.counts) || { total: 0, now: 0, upcoming: 0 }
      const visible = filter === 'all' ? picks : picks.filter((pick) => pick.releaseStatus === filter)
      const matched =
        needle === ''
          ? visible
          : visible.filter((pick) =>
              [pick.title, pick.originalTitle, pick.mediaType === 'series' ? 'series tv' : 'movie film']
                .concat(Array.isArray(pick.genres) ? pick.genres : [])
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(needle),
            )

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '12px 14px 10px',
            borderBottom: '1px solid ' + T.border1,
            background: T.layer1,
            position: 'sticky',
            top: 0,
            zIndex: 2,
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '7px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '14px', fontWeight: 600, color: T.label1, letterSpacing: '.01em' } }, t.title),
            h(
              'span',
              { style: { fontSize: '10.5px', color: T.label2, opacity: 0.7 } },
              t.subtitle,
            ),
          ),
          h(
            'div',
            {
              role: 'status',
              'aria-live': 'polite',
              style: {
                marginTop: '2px',
                fontSize: '10.5px',
                color: T.label2,
                opacity: 0.8,
                fontVariantNumeric: 'tabular-nums',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            state.status === 'refreshing'
              ? t.refreshing
              : state.status === 'loading'
                ? t.loading + (elapsed > 3 ? ' · ' + t.building + ' ' + elapsed + 's' : '')
                : board && board.generatedAt
                  ? t.updated + ' ' + new Date(board.generatedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-GB')
                  : t.loadingHint,
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', flex: '0 0 auto' } },
          h(ActionButton, {
            label: t.langToggle,
            title: t.langToggle,
            active: false,
            onClick: () => chooseLang(lang === 'zh' ? 'en' : 'zh'),
          }),
          h(ActionButton, {
            label: busy ? '…' : t.refresh,
            title: t.refresh,
            disabled: busy,
            onClick: () => load(true),
          }),
        ),
      )

      const bannerLines = []
      if (board && board.degraded) bannerLines.push(t.degraded)
      if (board && board.translation && board.translation.failed > 0) bannerLines.push(t.translationFailed)

      const filterChips =
        picks.length > 0
          ? [
              h(ActionButton, {
                key: 'all',
                label: t.all + ' ' + counts.total,
                active: filter === 'all',
                pressed: filter === 'all',
                onClick: () => setFilter('all'),
              }),
              h(ActionButton, {
                key: 'now',
                label: t.nowShowing + ' ' + counts.now,
                active: filter === 'now',
                pressed: filter === 'now',
                onClick: () => setFilter('now'),
              }),
              h(ActionButton, {
                key: 'upcoming',
                label: t.upcoming + ' ' + counts.upcoming,
                active: filter === 'upcoming',
                pressed: filter === 'upcoming',
                onClick: () => setFilter('upcoming'),
              }),
            ]
          : []

      const filters = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: '8px 14px',
            borderBottom: '1px solid ' + T.border1,
            flexWrap: 'wrap',
          },
        },
        filterChips,
        h(SearchBox, {
          value: query,
          placeholder: t.searchPlaceholder,
          clearLabel: t.searchClear,
          onChange: setQuery,
          onClear: () => setQuery(''),
        }),
      )

      let body
      if (needle.length >= 2) {
        body = h(SearchResults, {
          t: t,
          lang: lang,
          web: web,
          local: matched,
          onOpenLocal: (row) => setSelectedId(row.id || 'rank-' + row.rank),
        })
      } else if (state.status === 'error' && picks.length === 0) {
        body = h(
          'div',
          { style: { padding: '20px 16px', fontSize: '12px', color: T.label2, lineHeight: 1.6 } },
          h('div', { style: { color: T.error, fontWeight: 600, marginBottom: '4px' } }, t.error + ': ' + state.error),
          h('div', { style: { opacity: 0.8 } }, t.errorHint),
          h('div', { style: { marginTop: '10px' } }, h(ActionButton, { label: t.retry, onClick: () => load(true) })),
        )
      } else if (busy && picks.length === 0) {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '9px', padding: '12px 14px' } },
          [0, 1, 2, 3, 4].map((index) => h(Skeleton, { key: index, index: index })),
          h(
            'div',
            { style: { fontSize: '10.5px', color: T.label2, opacity: 0.7, paddingTop: '2px' } },
            t.loadingHint,
          ),
        )
      } else if (matched.length === 0) {
        body = h(
          'div',
          { style: { padding: '22px 16px', fontSize: '12px', color: T.label2, lineHeight: 1.7 } },
          h('div', { style: { color: T.label1, fontWeight: 600, marginBottom: '5px' } }, t.empty),
          h('div', { style: { opacity: 0.8 } }, t.emptyHint),
          h('div', { style: { marginTop: '10px' } }, h(ActionButton, { label: t.refresh, onClick: () => load(true) })),
        )
      } else {
        body = h(
          'div',
          {
            role: 'list',
            'aria-label': t.title,
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(156px, 1fr))',
              gap: '12px',
              padding: '14px 16px 26px',
              alignItems: 'start',
            },
          },
          matched.map((pick) =>
            h(
              'div',
              { key: pick.id || 'rank-' + pick.rank, role: 'listitem', style: { display: 'flex', minWidth: 0 } },
              h(PosterCard, {
                pick: pick,
                t: t,
                lang: lang,
                onOpen: (row) => setSelectedId(row.id || 'rank-' + row.rank),
              }),
            ),
          ),
        )
      }

      const selectedPick = selectedId ? picks.find((pick) => (pick.id || 'rank-' + pick.rank) === selectedId) : null
      if (selectedPick) {
        body = h(DetailView, { pick: selectedPick, t: t, lang: lang, onBack: () => setSelectedId(null) })
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            overflowY: 'auto',
            background: T.base,
            color: T.label1,
            fontFamily: 'inherit',
          },
        },
        h(
          'style',
          null,
          '@keyframes dshMoviePulse{0%,100%{opacity:.35}50%{opacity:.7}}' +
            '.dsh-movie-search::placeholder{color:' +
            T.label2 +
            ';opacity:.65}' +
            '.dsh-movie-search::-webkit-search-cancel-button{display:none}',
        ),
        header,
        bannerLines.length > 0
          ? h(
              'div',
              {
                style: {
                  padding: '6px 14px',
                  fontSize: '10.5px',
                  color: T.warn,
                  background: T.layer2,
                  borderBottom: '1px solid ' + T.border1,
                  lineHeight: 1.5,
                },
              },
              bannerLines.join(' · '),
            )
          : null,
        selectedPick ? null : filters,
        selectedPick ? null : h(SourceStrip, { sources: board && board.sources, label: t.sources }),
        body,
      )
    }

    /**
     * The left-sidebar button. The sidebar owns the hit target, the tooltip and
     * the selected state; this only draws the glyph at the requested edge.
     */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
      const active = Boolean(props.active)
      const stroke = active ? T.brand : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          role: 'img',
          'aria-label': I18N[langStore.lang || 'zh'].iconLabel,
          style: { display: 'block', opacity: active ? 1 : 0.86 },
        },
        h('rect', {
          x: '3',
          y: '4.5',
          width: '18',
          height: '15',
          rx: '3',
          stroke: stroke,
          strokeWidth: '1.5',
        }),
        h('path', { d: 'M10.4 9.2 15.4 12 10.4 14.8Z', fill: stroke }),
        h('path', { d: 'M3 17.6h18', stroke: stroke, strokeWidth: '1.2', strokeLinecap: 'round', opacity: 0.55 }),
        h('circle', { cx: '6.4', cy: '7.6', r: '0.9', fill: stroke, opacity: 0.85 }),
        h('circle', { cx: '9.6', cy: '7.6', r: '0.9', fill: stroke, opacity: 0.85 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        runtime = ctx

        // This entry is boot-gating: an exception thrown out of apply() fails the
        // page boot for the whole app, not just this panel. Every setup step is
        // therefore isolated, so a missing service degrades instead of aborting.
        const attempt = (step) => {
          try {
            return step()
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('dsh-movie: client setup step failed', error)
            }
            return undefined
          }
        }

        attempt(() => {
          if (!langStore.lang) langStore.lang = detectLang(ctx)
        })

        const keep = (step) => attempt(step)

        keep(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 7,
                label: () => I18N[langStore.lang || 'zh'].title,
              },
              PanelIcon,
            ),
          ),
        )

        keep(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, MoviePanel),
          ),
        )

        // Follow the harness language until the reader chooses one themselves.
        keep(() =>
          ctx.effect(() => {
            const locale = ctx.locale
            if (!locale || typeof locale.subscribe !== 'function') return undefined
            return locale.subscribe(() => {
              if (langStore.manual) return
              setLang(detectLang(ctx))
            })
          }, 'dsh-movie: follow harness locale'),
        )

        // Slot registrations, the locale subscription and the effect dispose with
        // the plugin fiber; there is nothing to tear down by hand here.
      },
    }
  },
})
