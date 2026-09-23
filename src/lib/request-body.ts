/**
 * Reading request bodies with a size cap that actually bounds memory.
 *
 * THE PROBLEM
 * -----------
 * The webhook route checked the size like this:
 *
 *     const declaredLength = Number(request.headers.get('content-length') || 0)
 *     if (declaredLength && declaredLength > MAX_WEBHOOK_BYTES) return 413
 *     const rawBody = await request.text()          // ← already all in memory
 *     if (rawBody.length > MAX_WEBHOOK_BYTES) return 413
 *
 * `Content-Length` is optional: a chunked request omits it, so the first check
 * is skipped, and `request.text()` buffers the whole body before the second
 * check runs. The endpoint is unauthenticated and rate limited only per IP, so
 * a chunked body was an unbounded memory allocation.
 *
 * This reads the stream in chunks and aborts the moment the limit is exceeded,
 * so the peak allocation is one chunk over the limit rather than the whole body.
 *
 * Zero imports — reachable from the type-stripped test runner.
 */

export class PayloadTooLargeError extends Error {
  readonly limitBytes: number
  readonly observedBytes: number

  constructor(limitBytes: number, observedBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit`)
    this.name = 'PayloadTooLargeError'
    this.limitBytes = limitBytes
    this.observedBytes = observedBytes
  }
}

/**
 * Read a request body as text, refusing to buffer more than `limitBytes`.
 *
 * Throws {@link PayloadTooLargeError} as soon as the limit is passed — it does
 * not read to the end first, which is the whole point.
 */
export async function readTextWithLimit(request: Request, limitBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new PayloadTooLargeError(limitBytes, declared)
  }

  const body = request.body
  if (!body) return ''

  const decoder = new TextDecoder('utf-8', { fatal: false })
  const reader = body.getReader()
  let total = 0
  let text = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      if (total > limitBytes) {
        throw new PayloadTooLargeError(limitBytes, total)
      }

      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    // Release the stream even on the error path, so the connection is not left
    // half-consumed.
    try {
      await reader.cancel()
    } catch {
      // Already closed — nothing to do.
    }
  }
}

/**
 * Parse a JSON request body with the same cap.
 *
 * Returns a discriminated result rather than throwing, because callers need to
 * distinguish "too large" (413) from "malformed" (400) to respond correctly.
 */
export async function readJsonWithLimit<T = unknown>(
  request: Request,
  limitBytes: number
): Promise<{ ok: true; data: T } | { ok: false; reason: 'too-large' | 'malformed'; detail?: string }> {
  let text: string
  try {
    text = await readTextWithLimit(request, limitBytes)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return { ok: false, reason: 'too-large' }
    }
    return { ok: false, reason: 'malformed', detail: error instanceof Error ? error.message : 'unreadable body' }
  }

  try {
    return { ok: true, data: JSON.parse(text) as T }
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: error instanceof Error ? error.message : 'invalid JSON' }
  }
}
