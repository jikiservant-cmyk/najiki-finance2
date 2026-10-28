'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { 
  Copy, 
  Eye, 
  EyeOff, 
  Trash2, 
  Edit3, 
  Key, 
  ShieldCheck, 
  CheckCircle2, 
  AlertCircle,
  Plus,
  RefreshCw,
  ArrowRight,
  Send,
  ShieldAlert
} from 'lucide-react'

interface WebhookIssue {
  level: 'error' | 'warning'
  code: string
  message: string
}

interface Application {
  id: string
  code: string
  name: string
  baseUrl: string
  webhookPath: string
  internalSecretRef: string
  // Not returned by the API any more — only the hash is stored. See
  // scripts/migrate-api-keys.ts and src/lib/api-keys.ts.
  apiKeyHint: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  tenants: any[]
  paymentTypes: any[]
  /** Resolved outbound endpoint — exactly what settlements are POSTed to. */
  webhookUrl?: string
  /** Whether a signing secret exists. The value is never in the list payload. */
  webhookSecretSet?: boolean
  /** False when the sender would refuse, or the partner could not verify. */
  webhookDeliverable?: boolean
  webhookIssues?: WebhookIssue[]
}

/** Inbound endpoints the providers must be pointed at. */
interface InboundEndpoints {
  origin: string | null
  livepay: string | null
  africastalking: string | null
}

/**
 * The outcome of a real signed delivery to the partner, from
 * `POST /api/setup {type:'sendTestWebhook'}`.
 */
interface SelfTestResult {
  mode: 'valid' | 'invalid'
  sent: boolean
  ok: boolean
  verdict: string
  url: string
  statusCode: number
  latencyMs: number
  timestamp: number
  signature: string
  locallyValid: boolean
  responseSnippet: string
  headline: string
  detail: string
  nextSteps: string[]
  payload: string
  headers: Record<string, string>
}

interface Tenant {
  id: string
  applicationId: string
  code: string
  appType?: string
  name: string
  defaultProviderId: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface PaymentType {
  id: string
  applicationId: string
  code: string
  description: string
  createdAt: string
}

interface Provider {
  id: string
  code: string
  name: string
  credentialsRef: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Providers that can actually take a payment.
 *
 * Kept in sync with IMPLEMENTED_PROVIDER_CODES in src/lib/providers/index.ts.
 * The Setup API rejects anything not on this list, so offering it in the
 * dropdown would only produce a failed setup.
 */
const IMPLEMENTED_PROVIDER_CODES = ['livepay']

interface TenantProviderConfig {
  id: string
  tenantId: string
  tenant?: {
    id: string
    name: string
    code: string
    applicationId?: string
  }
  providerId: string
  provider?: {
    id: string
    name: string
    code: string
  }
  credentialsRef: string | null
  /**
   * Non-secret summary only. The server never sends the credential blob, so the
   * form cannot prefill the API key — leaving it blank means "unchanged".
   */
  configSummary?: {
    hasApiKey: boolean
    hasWebhookSecret: boolean
    accountNo: string
    baseUrl: string
    encrypted: boolean
  }
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export default function SetupPage() {
  const [applications, setApplications] = useState<Application[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const usableProviders = providers.filter(
    (p) => IMPLEMENTED_PROVIDER_CODES.includes(p.code.toLowerCase()) && p.isActive
  )

  const [tenantConfigs, setTenantConfigs] = useState<TenantProviderConfig[]>([])
  const [tenantsList, setTenantsList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('applications')
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [inbound, setInbound] = useState<InboundEndpoints | null>(null)

  // Which application's endpoint form is open, and the secret revealed for it.
  // Revealed secrets live only in this browser tab's memory: they are fetched
  // on demand and dropped when the form closes or the page reloads.
  // Radix `Switch` renders a role="switch" button, not a form control, so
  // `new FormData(form).get('isActive')` is ALWAYS null. Every entity created
  // from this page was therefore stored inactive — the church app included.
  // These are controlled now.
  const [newAppIsActive, setNewAppIsActive] = useState(true)
  const [newProviderIsActive, setNewProviderIsActive] = useState(true)
  const [newTenantIsActive, setNewTenantIsActive] = useState(true)
  const [editingAppId, setEditingAppId] = useState<string | null>(null)
  const [editAppIsActive, setEditAppIsActive] = useState(true)
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({})
  const [revealingId, setRevealingId] = useState<string | null>(null)
  // Results of real test deliveries, keyed `${appId}:${mode}`. They are the
  // only evidence that the partner accepts a signature made with OUR secret,
  // so they stay on screen until the page is reloaded.
  const [testResults, setTestResults] = useState<Record<string, SelfTestResult>>({})
  const [testingKey, setTestingKey] = useState<string | null>(null)

  // Provider Config Form State
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null)
  const [configTenantId, setConfigTenantId] = useState<string>('')
  const [configProviderId, setConfigProviderId] = useState<string>('')
  const [configApiKey, setConfigApiKey] = useState<string>('')
  const [configAccountNo, setConfigAccountNo] = useState<string>('')
  const [configWebhookSecret, setConfigWebhookSecret] = useState<string>('')
  const [configBaseUrl, setConfigBaseUrl] = useState<string>('https://livepay.me')
  const [configCredentialsRef, setConfigCredentialsRef] = useState<string>('')
  const [configIsActive, setConfigIsActive] = useState<boolean>(true)
  const [showConfigApiKey, setShowConfigApiKey] = useState<boolean>(false)
  const [submittingConfig, setSubmittingConfig] = useState<boolean>(false)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const res = await fetch('/api/setup')
      if (res.ok) {
        const data = await res.json()
        setApplications(data.applications || [])
        setProviders(data.providers || [])
        setTenantConfigs(data.tenantProviderConfigs || [])
        setTenantsList(data.tenants || [])
        setInbound(data.inbound || null)
      } else if (res.status === 401) {
        setStatusMessage({ type: 'error', text: 'Your session has expired. Please sign in again.' })
      } else if (res.status === 403) {
        setStatusMessage({ type: 'error', text: 'Super admin access is required to view this page.' })
      }
    } catch (error) {
      console.error('Failed to fetch setup data:', error)
    } finally {
      setLoading(false)
    }
  }

