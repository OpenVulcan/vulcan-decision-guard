/**
 * The resident service: one per user and data directory, shared by every host plugin, so no
 * tool call pays a model load.
 */

import fs from 'node:fs'
import net from 'node:net'

import { encodeFrame, readFrames } from './frame.js'
import { ModelHost, messageOf } from './models.js'
import { endpointPath, logPath } from './paths.js'
import { CONTRACT_VERSION, DecisionError, MODEL_SIZES, type JudgeCall, type JudgeSettings, type Request, type Response } from './protocol.js'
import { renderCall } from './render.js'
import { VERSION } from './version.js'

/**
 * The service exits after this long with no open connection and no request; the next call
 * starts it again. A resident host plugin keeps one connection open, which keeps it alive.
 */
const IDLE_SHUTDOWN_MS = 30 * 60 * 1000

export interface ServeOptions {
  /** Overrides the idle shutdown, for tests. */
  readonly idleShutdownMs?: number
  /** Overrides the model host, for tests. */
  readonly models?: Pick<ModelHost, 'judge' | 'status' | 'close'>
  /** Called once the service has stopped; exits the process unless overridden, for tests. */
  readonly onStopped?: () => void
}

/** A running service. */
export interface ServiceHandle {
  /** Stop listening and release the models. */
  stop(): Promise<void>
}

/**
 * Listen on the endpoint until shut down.
 * @returns undefined when another service already owns the endpoint.
 */
export async function serve(options: ServeOptions = {}): Promise<ServiceHandle | undefined> {
  const endpoint = endpointPath()
  const server = net.createServer()
  if (!await listen(server, endpoint)) return undefined

  const models = options.models ?? new ModelHost()
  const started = Date.now()
  let judged = 0
  let lastActivity = Date.now()
  let open = 0
  let stopping = false
  const sockets = new Set<net.Socket>()
  const log = openLog()

  let stopped: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopping = true
      server.close()
      for (const socket of sockets) socket.destroy()
      await models.close().catch(() => {})
      log('stopped')
      ;(options.onStopped ?? (() => process.exit(0)))()
    })()
    return stopped
  }

  const respond = async (request: Request): Promise<Response> => {
    if (request.type === 'shutdown') return { type: 'shutting_down' }
    if (request.contract !== CONTRACT_VERSION) return { type: 'contract_mismatch', contract: CONTRACT_VERSION }
    switch (request.type) {
      case 'ping':
        return { type: 'pong', contract: CONTRACT_VERSION, version: VERSION }
      case 'status':
        return {
          type: 'status',
          status: { version: VERSION, pid: process.pid, uptime_ms: Date.now() - started, judged, models: models.status() },
        }
      case 'judge': {
        validateSettings(request.settings)
        if (request.settings.backend === 'cloud') {
          throw new DecisionError('backend_unavailable', 'the OpenVulcan cloud backend is not available yet; choose the local model')
        }
        const verdict = await models.judge(request.settings.model_size, {
          options: request.settings.options,
          rendered: renderCall(validateCall(request.call)),
        })
        judged += 1
        return { type: 'verdict', verdict }
      }
      default:
        throw new DecisionError('invalid_request', `unknown request type ${String((request as { type?: unknown }).type)}`)
    }
  }

  server.on('connection', (socket) => {
    if (stopping) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    open += 1
    lastActivity = Date.now()
    socket.on('close', () => {
      sockets.delete(socket)
      open -= 1
      lastActivity = Date.now()
    })
    socket.on('error', () => {})
    const send = (response: Response): void => {
      if (!socket.destroyed) socket.write(encodeFrame(response))
    }
    // Requests on one connection are answered in order.
    let chain = Promise.resolve()
    readFrames(socket, (frame) => {
      lastActivity = Date.now()
      chain = chain.then(async () => {
        let response: Response
        try {
          response = await respond(asRequest(frame))
        } catch (error) {
          const code = error instanceof DecisionError ? error.code : 'model_failed'
          if (code === 'model_failed') log(messageOf(error))
          response = { type: 'error', code, message: messageOf(error) }
        }
        send(response)
        if (response.type === 'shutting_down') socket.end(() => { void stop() })
      })
    }, (error) => {
      send({ type: 'error', code: 'invalid_request', message: error.message })
      socket.end()
    })
  })

  const idleLimit = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS
  const watcher = setInterval(() => {
    if (open === 0 && Date.now() - lastActivity >= idleLimit) void stop()
  }, Math.min(30_000, Math.max(50, idleLimit / 4)))
  watcher.unref()
  server.on('close', () => clearInterval(watcher))
  log(`listening on ${endpoint} (version ${VERSION}, pid ${process.pid})`)
  return { stop }
}

/** Bind the endpoint, replacing a stale Unix socket file. @returns false when a live service owns it. */
async function listen(server: net.Server, endpoint: string): Promise<boolean> {
  const attempt = (): Promise<NodeJS.ErrnoException | undefined> => new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => resolve(error)
    server.once('error', onError)
    server.listen(endpoint, () => {
      server.off('error', onError)
      resolve(undefined)
    })
  })
  let error = await attempt()
  if (error?.code === 'EADDRINUSE' && process.platform !== 'win32') {
    if (await reachable(endpoint)) return false
    fs.rmSync(endpoint, { force: true })
    error = await attempt()
  }
  if (error?.code === 'EADDRINUSE') return false
  if (error) throw error
  return true
}

function reachable(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function asRequest(frame: unknown): Request {
  if (typeof frame !== 'object' || frame === null || typeof (frame as { type?: unknown }).type !== 'string') {
    throw new DecisionError('invalid_request', 'a request must be an object with a type')
  }
  return frame as Request
}

function validateSettings(settings: JudgeSettings): void {
  if (typeof settings !== 'object' || settings === null) throw new DecisionError('invalid_request', 'judge settings are missing')
  if (settings.backend !== 'local' && settings.backend !== 'cloud') throw new DecisionError('invalid_request', 'unknown backend')
  if (settings.model_size !== undefined && !MODEL_SIZES.includes(settings.model_size)) {
    throw new DecisionError('invalid_request', `unknown model size ${String(settings.model_size)}`)
  }
  if (typeof settings.options !== 'object' || settings.options === null) throw new DecisionError('invalid_request', 'decision options are missing')
}

function validateCall(call: JudgeCall): JudgeCall {
  if (typeof call !== 'object' || call === null) throw new DecisionError('invalid_request', 'the call is missing')
  return call
}

/** Append service diagnostics to the log file, keeping it small. */
function openLog(): (line: string) => void {
  const file = logPath()
  try {
    if (fs.statSync(file).size > 1024 * 1024) fs.rmSync(file, { force: true })
  } catch {
    // No log yet.
  }
  return (line) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Logging must never take the service down.
    }
  }
}
