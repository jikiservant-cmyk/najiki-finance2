import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/auth'
import { getPaymentProvider } from '@/lib/providers'
import { resolveLivePayProxyUrl } from '@/lib/providers/livepay'
import { resolveTenantOrPlatformCredentials } from '@/lib/tenant-credentials'
import { resolveTenantForApplication } from '@/lib/tenant-resolution'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/debug/livepay-ping?tenantCode=abc-sacco&phone=0777123456&amount=5000
// Super-admin only. Proves gateway → LivePay connectivity without creating a real PaymentIntent.
// If this returns LivePay error, no PIN will ever fire for SACCO deposits.
export async function GET(request: Request) {
  try {
    // Auth: super_admin session OR valid SACCO API key (so you can test with
    // the same key the SACCO uses without knowing dashboard login).
    let authed = false
    try { await requireSuperAdmin(); authed = true } catch {}
    if (!authed) {
      const key = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^bearer\s+/i, '').trim() || new URL(request.url).searchParams.get('apiKey')
      if (key) {
        const { findApplicationByApiKey } = await import('@/lib/application-auth')
        const found = await findApplicationByApiKey(key)
        if (found?.application) authed = true
      }
    }
    if (!authed) return NextResponse.json({ error: 'Unauthorized — login as super_admin in dashboard OR pass ?apiKey=YOUR_SACCO_KEY or Header x-api-key' }, { status: 401 })

    const url = new URL(request.url)
    const tenantCode = url.searchParams.get('tenantCode') || url.searchParams.get('tenant') || ''
    const phone = url.searchParams.get('phone') || '0777123456'
    const amount = Number(url.searchParams.get('amount') || '1000')
    const currency = (url.searchParams.get('currency') || 'UGX').toUpperCase()
    const reference = `PING-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`

    // Find application + tenant like payment handler does
    const app = await db.application.findFirst({ where: { code: 'sacco', isActive: true } })
    if (!app) return NextResponse.json({ error: 'No active sacco application found', hint: 'Seed DB or create via /setup' }, { status: 404 })

    const tenantLookup = await resolveTenantForApplication(app.id, tenantCode)
    const tenant = tenantLookup.resolved?.tenant ?? null
    if (!tenant) {
      return NextResponse.json(
        {
          error: tenantCode
            ? `Tenant "${tenantCode}" not found for sacco`
            : 'tenantCode required for multi-tenant sacco',
          available: tenantLookup.tenants.map((t) => t.code),
        },
        { status: tenantCode ? 404 : 400 }
      )
    }

    const livepayProvider = await db.provider.findFirst({ where: { code: 'livepay', isActive: true } })
    if (!livepayProvider) return NextResponse.json({ error: 'LivePay provider not active', hint: 'Check providers table' }, { status: 503 })

    // Resolve using the exact same credential loader used by POST /api/payments
    const resolved = await resolveTenantOrPlatformCredentials(tenant.id, livepayProvider.id, tenant.code)

    if (!resolved) {
      return NextResponse.json({
        error: `No LivePay credentials for tenant ${tenant.code}`,
        hint: 'Configure in Setup → tenant_provider_configs or set LIVEPAY_API_KEY/ACCOUNT_NO in Netlify',
        env: {
          hasApiKey: !!process.env.LIVEPAY_API_KEY,
          hasAccountNo: !!process.env.LIVEPAY_ACCOUNT_NO,
          hasWebhookSecret: (process.env.LIVEPAY_WEBHOOK_SECRET || '').length >= 16,
          baseUrl: process.env.LIVEPAY_BASE_URL || 'https://livepay.me',
          nextAuthUrl: process.env.NEXTAUTH_URL || 'NOT SET (will fallback to host)',
        },
        tenant: tenant.code,
        accountNumber: 'N/A (would use tenant config)',
      }, { status: 503 })
    }

    const creds = resolved.credentials
    const source = resolved.source
    const provider = getPaymentProvider('livepay', creds)

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

    const ipBlockMatch = /IP\s+([\d.:a-fA-F]+)\s+not allowed/i.exec(result.failureReason || '')
    const staticProxyActive = Boolean(resolveLivePayProxyUrl())

    return NextResponse.json({
      ok: result.success,
      tenant: tenant.code,
      tenantId: tenant.id,
      provider: livepayProvider.code,
      credentialSource: source,
      livepayAccount: (creds?.accountNo || process.env.LIVEPAY_ACCOUNT_NO || '').slice(0,4) + '****',
      livepayBaseUrl: creds?.baseUrl || process.env.LIVEPAY_BASE_URL || 'https://livepay.me',
      staticEgressProxyConfigured: staticProxyActive,
      detectedOutboundIp: ipBlockMatch ? ipBlockMatch[1] : null,
      nextAuthUrl: process.env.NEXTAUTH_URL || null,
      hostedAt: request.headers.get('host'),
      request: { amount, currency, phone: phone.slice(0,4)+'****'+phone.slice(-2), reference },
      result,
      willPinFire: result.success && result.status === 'processing',
      hint: result.success
        ? 'LivePay accepted → PIN should fire within 5s to phone. Check phone for USSD *165# prompt.'
        : ipBlockMatch
          ? staticProxyActive
            ? `Static proxy outbound IP ${ipBlockMatch[1]} is not yet added to LivePay IP Whitelist for account ${(creds?.accountNo || process.env.LIVEPAY_ACCOUNT_NO || '').slice(0,4)}****. Add ${ipBlockMatch[1]} once in partners.livepay.me → Developer Portal → IP Whitelist!`
            : `LivePay account ${(creds?.accountNo || process.env.LIVEPAY_ACCOUNT_NO || '').slice(0,4)}**** blocked dynamic serverless IP ${ipBlockMatch[1]}. Either delete ALL IP entries on that exact LivePay account (LivePay rejects 0.0.0.0/0 CIDR syntax) OR set LIVEPAY_PROXY_URL in Netlify env to a static outbound proxy IP and whitelist that one static IP in LivePay.`
          : `LivePay rejected: ${result.failureReason} — fix that and PIN will fire. Common: Account number does not match API key owner, Reference already used, Amount must be at least X, Invalid phone.`,
    })
  } catch (error: any) {
    console.error('[debug/livepay-ping] error', error)
    if (error?.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized — login as super_admin' }, { status: 401 })
    return NextResponse.json({ error: error?.message || 'ping failed', stack: error?.stack?.slice(0,800) }, { status: 500 })
  }
}
