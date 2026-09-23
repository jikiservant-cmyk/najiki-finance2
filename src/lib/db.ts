import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Force new client if old one is cached
if (globalForPrisma.prisma && !(globalForPrisma.prisma as any).paymentIntent) {
  globalForPrisma.prisma = undefined
}

function createPrismaClient(): PrismaClient {
  try {
    return new PrismaClient({
      log: ['error', 'warn'],
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

