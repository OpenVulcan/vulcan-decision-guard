import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** This package's version, as `package.json` declares it. */
export const VERSION: string = (require('../package.json') as { version: string }).version
