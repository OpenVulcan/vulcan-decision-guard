import type { Socket } from 'node:net'

/**
 * Largest accepted frame. Tool arguments can be long, but the model reads at most 32,768
 * tokens, so a frame beyond this cannot be judged anyway.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Encode one message as a newline-terminated JSON frame. */
export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Split a socket's byte stream into JSON frames.
 * @param onFrame - called with each parsed frame, in order.
 * @param onError - called once when a frame is oversized or malformed; no frame follows it.
 */
export function readFrames(socket: Socket, onFrame: (frame: unknown) => void, onError: (error: Error) => void): void {
  let pending: Buffer[] = []
  let size = 0
  let failed = false
  socket.on('data', (chunk: Buffer) => {
    if (failed) return
    let start = 0
    for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
      pending.push(chunk.subarray(start, end))
      size += end - start
      if (size > MAX_FRAME_BYTES) {
        failed = true
        onError(new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`))
        return
      }
      const line = Buffer.concat(pending, size).toString('utf8')
      pending = []
      size = 0
      start = end + 1
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch (error) {
        failed = true
        onError(new Error(`malformed frame: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      onFrame(frame)
    }
    const rest = chunk.subarray(start)
    size += rest.length
    if (size > MAX_FRAME_BYTES) {
      failed = true
      onError(new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`))
      return
    }
    if (rest.length > 0) pending.push(rest)
  })
}
