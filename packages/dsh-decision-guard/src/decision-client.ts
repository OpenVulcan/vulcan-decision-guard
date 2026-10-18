import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Wire contract this client speaks. Must equal `CONTRACT_VERSION` in `crates/decision-core`. */
export const CONTRACT_VERSION = 1

/**
 * Upper bound for `vulcan-decision ensure`, which itself waits up to its `ENSURE_TIMEOUT`
 * (10 s) for a starting service; this bound must stay above it.
 */
const START_TIMEOUT_MS = 15_000

/** Final decision for one tool call, as `serve` returns it. */
export type Verdict =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: string }
  | { readonly decision: 'ask'; readonly reason: string }

/** One tool call to judge. Field names follow the service's wire format. */
export interface JudgeCall {
  readonly host: 'dsh'
  readonly session_id?: string
  readonly cwd?: string
  readonly tool: string
  readonly arguments: unknown
}

type Response =
  | { readonly type: 'verdict'; readonly verdict: Verdict }
  | { readonly type: 'pong'; readonly contract: number; readonly version: string }
  | { readonly type: 'contract_mismatch'; readonly contract: number }
  | { readonly type: 'shutting_down' }
  | { readonly type: 'error'; readonly message: string }

interface EndpointDescription {
  readonly endpoint: string
  readonly contract: number
  readonly version: string
}

/**
 * Client of the resident `vulcan-decision serve` process. It starts the service once, keeps
 * one connection open so the service stays loaded while dsh runs, and judges each call over a
 * short-lived connection.
 */
export class DecisionClient {
  readonly #binary: () => string
  #starting: Promise<string> | undefined
  #keepalive: net.Socket | undefined
  #closed = false

  /** @param binary - resolves the executable path; called lazily so a missing build fails calls, not plugin load. */
  constructor(binary: () => string) {
    this.#binary = binary
  }

  /**
   * Start the service when needed and open the keepalive connection.
   * @returns the endpoint path.
   */
  start(): Promise<string> {
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined
      throw error
    })
    return this.#starting
  }

  /**
   * Judge one call. A failed exchange restarts the service once before giving up.
   * @throws when no verdict can be obtained; callers must treat that as a denial.
   */
  async judge(call: JudgeCall, signal: AbortSignal): Promise<Verdict> {
    try {
      return await exchange(await this.start(), call, signal)
    } catch (error) {
      if (signal.aborted || this.#closed) throw error
      this.#reset()
      return await exchange(await this.start(), call, signal)
    }
  }

  /** Close the keepalive connection; the service then idles out on its own. */
  close(): void {
    this.#closed = true
    this.#reset()
  }

  async #start(): Promise<string> {
    if (this.#closed) throw new Error('decision client is closed')
    const binary = this.#binary()
    const options = { timeout: START_TIMEOUT_MS, windowsHide: true }
    await execFileAsync(binary, ['ensure'], options)
    const { stdout } = await execFileAsync(binary, ['endpoint'], options)
    const description = JSON.parse(stdout) as EndpointDescription
    if (description.contract !== CONTRACT_VERSION) {
      throw new Error(
        `vulcan-decision ${description.version} speaks contract ${description.contract}, this plugin speaks ${CONTRACT_VERSION}`,
      )
    }
    this.#openKeepalive(description.endpoint)
    return description.endpoint
  }

  #openKeepalive(endpoint: string): void {
    const socket = net.connect(endpoint)
    socket.unref()
    // A lost keepalive means the service may be gone; the next call starts it again.
    const lost = (): void => {
      if (this.#keepalive === socket) this.#reset()
    }
    socket.on('error', lost)
    socket.on('close', lost)
    this.#keepalive = socket
  }

  #reset(): void {
    this.#starting = undefined
    const socket = this.#keepalive
    this.#keepalive = undefined
    socket?.destroy()
  }
}

/** Send one judge request over its own connection and read the single response line. */
function exchange(endpoint: string, call: JudgeCall, signal: AbortSignal): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const socket = net.connect(endpoint)
    const chunks: Buffer[] = []
    const fail = (error: unknown): void => {
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onAbort = (): void => fail(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('decision service closed the connection')))
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      const end = text.indexOf('\n')
      if (end < 0) return
      signal.removeEventListener('abort', onAbort)
      socket.removeAllListeners('close')
      socket.end()
      try {
        const response = JSON.parse(text.slice(0, end)) as Response
        if (response.type === 'verdict') resolve(response.verdict)
        else reject(new Error(`decision service answered ${JSON.stringify(response)}`))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.write(`${JSON.stringify({ type: 'judge', contract: CONTRACT_VERSION, call })}\n`)
  })
}
