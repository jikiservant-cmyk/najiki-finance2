// scripts/seed.ts
// FIX: Removed `import type { PaymentStatus } from '@prisma/client'`
// PaymentStatus was a Prisma enum in the old schema. It was replaced with
// a plain String field when we migrated to Postgres. The type no longer
// exists in the generated client, so the import is a dead type error.
// All status values below are already plain string literals — no change needed there.

import { db } from '../src/lib/db'
import crypto from 'crypto'

function generateApiKey(): string {
  return `nk_${crypto.randomBytes(24).toString('hex')}`
}

async function seed() {
  // === PROVIDERS ===
  const livepay = await db.provider.create({
    data: { code: 'livepay', name: 'LivePay', credentialsRef: 'LIVEPAY_', isActive: true },
  })
  const mtn = await db.provider.create({
    data: { code: 'mtn', name: 'MTN MoMo', credentialsRef: 'MTN_', isActive: true },
  })
  const airtel = await db.provider.create({
    data: { code: 'airtel', name: 'Airtel Money', credentialsRef: 'AIRTEL_', isActive: true },
  })
  const pesapal = await db.provider.create({
    data: { code: 'pesapal', name: 'Pesapal', credentialsRef: 'PESAPAL_', isActive: true },
  })

  // === APPLICATIONS ===
  const saccoApiKey = generateApiKey()
  const sacco = await db.application.create({
    data: { code: 'sacco', name: 'SACCO Platform', baseUrl: 'https://sacco.yourdomain.com', webhookPath: '/api/internal/payment-completed', internalSecretRef: 'SACCO_INTERNAL_SECRET', apiKey: saccoApiKey, isActive: true },
  })
  
  const churchApiKey = generateApiKey()
  const church = await db.application.create({
    data: { code: 'church', name: 'Church App', baseUrl: 'https://church.yourdomain.com', webhookPath: '/api/internal/payment-completed', internalSecretRef: 'CHURCH_INTERNAL_SECRET', apiKey: churchApiKey, isActive: true },
  })
  
  const schoolApiKey = generateApiKey()
  const school = await db.application.create({
    data: { code: 'school', name: 'School Platform', baseUrl: 'https://school.yourdomain.com', webhookPath: '/api/internal/payment-completed', internalSecretRef: 'SCHOOL_INTERNAL_SECRET', apiKey: schoolApiKey, isActive: true },
  })
  
  console.log('Generated API keys:')
  console.log('- SACCO:', saccoApiKey)
  console.log('- Church:', churchApiKey)
  console.log('- School:', schoolApiKey)

  // === TENANTS ===
  const abcSacco = await db.tenant.create({
    data: { applicationId: sacco.id, code: 'abc-sacco', name: 'ABC SACCO', defaultProviderId: livepay.id, isActive: true },
  })
  const xyzSacco = await db.tenant.create({
    data: { applicationId: sacco.id, code: 'xyz-sacco', name: 'XYZ SACCO', defaultProviderId: mtn.id, isActive: true },
  })
  const graceChurch = await db.tenant.create({
    data: { applicationId: church.id, code: 'grace-church', name: 'Grace Community Church', defaultProviderId: livepay.id, isActive: true },
  })
  const hopeAcademy = await db.tenant.create({
    data: { applicationId: school.id, code: 'hope-academy', name: 'Hope Academy', defaultProviderId: pesapal.id, isActive: true },
  })

  // === PAYMENT TYPES ===
  const saccoDeposit = await db.paymentType.create({ data: { applicationId: sacco.id, code: 'deposit', description: 'Member savings deposit' } })
  const saccoLoan = await db.paymentType.create({ data: { applicationId: sacco.id, code: 'loan_repayment', description: 'Loan repayment' } })
  const saccoActivation = await db.paymentType.create({ data: { applicationId: sacco.id, code: 'account_activation', description: 'Account activation fee' } })
  const churchTithe = await db.paymentType.create({ data: { applicationId: church.id, code: 'tithe', description: 'Tithe payment' } })
  const churchOffering = await db.paymentType.create({ data: { applicationId: church.id, code: 'offering', description: 'General offering' } })
  const schoolTuition = await db.paymentType.create({ data: { applicationId: school.id, code: 'tuition', description: 'Tuition fee' } })
  const schoolSub = await db.paymentType.create({ data: { applicationId: school.id, code: 'subscription', description: 'Platform subscription' } })

  // === PAYMENT INTENTS (last 14 days) ===
  const providers = [livepay, mtn, airtel, pesapal]
  const statusWeights = ['pending', 'pending', 'processing', 'success', 'success', 'success', 'success', 'success', 'failed', 'expired']

  const appConfig = [
    { app: sacco, types: [saccoDeposit, saccoLoan, saccoActivation], tenantPool: [abcSacco, xyzSacco], prefix: 'SACCO' },
    { app: church, types: [churchTithe, churchOffering], tenantPool: [graceChurch], prefix: 'CHURCH' },
    { app: school, types: [schoolTuition, schoolSub], tenantPool: [hopeAcademy], prefix: 'SCHOOL' },
  ]

  let counter = 1000

  for (let day = 14; day >= 0; day--) {
    for (const config of appConfig) {
      const numPayments = Math.floor(Math.random() * 5) + 2

      for (let i = 0; i < numPayments; i++) {
        const type     = config.types[Math.floor(Math.random() * config.types.length)]
        const tenant   = config.tenantPool[Math.floor(Math.random() * config.tenantPool.length)]
        const provider = providers[Math.floor(Math.random() * providers.length)]
        const status   = statusWeights[Math.floor(Math.random() * statusWeights.length)]
        const amount   = Math.floor(Math.random() * 500000) + 10000
        const createdAt = new Date()
        createdAt.setDate(createdAt.getDate() - day)
        createdAt.setHours(Math.floor(Math.random() * 12) + 8, Math.floor(Math.random() * 60))
        counter++

        const reference      = `${config.prefix}-${type.code.toUpperCase().replace(/_/g, '-')}-${String(counter).padStart(6, '0')}`
        const idempotencyKey = `${reference}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`

        const intent = await db.paymentIntent.create({
          data: {
            applicationId:    config.app.id,
            tenantId:         tenant.id,
            paymentTypeId:    type.id,
            externalEntityId: `member-${Math.floor(Math.random() * 200) + 1}`,
            reference,
            idempotencyKey,
            amount,
            currency:         'UGX',
            phoneNumber:      `2567${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`,
            providerId:       provider.id,
            providerPaymentId: status !== 'pending' ? `prov-${Math.random().toString(36).substring(2, 12)}` : null,
            status,
            metadata:         JSON.stringify({ source: config.app.code, tenant: tenant.code }),
            failureReason:    status === 'failed' ? 'INSUFFICIENT_FUNDS' : null,
            completedAt:      status === 'success' ? new Date(createdAt.getTime() + 30000 + Math.random() * 60000) : null,
            createdAt,
          },
        })

        if (status === 'success') {
          const notifStatus = Math.random() > 0.15 ? 'delivered' : (Math.random() > 0.5 ? 'failed_retrying' : 'pending')
          await db.internalNotification.create({
            data: {
              paymentIntentId:    intent.id,
              applicationId:      config.app.id,
              url:                `${config.app.baseUrl}${config.app.webhookPath}`,
              payload:            JSON.stringify({ reference, amount, status: 'success', currency: 'UGX', paymentType: type.code, tenantId: tenant.code }),
              status:             notifStatus,
              attemptCount:       notifStatus === 'delivered' ? 1 : notifStatus === 'failed_retrying' ? Math.floor(Math.random() * 3) + 1 : 0,
              lastResponseStatus: notifStatus === 'delivered' ? 200 : notifStatus === 'failed_retrying' ? 503 : null,
              lastAttemptAt:      notifStatus !== 'pending' ? new Date(createdAt.getTime() + 35000) : null,
              nextRetryAt:        notifStatus === 'failed_retrying' ? new Date(createdAt.getTime() + 300000) : null,
              createdAt:          new Date(createdAt.getTime() + 30000),
            },
          })
        }
      }
    }
  }

  // === WEBHOOK LOGS ===
  const recentIntents = await db.paymentIntent.findMany({ take: 8, orderBy: { createdAt: 'desc' } })
  for (const intent of recentIntents) {
    await db.webhookLog.create({
      data: {
        providerId:      intent.providerId,
        paymentIntentId: intent.id,
        payload:         JSON.stringify({ event: 'payment.completed', reference: intent.reference, amount: intent.amount, status: intent.status }),
        headers:         JSON.stringify({ 'x-signature': `sig-${Math.random().toString(36).substring(2, 16)}` }),
        signatureValid:  Math.random() > 0.1,
        processed:       true,
        createdAt:       new Date(intent.createdAt.getTime() + 25000),
      },
    })
  }

  await db.webhookLog.create({
    data: { providerId: livepay.id, payload: JSON.stringify({ invalid: true }), headers: '{}', signatureValid: false, processed: false, processingError: 'Invalid signature' },
  })

  console.log('✅ Seed completed successfully!')
  await db.$disconnect()
}

seed().catch(async (e) => {
  console.error(e)
  await db.$disconnect()
  process.exit(1)
})
