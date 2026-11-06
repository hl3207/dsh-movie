# Developing

There is no build step: `client.js` is hand-written `h()` calls against React, `index.js` is a Cordis
plugin, and the published package is the repository. Node only appears to run the check script.

## Run it from this checkout

Install the checkout itself into a scratch profile and restart DeepSeek Harness:

```sh
dsh plugin --profile dev add "file:$PWD"
```

Windows PowerShell:

```powershell
dsh plugin --profile dev add "file:$((Get-Location).Path)"
```

The first build of the board takes 15–25 seconds (six sources plus translation); look at the panel's
progress line, then at `/dsh-movie/api/health` for `picked` and the build time.

## Iterating on the Client half

The Client bundle is served per page load, so a code change needs a page reload — not an app restart:

1. `npm run check` (syntax, identity, locale resources).
2. Reload the page (`Ctrl+R`). The URL carries a `rev` hash, so a stale bundle is impossible to mistake for
   a code bug.
3. If the sidebar entry is missing entirely, read `/dsh-movie/api/wiring`: `inGraph: false` means the
   bundle is not wired into the boot graph, `inGraph: true` with no entry means the page was not reloaded.

## Layering

| Layer | Files | Owns |
| --- | --- | --- |
| Providers | `lib/providers.js`, `lib/pipeline.js`, `lib/util.js` | Reaching the public sources, scoring, diversity caps |
| Enrichment | `lib/enrich.js` | Douban / TVMaze / iTunes detail, synopsis sentences, comment selection |
| Covers | `lib/covers.js` | Poster lookup, URL normalisation, the same-origin image proxy and its cache |
| Search | `lib/search.js` | Merging three sources into one record per title |
| Host | `index.js` | Config schema, the `movie_board` tool, the HTTP routes, translation |
| Client | `client.js` | Slots, the board, the detail view, the search view, the zh/en switch |

The Host and the Client only meet through JSON payloads and the fixed `/dsh-movie/api/*` paths, which is
what lets the same package run in the desktop app and in the Web GUI.

## Profiling a slow board

`/dsh-movie/api/health` returns `buildMs`. A cold build over six sources is 15–25 s; a warm read is a memory
hit and returns in milliseconds. If a build is slow with a warm cache, the culprit is translation, not the
sources — set `translate: false` to confirm before changing pipeline code.
