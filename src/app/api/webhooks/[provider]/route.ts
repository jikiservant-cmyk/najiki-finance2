// Inbound provider webhooks (LivePay etc).
//
// Ordering and trust rules enforced here:
//
//   1. rate limit + body size cap        ← cheap guards before any DB work
//   2. resolve provider / tenant creds   ← read-only
//   3. VERIFY THE SIGNATURE              ← nothing is written before this
//   4. idempotency (event hash)          ← dedupe on the provider's event identity
//                                          (an UNFINISHED row is resumed, not
//                                          acknowledged — see webhook-dedupe.ts)
//   5. load intent → provider must match this route → amount/currency gates
//      → completePayment()
//
// Previously the audit row was inserted *before* verification and the
// invalid-signature path marked it `processed: true`. Because the dedupe check
// short-circuits on `processed`, an attacker who knew a payment's provider-side
// identifier could pre-seed the hash and cause the genuine webhook to be
// acknowledged as a duplicate and never processed.

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAvailableProviders, getPaymentProvider } from '@/lib/providers'
import { createWebhookLog, getPaymentByReference } from '@/lib/data'
import { enqueueWebhookNotification, completePayment } from '@/lib/payments'
import { resolveTenantOrPlatformCredentials } from '@/lib/tenant-credentials'
import { checkRateLimit, clientIdentifier } from '@/lib/rate-limit'
import { computeWebhookEventHash } from '@/lib/webhook-hash'
import { fallbackSigningSecretsFromRow, webhookSecretFromRow } from '@/lib/application-auth'
import { redactPhoneNumbersInText } from '@/lib/redact'
import { buildSignatureUrlCandidates } from '@/lib/webhook-url'
import { readTextWithLimit } from '@/lib/request-body'
import { safeJsonObject } from '@/lib/json'
import { decideWebhookLogAction } from '@/lib/webhook-dedupe'
import { isPlatformFeeType, resolvePartnerWebhookUrl } from '@/lib/constants'
import {
  flushPendingNotificationsForPayment,
  reconcileSinglePaymentById,
} from '@/lib/reconcile-payments'

