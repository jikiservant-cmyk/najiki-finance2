/**
 * Tolerant parsing of JSON columns.
 *
 * `PaymentIntent.metadata` is a `String` column holding JSON, so every read has
 * to parse it. Four call sites did so without a guard and two did so with one —
 * the same value trusted differently depending on which code path happened to
 * reach it. That is the shape of bug that stays hidden until a single malformed
 * row (hand-edited, truncated by a bad migration, or written by an older
 * version of the code) reaches the unguarded path and takes down a background
 * worker.
 *
 * These helpers never throw. They return a fallback instead, and the caller
 * decides whether an unparseable value is worth logging.
 *
 * Zero imports — reachable from the type-stripped test runner.
 */

/** Parse a JSON string, returning `fallback` on anything unusable. */
export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') {
    // Already an object/array (e.g. a Prisma Json column) passes straight through.
    if (value !== null && typeof value === 'object') return value as T
    return fallback
  }

  try {
    const parsed = JSON.parse(value)
    return parsed === null ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

/**
 * Parse a JSON string into a plain object.
 *
 * Returns `{}` for null, empty, malformed, or non-object values — never a
 * primitive, because every caller here spreads it into a payload. An array is
 * not a record either, so it falls back too.
 */
export function safeJsonObject(value: unknown): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, {})
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

/** Serialise a value for storage, falling back to `fallback` on a cycle. */
export function safeJsonStringify(value: unknown, fallback = '{}'): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? fallback : text
  } catch {
    return fallback
  }
}
