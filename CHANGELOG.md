# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-11-05

First public release. Earlier internal milestones (0.1.0–0.3.0) were never published, so everything
they added is listed here as well.

### Added

- **Title search** — a field at the right of 「全部 · 上映中 · 待映」 that filters the board as you type and,
  after a 0.3 s pause, asks Douban, TVMaze and the iTunes storefront in parallel. Records for the same title
  are merged into one row: Douban supplies the Chinese name, synopsis, genres and score, TVMaze the series
  data, iTunes the release date and artwork. Results are cached for ten minutes, board matches and web
  matches are grouped separately, and the film-or-series judgement comes from the subject API rather than
  the suggestion endpoint.
- **Poster resolution** — a title with no usable cover is searched by name on Douban / TVMaze / iTunes and
  the found poster is proxied, so a board shows posters instead of icons (19 of 20 titles on a typical
  board).
- **Poster-forward layout** — the board is a 2:3 poster grid with rank and score overlaid; clicking a card
  opens a detail view with the large poster, the whole synopsis and every comment.
- **Poster proxy** — `GET /dsh-movie/api/cover`, same-origin, with the per-CDN `Referer` each image host
  requires, an LRU cache and a host allowlist.
- **`movie_board` tool** — `refresh | read | clear` for the agent.
- **`/api/search`, `/api/health`, `/api/wiring`** routes; `wiring` reports how the bundle appears in the
  browser boot graph, which separates "not wired" from "page not refreshed".

### Changed

- Translation goes through the Host `translator` service (keyless Bing/Google routes with a probe and a
  time budget) instead of anonymous HTTP endpoints that are unreachable on some networks, with the
  session's own model route as the last fallback.
- Rank pills are drawn on their own dark plate with white numerals for every rank, and the top three are
  marked with a brand-coloured ring instead of a brand-coloured fill, so contrast no longer depends on the
  theme's `brand-primary` (which is white in light themes).

### Fixed

- Cards with and without an original-language subtitle no longer differ in height: the title box always
  reserves two lines, the subtitle line always occupies its own row, and the metadata row is pinned to the
  bottom of the card.
- The plugin no longer fails to boot when `dsh.client.inject` names packages that do not exist in the
  running profile.
- Status text («待映») and indicator chips no longer use `brand-primary` as a text colour.

## [Unreleased]

Nothing yet.
