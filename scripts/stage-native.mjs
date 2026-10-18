#!/usr/bin/env node
// Stage the per-platform npm packages that carry the native `vulcan-decision` executable.
//
// The set of platform packages is defined once: the optionalDependencies of the dsh plugin.
// This script only maps each of them to the Rust target that builds it, and refuses to run when
// the two disagree or when the Cargo, plugin and platform versions differ.
//
// usage: node scripts/stage-native.mjs [--only <os>-<cpu>]... [--out <dir>]
//   Expects `cargo build --release --target <triple>` output under target/<triple>/release/.
//   Without --only every platform is staged and a missing build is an error.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginManifestPath = path.join(root, 'packages/dsh-decision-guard/package.json')
const PLATFORM_PREFIX = '@openvulcan/vulcan-decision-'

/** Rust target for each `<os>-<cpu>` platform package, in Node's `process.platform`/`process.arch` terms. */
const RUST_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

function fail(message) {
  console.error(`stage-native: ${message}`)
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    out: { type: 'string', default: path.join(root, 'dist/npm') },
  },
})

const plugin = JSON.parse(readFileSync(pluginManifestPath, 'utf8'))
const cargoVersion = /\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/.exec(
  readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
)?.[1]
if (cargoVersion === undefined) fail('cannot read [workspace.package] version from Cargo.toml')
if (plugin.version !== cargoVersion) {
  fail(`plugin version ${plugin.version} differs from Cargo workspace version ${cargoVersion}`)
}

const platforms = Object.entries(plugin.optionalDependencies ?? {})
  .filter(([name]) => name.startsWith(PLATFORM_PREFIX))
  .map(([name, spec]) => ({ name, spec, key: name.slice(PLATFORM_PREFIX.length) }))
for (const { name, spec, key } of platforms) {
  if (!(key in RUST_TARGETS)) fail(`${name} has no Rust target in RUST_TARGETS`)
  if (spec !== cargoVersion) fail(`${name} is pinned to ${spec}, expected exactly ${cargoVersion}`)
}
for (const key of Object.keys(RUST_TARGETS)) {
  if (!platforms.some(platform => platform.key === key)) {
    fail(`RUST_TARGETS lists ${key}, but the plugin has no ${PLATFORM_PREFIX}${key} optional dependency`)
  }
}

const selected = values.only ?? platforms.map(platform => platform.key)
for (const key of selected) {
  if (!platforms.some(platform => platform.key === key)) fail(`unknown platform ${key}`)
}

for (const { name, key } of platforms.filter(platform => selected.includes(platform.key))) {
  const [os, cpu] = key.split('-')
  const executable = os === 'win32' ? 'vulcan-decision.exe' : 'vulcan-decision'
  const built = path.join(root, 'target', RUST_TARGETS[key], 'release', executable)
  if (!existsSync(built)) fail(`missing ${built}; run cargo build --release --target ${RUST_TARGETS[key]}`)

  const dir = path.join(values.out, `vulcan-decision-${key}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'bin'), { recursive: true })
  const staged = path.join(dir, 'bin', executable)
  copyFileSync(built, staged)
  chmodSync(staged, 0o755)

  const manifest = {
    name,
    version: cargoVersion,
    description: `The vulcan-decision executable for ${key}. Installed through @openvulcan/dsh-decision-guard.`,
    license: plugin.license,
    repository: { type: plugin.repository.type, url: plugin.repository.url },
    os: [os],
    cpu: [cpu],
    ...os === 'linux' ? { libc: ['glibc'] } : {},
    files: ['bin'],
    preferUnplugged: true,
    publishConfig: { access: 'public' },
  }
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`staged ${name}@${cargoVersion} -> ${path.relative(root, dir)}`)
}
