#!/usr/bin/env node
// Wrap the compiled browser half into the lazy factory that dsh's page module loader registers:
// `window.__ModuleLoader__.load({ id, factory(require) })`, as described in dsh's client module
// system README. The client compiles to CommonJS files whose only outside requests are modules dsh
// serves to every plugin; their relative requests are linked here, so no bundler is involved.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
/** Requests answered by dsh's baseline page module table (`packages/client/web/src/platform.ts`). */
const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'])
const BUILD = path.join(root, 'build/client')

const modules = new Map(readdirSync(BUILD).filter(file => file.endsWith('.js')).map(file => [
  `./${file.slice(0, -3)}`,
  readFileSync(path.join(BUILD, file), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, ''),
]))
if (modules.get('./shared')?.match(/\bPACKAGE_NAME = '([^']+)'/)?.[1] !== name) {
  console.error(`bundle-client: PACKAGE_NAME in client/shared.ts must equal the package name ${name}`)
  process.exit(1)
}
for (const [file, source] of modules) {
  for (const [, request] of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    if (request.startsWith('./') ? !modules.has(request) : !PLATFORM_MODULES.has(request)) {
      console.error(`bundle-client: ${file} requests ${request}, which is neither a client file nor served by dsh's page module table`)
      process.exit(1)
    }
  }
}

const indent = (text, tabs) => text.split('\n').map(line => (line === '' ? line : `${'\t'.repeat(tabs)}${line}`)).join('\n')
const definitions = [...modules].map(([file, source]) => `\t\t${JSON.stringify(file)}: function (module, exports, require) {\n${indent(source, 3)}\n\t\t},`).join('\n')
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(name)},
\tfactory: (platformRequire) => {
\t\tvar definitions = {
${definitions}
\t\t};
\t\tvar cache = {};
\t\tfunction load(request) {
\t\t\tif (!(request in definitions)) return platformRequire(request);
\t\t\tif (!(request in cache)) {
\t\t\t\tvar module = { exports: {} };
\t\t\t\tcache[request] = module;
\t\t\t\tdefinitions[request](module, module.exports, load);
\t\t\t}
\t\t\treturn cache[request].exports;
\t\t}
\t\treturn load('./index');
\t}
});
`
writeFileSync(path.join(root, 'lib/client.js'), bundle)
console.log(`bundle-client: wrote lib/client.js (${modules.size} files)`)