/** Providers retry with at-least-once semantics; 64 KB is far above any real payload. */
const MAX_WEBHOOK_BYTES = 64 * 1024

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerCode } = await params
  const normalizedProvider = String(providerCode || '').toLowerCase()

  try {
    // ── 1. Unauthenticated-endpoint guards ─────────────────────────────────
    const ipDecision = await checkRateLimit('webhook-inbound', clientIdentifier(request), {
      tokens: 120,
      window: '1 m',
    })
    if (!ipDecision.ok) {
      return NextResponse.json(
        { error: ipDecision.message },
        { status: ipDecision.status, headers: ipDecision.retryAfter ? { 'Retry-After': ipDecision.retryAfter } : {} }
      )
    }

    // Read with the cap applied DURING the read. The previous version checked
    // `content-length` and then called `request.text()`, which buffers the whole
    // body first — a chunked request omits content-length, so nothing bounded
    // the allocation on an endpoint that is reachable without credentials.
    let rawBody: string
    try {
      rawBody = await readTextWithLimit(request, MAX_WEBHOOK_BYTES)
    } catch (readError: any) {
      if (readError?.name === 'PayloadTooLargeError' || readError?.limitBytes) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
      }
      throw readError
    }

    const signature =
      request.headers.get('x-webhook-signature') ||
      request.headers.get('signature') ||
      ''

    if (!getAvailableProviders().includes(normalizedProvider)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
    }

    // ── 2. Resolve provider + tenant credentials (read-only) ────────────────
    let parsedBody: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(rawBody)
      parsedBody = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      parsedBody = null
    }

    const nestedData =
      parsedBody?.data && typeof parsedBody.data === 'object'
        ? (parsedBody.data as Record<string, unknown>)
        : null
    const tentativeReference =
      (parsedBody?.customer_reference as string) ||
      (parsedBody?.reference as string) ||
      (nestedData?.customer_reference as string) ||
      (nestedData?.reference as string) ||
      null

    const provider = await db.provider.findFirst({
      where: { code: normalizedProvider, isActive: true },
    })

    if (!provider) {
      return NextResponse.json({ error: 'Provider not active' }, { status: 404 })
    }

    let customCredentials: any = undefined
    let matchedIntentForWakeup: { id: string; status: string; lastPolledAt: Date | null } | null = null
    if (tentativeReference) {
      const intent = await db.paymentIntent.findUnique({
        where: { reference: tentativeReference },
        select: {
          id: true,
          status: true,
          lastPolledAt: true,
          tenantId: true,
          providerId: true,
          metadata: true,
          tenant: { select: { code: true } },
          paymentType: { select: { code: true } },
        },
      })
      if (intent) {
        matchedIntentForWakeup = {
          id: intent.id,
          status: intent.status,
          lastPolledAt: intent.lastPolledAt,
        }
      }
      const intentMeta = safeJsonObject(intent?.metadata)
      const isPlatformPayment = isPlatformFeeType(
        intent?.paymentType?.code ?? (intentMeta?.paymentTypeCode as string | undefined)
      )
      if (intent?.tenantId && !isPlatformPayment) {
        const resolved = await resolveTenantOrPlatformCredentials(
          intent.tenantId,
          intent.providerId,
          intent.tenant?.code
        )
        if (!resolved) {
          console.error(`[Webhook] Tenant credentials unavailable for ${tentativeReference}; refusing platform fallback`)
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }
        customCredentials = resolved.credentials
      }
    }

    const providerClient = getPaymentProvider(normalizedProvider, customCredentials)

    // Canonical public URL. The signature string embeds the webhook URL, so it
    // is derived from configured origins rather than from a caller-supplied
    // `x-forwarded-host`. The forwarded host is only used as a last resort in
    // development (see buildSignatureUrlCandidates).
    const publicUrl = buildSignatureUrlCandidates(request)

    const isValidSignature = await providerClient.validateWebhookSignature(
      rawBody,
      signature,
      Object.fromEntries(request.headers.entries()),
      publicUrl[0],
      publicUrl.slice(1)
    )

    // ── 3. Verify BEFORE processing unverified payload fields ───────────────
    const safeInboundHeaders = {
      requestUrl: request.url,
      userAgent: request.headers.get('user-agent') || null,
      contentType: request.headers.get('content-type') || null,
      xWebhookSignature: signature || null,
    }
    const sanitizedPayload = redactPhoneNumbersInText(rawBody)

    if (!isValidSignature) {
      let verifiedByPollStatus: string | null = null
      let pollDiagError: string | null = null

      // Out-of-band authenticated verification: when a tenant saved API credentials
      // in `/setup` without configuring `Webhook Secret`, never trust the unverified
      // webhook body — instead query the provider directly using our own encrypted
      // `apiKey` to verify whether the payment genuinely reached a terminal status.
      if (
        matchedIntentForWakeup &&
        (matchedIntentForWakeup.status === 'processing' || matchedIntentForWakeup.status === 'pending') &&
        Date.now() - (matchedIntentForWakeup.lastPolledAt?.getTime() ?? 0) >= 1_000
      ) {
        try {
          const verified = await reconcileSinglePaymentById(matchedIntentForWakeup.id, {
            note: 'WEBHOOK_WAKEUP_VERIFIED_BY_PROVIDER_POLL',
          })
          if (verified && (verified.status === 'success' || verified.status === 'failed')) {
            verifiedByPollStatus = verified.status
          } else if (verified?.providerFailureReason) {
            pollDiagError = verified.providerFailureReason
          }
        } catch (wakeupErr: any) {
          pollDiagError = wakeupErr instanceof Error ? wakeupErr.message : String(wakeupErr)
          console.warn('[Webhook] Out-of-band provider verification check failed:', wakeupErr)
        }
      }

      // Record an explicit audit log row using a unique non-deduping `unverified:<uuid>`
      // signatureHash so operators inspecting `/api/webhooks` see the exact raw payload,
      // headers, and verification result while never pre-seeding real event hashes.
      await createWebhookLog({
        provider: normalizedProvider,
        eventType: verifiedByPollStatus
          ? 'WEBHOOK_VERIFIED_VIA_PROVIDER_API'
          : 'WEBHOOK_SIGNATURE_INVALID',
        payload: sanitizedPayload,
        signature,
        signatureHash: `unverified:${crypto.randomUUID()}`,
        verified: false,
        processed: Boolean(verifiedByPollStatus),
        headersObj: safeInboundHeaders,
        paymentIntentId: matchedIntentForWakeup?.id ?? null,
        processingError: verifiedByPollStatus
          ? `HMAC signature did not match tenant secret; verified & settled (${verifiedByPollStatus}) directly via authenticated LivePay API status check`
          : `Invalid HMAC signature${!signature ? ' (missing X-Webhook-Signature header)' : ' (verify Webhook Secret in /setup matches LivePay portal)'}${pollDiagError ? ` | poll=${pollDiagError}` : ''}`,
      }).catch((logErr) => {
        console.warn('[Webhook] Could not persist unverified webhook audit row:', logErr)
      })

      if (verifiedByPollStatus) {
        return NextResponse.json({
          success: true,
          verifiedViaProviderPoll: true,
          status: verifiedByPollStatus,
        })
      }

      console.warn(
        `[Webhook] Rejected ${normalizedProvider} delivery: signature verification failed (bodyHash=${rawBody.length}b)`
      )
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const { hash: signatureHash, strategy } = computeWebhookEventHash({
      providerCode: normalizedProvider,
      rawBody,
      parsedBody,
    })

    // ── 4. Idempotency ─────────────────────────────────────────────────────
    const existingLog = await db.webhookLog.findUnique({ where: { signatureHash } })
    if (decideWebhookLogAction(existingLog) === 'duplicate') {
      // Genuinely finished — acknowledge so the provider stops retrying.
      return NextResponse.json({ success: true, duplicate: true })
    }

    // An existing-but-unfinished row is RESUMED, not duplicated.
    //
    // The row is written with `processed: false` before any work happens, so if
    // a previous delivery died part-way (DB blip, timeout, a lost race on the
    // wallet balance) that row is still here. Attempting a fresh insert would
    // hit the unique key, and the old code answered 200 {duplicate: true} — the
    // provider stopped retrying and the payment never settled, silently. Reusing
    // the row lets the delivery complete; every step below is idempotent, so
    // running it twice is harmless.
    let resolvedLog: { id: string } | null = existingLog

    if (!resolvedLog) {
      try {
        resolvedLog = await createWebhookLog({
          provider: normalizedProvider,
          eventType: 'WEBHOOK_RECEIVED',
          payload: sanitizedPayload,
          signature,
          signatureHash,
          verified: true,
          processed: false,
          headersObj: safeInboundHeaders,
        })
      } catch (logError: any) {
        if (logError?.code !== 'P2002') throw logError

        // Another delivery of this event inserted the row between our read and
        // this insert. Re-read to find out whether it *finished* or is still in
        // flight / died: only a finished row is a duplicate.
        const concurrent = await db.webhookLog.findUnique({ where: { signatureHash } })
        if (!concurrent) throw logError

        if (decideWebhookLogAction(concurrent) === 'duplicate') {
          return NextResponse.json({ success: true, duplicate: true })
        }
        resolvedLog = concurrent
      }
    }

    // Narrowed once, explicitly: the compiler cannot see that every branch above
    // either assigns or returns, and the rest of the handler needs a non-null id.
    if (!resolvedLog) {
      throw new Error('webhook log row missing after dedupe resolution')
    }
    const webhookLog: { id: string } = resolvedLog

    if (!parsedBody) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processed: true, processingError: 'Malformed JSON body' },
      })
      return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 })
    }

    const parsedWebhook = await providerClient.parseWebhookPayload(parsedBody)

    if (!parsedWebhook.reference) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processed: true, processingError: 'Missing payment reference' },
      })
      return NextResponse.json({ error: 'Missing payment reference' }, { status: 400 })
    }

    // O(1) lookup on @unique index — replaces old full-table scan
    const paymentIntent = await getPaymentByReference(parsedWebhook.reference)

    if (!paymentIntent) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processingError: 'Payment not found', processed: true },
      })
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    const fullPaymentIntent = await db.paymentIntent.findUnique({
      where: { id: paymentIntent.id },
      include: {
        application: true,
        tenant: true,
        paymentType: true,
        provider: { select: { code: true } },
      },
    })

    if (!fullPaymentIntent) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { processingError: 'Payment not found', processed: true },
      })
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // ── The intent must belong to the provider that signed this request ─────
    // Otherwise a callback signed by provider A can settle a payment created
    // through provider B: the signature verifies against A's secret, the
    // reference is a B reference, and the amount/currency gates below compare
    // against the stored intent — so a *correctly sized* A-signed body would
    // flip a B payment to success. Harmless while exactly one provider is
    // implemented, which is precisely why it must be enforced before a second
    // adapter is added (see IMPLEMENTED_PROVIDER_CODES).
    if (String(fullPaymentIntent.provider?.code || '').toLowerCase() !== normalizedProvider) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          paymentIntentId: paymentIntent.id,
          processed: true,
          processingError:
            `PROVIDER_MISMATCH intent=${fullPaymentIntent.provider?.code} route=${normalizedProvider}`,
        },
      })
      console.error(
        `[Webhook] Rejected ${normalizedProvider} callback for ${paymentIntent.reference}: ` +
          `payment belongs to provider "${fullPaymentIntent.provider?.code}".`
      )
      return NextResponse.json({ error: 'Provider mismatch' }, { status: 409 })
    }

    const normalizedStatus = String(parsedWebhook.status || '').toLowerCase()

    // ── 5. Amount / currency gates against the stored intent ───────────────
    const expectedAmount = Number(paymentIntent.amount)
    const reportedAmount =
      parsedWebhook.amount !== undefined && parsedWebhook.amount !== null
        ? Number(parsedWebhook.amount)
        : expectedAmount

    if (!Number.isFinite(reportedAmount) || Math.abs(expectedAmount - reportedAmount) > 0.001) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          paymentIntentId: paymentIntent.id,
          processed: true,
          processingError: `AMOUNT_MISMATCH expected=${expectedAmount} reported=${reportedAmount}`,
        },
      })
      await db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: 'disputed',
          rawProviderResponse: sanitizedPayload,
          note: `AMOUNT_MISMATCH | expected ${expectedAmount} ${paymentIntent.currency}, got ${reportedAmount} ${parsedWebhook.currency || ''}`,
        },
      })
      console.error(
        `[Webhook] Amount mismatch on ${paymentIntent.reference}: expected ${expectedAmount}, reported ${reportedAmount}`
      )
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 422 })
    }

    if (
      parsedWebhook.currency &&
      String(parsedWebhook.currency).toUpperCase() !== String(paymentIntent.currency).toUpperCase()
    ) {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          paymentIntentId: paymentIntent.id,
          processed: true,
          processingError: `CURRENCY_MISMATCH expected=${paymentIntent.currency} reported=${parsedWebhook.currency}`,
        },
      })
      await db.paymentTransaction.create({
        data: {
          paymentIntentId: paymentIntent.id,
          status: 'disputed',
          rawProviderResponse: sanitizedPayload,
          note: `CURRENCY_MISMATCH | expected ${paymentIntent.currency}, got ${parsedWebhook.currency}`,
        },
      })
      console.error(
        `[Webhook] Currency mismatch on ${paymentIntent.reference}: expected ${paymentIntent.currency}, got ${parsedWebhook.currency}`
      )
      return NextResponse.json({ error: 'Currency mismatch' }, { status: 422 })
    }

    // Guard against double-crediting if a retry arrives with a different signature
    if (fullPaymentIntent.status === 'success' || fullPaymentIntent.status === 'failed') {
      await db.webhookLog.update({
        where: { id: webhookLog.id },
        data: { paymentIntentId: paymentIntent.id, processed: true },
      })
      await flushPendingNotificationsForPayment(paymentIntent.id, {
        fallbackWebhookSecret: fullPaymentIntent.application.apiKey ?? null,
        fallbackWebhookSecrets: fallbackSigningSecretsFromRow(fullPaymentIntent.application),
      })
      return NextResponse.json({ success: true, duplicate: true })
    }

    // Always use the AUTHORITATIVE stored amount and currency, never the
    // provider's (already gated) value.
    const { wasAlreadyProcessed } = await completePayment({
      paymentIntentId: paymentIntent.id,
      status: normalizedStatus,
      providerPaymentId: parsedWebhook.providerPaymentId,
      failureReason: parsedWebhook.failureReason,
      amount: expectedAmount,
      currency: paymentIntent.currency,
      rawProviderResponse: sanitizedPayload,
      note: `WEBHOOK_UPDATE (${strategy})`,
    })

    await db.webhookLog.update({
      where: { id: webhookLog.id },
      data: { paymentIntentId: paymentIntent.id, processed: true },
    })

    // Create completion event for webhook delivery
    if (!wasAlreadyProcessed && (normalizedStatus === 'success' || normalizedStatus === 'failed')) {
      const parsedMeta = (() => {
        try {
          return safeJsonObject(fullPaymentIntent.metadata)
        } catch {
          return {}
        }
      })()
      await enqueueWebhookNotification({
        paymentIntentId: paymentIntent.id,
        reference: paymentIntent.reference,
        status: normalizedStatus,
        amount: expectedAmount,
        currency: paymentIntent.currency,
        providerPaymentId: parsedWebhook.providerPaymentId || '',
        failureReason: parsedWebhook.failureReason,
        applicationId: fullPaymentIntent.applicationId,
        webhookUrl: resolvePartnerWebhookUrl(fullPaymentIntent.application),
        webhookSecret: webhookSecretFromRow(fullPaymentIntent.application),
        fallbackWebhookSecret: fullPaymentIntent.application.apiKey ?? null,
        fallbackWebhookSecrets: fallbackSigningSecretsFromRow(fullPaymentIntent.application),
        externalEntityId: fullPaymentIntent.externalEntityId,
        tenantId: fullPaymentIntent.tenantId,
        tenantCode: fullPaymentIntent.tenant?.code ?? null,
        paymentTypeCode:
          fullPaymentIntent.paymentType?.code ??
          (parsedMeta?.paymentTypeCode as string | undefined) ??
          null,
        metadata: parsedMeta,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    // Never echo internal error text to an unauthenticated caller.
    console.error(`Webhook error (${normalizedProvider}):`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
