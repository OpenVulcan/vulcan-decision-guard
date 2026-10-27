// Pack the dsh plugin as one self-contained tarball: the plugin with @openvulcan/vulcan-decision
// inside it as a bundled dependency, so `dsh plugin add` installs a single package and never looks
// the engine up in a registry. Run after `pnpm -r run build`; writes dist/<name>-<version>.tgz.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const PLUGIN = path.join(ROOT, 'packages', 'dsh-decision-guard')
const ENGINE = path.join(ROOT, 'packages', 'vulcan-decision')
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(DIST, '.stage-dsh-plugin')
const ENGINE_NAME = '@openvulcan/vulcan-decision'

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const isTest = name => /\.test\./.test(name)

/** Copy `from` into `to`, leaving out compiled tests and the test helpers. */
function copy(from, to, keep = () => true) {
  fs.cpSync(from, to, { recursive: true, filter: source => !isTest(path.basename(source)) && keep(source) })
}

/** The manifest as published: no scripts or development dependencies. */
function published(manifest) {
  const { scripts: _scripts, devDependencies: _dev, ...rest } = manifest
  return rest
}

for (const [dir, what] of [[PLUGIN, 'plugin'], [ENGINE, 'engine']]) {
  if (!fs.existsSync(path.join(dir, 'lib', 'index.js'))) throw new Error(`the ${what} is not built; run pnpm -r run build first`)
}

fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

const engine = readJson(path.join(ENGINE, 'package.json'))
const plugin = readJson(path.join(PLUGIN, 'package.json'))
if (plugin.dependencies?.[ENGINE_NAME] === undefined) throw new Error(`the plugin no longer depends on ${ENGINE_NAME}`)

// The plugin, as its own `files` list publishes it.
copy(path.join(PLUGIN, 'lib'), path.join(STAGE, 'lib'))
fs.copyFileSync(path.join(PLUGIN, 'cordis.patch.yml'), path.join(STAGE, 'cordis.patch.yml'))
fs.copyFileSync(path.join(PLUGIN, 'README.md'), path.join(STAGE, 'README.md'))
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'))
fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify({
  ...published(plugin),
  dependencies: { ...plugin.dependencies, [ENGINE_NAME]: engine.version },
  bundleDependencies: [ENGINE_NAME],
}, null, 2)}\n`)

// The engine, as its own `files` list publishes it.
const bundled = path.join(STAGE, 'node_modules', ...ENGINE_NAME.split('/'))
fs.mkdirSync(bundled, { recursive: true })
copy(path.join(ENGINE, 'bin'), path.join(bundled, 'bin'))
copy(path.join(ENGINE, 'lib'), path.join(bundled, 'lib'))
copy(path.join(ENGINE, 'python'), path.join(bundled, 'python'), source => fs.statSync(source).isDirectory() || source.endsWith('.py'))
copy(path.join(ENGINE, 'runtime-packs'), path.join(bundled, 'runtime-packs'),
  source => fs.statSync(source).isDirectory() || (source.endsWith('.json') && path.basename(source) !== 'spec.json'))
fs.copyFileSync(path.join(ENGINE, 'README.md'), path.join(bundled, 'README.md'))
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(bundled, 'LICENSE'))
fs.writeFileSync(path.join(bundled, 'package.json'), `${JSON.stringify(published(engine), null, 2)}\n`)

// One command string: on Windows npm is a .cmd script, which only runs through a shell.
const [packed] = JSON.parse(execSync(`npm pack --json --pack-destination "${DIST}"`, { cwd: STAGE, encoding: 'utf8' }))
fs.rmSync(STAGE, { recursive: true, force: true })
console.log(`${path.join(DIST, packed.filename)} (${(packed.size / 1024).toFixed(0)} KiB, ${packed.entryCount} files, bundles ${ENGINE_NAME} ${engine.version})`)
