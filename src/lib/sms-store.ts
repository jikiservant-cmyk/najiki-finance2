import { redis } from './redis'

export interface SmsRequest {
  id: string
  reference: string
  recipient: string
  message: string
  status: 'queued' | 'pending' | 'delivered' | 'failed'
  attemptCount: number
  applicationId?: string
  applicationCode: string
  providerCode: string
  cost: number
  failureReason?: string
  createdAt: string
  updatedAt: string
}

const SMS_HASH_KEY = 'sms:data'

export const smsStore = {
  create: async (params: {
    recipient: string
    message: string
    applicationCode: string
    providerCode: string
    cost: number
    applicationId?: string
  }) => {
    const item: SmsRequest = {
      id: 'sms_' + Math.random().toString(36).substring(2, 11),
      reference: 'MSG-' + Date.now().toString(16).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase(),
      recipient: params.recipient,
      message: params.message,
      status: 'queued',
      attemptCount: 0,
      applicationId: params.applicationId,
      applicationCode: params.applicationCode,
      providerCode: params.providerCode,
      cost: params.cost,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await redis.hset(SMS_HASH_KEY, { [item.id]: JSON.stringify(item) })
    return item
  },
  
  get: async (id: string) => {
    const data = await redis.hget(SMS_HASH_KEY, id) as string | SmsRequest | null
    if (data) {
      // Depending on Upstash Redis client configuration, hget might return parsed JSON or a string.
      // We handle both just in case.
      const parsed = typeof data === 'string' ? JSON.parse(data) as SmsRequest : data as SmsRequest
      if (parsed && typeof parsed.attemptCount !== 'number') {
        parsed.attemptCount = 0
      }
      return parsed
    }
    return null
  },

  getAll: async () => {
    const data = await redis.hvals(SMS_HASH_KEY) as Array<string | SmsRequest>
    return data.map(item => {
      const parsed = typeof item === 'string' ? JSON.parse(item) as SmsRequest : item as SmsRequest
      if (parsed && typeof parsed.attemptCount !== 'number') {
        parsed.attemptCount = 0
      }
      return parsed
    })
  },

  updateStatus: async (
    id: string,
    status: SmsRequest['status'],
    failureReason?: string,
    attemptCount?: number
  ) => {
    const item = await smsStore.get(id)
    if (item) {
      item.status = status
      item.updatedAt = new Date().toISOString()
      if (failureReason !== undefined) {
        item.failureReason = failureReason
      }
      if (typeof attemptCount === 'number') {
        item.attemptCount = attemptCount
      }
      await redis.hset(SMS_HASH_KEY, { [id]: JSON.stringify(item) })
      return item
    }
    return null
  },
}
