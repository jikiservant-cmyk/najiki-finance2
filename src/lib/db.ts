import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Force new client if old one is cached
if (globalForPrisma.prisma && !(globalForPrisma.prisma as any).paymentIntent) {
  globalForPrisma.prisma = undefined
}

/**
 * Normalize PostgreSQL connection strings at runtime:
 *  - Strips surrounding whitespace and accidental quotes pasted into env UIs.
 *  - Automatically appends `pgbouncer=true` when using Supabase's transaction
 *    pooler port (:6543) without it, preventing intermittent
 *    `42P05: prepared statement "s0" already exists` 500 errors.
 */
export function normalizePrismaDatabaseUrl(rawUrl: string | undefined | null): string | undefined {
  if (!rawUrl) return undefined
  const trimmed = String(rawUrl).trim().replace(/^["']+|["']+$/g, '').trim()
  if (!trimmed) return undefined

  if (trimmed.includes(':6543') && !/[?&]pgbouncer=true(&|$)/i.test(trimmed)) {
    const separator = trimmed.includes('?') ? '&' : '?'
    return `${trimmed}${separator}pgbouncer=true`
  }

  return trimmed
}

function createPrismaClient(): PrismaClient {
  try {
    const normalizedUrl = normalizePrismaDatabaseUrl(process.env.DATABASE_URL)
    return new PrismaClient({
      log: ['error', 'warn'],
      ...(normalizedUrl ? { datasources: { db: { url: normalizedUrl } } } : {}),
    })
  } catch (err: any) {
    // When @prisma/client hasn't been generated yet (e.g. fresh clone before `prisma generate`),
    // return a proxy so module evaluation doesn't crash routes that import `db`.
    // Method calls will fail gracefully inside try/catch blocks with the actual reason.
    const msg = err?.message || String(err)
    return new Proxy({} as PrismaClient, {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (typeof prop === 'string') {
          return () => {
            return Promise.reject(new Error(`Database client unavailable: ${msg}`))
          }
        }
        return undefined
      },
    })
  }
}

export const db: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
