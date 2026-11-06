# Contributing

This package is a DeepSeek Harness **bundle**: a Host half (`index.js` + `lib/`) and a Client half
(`client.js`) joined by `cordis.patch.yml`. There is no build step and no bundler — `client.js` is
hand-written `h()` calls, and the package ships exactly what you see in the repository.

## Before a pull request

```sh
npm run check
```

That runs `scripts/check.mjs`, which verifies one thing people break most often: **the bundle's identity is
spelled the same way in four places**

| Where | What |
| --- | --- |
| `package.json` | `name` |
| `cordis.patch.yml` | the Host row's `name:` — must be the exact package specifier |
| `index.js` | `export const name` |
| `client.js` | `__ModuleLoader__.load({ id })` |

A mismatch does not crash anything: the plugin installs, the sidebar entry simply never draws. The check
also syntax-checks every shipped JavaScript file, parses the locale resources, and confirms that everything
listed in `files` exists.

## What makes a reviewable change

- **Keep both halves in step.** A new field on a board pick is a change to `lib/`, `index.js` and
  `client.js` — the Host builds the payload, the Client renders it, and neither knows about the other.
- **Never let one source fail the request.** Providers degrade: record what is missing on the board
  (`degraded`, source health) instead of throwing.
- **Stay inside the theme.** Use the `--dsw-alias-*` tokens (`T.bg`, `T.label1`, `T.border1`, …). Do not use
  `brand-primary` as a text colour: it is white in light themes, and the result is invisible text.
- **No build tooling, no runtime dependencies.** The package has zero `dependencies`; keep it that way.
- **Translate through the Host.** Do not call translation or image endpoints directly from the Client.
- **Update `CHANGELOG.md`** under `## [Unreleased]`.

## Reporting a bug

Please include: the DSH version (`dsh --version`), the plugin version, what the panel showed, and — most
useful of all — the output of

```sh
curl -s http://127.0.0.1:<port>/dsh-movie/api/health
curl -s http://127.0.0.1:<port>/dsh-movie/api/wiring
```

`wiring` tells a "not loaded" problem apart from a "not refreshed" problem in one look.

## Licence

By contributing you agree that your work is licensed under the Apache-2.0 licence of this repository.
