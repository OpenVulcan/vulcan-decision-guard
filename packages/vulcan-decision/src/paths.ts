import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Overrides the data directory; used by tests and isolated setups. */
export const HOME_ENV = 'VULCAN_DECISION_HOME'

/** The per-user data directory, created with owner-only access. */
export function dataDir(): string {
  const dir = process.env[HOME_ENV] || path.join(os.homedir(), '.vulcan-decision')
  createPrivateDir(dir)
  return dir
}

/** Where installed model packages live, one directory per model id. */
export function modelsDir(): string {
  const dir = path.join(dataDir(), 'models')
  createPrivateDir(dir)
  return dir
}

/**
 * The local endpoint every client connects to and the service listens on. This is the only
 * definition of the endpoint location.
 *
 * Windows uses a named pipe whose name includes the user name and a hash of the data directory,
 * so isolated data directories get their own service. Unix uses a socket file inside the
 * owner-only data directory, because abstract sockets carry no access control.
 */
export function endpointPath(): string {
  const dir = dataDir()
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME ?? '').replace(/[^A-Za-z0-9]/g, '_')
    return `\\\\.\\pipe\\vulcan-decision-${user}-${hashOf(path.resolve(dir).toLowerCase())}`
  }
  const run = path.join(dir, 'run')
  createPrivateDir(run)
  return path.join(run, 'serve.sock')
}

/** File the service appends its diagnostics to. */
export function logPath(): string {
  return path.join(dataDir(), 'serve.log')
}

function hashOf(text: string): string {
  // FNV-1a, enough to separate data directories; not a security boundary.
  let hash = 0x811c9dc5
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function createPrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
}
