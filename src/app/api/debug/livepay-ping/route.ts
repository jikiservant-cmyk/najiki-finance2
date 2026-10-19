import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth'
import { getPaymentProvider } from '@/lib/providers'
import { loadTenantProviderCredentials } from '@/lib/tenant-credentials'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/debug/livepay-ping?tenantCode=abc-sacco&phone=0777123456&amount=5000
// Super-admin only. Proves gateway → LivePay connectivity without creating a real PaymentIntent.
// If this returns LivePay error, no PIN will ever fire for SACCO deposits.
export async function GET(request: Request) {
  try {
    await requireSuperAdmin()

    const url = new URL(request.url)
    const tenantCode = url.searchParams.get('tenantCode') || url.searchParams.get('tenant') || ''
    const phone = url.searchParams.get('phone') || '0777123456'
    const amount = Number(url.searchParams.get('amount') || '1000')
    const currency = (url.searchParams.get('currency') || 'UGX').toUpperCase()
    const reference = `PING-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`

    // Find application + tenant like payment handler does
    const app = await db.application.findFirst({ where: { code: 'sacco', isActive: true } })
    if (!app) return NextResponse.json({ error: 'No active sacco application found', hint: 'Seed DB or create via /setup' }, { status: 404 })

    let tenant = null
    if (tenantCode) {
      tenant = await db.tenant.findFirst({ where: { applicationId: app.id, code: tenantCode, isActive: true } })
      if (!tenant) return NextResponse.json({ error: `Tenant ${tenantCode} not found for sacco`, available: (await db.tenant.findMany({ where: { applicationId: app.id }, select: { code: true } })).map(t=>t.code) }, { status: 404 })
    } else {
      const all = await db.tenant.findMany({ where: { applicationId: app.id, isActive: true } })
      if (all.length === 1) tenant = all[0]
      else return NextResponse.json({ error: 'tenantCode required for multi-tenant sacco', tenants: all.map(t=>t.code) }, { status: 400 })
    }

    const livepayProvider = await db.provider.findFirst({ where: { code: 'livepay', isActive: true } })
    if (!livepayProvider) return NextResponse.json({ error: 'LivePay provider not active', hint: 'Check providers table' }, { status: 503 })

    // Try tenant creds first, then platform env
    let creds: any = null
    try { creds = await loadTenantProviderCredentials(tenant.id, livepayProvider.id) } catch {}
    const platformHas = !!process.env.LIVEPAY_API_KEY && !!process.env.LIVEPAY_ACCOUNT_NO && (process.env.LIVEPAY_WEBHOOK_SECRET||'').length >= 16
    const source = creds ? 'tenant' : (platformHas ? 'platform-env' : 'none')

    if (!creds && !platformHas) {
      return NextResponse.json({
        error: `No LivePay credentials for tenant ${tenant.code}`,
        hint: 'Configure in Setup → tenant_provider_configs or set LIVEPAY_API_KEY/ACCOUNT_NO/WEBHOOK_SECRET in Vercel',
        env: {
          hasApiKey: !!process.env.LIVEPAY_API_KEY,
          hasAccountNo: !!process.env.LIVEPAY_ACCOUNT_NO,
          hasWebhookSecret: (process.env.LIVEPAY_WEBHOOK_SECRET||'').length >= 16,
          baseUrl: process.env.LIVEPAY_BASE_URL || 'https://livepay.me',
          nextAuthUrl: process.env.NEXTAUTH_URL || 'NOT SET (will fallback to host)',
        },
        tenant: tenant.code,
        accountNumber: 'N/A (would use tenant config)',
      }, { status: 503 })
    }

    const provider = getPaymentProvider('livepay', creds || undefined)

    // Dry-run: we actually call LivePay collect-money — this WILL trigger PIN if phone is real
    // Use small amount to avoid charging; LivePay will still validate account/phone
    // If you don't want to charge test user, use phone that will decline PIN
    const result = await (provider as any).initiatePayment({
      amount,
      currency,
      phoneNumber: phone,
      reference,
      description: `Ping test for ${tenant.code}`,
      metadata: { ping: true, tenantCode: tenant.code },
      webhookUrl: `${(process.env.NEXTAUTH_URL || 'https://'+request.headers.get('host'))?.replace(/\/+$/,'')}/api/webhooks/livepay`,
    })

    return NextResponse.json({
      ok: result.success,
      tenant: tenant.code,
      tenantId: tenant.id,
      provider: livepayProvider.code,
      credentialSource: source,
      livepayAccount: (creds?.accountNo || process.env.LIVEPAY_ACCOUNT_NO || '').slice(0,4) + '****',
      livepayBaseUrl: creds?.baseUrl || process.env.LIVEPAY_BASE_URL || 'https://livepay.me',
      nextAuthUrl: process.env.NEXTAUTH_URL || null,
      hostedAt: request.headers.get('host'),
      request: { amount, currency, phone: phone.slice(0,4)+'****'+phone.slice(-2), reference },
      result,
      willPinFire: result.success && result.status === 'processing',
      hint: result.success
        ? 'LivePay accepted → PIN should fire within 5s to phone. Check phone for USSD *165# prompt.'
        : `LivePay rejected: ${result.failureReason} — fix that and PIN will fire. Common: Account number does not match API key owner, Reference already used, Amount must be at least X, Invalid phone.`,
    })
  } catch (error: any) {
    console.error('[debug/livepay-ping] error', error)
    if (error?.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized — login as super_admin' }, { status: 401 })
    return NextResponse.json({ error: error?.message || 'ping failed', stack: error?.stack?.slice(0,800) }, { status: 500 })
  }
}
