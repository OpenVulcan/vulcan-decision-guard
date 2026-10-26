import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Overrides the default data directory of the command line; used by tests and isolated setups. */
export const HOME_ENV = 'VULCAN_DECISION_HOME'

/**
 * One data directory: installed runtime packs, installed models, partial downloads and, for the
 * command line, its account file and settings. A host passes its own directory (dsh uses
 * `$DSH_HOME/vulcan-decision`); the command line uses {@link defaultHome}.
 */
export class DecisionHome {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /** `<root>/packs/<pack id>/`, one installed runtime pack each. */
  get packs(): string {
    return this.dir('packs')
  }

  /** `<root>/models/<install id>/`, one installed model package each. */
  get models(): string {
    return this.dir('models')
  }

  /** Partial downloads, kept between attempts so an interrupted download resumes. */
  get downloads(): string {
    return this.dir('downloads')
  }

  /** A file directly in the data directory, which is created first. */
  file(name: string): string {
    createPrivateDir(this.root)
    return path.join(this.root, name)
  }

  private dir(name: string): string {
    const dir = path.join(this.root, name)
    createPrivateDir(dir)
    return dir
  }
}

/** The command line's data directory: `VULCAN_DECISION_HOME`, else `~/.vulcan-decision`. */
export function defaultHome(): DecisionHome {
  return new DecisionHome(process.env[HOME_ENV] || path.join(os.homedir(), '.vulcan-decision'))
}

/** Create `dir` and its parents with owner-only access. */
export function createPrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700)
}

/** Write `text` to `file` through a temporary file, so readers never see a partial file. */
export function writeFileAtomic(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { mode: 0o600 })
  fs.renameSync(temporary, file)
}
