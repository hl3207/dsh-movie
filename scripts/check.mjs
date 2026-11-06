#!/usr/bin/env node
/**
 * Release self-check — no dependencies, runs on plain Node.
 *
 * A bundle has one identity that has to be spelled the same way in four places:
 * the package name, the `name:` of the Host row in the patch, the `name` export
 * of the Host half, and the module-loader id of the Client half. Get one of them
 * wrong and the plugin still installs — it just silently draws nothing, which is
 * the hardest failure to debug. This script is the guard against that.
 *
 * It also syntax-checks every shipped JavaScript file and parses the locale
 * resources, so `npm run check` is a full pre-publish gate.
 *
 * Usage: node scripts/check.mjs   (also runs in CI, see .github/workflows)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []

function check(label, problem) {
  results.push({ label, problem: problem || null })
}

function readJSON(relativePath) {
  const text = readFileSync(join(ROOT, relativePath), 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/* ------------------------------------------------------------------ manifest */

const pkg = readJSON('package.json')
const name = String(pkg.name || '')
const scoped = name.startsWith('@')

check('package.json declares a name', name ? null : 'name is empty')
check(
  'scoped packages publish publicly',
  !scoped || pkg.publishConfig?.access === 'public' ? null : 'add publishConfig.access = "public"',
)
check('package.json is not private', pkg.private === true ? 'remove "private": true before publishing' : null)

/* ------------------------------------------------- one identity, four places */

const patchPath = pkg.dsh?.bundle?.patch
check('dsh.bundle.patch is declared', patchPath ? null : 'package.json needs dsh.bundle.patch')
check('the patch file exists', patchPath && existsSync(join(ROOT, patchPath)) ? null : String(patchPath))

if (patchPath && existsSync(join(ROOT, patchPath))) {
  const patch = readFileSync(join(ROOT, patchPath), 'utf8')
  const rowName = patch.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1] ?? null
  check(
    'the Host row name is the package name',
    rowName === name ? null : 'patch says ' + JSON.stringify(rowName) + ', package says ' + JSON.stringify(name),
  )
}

const hostSource = readFileSync(join(ROOT, 'index.js'), 'utf8')
const hostName = hostSource.match(/export const name = ['"]([^'"]+)['"]/)?.[1] ?? null
check(
  'the Host export name is the package name',
  hostName === name ? null : 'index.js exports ' + JSON.stringify(hostName),
)

const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8')
const clientId = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)?.[1] ?? null
check(
  'the Client loader id is the package name',
  clientId === name ? null : 'client.js loads ' + JSON.stringify(clientId),
)
check('the Client half is exported', pkg.exports?.['./client'] ? null : 'package.json needs exports["./client"]')
check('the Client half is injected immediately', pkg.dsh?.client?.immediately === true ? null : 'set dsh.client.immediately')
check('the Client platform is web', pkg.dsh?.client?.platform === 'web' ? null : 'set dsh.client.platform = "web"')

/* ---------------------------------------------------------------- shipped set */

for (const declared of pkg.files ?? []) {
  if (declared.includes('*')) continue
  check('shipped file exists: ' + declared, existsSync(join(ROOT, declared)) ? null : 'missing')
}
check('the entry point exists', pkg.main && existsSync(join(ROOT, pkg.main)) ? null : String(pkg.main))
check('the icon exists', pkg.icon && existsSync(join(ROOT, pkg.icon)) ? null : String(pkg.icon))
check('a license file exists', existsSync(join(ROOT, 'LICENSE')) ? null : 'add LICENSE')
check('the dsh engine range is declared', pkg.engines?.dsh ? null : 'add engines.dsh so the market can match hosts')

/* ------------------------------------------------- storefront declarations */

// The catalog reads two things from this repository besides package.json:
// screenshots.json (paths relative to the repo root, 1-8 images) and the entry
// file the maintainer is handed. Both are easy to break silently.
const shotsPath = join(ROOT, 'screenshots.json')
if (existsSync(shotsPath)) {
  let shots = null
  try {
    shots = JSON.parse(readFileSync(shotsPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    check('screenshots.json parses', String(error.message))
  }
  check('screenshots.json is an array', Array.isArray(shots) ? null : 'expected an array of paths')
  if (Array.isArray(shots)) {
    check('1-8 screenshots declared', shots.length >= 1 && shots.length <= 8 ? null : String(shots.length) + ' declared')
    for (const shot of shots) {
      const inside =
        typeof shot === 'string' && !shot.startsWith('/') && !shot.split('/').includes('..') && !/^https?:/i.test(shot)
      check('screenshot stays inside the repo: ' + shot, inside ? null : 'must be a relative path inside the plugin')
      if (inside) check('screenshot exists: ' + shot, existsSync(join(ROOT, shot)) ? null : 'file missing')
    }
  }
}

const entryPath = join(ROOT, 'docs/plugin-entry.yml')
if (existsSync(entryPath)) {
  const entry = readFileSync(entryPath, 'utf8')
  const owner = (pkg.repository?.url ?? '').match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  const field = (key) =>
    entry
      .match(new RegExp('^' + key + ':\\s*(\\S+)', 'm'))?.[1]
      ?.replace(/^['"]|['"]$/g, '') ?? ''
  const categories = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun']
  check('the catalog entry has an en description', /^\s{2}en:/m.test(entry) ? null : 'description.en is required')
  check('the catalog entry category is valid', categories.includes(field('category')) ? null : field('category'))
  if (owner) {
    const expected = owner[1] + '/' + owner[2]
    check('the catalog entry url matches the repository', field('url') === 'https://github.com/' + expected ? null : field('url'))
    check('the catalog entry name is owner/repo', field('name') === expected ? null : field('name'))
  }
} else {
  check('docs/plugin-entry.yml exists', 'missing — this is the file the catalog asks for')
}

/* ------------------------------------------------------------------- syntax */

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full)
  }
  return out
}

let checked = 0
for (const file of walk(ROOT)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    checked += 1
  } catch (error) {
    check('syntax: ' + relative(ROOT, file), String(error.stderr || error.message).split('\n')[0])
  }
}
check('every shipped script parses (' + checked + ' files)', checked > 0 ? null : 'no JavaScript found')

/* ------------------------------------------------------------------ locales */

for (const file of existsSync(join(ROOT, 'locale')) ? readdirSync(join(ROOT, 'locale')) : []) {
  if (!file.endsWith('.json')) continue
  try {
    const locale = readJSON(join('locale', file))
    check('locale ' + file + ' has a title', locale.meta?.title ? null : 'meta.title is empty')
    check('locale ' + file + ' has a description', locale.meta?.description ? null : 'meta.description is empty')
  } catch (error) {
    check('locale ' + file + ' parses', String(error.message))
  }
}

/* -------------------------------------------------------------------- report */

const failed = results.filter((row) => row.problem)
for (const row of results) {
  console.log((row.problem ? 'FAIL ' : 'ok   ') + row.label + (row.problem ? ' — ' + row.problem : ''))
}
console.log('')
console.log(failed.length === 0 ? 'release check: OK (' + name + '@' + pkg.version + ')' : 'release check: ' + failed.length + ' failure(s)')
process.exit(failed.length === 0 ? 0 : 1)
