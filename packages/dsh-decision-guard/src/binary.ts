import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** Development override: absolute path of a locally built `vulcan-decision` executable. */
const BINARY_OVERRIDE_ENV = 'VULCAN_DECISION_BIN'

/**
 * Locate the native `vulcan-decision` executable. It ships in the platform package
 * `@openvulcan/vulcan-decision-<platform>-<arch>`, which the package manager installs from this
 * plugin's optional dependencies for the current machine only.
 * @returns the executable's absolute path.
 * @throws when no build exists for this platform.
 */
export function binaryPath(): string {
  const override = process.env[BINARY_OVERRIDE_ENV]
  if (override) return override
  const platformPackage = `@openvulcan/vulcan-decision-${process.platform}-${process.arch}`
  let manifest: string
  try {
    manifest = require.resolve(`${platformPackage}/package.json`)
  } catch {
    throw new Error(
      `Vulcan Decision has no native build for ${process.platform}-${process.arch}: ${platformPackage} is not installed`,
    )
  }
  const executable = process.platform === 'win32' ? 'vulcan-decision.exe' : 'vulcan-decision'
  return path.join(path.dirname(manifest), 'bin', executable)
}
