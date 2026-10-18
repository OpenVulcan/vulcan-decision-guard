#!/usr/bin/env node
// Wrap the compiled browser half into the lazy factory that dsh's page module loader registers:
// `window.__ModuleLoader__.load({ id, factory(require) })`, as described in dsh's client module
// system README. The client compiles to one CommonJS file whose only requests are modules dsh
// serves to every plugin, so no bundler is involved.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
/** Requests answered by dsh's baseline page module table (`packages/client/web/src/platform.ts`). */
const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])

const compiled = readFileSync(path.join(root, 'build/client/index.js'), 'utf8')
  .replace(/\n\/\/# sourceMappingURL=.*$/m, '')
if (!compiled.includes(`const PACKAGE_NAME = ${JSON.stringify(name).replaceAll('"', "'")};`)) {
  console.error(`bundle-client: PACKAGE_NAME in client/index.tsx must equal the package name ${name}`)
  process.exit(1)
}
for (const [, request] of compiled.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
  if (!PLATFORM_MODULES.has(request)) {
    console.error(`bundle-client: ${request} is not served by dsh's page module table; keep the client one self-contained file`)
    process.exit(1)
  }
}

const body = compiled.split('\n').map(line => (line === '' ? line : `\t\t${line}`)).join('\n')
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
writeFileSync(path.join(root, 'lib/client.js'), bundle)
console.log('bundle-client: wrote lib/client.js')
