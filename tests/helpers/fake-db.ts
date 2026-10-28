/**
 * An in-memory stand-in for the Prisma client, for webhook route tests.
 *
 * It implements only the query surface the webhook paths actually use, with
 * Prisma-like semantics where those semantics matter to the code under test:
 *
 *   * `findFirst` / `findUnique` / `findMany` honour `where` equality filters
 *     and the `{ in: [...] }` operator,
 *   * `create` throws a `P2002`-coded error on a duplicate `signatureHash`,
 *     because the webhook route's concurrent-delivery branch is written
 *     against exactly that behaviour,
 *   * `update` supports `{ increment: n }`,
 *   * `upsert` behaves like a real upsert.
 *
 * Rows are seeded with their relations already attached (`application`,
 * `tenant`, `paymentType`, `provider`); `include`/`select` are accepted and
 * ignored, which matches what the callers read.
 */

export type Row = Record<string, any>

export interface FakeDbSeed {
  provider?: Row[]
  paymentIntent?: Row[]
  webhookLog?: Row[]
  paymentTransaction?: Row[]
  application?: Row[]
  internalNotification?: Row[]
  tenant?: Row[]
  walletAccount?: Row[]
  ledgerEntry?: Row[]
  [table: string]: Row[] | undefined
}

const TABLE_NAMES = [
  'provider',
  'paymentIntent',
  'webhookLog',
  'paymentTransaction',
  'application',
  'internalNotification',
  'tenant',
  'walletAccount',
  'ledgerEntry',
  'adminUser',
] as const

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T)
}

function matchesCondition(value: any, condition: any): boolean {
  if (condition === null || condition === undefined) return value === condition
  if (typeof condition !== 'object' || condition instanceof Date) return value === condition
  if (Array.isArray(condition)) return condition.includes(value)

  if ('in' in condition) return (condition.in as any[]).includes(value)
  if ('notIn' in condition) return !(condition.notIn as any[]).includes(value)
  if ('not' in condition) return value !== condition.not
  if ('equals' in condition) return value === condition.equals

  // Range filters. Dates and numbers compare with < / > directly, which is what
  // the cron workers rely on (`createdAt: { lte, gte }`, `lastPolledAt: { lte }`).
  if ('lte' in condition || 'lt' in condition || 'gte' in condition || 'gt' in condition) {
    if (value === null || value === undefined) return false
    const compare = (bound: any) =>
      bound instanceof Date ? new Date(value).getTime() - bound.getTime() : Number(value) - Number(bound)
    if ('lte' in condition && !(compare(condition.lte) <= 0)) return false
    if ('lt' in condition && !(compare(condition.lt) < 0)) return false
    if ('gte' in condition && !(compare(condition.gte) >= 0)) return false
    if ('gt' in condition && !(compare(condition.gt) > 0)) return false
    return true
  }

  return value === condition
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Row[]).every((c) => matchesWhere(row, c))
    if (key === 'OR') return (condition as Row[]).some((c) => matchesWhere(row, c))
    if (key === 'NOT') return !matchesWhere(row, condition as Row)
    return matchesCondition(row[key], condition)
  })
}

export interface FakeDb {
  [table: string]: any
  rows: Record<string, Row[]>
  $transaction: (arg: any) => Promise<any>
  reset: () => void
}

export function createFakeDb(seed: FakeDbSeed = {}): FakeDb {
  const rows: Record<string, Row[]> = {}
  for (const table of TABLE_NAMES) rows[table] = []
  for (const [table, values] of Object.entries(seed)) {
    rows[table] = (values ?? []).map((row) => clone(row))
  }

  let counter = 0
  const nextId = (prefix: string) => `${prefix}_${++counter}`

  const model = (table: string) => ({
    async findUnique({ where }: { where: Row }) {
      return clone(rows[table].find((row) => matchesWhere(row, where)) ?? null)
    },

    async findFirst(args: { where?: Row; orderBy?: any } = {}) {
      return clone(rows[table].find((row) => matchesWhere(row, args.where)) ?? null)
    },

    async findMany(args: { where?: Row; take?: number; orderBy?: any } = {}) {
      let result = rows[table].filter((row) => matchesWhere(row, args.where))
      if (typeof args.take === 'number') result = result.slice(0, args.take)
      return clone(result)
    },

    async count(args: { where?: Row } = {}) {
      return rows[table].filter((row) => matchesWhere(row, args.where)).length
    },

    async create({ data }: { data: Row }) {
      if (table === 'webhookLog' && data.signatureHash) {
        const clash = rows.webhookLog.find((row) => row.signatureHash === data.signatureHash)
        if (clash) {
          const error: any = new Error('Unique constraint failed on the fields: (`signature_hash`)')
          error.code = 'P2002'
          error.meta = { target: ['signature_hash'] }
          throw error
        }
      }

      const row: Row = {
        id: nextId(table),
        createdAt: new Date(),
        ...data,
      }
      rows[table].push(row)
      return clone(row)
    },

    async update({ where, data }: { where: Row; data: Row }) {
      const row = rows[table].find((candidate) => matchesWhere(candidate, where))
      if (!row) {
        const error: any = new Error(`No ${table} found for update`)
        error.code = 'P2025'
        throw error
      }
      applyUpdate(row, data)
      return clone(row)
    },

    async updateMany({ where, data }: { where: Row; data: Row }) {
      const targets = rows[table].filter((row) => matchesWhere(row, where))
      for (const row of targets) applyUpdate(row, data)
      return { count: targets.length }
    },

    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
      const existing = rows[table].find((row) => matchesWhere(row, where))
      if (existing) {
        applyUpdate(existing, update)
        return clone(existing)
      }
      return model(table).create({ data: create })
    },
  })

  function applyUpdate(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && !(value instanceof Date) && 'increment' in value) {
        row[key] = (row[key] ?? 0) + (value as any).increment
      } else {
        row[key] = clone(value)
      }
    }
    row.updatedAt = new Date()
  }

  const db: FakeDb = {
    rows,
    $transaction: async (arg: any) => {
      if (typeof arg === 'function') return arg(db)
      return Promise.all(arg)
    },
    reset: () => {
      for (const table of TABLE_NAMES) rows[table] = []
    },
  }

  for (const table of TABLE_NAMES) db[table] = model(table)

  return db
}
