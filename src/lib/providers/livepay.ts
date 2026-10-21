import {
  PaymentProvider,
  ProviderCredentials,
  InitiatePaymentParams,
  InitiatePaymentResponse,
  PaymentStatusResponse,
  ParsedWebhook,
} from './types'
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import net from 'net'
import tls from 'tls'
import { normalizePhone } from '@/lib/phone'

function cleanEnvUrl(raw?: string | null): string {
  if (!raw) return ''
  return raw.trim().replace(/^["']+|["']+$/g, '').trim()
}

export function resolveLivePayProxyUrl(explicitProxyUrl?: string | null): string {
  return (
    cleanEnvUrl(explicitProxyUrl) ||
    cleanEnvUrl(process.env.LIVEPAY_PROXY_URL) ||
    cleanEnvUrl(process.env.QUOTAGUARDSTATIC_URL) ||
    cleanEnvUrl(process.env.FIXIE_URL)
  )
}

function openConnectTunnel(
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal | null
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyIsTls = proxyUrl.protocol === 'https:'
    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : proxyIsTls ? 443 : 80

    const socket: net.Socket = proxyIsTls
      ? tls.connect({
          host: proxyUrl.hostname,
          port: proxyPort,
          servername: proxyUrl.hostname,
        })
      : net.connect({
          host: proxyUrl.hostname,
          port: proxyPort,
        })

    let settled = false
    const finishError = (err: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }

    if (signal) {
      if (signal.aborted) {
        finishError(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          finishError(signal.reason instanceof Error ? signal.reason : new Error('Request timed out'))
        },
        { once: true }
      )
    }

    socket.once('error', finishError)

    const sendConnect = () => {
      const hostAuthority = `${targetHost}:${targetPort}`
      const lines = [
        `CONNECT ${hostAuthority} HTTP/1.1`,
        `Host: ${hostAuthority}`,
        'Proxy-Connection: Keep-Alive',
      ]

      if (proxyUrl.username || proxyUrl.password) {
        const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`)
      }

      socket.write(`${lines.join('\r\n')}\r\n\r\n`)

      let headerBuf = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        headerBuf = Buffer.concat([headerBuf, chunk])
        const markerIdx = headerBuf.indexOf('\r\n\r\n')
        if (markerIdx === -1) {
          if (headerBuf.length > 16_384) {
            socket.off('data', onData)
            finishError(new Error('Proxy CONNECT response header exceeded 16KB'))
          }
          return
        }

        socket.off('data', onData)
        const headerText = headerBuf.subarray(0, markerIdx).toString('latin1')
        const leftover = headerBuf.subarray(markerIdx + 4)
        const statusLine = headerText.split('\r\n')[0] || ''
        const match = /^HTTP\/1\.\d\s+(\d{3})/i.exec(statusLine)
        const statusCode = match ? Number(match[1]) : 0

        if (statusCode !== 200) {
          finishError(new Error(`Static IP proxy CONNECT failed (${statusLine || 'invalid response'})`))
          return
        }

        settled = true
        socket.removeListener('error', finishError)
        if (leftover.length > 0) {
          socket.unshift(leftover)
        }
        resolve(socket)
      }

      socket.on('data', onData)
    }

    if (proxyIsTls) {
      socket.once('secureConnect', sendConnect)
    } else {
      socket.once('connect', sendConnect)
    }
  })
}

export async function livePayFetch(
  input: string | URL,
  init?: RequestInit,
  explicitProxyUrl?: string | null
): Promise<Response> {
  const rawProxy = resolveLivePayProxyUrl(explicitProxyUrl)
  if (!rawProxy) {
    return globalThis.fetch(input, init)
  }

  const proxyUrl = new URL(rawProxy)
  const targetUrl = typeof input === 'string' ? new URL(input) : input
  const isTargetHttps = targetUrl.protocol === 'https:'
  const targetPort = targetUrl.port ? Number(targetUrl.port) : isTargetHttps ? 443 : 80

  const rawTunnelSocket = await openConnectTunnel(
    proxyUrl,
    targetUrl.hostname,
    targetPort,
    init?.signal
  )

  const transportSocket: net.Socket = isTargetHttps
    ? tls.connect({
        socket: rawTunnelSocket,
        servername: targetUrl.hostname,
      })
    : rawTunnelSocket

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      transportSocket.destroy()
      reject(err)
    }

    if (init?.signal) {
      if (init.signal.aborted) {
        fail(init.signal.reason instanceof Error ? init.signal.reason : new Error('Request aborted'))
        return
      }
      init.signal.addEventListener(
        'abort',
        () => fail(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Request timed out')),
        { once: true }
      )
    }

    const requestHeaders: Record<string, string> = {}
    if (init?.headers) {
      const normalized = new Headers(init.headers)
      normalized.forEach((value, key) => {
        requestHeaders[key] = value
      })
    }

    let bodyBuffer: Buffer | undefined
    if (typeof init?.body === 'string') {
      bodyBuffer = Buffer.from(init.body, 'utf8')
      if (!requestHeaders['content-length'] && !requestHeaders['Content-Length']) {
        requestHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }
    } else if (init?.body instanceof Uint8Array) {
      bodyBuffer = Buffer.from(init.body)
      if (!requestHeaders['content-length'] && !requestHeaders['Content-Length']) {
        requestHeaders['Content-Length'] = String(bodyBuffer.byteLength)
      }
    }

    const reqFn = isTargetHttps ? https.request : http.request
    const agent = isTargetHttps
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false })
    ;(agent as any).createConnection = () => transportSocket

    const req = reqFn(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetPort,
        method: init?.method || 'GET',
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: requestHeaders,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('error', fail)
        res.on('end', () => {
          if (settled) return
          settled = true
          const responseHeaders = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item)
            } else if (typeof v === 'string') {
              responseHeaders.set(k, v)
            }
          }
          const combined = Buffer.concat(chunks)
          transportSocket.destroy()
          resolve(
            new Response(combined, {
              status: res.statusCode || 200,
              statusText: res.statusMessage || '',
              headers: responseHeaders,
            })
          )
        })
      }
    )

    req.once('error', fail)
    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })
}

export class LivePayProvider implements PaymentProvider {
  code = 'livepay'
  name = 'LivePay'

  private apiKey: string
  private accountNo: string
  private webhookSecret: string
  private baseUrl: string

  constructor(config?: Partial<ProviderCredentials>) {
    const clean = (v?: string) => (v ? v.trim().replace(/^["']+|["']+$/g, '').trim() : '')
    const cleanKey = (v?: string) => clean(clean(v).replace(/^bearer\s+/i, ''))
    const cleanUrl = (v?: string) => clean(v).replace(/\/+$/, '') || 'https://livepay.me'

    // An explicit tenant config is never supplemented from the platform account.
    if (config) {
      this.apiKey = cleanKey(config.apiKey || config.api_key)
      this.accountNo = clean(config.accountNo || config.account_number || config.accountNumber)
      this.webhookSecret = clean(config.webhookSecret || config.webhook_secret)
      this.baseUrl = cleanUrl(config.baseUrl || config.base_url)
      if (!this.apiKey || !this.accountNo || this.webhookSecret.length < 16) {
        throw new Error('Incomplete tenant LivePay credentials')
      }
    } else {
      this.apiKey = cleanKey(process.env.LIVEPAY_API_KEY)
      this.accountNo = clean(process.env.LIVEPAY_ACCOUNT_NO || process.env.LIVEPAY_ACCOUNT_NUMBER)
      this.webhookSecret = clean(process.env.LIVEPAY_WEBHOOK_SECRET || process.env.LIVEPAY_SECRET_KEY)
      this.baseUrl = cleanUrl(process.env.LIVEPAY_BASE_URL)
    }
  }

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResponse> {
    // Normalize local mobile money formats (e.g. "0772123456" -> "256772123456",
    // "+256772123456" -> "256772123456") so member deposits match the exact
    // 12-digit country-prefixed MSISDN format that triggers LivePay PIN prompts.
    const rawPhone = String(params.phoneNumber || '').trim()
    const normalizedPhone = normalizePhone(rawPhone).replace(/[\s\-()]/g, '').replace(/^\+/, '')
    // For UGX, LivePay example uses 50000 (major units, zero-decimal). Ensure amount is integer.
    const normalizedAmount = params.currency?.toUpperCase() === 'UGX' ? Math.round(Number(params.amount)) : params.amount
    // Enforce reference constraints per docs: max 30, no spaces
    let safeReference = String(params.reference || '').trim().replace(/\s+/g, '-')
    if (safeReference.length > 30) safeReference = safeReference.slice(0, 30)
    const payload: Record<string, any> = {
      accountNumber: this.accountNo,
      phoneNumber: normalizedPhone,
      amount: normalizedAmount,
      currency: params.currency || 'UGX',
      reference: safeReference,
      description: params.description || 'Payment',
    }
    // Only add network for non-UGX per docs
    if (payload.currency.toUpperCase() !== 'UGX' && (params as any).network) {
      payload.network = (params as any).network
    }

    const viaProxy = Boolean(resolveLivePayProxyUrl())
    console.log(`[LivePay] collect-money → ${this.baseUrl}/api/collect-money phone=${normalizedPhone.slice(0,4)}****${normalizedPhone.slice(-2)} amount=${normalizedAmount} ${payload.currency} ref=${safeReference} account=${this.accountNo.slice(0,4)}**** proxy=${viaProxy ? 'static-ip' : 'direct'}`)

    try {
      const response = await livePayFetch(`${this.baseUrl}/api/collect-money`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })

      let data: any = null
      let bodyText = ''
      try {
        bodyText = await response.text()
        data = JSON.parse(bodyText)
      } catch {
        // LivePay returned non-JSON (e.g. HTML 500 on bad account) — treat as failed, not silent processing
        console.error(`[LivePay] Non-JSON response from collect-money: status=${response.status} body=${bodyText.slice(0,500)}`)
        return {
          success: false,
          status: 'failed',
          failureReason: `LivePay returned non-JSON (status ${response.status}): ${bodyText.slice(0,200)}`,
        }
      }

      console.log(`[LivePay] collect-money response status=${response.status} success=${data?.success} ref=${params.reference} data=${JSON.stringify(data).slice(0,500)}`)

      if (response.ok && data.success) {
        const tx = data?.data && typeof data.data === 'object' ? data.data : data
        // LivePay accepted — PIN should be sent within seconds.
        // Only store LivePay's own transaction identifier (`internal_reference` /
        // `transactionId`), never our customer `reference`, so subsequent status
        // polls match LivePay's real `internal_reference` cleanly.
        return {
          success: true,
          providerPaymentId:
            tx?.internal_reference ||
            tx?.transactionId ||
            data.internal_reference ||
            data.transactionId ||
            undefined,
          status: 'processing',
          metadata: data,
        }
      }

      // LivePay rejected — surface reason so gateway can return 400/failed not silent 200
      const livePayError = data?.error || data?.message || data?.error_description || JSON.stringify(data).slice(0,300)
      // Distinguish 5xx (retryable processing) vs 4xx/200+success:false (failed)
      const isRetryable = response.status >= 500 || response.status === 429 || data?.code === 'TIMEOUT'
      return {
        success: false,
        status: isRetryable ? 'processing' : 'failed',
        failureReason: livePayError || `LivePay rejected (HTTP ${response.status})`,
      }
    } catch (error: any) {
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || String(error?.message).includes('timeout')
      console.error(`[LivePay] collect-money fetch failed ref=${params.reference} timeout=${isTimeout} error=${error?.message} stack=${error?.stack?.slice(0,300)}`)
      return {
        success: false,
        // Only timeout is ambiguous (PIN may still arrive) — keep processing so webhook can confirm
        // Other network errors are failed so SACCO gets actionable error, not silent pending
        status: isTimeout ? 'processing' : 'failed',
        failureReason: isTimeout ? `LivePay timeout after 15s: ${error.message}` : `LivePay network error: ${error.message}`,
      }
    }
  }

  async checkPaymentStatus(reference: string, currency: string = 'UGX', providerPaymentId?: string): Promise<PaymentStatusResponse> {
    try {
      let safeReference = String(reference || '').trim().replace(/\s+/g, '-')
      if (safeReference.length > 30) safeReference = safeReference.slice(0, 30)
      const url = new URL(`${this.baseUrl}/api/transaction-status`)
      url.searchParams.append('accountNumber', this.accountNo)
      url.searchParams.append('currency', currency)
      url.searchParams.append('reference', safeReference)

      const response = await livePayFetch(url.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      })

      let data: any = null
      try {
        const text = await response.text()
        data = text ? JSON.parse(text) : {}
      } catch {
        return {
          success: false,
          status: 'pending',
          failureReason: `Status check returned non-JSON (HTTP ${response.status})`,
        }
      }

      if (response.ok && data?.success) {
        const tx =
          (data?.data && typeof data.data === 'object' ? data.data : null) ||
          (data?.transaction && typeof data.transaction === 'object' ? data.transaction : null) ||
          data
        const statusString = String(tx?.status ?? data?.status ?? '').trim().toLowerCase()
        let status: PaymentStatusResponse['status'] = 'pending'

        if (['success', 'successful', 'completed', 'paid', 'approved'].includes(statusString)) {
          status = 'success'
        } else if (
          ['failed', 'failure', 'declined', 'cancelled', 'canceled', 'expired', 'rejected'].includes(
            statusString
          )
        ) {
          status = 'failed'
        }

        const rawAmount = tx?.amount ?? data?.amount
        const parsedAmount =
          rawAmount !== undefined && rawAmount !== null && rawAmount !== ''
            ? Number(rawAmount)
            : undefined

        return {
          success: true,
          status,
          amount: parsedAmount !== undefined && Number.isFinite(parsedAmount) ? parsedAmount : rawAmount,
          currency: tx?.currency || data?.currency || currency,
          providerPaymentId:
            tx?.internal_reference ||
            tx?.transactionId ||
            data?.internal_reference ||
            data?.transactionId ||
            providerPaymentId,
          failureReason:
            status === 'failed'
              ? tx?.message || tx?.failure_reason || data?.message || 'Payment declined or expired'
              : undefined,
        }
      }

      return {
        success: false,
        status: 'pending',
        failureReason: data?.message || data?.error || 'Status check failed',
      }
    } catch (error) {
      console.error('[LivePay] Error checking payment status:', error)
      return {
        success: false,
        status: 'pending',
        failureReason: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async validateWebhookSignature(
    payload: string,
    signatureHeader: string,
    headers?: Record<string, string>,
    requestUrl?: string,
    additionalUrls?: string[]
  ): Promise<boolean> {
    try {
      // P0-1: FAIL CLOSED. If secret is missing or too short, reject immediately.
      // An empty secret must NEVER compute an empty-key HMAC.
      if (!this.webhookSecret || this.webhookSecret.trim().length < 16) {
        console.error('[LivePay] REJECTING webhook: webhookSecret is not configured or too short (fail-closed)')
        return false
      }

      let sigValue = signatureHeader
      if (!sigValue && headers) {
        // Fallback to checking headers case-insensitively
        const keys = Object.keys(headers)
        const foundKey = keys.find(k => k.toLowerCase() === 'x-webhook-signature' || k.toLowerCase() === 'signature')
        if (foundKey) {
          sigValue = headers[foundKey]
        }
      }

      if (!sigValue) {
        console.warn('[LivePay] Webhook signature verification skipped: signature is missing')
        return false
      }

      const parts = sigValue.split(',')
      const timestampPart = parts.find(p => p.trim().startsWith('t='))
      const signaturePart = parts.find(p => p.trim().startsWith('v='))

      if (!timestampPart || !signaturePart) {
        console.warn('[LivePay] Webhook signature verification failed: invalid signature format', sigValue)
        return false
      }

      const timestamp = timestampPart.split('=')[1]?.trim()
      const receivedSignature = signaturePart.split('=')[1]?.trim()

      if (!timestamp || !receivedSignature) {
        console.warn('[LivePay] Webhook signature verification failed: missing timestamp or signature value')
        return false
      }

      // P1-6: Replay window check - ensure timestamp is within 5 minutes (300,000 ms)
      const timestampNum = Number(timestamp)
      if (isNaN(timestampNum) || timestampNum <= 0) {
        console.warn('[LivePay] Webhook signature verification failed: invalid timestamp value', timestamp)
        return false
      }
      const timestampMs = timestampNum < 1e11 ? timestampNum * 1000 : timestampNum
      const now = Date.now()
      const maxReplayDriftMs = 5 * 60 * 1000
      if (Math.abs(now - timestampMs) > maxReplayDriftMs) {
        console.error(`[LivePay] Webhook REJECTED: timestamp outside 5-minute replay window (received: ${timestampMs}, now: ${now})`)
        return false
      }

      const webhookPayload = JSON.parse(payload)
      const txPayload =
        webhookPayload?.data && typeof webhookPayload.data === 'object'
          ? webhookPayload.data
          : webhookPayload
      const params = {
        amount: String(txPayload.amount ?? webhookPayload.amount ?? ''),
        currency: txPayload.currency ?? webhookPayload.currency ?? '',
        customer_reference: txPayload.customer_reference ?? webhookPayload.customer_reference ?? '',
        internal_reference: txPayload.internal_reference ?? webhookPayload.internal_reference ?? '',
        status: txPayload.status ?? webhookPayload.status ?? '',
      }
      const sortedKeys = Object.keys(params).sort() as Array<keyof typeof params>
      
      // Candidate webhook URLs. The URL is part of the signed string, so the
      // caller passes the canonical origin first and env-configured origins
      // after it. A caller-supplied host is deliberately NOT trusted here
      // outside development — see buildSignatureUrlCandidates() in the route.
      const possibleWebhookUrls: string[] = []

      const candidates = [requestUrl, ...(additionalUrls ?? [])].filter(
        (url): url is string => typeof url === 'string' && url.length > 0
      )

      for (const candidate of candidates) {
        possibleWebhookUrls.push(candidate)
        possibleWebhookUrls.push(candidate.endsWith('/') ? candidate.slice(0, -1) : `${candidate}/`)
      }

      for (const envOrigin of [
        process.env.NEXTAUTH_URL,
        process.env.PUBLIC_BASE_URL,
        process.env.URL,
        process.env.DEPLOY_PRIME_URL,
      ]) {
        if (envOrigin) {
          const fallbackUrl = `${envOrigin.replace(/\/$/, '')}/api/webhooks/livepay`
          possibleWebhookUrls.push(fallbackUrl)
          possibleWebhookUrls.push(`${fallbackUrl}/`)
        }
      }

      const vercelUrl = process.env.VERCEL_URL
      if (vercelUrl) {
        const fallbackVercel = `https://${vercelUrl.replace(/\/$/, '')}/api/webhooks/livepay`
        possibleWebhookUrls.push(fallbackVercel)
        possibleWebhookUrls.push(`${fallbackVercel}/`)
      }

      if (process.env.NODE_ENV !== 'production') {
        possibleWebhookUrls.push('http://localhost:3000/api/webhooks/livepay')
      }

      const uniqueUrls = Array.from(new Set(possibleWebhookUrls))
      if (uniqueUrls.length === 0) {
        console.error('[LivePay] No webhook base URL available for signature verification (fail-closed)')
        return false
      }

      for (const webhookUrl of uniqueUrls) {
        let stringToSign = `${webhookUrl}${timestamp}`
        for (const key of sortedKeys) {
          stringToSign += `${key}${params[key]}`
        }

        const expectedSignature = crypto
          .createHmac('sha256', this.webhookSecret || '')
          .update(stringToSign)
          .digest('hex')

        const receivedBuffer = Buffer.from(receivedSignature)
        const expectedBuffer = Buffer.from(expectedSignature)
        
        if (receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
          return true
        }
      }

      console.error(
        `[LivePay] Webhook signature verification failed. Tried URLs:`, uniqueUrls,
        `Payload:`, payload,
        `Expected signature with secret length ${this.webhookSecret?.length || 0} did not match received ${receivedSignature}`
      )
      return false
    } catch (err) {
      console.error('[LivePay] Webhook signature verification failed with error:', err)
      return false
    }
  }

  async parseWebhookPayload(payload: any): Promise<ParsedWebhook> {
    const tx =
      (payload?.data && typeof payload.data === 'object' ? payload.data : null) ||
      (payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : null) ||
      payload
    const statusString = String(tx?.status ?? payload?.status ?? '').trim().toLowerCase()
    
    let status: ParsedWebhook['status'] = 'pending'
    if (['success', 'successful', 'completed', 'paid', 'approved'].includes(statusString)) {
      status = 'success'
    } else if (
      ['failed', 'failure', 'declined', 'cancelled', 'canceled', 'expired', 'rejected'].includes(
        statusString
      )
    ) {
      status = 'failed'
    }

    const rawAmount = tx?.amount ?? payload?.amount
    const parsedAmount =
      rawAmount !== undefined && rawAmount !== null && rawAmount !== ''
        ? Number(rawAmount)
        : rawAmount

    return {
      reference: tx?.customer_reference || tx?.reference || payload?.customer_reference || payload?.reference,
      providerPaymentId: tx?.internal_reference || tx?.transactionId || payload?.internal_reference || payload?.transactionId,
      status,
      amount: typeof parsedAmount === 'number' && Number.isFinite(parsedAmount) ? parsedAmount : rawAmount,
      currency: tx?.currency || payload?.currency,
      metadata: payload,
      failureReason:
        status === 'failed'
          ? tx?.message || tx?.failure_reason || payload?.message || 'Payment failed'
          : undefined,
    }
  }
}
