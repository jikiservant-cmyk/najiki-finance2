import fs from 'fs'
import path from 'path'

export interface SmsRequest {
  id: string
  reference: string
  recipient: string
  message: string
  status: 'queued' | 'pending' | 'delivered' | 'failed'
  applicationId?: string
  applicationCode: string
  providerCode: string
  cost: number
  failureReason?: string
  createdAt: string
  updatedAt: string
}

const FILE_PATH = path.join(process.cwd(), 'sms-store.json')

function readStore(): SmsRequest[] {
  try {
    if (fs.existsSync(FILE_PATH)) {
      const data = fs.readFileSync(FILE_PATH, 'utf-8')
      return JSON.parse(data)
    }
  } catch (error) {
    console.error('Error reading SMS store:', error)
  }
  return []
}

function writeStore(data: SmsRequest[]) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.error('Error writing SMS store:', error)
  }
}

export const smsStore = {
  create: (params: {
    recipient: string
    message: string
    applicationCode: string
    providerCode: string
    cost: number
    applicationId?: string
  }) => {
    const list = readStore()
    const item: SmsRequest = {
      id: 'sms_' + Math.random().toString(36).substring(2, 11),
      reference: 'MSG-' + Date.now().toString(16).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase(),
      recipient: params.recipient,
      message: params.message,
      status: 'queued',
      applicationId: params.applicationId,
      applicationCode: params.applicationCode,
      providerCode: params.providerCode,
      cost: params.cost,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    list.unshift(item)
    writeStore(list)
    return item
  },

  getAll: () => {
    return readStore()
  },

  updateStatus: (id: string, status: SmsRequest['status'], failureReason?: string) => {
    const list = readStore()
    const index = list.findIndex(item => item.id === id)
    if (index !== -1) {
      list[index].status = status
      list[index].updatedAt = new Date().toISOString()
      if (failureReason) {
        list[index].failureReason = failureReason
      }
      writeStore(list)
      return list[index]
    }
    return null
  },
}