  // Helper to list all tenants across applications
  const allTenants = tenantsList.length > 0
    ? tenantsList.map((t) => ({
        ...t,
        applicationName: t.application?.name || applications.find((a) => a.id === t.applicationId)?.name || 'SACCO / Platform',
        applicationCode: t.application?.code || applications.find((a) => a.id === t.applicationId)?.code || 'sacco',
      }))
    : applications.flatMap((app) =>
        (app.tenants || []).map((t) => ({
          ...t,
          applicationName: app.name,
          applicationCode: app.code,
        }))
      )

  async function handleCreateApplication(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      code: formData.get('code') as string,
      name: formData.get('name') as string,
      baseUrl: formData.get('baseUrl') as string,
      webhookPath: formData.get('webhookPath') as string,
      internalSecretRef: formData.get('internalSecretRef') as string,
      isActive: newAppIsActive,
    }
    const res = await fetch('/api/setup', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'application', data }) 
    })
    if (res.ok) {
      const newApp = await res.json()
      setNewApiKey(newApp.apiKey)
      setStatusMessage({
        type: 'success',
        text: `Application "${data.name}" created ${newAppIsActive ? 'and active' : 'INACTIVE — it will reject requests until you activate it'}.`,
      })
      e.currentTarget.reset()
      setNewAppIsActive(true)
      fetchData()
    } else {
      const err = await res.json()
      setStatusMessage({ type: 'error', text: err.error || 'Failed to create application' })
    }
  }

  /**
   * Rotate an application's API key.
   *
   * Confirmed first, because it is irreversible and immediately breaks any
   * integration still using the old key. The new key is shown once, in the same
   * banner a newly created application uses.
   */
  async function handleRotateApplication(appId: string, appName: string) {
    if (!window.confirm(
      `Rotate the API key for "${appName}"?\n\n` +
      'The current key stops working immediately. Any integration still using ' +
      'it will start getting 401s until it is updated.'
    )) return

    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'rotateApplication', data: { id: appId } }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setStatusMessage({ type: 'error', text: err.error || 'Failed to rotate API key' })
        return
      }

      const rotated = await res.json()
      setNewApiKey(rotated.apiKey)
      setStatusMessage({
        type: 'success',
        text: `New API key issued for "${appName}". Copy it now — it is not stored and cannot be shown again.`,
      })
      fetchData()
    } catch {
      setStatusMessage({ type: 'error', text: 'Failed to rotate API key' })
    }
  }

  /**
   * Save an application's delivery endpoint.
   *
   * Until now the only way to write `baseUrl` / `webhookPath` was to create the
   * application — the API accepted an update but nothing in the UI called it, so
   * a wrong host could only be fixed by deleting history-bearing records.
   */
  async function handleUpdateApplication(e: React.FormEvent<HTMLFormElement>, app: Application) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'updateApplication',
        data: {
          id: app.id,
          name: (formData.get('name') as string) || app.name,
          baseUrl: formData.get('baseUrl') as string,
          webhookPath: formData.get('webhookPath') as string,
          internalSecretRef: (formData.get('internalSecretRef') as string) ?? '',
          isActive: editAppIsActive,
        },
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const detail = Array.isArray(err.details) ? ` (${err.details.join('; ')})` : ''
      setStatusMessage({ type: 'error', text: (err.error || 'Failed to save application') + detail })
      return
    }

    const saved = await res.json()
    setStatusMessage({
      type: 'success',
      text: saved.message || `Saved ${app.name}.`,
    })
    setEditingAppId(null)
    fetchData()
  }

  /** Read the outbound signing secret, so it can be copied into the partner app. */
  async function handleRevealWebhookSecret(appId: string, appName: string) {
    setRevealingId(appId)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'revealWebhookSecret', data: { id: appId } }),
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        setStatusMessage({ type: 'error', text: payload.error || 'Could not read the webhook secret' })
        return
      }

      setRevealedSecrets((current) => ({ ...current, [appId]: payload.webhookSecret }))
      setStatusMessage({
        type: 'success',
        text: `Signing secret for "${appName}" revealed. Copy it into the partner app's verifier.`,
      })
    } finally {
      setRevealingId(null)
    }
  }

  /** Replace the signing secret. The new value is shown once, in the banner. */
  async function handleRotateWebhookSecret(appId: string, appName: string) {
    if (!window.confirm(
      `Rotate the webhook signing secret for "${appName}"?\n\n` +
      'Until the partner app is updated it will reject every notification with 401. ' +
      'Deliveries are retried with backoff, so nothing is lost while you update it.'
    )) return

    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'rotateApplication', data: { id: appId, rotateWebhookSecret: true } }),
    })
    const payload = await res.json().catch(() => ({}))

    if (!res.ok) {
      setStatusMessage({ type: 'error', text: payload.error || 'Failed to rotate the webhook secret' })
      return
    }

    // The rotation also issues a new API key; keep it visible rather than
    // silently invalidating whatever the partner is using.
    if (payload.apiKey) setNewApiKey(payload.apiKey)
    if (payload.webhookSecret) {
      setRevealedSecrets((current) => ({ ...current, [appId]: payload.webhookSecret }))
    }
    setStatusMessage({
      type: 'success',
      text: `New key and signing secret issued for "${appName}". Update the partner app now.`,
    })
    fetchData()
  }

  /**
   * Send a real signed request to the partner and show what came back.
   *
   * Two modes, and the pair is the test:
   *   valid   — signed with the stored secret; the endpoint should answer 2xx.
   *   invalid — signed with a key that is deliberately not this application's;
   *             a verifying endpoint MUST answer 401/403. A 2xx here means the
   *             endpoint is not checking, so anyone could post a forged success.
   */
  async function handleTestWebhook(appId: string, appName: string, mode: 'valid' | 'invalid') {
    const key = `${appId}:${mode}`
    setTestingKey(key)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'sendTestWebhook', data: { id: appId, mode } }),
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        setStatusMessage({ type: 'error', text: payload.error || 'Could not send the test delivery' })
        return
      }

      setTestResults((current) => ({ ...current, [key]: payload as SelfTestResult }))
    } catch (error: any) {
      setStatusMessage({
        type: 'error',
        text: `Test delivery failed in the browser: ${error?.message ?? 'network error'}`,
      })
    } finally {
      setTestingKey(null)
    }
  }

  /** The same request as a curl command, so the partner can be handed it. */
  function replayCommand(result: SelfTestResult) {
    const headers = Object.entries(result.headers)
      .filter(([name]) => name !== 'Content-Type')
      .map(([name, value]) => `-H '${name}: ${value}'`)
      .join(' ')
    return `curl -i -X POST '${result.url}' -H 'Content-Type: application/json' ${headers} --data '${result.payload}'`
  }

  async function handleCreateProvider(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      code: formData.get('code') as string,
      name: formData.get('name') as string,
      credentialsRef: formData.get('credentialsRef') as string,
      isActive: newProviderIsActive,
    }
    const res = await fetch('/api/setup', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'provider', data }) 
    })
    if (res.ok) {
      setStatusMessage({
        type: 'success',
        text: `Provider "${data.name}" registered ${newProviderIsActive ? 'and active' : 'INACTIVE — no payment can use it'}.`,
      })
      e.currentTarget.reset()
      setNewProviderIsActive(true)
      fetchData()
    } else {
      const err = await res.json()
      setStatusMessage({ type: 'error', text: err.error || 'Failed to create provider' })
    }
  }

  async function handleCreateTenant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      applicationId: formData.get('applicationId') as string,
      code: formData.get('code') as string,
      appType: (formData.get('appType') as string) || 'sacco',
      name: formData.get('name') as string,
      defaultProviderId: formData.get('defaultProviderId') as string,
      isActive: newTenantIsActive,
    }
    const res = await fetch('/api/setup', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tenant', data }) 
    })
    if (res.ok) {
      setStatusMessage({ type: 'success', text: `Tenant "${data.name}" registered successfully!` })
      e.currentTarget.reset()
      fetchData()
    } else {
      const err = await res.json()
      setStatusMessage({ type: 'error', text: err.error || 'Failed to create tenant' })
    }
  }

  async function handleCreatePaymentType(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      applicationId: formData.get('applicationId') as string,
      code: formData.get('code') as string,
      description: formData.get('description') as string,
    }
    const res = await fetch('/api/setup', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'paymentType', data }) 
    })
    if (res.ok) {
      setStatusMessage({ type: 'success', text: `Payment type "${data.code}" created successfully!` })
      e.currentTarget.reset()
      fetchData()
    } else {
      const err = await res.json()
      setStatusMessage({ type: 'error', text: err.error || 'Failed to create payment type' })
    }
  }

  // Tenant Provider Config handlers
  async function handleSaveTenantProviderConfig(e: React.FormEvent) {
    e.preventDefault()
    if (!configTenantId) {
      setStatusMessage({ type: 'error', text: 'Please select a Tenant / SACCO' })
      return
    }
    if (!configProviderId) {
      setStatusMessage({ type: 'error', text: 'Please select a Provider' })
      return
    }
    // When editing, a blank key means "keep the stored one" — the server carries
    // the existing credential forward. Requiring it again would force an operator
    // to re-paste a secret just to change a base URL.
    if (!configAccountNo) {
      setStatusMessage({ type: 'error', text: 'Account Number is required' })
      return
    }
    if (!editingConfigId && !configApiKey) {
      setStatusMessage({ type: 'error', text: 'Provider API Key is required when adding a new configuration' })
      return
    }

    setSubmittingConfig(true)
    try {
      const payload = {
        type: 'tenantProviderConfig',
        data: {
          id: editingConfigId || undefined,
          tenantId: configTenantId,
          providerId: configProviderId,
          apiKey: configApiKey,
          accountNo: configAccountNo,
          webhookSecret: configWebhookSecret,
          baseUrl: configBaseUrl,
          credentialsRef: configCredentialsRef,
          isActive: configIsActive,
        },
      }

      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (res.ok) {
        setStatusMessage({
          type: 'success',
          text: editingConfigId
            ? 'SACCO Provider credentials updated successfully!'
            : 'SACCO Provider credentials saved successfully!',
        })
        resetConfigForm()
        fetchData()
      } else {
        const err = await res.json()
        setStatusMessage({ type: 'error', text: err.error || 'Failed to save configuration' })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Error saving configuration' })
    } finally {
      setSubmittingConfig(false)
    }
  }

  function handleEditConfig(cfg: TenantProviderConfig) {
    setEditingConfigId(cfg.id)
    setConfigTenantId(cfg.tenantId)
    setConfigProviderId(cfg.providerId)
    const summary = cfg.configSummary
    // Deliberately blank: the server does not send secrets, so the operator
    // re-enters the key only when they want to change it.
    setConfigApiKey('')
    setConfigWebhookSecret('')
    setConfigAccountNo(summary?.accountNo || '')
    setConfigBaseUrl(summary?.baseUrl || 'https://livepay.me')
    setConfigCredentialsRef(cfg.credentialsRef || '')
    setConfigIsActive(cfg.isActive)
    setActiveTab('tenant-providers')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleDeleteConfig(id: string) {
    if (!confirm('Are you sure you want to delete these provider credentials? This SACCO will revert to platform fallback keys.')) {
      return
    }
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'deleteTenantProviderConfig', data: { id } }),
      })
      if (res.ok) {
        setStatusMessage({ type: 'success', text: 'Credentials deleted successfully.' })
        if (editingConfigId === id) resetConfigForm()
        fetchData()
      } else {
        const err = await res.json()
        setStatusMessage({ type: 'error', text: err.error || 'Failed to delete configuration' })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Error deleting configuration' })
    }
  }

  async function handleToggleConfig(id: string, currentStatus: boolean) {
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'toggleTenantProviderConfig',
          data: { id, isActive: !currentStatus },
        }),
      })
      if (res.ok) {
        setStatusMessage({
          type: 'success',
          text: `Credentials ${!currentStatus ? 'activated' : 'deactivated'} successfully.`,
        })
        fetchData()
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Error toggling configuration' })
    }
  }

  async function handleTestTenantPin(tenantCode: string, tenantName?: string) {
    const phone = window.prompt(
      `Enter Ugandan Mobile Money number to test PIN prompt for "${tenantName || tenantCode}":`,
      '07'
    )
    if (!phone || !phone.trim()) return
    try {
      setStatusMessage({
        type: 'success',
        text: `Sending UGX 1,000 test PIN prompt via "${tenantName || tenantCode}" credentials...`,
      })
      const res = await fetch(
        `/api/debug/livepay-ping?tenantCode=${encodeURIComponent(tenantCode)}&phone=${encodeURIComponent(phone.trim())}&amount=1000`
      )
      const data = await res.json()
      if (res.ok && data.ok) {
        setStatusMessage({
          type: 'success',
          text: `PIN prompt sent via ${data.credentialSource} account (${data.livepayAccount}) — check ${phone.trim()} for USSD prompt!`,
        })
      } else {
        const reason = data.result?.failureReason || data.error || 'Unknown error'
        const extraHint = data.detectedOutboundIp ? ` — ${data.hint}` : ''
        setStatusMessage({
          type: 'error',
          text: `PIN test failed (source: ${data.credentialSource || 'unknown'}, account: ${data.livepayAccount || 'N/A'}): ${reason}${extraHint}`,
        })
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Error testing LivePay PIN prompt' })
    }
  }

  function resetConfigForm() {
    setEditingConfigId(null)
    setConfigTenantId('')
    setConfigProviderId('')
    setConfigApiKey('')
    setConfigAccountNo('')
    setConfigWebhookSecret('')
    setConfigBaseUrl('https://livepay.me')
    setConfigCredentialsRef('')
    setConfigIsActive(true)
    setShowConfigApiKey(false)
  }

  function openConfigForTenant(tenantId: string, defaultProviderId?: string | null) {
    resetConfigForm()
    setConfigTenantId(tenantId)
    if (defaultProviderId) {
      setConfigProviderId(defaultProviderId)
    } else if (providers.length > 0) {
      setConfigProviderId(providers[0].id)
    }
    setActiveTab('tenant-providers')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    setStatusMessage({ type: 'success', text: 'Copied to clipboard!' })
  }

  function maskKey(key?: string) {
    if (!key) return 'Not set'
    if (key.length <= 8) return '••••••••'
    return `••••••••${key.slice(-4)}`
  }

  if (loading && applications.length === 0) {
    return (
      <div className="container mx-auto py-16 flex flex-col items-center justify-center space-y-4">
        <RefreshCw className="w-8 h-8 animate-spin text-primary" />
        <p className="text-muted-foreground text-sm">Loading Na'jiki configuration...</p>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 max-w-7xl px-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Na'jiki Gateway Setup</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage applications, payment providers, SACCO tenants, and per-tenant provider API keys.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} className="self-start md:self-auto gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh Data
        </Button>
      </div>

      {statusMessage && (
        <Alert
          className={`mb-6 ${
            statusMessage.type === 'success'
              ? 'border-emerald-500/50 bg-emerald-50/50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'border-destructive/50 bg-destructive/10 text-destructive'
          }`}
        >
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              {statusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0" />
              )}
              <AlertDescription className="text-sm font-medium">{statusMessage.text}</AlertDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setStatusMessage(null)}
            >
              Dismiss
            </Button>
          </div>
        </Alert>
      )}

      {newApiKey && (
        <Alert className="mb-8 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40">
          <AlertDescription className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex-1">
              <p className="font-bold text-emerald-900 dark:text-emerald-200">New Application API Key Generated</p>
              <p className="text-xs text-muted-foreground mb-1">
                Save this key now. The client application passes this in <code>Authorization: Bearer nk_...</code>
              </p>
              <p className="text-emerald-800 dark:text-emerald-300 font-mono text-xs bg-emerald-100/70 dark:bg-emerald-900/50 p-2 rounded break-all select-all">
                {newApiKey}
              </p>
            </div>
            <Button onClick={() => copyToClipboard(newApiKey)} variant="default" size="sm" className="shrink-0 gap-1">
              <Copy className="w-4 h-4" /> Copy Key
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-8 flex flex-wrap h-auto p-1 gap-1">
          <TabsTrigger value="applications">Applications</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="tenants">Tenants (SACCOs)</TabsTrigger>
          <TabsTrigger value="tenant-providers" className="flex items-center gap-1.5 font-semibold">
            <Key className="w-3.5 h-3.5" /> SACCO Provider Keys ({tenantConfigs.length})
          </TabsTrigger>
          <TabsTrigger value="payment-types">Payment Types</TabsTrigger>
        </TabsList>

        {/* ============================================================ */}
        {/* TAB 1: APPLICATIONS */}
        {/* ============================================================ */}
        <TabsContent value="applications">
          {/* Where the providers send their callbacks. Previously only in the
              README, which meant an operator had to reconstruct the URL by
              hand — and a wrong origin silently fails every signature. */}
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowRight className="w-4 h-4" /> Inbound webhooks (point the providers here)
              </CardTitle>
              <CardDescription>
                Give these URLs to the payment provider and the SMS provider. They are built
                from <code className="font-mono text-xs">NEXTAUTH_URL</code>, the same origin
                the inbound signature is verified against.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!inbound?.livepay && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Public origin is not configured. Set NEXTAUTH_URL, or every provider callback
                  will fail signature verification.
                </p>
              )}

              <div>
                <Label className="text-xs text-muted-foreground">LivePay — payment status callback</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto">
                    {inbound?.livepay || '— not configured —'}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!inbound?.livepay}
                    onClick={() => inbound?.livepay && copyToClipboard(inbound.livepay)}
                    className="gap-1 shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </Button>
                </div>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground">
                  Africa&apos;s Talking — delivery reports
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto">
                    {inbound?.africastalking
                      ? `${inbound.africastalking}?key=<AFRICASTALKING_CALLBACK_SECRET>`
                      : '— not configured —'}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!inbound?.africastalking}
                    onClick={() =>
                      inbound?.africastalking &&
                      copyToClipboard(`${inbound.africastalking}?key=<AFRICASTALKING_CALLBACK_SECRET>`)
                    }
                    className="gap-1 shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Replace the placeholder with your AFRICASTALKING_CALLBACK_SECRET. The secret is
                  deliberately not rendered here.
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Application</CardTitle>
                <CardDescription>Register a client platform (e.g. SACCO Platform, ChurchOS, School)</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateApplication} className="space-y-4">
                  <div>
                    <Label>Code</Label>
                    <Input name="code" required placeholder="e.g. sacco" />
                  </div>
                  <div>
                    <Label>Name</Label>
                    <Input name="name" required placeholder="e.g. SACCO Platform" />
                  </div>
                  <div>
                    <Label>Base URL</Label>
                    <Input name="baseUrl" required placeholder="e.g. https://sacco.yourdomain.com" />
                  </div>
                  <div>
                    <Label>Webhook Path</Label>
                    <Input
                      name="webhookPath"
                      required
                      placeholder="/api/webhooks/najiki"
                      defaultValue="/api/webhooks/najiki"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Path only — it is appended to the base URL. This is where payments are
                      reported back to the application.
                    </p>
                  </div>
                  <div>
                    <Label>Internal Secret Ref</Label>
                    <Input name="internalSecretRef" required placeholder="e.g. SACCO_INTERNAL_SECRET" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="new-app-active"
                      checked={newAppIsActive}
                      onCheckedChange={setNewAppIsActive}
                    />
                    <Label htmlFor="new-app-active">Active</Label>
                  </div>
                  <Button type="submit">Create Application</Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Applications ({applications.length})</h3>
              {applications.length === 0 ? (
                <p className="text-sm text-muted-foreground">No applications registered yet.</p>
              ) : (
                applications.map((app) => (
                  <Card key={app.id}>
                    <CardContent className="pt-6 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-bold text-base">{app.name} <span className="text-muted-foreground font-mono text-xs">({app.code})</span></h4>
                          <p className="text-xs text-muted-foreground mt-0.5">{app.baseUrl}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${app.isActive ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                            {app.isActive ? 'Active' : 'Inactive'}
                          </span>
                          {app.webhookDeliverable === false && (
                            <span className="text-[11px] px-2 py-0.5 rounded font-medium bg-destructive/10 text-destructive">
                              Won&apos;t deliver
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1 border-t">
                        <span>Tenants: <strong>{app.tenants?.length || 0}</strong></span>
                        <span>Payment Types: <strong>{app.paymentTypes?.length || 0}</strong></span>
                      </div>

                      {/* ── Outbound endpoint: what we POST settlements to ── */}
                      <div className="pt-1">
                        <Label className="text-xs text-muted-foreground">
                          Outbound webhook (settlements are POSTed here)
                        </Label>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto whitespace-nowrap">
                            {app.webhookUrl || '— not configured —'}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1 shrink-0"
                            disabled={!app.webhookUrl}
                            onClick={() => app.webhookUrl && copyToClipboard(app.webhookUrl)}
                          >
                            <Copy className="w-3.5 h-3.5" /> Copy
                          </Button>
                        </div>

                        {(app.webhookIssues?.length ?? 0) > 0 && (
                          <ul className="mt-2 space-y-1">
                            {app.webhookIssues!.map((issue) => (
                              <li
                                key={issue.code}
                                className={`text-[11px] flex items-start gap-1.5 ${
                                  issue.level === 'error'
                                    ? 'text-destructive'
                                    : 'text-amber-600 dark:text-amber-400'
                                }`}
                              >
                                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>{issue.message}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* ── Signing secret: what the partner verifies with ── */}
                      <div className="pt-1">
                        <Label className="text-xs text-muted-foreground">Outbound signing secret</Label>
                        {revealedSecrets[app.id] ? (
                          <>
                            <div className="flex items-center gap-2 mt-1">
                              <code className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto break-all">
                                {revealedSecrets[app.id]}
                              </code>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1 shrink-0"
                                onClick={() => copyToClipboard(revealedSecrets[app.id])}
                              >
                                <Copy className="w-3.5 h-3.5" /> Copy
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                onClick={() =>
                                  setRevealedSecrets((current) => {
                                    const next = { ...current }
                                    delete next[app.id]
                                    return next
                                  })
                                }
                              >
                                Hide
                              </Button>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-1">
                              Verify inbound notifications with{' '}
                              <code className="font-mono">HMAC-SHA256(secret, &quot;{'{'}timestamp{'}'}.{'{'}rawBody{'}'}&quot;)</code>{' '}
                              against the <code className="font-mono">X-Najiki-Signature</code> header.
                            </p>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={!app.webhookSecretSet || revealingId === app.id}
                              onClick={() => handleRevealWebhookSecret(app.id, app.name)}
                            >
                              <Eye className="w-3.5 h-3.5" />
                              {revealingId === app.id ? 'Reading…' : 'Reveal'}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => handleRotateWebhookSecret(app.id, app.name)}
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              {app.webhookSecretSet ? 'Rotate secret' : 'Create secret'}
                            </Button>
                            <span className="text-[11px] text-muted-foreground">
                              {app.webhookSecretSet
                                ? 'Stored encrypted; revealed on demand.'
                                : 'No secret yet — notifications would be unsigned.'}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* ── Does the secret actually work? ──
                          The only way to know is to send a signed request to the
                          partner and read its answer. The second button sends a
                          wrong signature on purpose: if that is accepted too, the
                          endpoint is not verifying anything. */}
                      <div className="pt-1">
                        <Label className="text-xs text-muted-foreground">Test the signing secret</Label>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={!app.webhookUrl || !app.webhookSecretSet || testingKey === `${app.id}:valid`}
                            onClick={() => handleTestWebhook(app.id, app.name, 'valid')}
                          >
                            <Send className="w-3.5 h-3.5" />
                            {testingKey === `${app.id}:valid` ? 'Sending…' : 'Send signed test'}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={!app.webhookUrl || !app.webhookSecretSet || testingKey === `${app.id}:invalid`}
                            onClick={() => handleTestWebhook(app.id, app.name, 'invalid')}
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            {testingKey === `${app.id}:invalid` ? 'Sending…' : 'Send bad signature'}
                          </Button>
                          <span className="text-[11px] text-muted-foreground">
                            Sends <code className="font-mono">event=&quot;webhook.test&quot;</code> to the real endpoint.
                          </span>
                        </div>

                        {(['valid', 'invalid'] as const).map((mode) => {
                          const result = testResults[`${app.id}:${mode}`]
                          if (!result) return null
                          const tone = result.ok
                            ? 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30'
                            : 'border-destructive/40 bg-destructive/5'
                          return (
                            <div key={mode} className={`mt-2 rounded-lg border p-3 text-xs ${tone}`}>
                              <div className="flex items-start gap-2">
                                {result.ok ? (
                                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
                                ) : (
                                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                                )}
                                <div className="space-y-1 flex-1">
                                  <p className="font-medium">{result.headline}</p>
                                  <p className="text-muted-foreground">{result.detail}</p>
                                  <p className="text-[11px] text-muted-foreground font-mono">
                                    {mode === 'invalid' ? 'wrong key' : 'real key'}
                                    {' · '}
                                    {result.statusCode ? `HTTP ${result.statusCode}` : 'no response'}
                                    {' · '}
                                    {result.latencyMs} ms
                                    {' · '}
                                    ours verified the signature:{' '}
                                    {String(result.locallyValid)}
                                  </p>
                                  {result.nextSteps?.length > 0 && (
                                    <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
                                      {result.nextSteps.map((step) => (
                                        <li key={step}>{step}</li>
                                      ))}
                                    </ul>
                                  )}
                                  {result.responseSnippet && (
                                    <p className="text-[11px] font-mono break-all text-muted-foreground">
                                      response: {result.responseSnippet}
                                    </p>
                                  )}
                                  {result.sent && (
                                    <details className="text-[11px]">
                                      <summary className="cursor-pointer text-muted-foreground">
                                        What was sent (headers, body, curl)
                                      </summary>
                                      <pre className="mt-1 p-2 rounded bg-muted overflow-x-auto whitespace-pre-wrap break-all">
{Object.entries(result.headers).map(([name, value]) => `${name}: ${value}`).join('\n')}

{result.payload}
                                      </pre>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="gap-1 mt-1"
                                        onClick={() => copyToClipboard(replayCommand(result))}
                                      >
                                        <Copy className="w-3.5 h-3.5" /> Copy curl
                                      </Button>
                                    </details>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* ── Edit the endpoint ── */}
                      <div className="pt-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => {
                            const next = editingAppId === app.id ? null : app.id
                            setEditingAppId(next)
                            if (next) setEditAppIsActive(Boolean(app.isActive))
                          }}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          {editingAppId === app.id ? 'Close' : 'Edit endpoint'}
                        </Button>

                        {editingAppId === app.id && (
                          <form
                            onSubmit={(event) => handleUpdateApplication(event, app)}
                            className="space-y-3 mt-3 p-3 rounded-lg border bg-muted/30"
                          >
                            <div>
                              <Label className="text-xs">Name</Label>
                              <Input name="name" defaultValue={app.name} required />
                            </div>
                            <div>
                              <Label className="text-xs">Base URL</Label>
                              <Input
                                name="baseUrl"
                                defaultValue={app.baseUrl}
                                required
                                placeholder="https://church.yourdomain.com"
                              />
                              <p className="text-[11px] text-muted-foreground mt-1">
                                The application&apos;s public origin. Placeholder domains are refused
                                by the outbound guard.
                              </p>
                            </div>
                            <div>
                              <Label className="text-xs">Webhook Path</Label>
                              <Input
                                name="webhookPath"
                                defaultValue={app.webhookPath}
                                required
                                placeholder="/api/webhooks/najiki"
                              />
                            </div>
                            <div>
                              <Label className="text-xs">Internal Secret Ref</Label>
                              <Input
                                name="internalSecretRef"
                                defaultValue={app.internalSecretRef || ''}
                                placeholder="e.g. CHURCH_INTERNAL_SECRET"
                              />
                              <p className="text-[11px] text-muted-foreground mt-1">
                                Optional. Name of an environment variable the partner also accepts
                                as a signing key.
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Switch
                                id={`edit-app-active-${app.id}`}
                                checked={editAppIsActive}
                                onCheckedChange={setEditAppIsActive}
                              />
                              <Label htmlFor={`edit-app-active-${app.id}`} className="text-xs">
                                Active
                              </Label>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button type="submit" size="sm">Save endpoint</Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingAppId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        )}
                      </div>

                      {app.apiKeyHint && (
                        <div className="pt-2">
                          <Label className="text-xs text-muted-foreground">
                            Client API Key:
                          </Label>
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto">
                              njk_••••••••{app.apiKeyHint}
                            </p>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Only a hash is stored, so the key cannot be shown again. If it
                            is lost or leaked, rotate it — the old one stops working immediately.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={() => handleRotateApplication(app.id, app.name)}
                          >
                            Rotate API Key
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        </TabsContent>

        {/* ============================================================ */}
        {/* TAB 2: PROVIDERS */}
        {/* ============================================================ */}
        <TabsContent value="providers">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Register Payment Provider</CardTitle>
                <CardDescription>Register payment gateway connectors (e.g. LivePay, MTN MoMo, Airtel)</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateProvider} className="space-y-4">
                  <div>
                    <Label>Provider Code</Label>
                    <Input name="code" required placeholder="e.g. livepay" />
                  </div>
                  <div>
                    <Label>Provider Name</Label>
                    <Input name="name" required placeholder="e.g. LivePay" />
                  </div>
                  <div>
                    <Label>Credentials Ref (Global Fallback)</Label>
                    <Input name="credentialsRef" required placeholder="e.g. LIVEPAY_" defaultValue="LIVEPAY_" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="new-provider-active"
                      checked={newProviderIsActive}
                      onCheckedChange={setNewProviderIsActive}
                    />
                    <Label htmlFor="new-provider-active">Active</Label>
                  </div>
                  <Button type="submit">Create Provider</Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Registered Providers ({providers.length})</h3>
              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No providers created yet.</p>
              ) : (
                providers.map((provider) => (
                  <Card key={provider.id}>
                    <CardContent className="pt-6 flex items-center justify-between">
                      <div>
                        <h4 className="font-bold">{provider.name} <span className="text-muted-foreground font-mono text-xs">({provider.code})</span></h4>
                        <p className="text-xs text-muted-foreground mt-1">Fallback prefix: <code>{provider.credentialsRef}</code></p>
                        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">ID: {provider.id}</p>
                      </div>
                      <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${provider.isActive ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                        {provider.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        </TabsContent>

        {/* ============================================================ */}
        {/* TAB 3: TENANTS (SACCOs, Branches, Churches) */}
        {/* ============================================================ */}
        <TabsContent value="tenants">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Tenant / SACCO</CardTitle>
                <CardDescription>Add a new tenant under an existing application</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateTenant} className="space-y-4">
                  <div>
                    <Label>Application</Label>
                    <select name="applicationId" required className="w-full p-2 border rounded bg-background text-sm">
                      {applications.map((app) => (
                        <option key={app.id} value={app.id}>
                          {app.name} ({app.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Tenant Code</Label>
                    <Input name="code" required placeholder="e.g. st-jude-sacco" />
                  </div>
                  <div>
                    <Label>Tenant Name</Label>
                    <Input name="name" required placeholder="e.g. St. Jude SACCO" />
                  </div>
                  <div>
                    <Label>App / Organization Type</Label>
                    <Input name="appType" placeholder="sacco" defaultValue="sacco" />
                  </div>
                  <div>
                    <Label>Default Provider</Label>
                    {/*
                      Only providers with a working adapter and an active row are
                      selectable. Listing every provider row let an operator point a
                      tenant at MTN/Airtel/Pesapal, which have no implementation and
                      throw on the first payment (the API now refuses this too).
                    */}
                    <select name="defaultProviderId" className="w-full p-2 border rounded bg-background text-sm">
                      <option value="">None (Global default)</option>
                      {usableProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.code})
                        </option>
                      ))}
                    </select>
                    {providers.length > usableProviders.length && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {providers
                          .filter((p) => !usableProviders.some((u) => u.id === p.id))
                          .map((p) => p.name)
                          .join(', ')}{' '}
                        {providers.length - usableProviders.length === 1 ? 'is' : 'are'} not selectable —
                        no working adapter yet.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="new-tenant-active"
                      checked={newTenantIsActive}
                      onCheckedChange={setNewTenantIsActive}
                    />
                    <Label htmlFor="new-tenant-active">Active</Label>
                  </div>
                  <Button type="submit">Create Tenant</Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Registered Tenants</h3>
              {applications.map((app) => (
                <div key={app.id} className="space-y-2">
                  <h4 className="font-semibold text-sm text-muted-foreground flex items-center justify-between">
                    <span>{app.name} ({app.code})</span>
                    <span className="text-xs font-normal">{(app.tenants || []).length} tenants</span>
                  </h4>
                  {(app.tenants || []).length === 0 ? (
                    <p className="text-xs text-muted-foreground italic pl-2">No tenants under this application.</p>
                  ) : (
                    app.tenants?.map((tenant) => {
                      const hasCustomConfig = tenantConfigs.some(
                        (c) => c.tenantId === tenant.id && c.isActive
                      )
                      return (
                        <Card key={tenant.id} className="hover:border-primary/40 transition-colors">
                          <CardContent className="pt-4 pb-4 space-y-2">
                            <div className="flex items-start justify-between">
                              <div>
                                <h5 className="font-medium text-sm">
                                  {tenant.name} <span className="font-mono text-xs text-muted-foreground">({tenant.code})</span>
                                </h5>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  ID: <code className="select-all">{tenant.id}</code>
                                </p>
                              </div>
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                                  hasCustomConfig
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                }`}
                              >
                                {hasCustomConfig ? 'Custom Keys Active' : 'Fallback Keys'}
                              </span>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t text-xs">
                              <span className="text-muted-foreground">
                                Default Provider:{' '}
                                {providers.find((p) => p.id === tenant.defaultProviderId)?.name || 'Default'}
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1"
                                onClick={() => openConfigForTenant(tenant.id, tenant.defaultProviderId)}
                              >
                                <Key className="w-3 h-3 text-primary" /> Configure Provider Keys
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })
                  )}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ============================================================ */}
        {/* TAB 4: TENANT PROVIDER CREDENTIALS (THE EXACT REQUESTED FEATURE) */}
        {/* ============================================================ */}
        <TabsContent value="tenant-providers">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Form Card */}
            <Card className="lg:col-span-5">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheck className="w-5 h-5 text-primary" />
                      {editingConfigId ? 'Edit SACCO Provider Keys' : 'Add SACCO Provider Keys'}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Store specific API keys & merchant account details for a SACCO in{' '}
                      <code>tenant_provider_configs</code>.
                    </CardDescription>
                  </div>
                  {editingConfigId && (
                    <Button variant="ghost" size="sm" onClick={resetConfigForm} className="text-xs h-7">
                      Cancel
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveTenantProviderConfig} className="space-y-4">
                  {/* Select Tenant */}
                  <div>
                    <Label className="text-xs font-semibold">Select SACCO / Tenant *</Label>
                    <select
                      value={configTenantId}
                      onChange={(e) => setConfigTenantId(e.target.value)}
                      required
                      className="w-full p-2 mt-1 border rounded bg-background text-sm"
                    >
                      <option value="">-- Choose a SACCO / Tenant --</option>
                      {allTenants.map((tenant) => (
                        <option key={tenant.id} value={tenant.id}>
                          {tenant.name} ({tenant.code}) — {tenant.applicationName}
                        </option>
                      ))}
                    </select>
                    {allTenants.length === 0 && (
                      <p className="text-xs text-destructive mt-1">
                        No tenants found. Please create a tenant first under the "Tenants" tab.
                      </p>
                    )}
                  </div>

                  {/* Select Provider */}
                  <div>
                    <Label className="text-xs font-semibold">Payment Provider *</Label>
                    <select
                      value={configProviderId}
                      onChange={(e) => setConfigProviderId(e.target.value)}
                      required
                      className="w-full p-2 mt-1 border rounded bg-background text-sm"
                    >
                      <option value="">-- Choose Provider --</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.code})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Account Number */}
                  <div>
                    <Label className="text-xs font-semibold">Merchant Account Number / ID *</Label>
                    <Input
                      value={configAccountNo}
                      onChange={(e) => setConfigAccountNo(e.target.value)}
                      placeholder="e.g. 100234 or sacco_livepay_account"
                      required
                      className="mt-1 font-mono text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      This is the SACCO's specific merchant wallet / collection account number.
                    </p>
                  </div>

                  {/* API Key */}
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold">Provider API Key *</Label>
                      <button
                        type="button"
                        onClick={() => setShowConfigApiKey(!showConfigApiKey)}
                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                      >
                        {showConfigApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {showConfigApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <Input
                      type={showConfigApiKey ? 'text' : 'password'}
                      value={configApiKey}
                      onChange={(e) => setConfigApiKey(e.target.value)}
                      placeholder="e.g. lp_live_••••••••"
                      required
                      className="mt-1 font-mono text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      The secret API key provided by LivePay for this SACCO.
                    </p>
                  </div>

                  {/* Webhook Secret */}
                  <div>
                    <Label className="text-xs font-semibold">Webhook Secret (Optional)</Label>
                    <Input
                      value={configWebhookSecret}
                      onChange={(e) => setConfigWebhookSecret(e.target.value)}
                      placeholder="Provider webhook verification secret"
                      className="mt-1 font-mono text-sm"
                    />
                  </div>

                  {/* Base URL */}
                  <div>
                    <Label className="text-xs font-semibold">Provider Base URL</Label>
                    <Input
                      value={configBaseUrl}
                      onChange={(e) => setConfigBaseUrl(e.target.value)}
                      placeholder="https://livepay.me"
                      className="mt-1 text-sm font-mono"
                    />
                  </div>

                  {/* Credentials Ref */}
                  <div>
                    <Label className="text-xs font-semibold">Credentials Reference (Optional)</Label>
                    <Input
                      value={configCredentialsRef}
                      onChange={(e) => setConfigCredentialsRef(e.target.value)}
                      placeholder="e.g. VAULT_SACCO_01 or LIVEPAY_ST_JUDE"
                      className="mt-1 text-sm font-mono"
                    />
                  </div>

                  {/* Active Switch */}
                  <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                    <div>
                      <Label className="text-sm font-medium">Activate for Transactions</Label>
                      <p className="text-xs text-muted-foreground">
                        When active, payments for this SACCO will directly use these credentials.
                      </p>
                    </div>
                    <Switch
                      checked={configIsActive}
                      onCheckedChange={setConfigIsActive}
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <Button type="submit" disabled={submittingConfig} className="flex-1">
                      {submittingConfig ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-4 h-4 mr-2" />
                      )}
                      {editingConfigId ? 'Update Credentials' : 'Save SACCO Credentials'}
                    </Button>
                    {editingConfigId && (
                      <Button type="button" variant="outline" onClick={resetConfigForm}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>

            {/* Configured List Card */}
            <div className="lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-semibold">Configured SACCO Provider Credentials</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Live rows in <code>tenant_provider_configs</code> ({tenantConfigs.length} configured)
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resetConfigForm}
                  className="gap-1 text-xs"
                >
                  <Plus className="w-3.5 h-3.5" /> New Config
                </Button>
              </div>

              {tenantConfigs.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="py-12 text-center space-y-3">
                    <Key className="w-10 h-10 text-muted-foreground mx-auto opacity-50" />
                    <h4 className="font-semibold text-base">No SACCO Provider Keys Added Yet</h4>
                    <p className="text-xs text-muted-foreground max-w-md mx-auto">
                      All SACCO payments currently fall back to the global platform credentials configured in your
                      server environment. Use the form on the left to add a custom merchant account for a specific
                      SACCO.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {tenantConfigs.map((cfg) => {
                    const summary = cfg.configSummary
                    const accountNo = summary?.accountNo
                    const baseUrl = summary?.baseUrl || 'https://livepay.me'

                    return (
                      <Card
                        key={cfg.id}
                        className={`transition-all ${
                          editingConfigId === cfg.id
                            ? 'ring-2 ring-primary border-transparent'
                            : 'hover:border-primary/40'
                        }`}
                      >
                        <CardContent className="pt-4 pb-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="font-bold text-base">
                                  {cfg.tenant?.name || 'Unknown SACCO'}
                                </h4>
                                <span className="font-mono text-xs text-muted-foreground">
                                  ({cfg.tenant?.code || cfg.tenantId})
                                </span>
                              </div>
                              <p className="text-xs text-primary font-medium mt-0.5 flex items-center gap-1">
                                <span>Provider:</span>
                                <strong>{cfg.provider?.name || cfg.providerId}</strong>
                              </p>
                            </div>

                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[11px] px-2.5 py-0.5 rounded-full font-semibold ${
                                  cfg.isActive
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                              >
                                {cfg.isActive ? 'Active' : 'Inactive'}
                              </span>
                            </div>
                          </div>

                          {/* Credentials Grid */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs bg-muted/40 p-3 rounded-md font-mono">
                            <div>
                              <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                                Account No:
                              </span>
                              <span className="font-semibold text-foreground">
                                {accountNo || 'Not specified'}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                                API Key:
                              </span>
                              <span className="text-foreground">
                                {summary?.hasApiKey ? (
                                  <span className="text-emerald-600 dark:text-emerald-400">
                                    •••• configured
                                  </span>
                                ) : (
                                  <span className="text-amber-600 dark:text-amber-400">
                                    not set — using platform fallback
                                  </span>
                                )}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                                Base URL:
                              </span>
                              <span className="text-muted-foreground truncate block">
                                {baseUrl}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block text-[10px] uppercase font-sans">
                                Updated:
                              </span>
                              <span className="text-muted-foreground font-sans" suppressHydrationWarning>
                                {new Date(cfg.updatedAt || cfg.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                          </div>

                          {/* Actions row */}
                          <div className="flex items-center justify-between pt-1 border-t text-xs">
                            <div
                              onClick={() => handleToggleConfig(cfg.id, cfg.isActive)}
                              className="text-xs text-muted-foreground hover:text-foreground font-medium flex items-center gap-1.5 cursor-pointer select-none"
                            >
                              <Switch
                                checked={cfg.isActive}
                                onCheckedChange={() => handleToggleConfig(cfg.id, cfg.isActive)}
                                className="scale-75"
                              />
                              <span>{cfg.isActive ? 'Deactivate' : 'Activate'}</span>
                            </div>

                            <div className="flex items-center gap-2">
                              {cfg.tenant?.code && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-8 text-xs gap-1"
                                  onClick={() => handleTestTenantPin(cfg.tenant!.code, cfg.tenant?.name)}
                                >
                                  <ArrowRight className="w-3.5 h-3.5" /> Test PIN
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs gap-1"
                                onClick={() => handleEditConfig(cfg)}
                              >
                                <Edit3 className="w-3.5 h-3.5" /> Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteConfig(cfg.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ============================================================ */}
        {/* TAB 5: PAYMENT TYPES */}
        {/* ============================================================ */}
        <TabsContent value="payment-types">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Payment Type</CardTitle>
                <CardDescription>Add a new payment type to an application</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreatePaymentType} className="space-y-4">
                  <div>
                    <Label>Application</Label>
                    <select name="applicationId" required className="w-full p-2 border rounded bg-background text-sm">
                      {applications.map((app) => (
                        <option key={app.id} value={app.id}>
                          {app.name} ({app.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Code</Label>
                    <Input name="code" required placeholder="e.g. deposit, loan_repayment" />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea name="description" required placeholder="e.g. Member savings deposit" />
                  </div>
                  <Button type="submit">Create Payment Type</Button>
                </form>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Payment Types</h3>
              {applications.map((app) => (
                <div key={app.id} className="space-y-2">
                  <h4 className="font-semibold text-sm text-muted-foreground">{app.name}</h4>
                  {(app.paymentTypes || []).length === 0 ? (
                    <p className="text-xs text-muted-foreground italic pl-2">No payment types created yet.</p>
                  ) : (
                    app.paymentTypes?.map((pt) => (
                      <Card key={pt.id}>
                        <CardContent className="pt-4 pb-4">
                          <h5 className="font-medium text-sm font-mono">{pt.code}</h5>
                          <p className="text-xs text-muted-foreground mt-0.5">{pt.description}</p>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

