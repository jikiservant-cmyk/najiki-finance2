/**
 * What an operator needs to know about an application's outbound webhook, and
 * whether it will actually work.
 *
 * WHY THIS IS A MODULE
 * --------------------
 * The Setup page showed an application's name, base URL and API-key hint — but
 * not the URL we will POST to, not whether a signing secret existed, and not
 * whether the configured target was deliverable. Every one of those is a
 * go-live blocker that was invisible in the dashboard and only surfaced in a
 * failed delivery, or in a preflight run from a terminal.
 *
 * The rules encoded here are the same ones `scripts/webhook-preflight.ts` and
 * the delivery path enforce, so the dashboard cannot say "fine" about something
 * the sender refuses. Kept dependency-light (`isPlaceholderUrl` is pure) so the
 * test runner can reach it directly.
 */

import { isPlaceholderUrl } from './safe-fetch'
import { resolvePartnerWebhookUrl } from './constants'

export type WebhookIssueLevel = 'error' | 'warning'

export type WebhookIssue = {
  level: WebhookIssueLevel
  /** Stable id, so the UI can style or group without matching on wording. */
  code:
    | 'missing-base-url'
    | 'placeholder-base-url'
    | 'plain-http'
    | 'legacy-path'
    | 'missing-secret'
    | 'secret-undecryptable'
  message: string
}

export type ApplicationWebhookView = {
  /** The exact URL outbound notifications are POSTed to. */
  webhookUrl: string
  /** True when a signing secret exists and could be read. */
  webhookSecretSet: boolean
  issues: WebhookIssue[]
  /** Nothing here will stop a delivery. */
  deliverable: boolean
}

export interface ApplicationWebhookInput {
  code?: string | null
  baseUrl: string
  webhookPath: string
  /**
   * Whether a signing secret is configured. The secret itself is never passed
   * here — only the fact that one exists (and, when it exists but cannot be
   * decrypted, that fact too).
   */
  hasWebhookSecret: boolean
  secretUndecryptable?: boolean
}

/**
 * Summarise an application's webhook configuration.
 *
 * `deliverable` is false when the sender would refuse or the partner could not
 * verify what it received — i.e. when a payment settlement would not reach the
 * application.
 */
export function describeApplicationWebhook(app: ApplicationWebhookInput): ApplicationWebhookView {
  const issues: WebhookIssue[] = []
  const baseUrl = String(app.baseUrl ?? '').trim()
  const webhookPath = String(app.webhookPath ?? '').trim()

  if (!baseUrl) {
    issues.push({
      level: 'error',
      code: 'missing-base-url',
      message: 'No base URL is set, so there is nowhere to deliver notifications.',
    })
  } else if (isPlaceholderUrl(baseUrl)) {
    // The seeder writes https://church.yourdomain.com. The SSRF guard refuses
    // placeholder domains, and the refusal is permanent: the notification is
    // marked failed_exhausted and never retried. Silence, otherwise.
    issues.push({
      level: 'error',
      code: 'placeholder-base-url',
      message:
        'This looks like an unconfigured placeholder domain. The outbound guard refuses it, so NO notification is ever delivered — set the real host.',
    })
  } else if (baseUrl.startsWith('http://')) {
    issues.push({
      level: 'warning',
      code: 'plain-http',
      message: 'Plain HTTP: the payload and its signature travel unencrypted. Use https.',
    })
  }

  if (/\/api\/internal\/payment-completed\/?$/i.test(webhookPath)) {
    issues.push({
      level: 'warning',
      code: 'legacy-path',
      message:
        'Legacy path. It only works if the application answers 404/405 there so the redirect to /api/webhooks/najiki can happen — set the path explicitly instead.',
    })
  }

  if (app.secretUndecryptable) {
    issues.push({
      level: 'error',
      code: 'secret-undecryptable',
      message:
        'A signing secret is stored but cannot be decrypted with APP_ENCRYPTION_KEY, so notifications would be sent UNSIGNED. Rotate the webhook secret.',
    })
  } else if (!app.hasWebhookSecret) {
    issues.push({
      level: 'error',
      code: 'missing-secret',
      message:
        'No signing secret is configured, so notifications would be sent UNSIGNED and the application could not verify them. Rotate the webhook secret to create one.',
    })
  }

  return {
    webhookUrl: baseUrl ? resolvePartnerWebhookUrl({ code: app.code, baseUrl, webhookPath }) : '',
    webhookSecretSet: app.hasWebhookSecret && !app.secretUndecryptable,
    issues,
    deliverable: !issues.some((issue) => issue.level === 'error'),
  }
}

/**
 * The URLs providers must be pointed at, for the operator to copy into the
 * LivePay portal and the Africa's Talking dashboard.
 *
 * These are this deployment's *inbound* endpoints — the other half of the same
 * setup, and previously documented only in the README.
 */
export function inboundWebhookEndpoints(origin: string | null | undefined): {
  livepay: string | null
  africastalking: string | null
  origin: string | null
} {
  const base = String(origin ?? '').trim().replace(/\/+$/, '')
  if (!base) return { livepay: null, africastalking: null, origin: null }
  return {
    origin: base,
    livepay: `${base}/api/webhooks/livepay`,
    africastalking: `${base}/api/webhooks/africastalking`,
  }
}
