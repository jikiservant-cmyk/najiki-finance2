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
import { Copy } from 'lucide-react'

interface Application {
  id: string
  code: string
  name: string
  baseUrl: string
  webhookPath: string
  internalSecretRef: string
  apiKey: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  tenants: any[]
  paymentTypes: any[]
}

interface Tenant {
  id: string
  applicationId: string
  code: string
  appType: string
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

export default function SetupPage() {
  const [applications, setApplications] = useState<Application[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    try {
      const res = await fetch('/api/debug-apps')
      const data = await res.json()
      setApplications(data.applications || [])
      setProviders(data.providers || [])
    } catch (error) {
      console.error('Failed to fetch data:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateApplication(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      code: formData.get('code') as string,
      name: formData.get('name') as string,
      baseUrl: formData.get('baseUrl') as string,
      webhookPath: formData.get('webhookPath') as string,
      internalSecretRef: formData.get('internalSecretRef') as string,
      isActive: (formData.get('isActive') as string) === 'on',
    }
    const res = await fetch('/api/setup', { 
      method: 'POST', 
      body: JSON.stringify({ type: 'application', data }) 
    })
    const newApp = await res.json()
    setNewApiKey(newApp.apiKey)
    e.currentTarget.reset()
    fetchData()
  }

  async function handleCreateProvider(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      code: formData.get('code') as string,
      name: formData.get('name') as string,
      credentialsRef: formData.get('credentialsRef') as string,
      isActive: (formData.get('isActive') as string) === 'on',
    }
    await fetch('/api/setup', { method: 'POST', body: JSON.stringify({ type: 'provider', data }) })
    e.currentTarget.reset()
    fetchData()
  }

  async function handleCreateTenant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      applicationId: formData.get('applicationId') as string,
      code: formData.get('code') as string,
      appType: formData.get('appType') as string,
      name: formData.get('name') as string,
      defaultProviderId: formData.get('defaultProviderId') as string,
      isActive: (formData.get('isActive') as string) === 'on',
    }
    await fetch('/api/setup', { method: 'POST', body: JSON.stringify({ type: 'tenant', data }) })
    e.currentTarget.reset()
    fetchData()
  }

  async function handleCreatePaymentType(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data = {
      applicationId: formData.get('applicationId') as string,
      code: formData.get('code') as string,
      description: formData.get('description') as string,
    }
    await fetch('/api/setup', { method: 'POST', body: JSON.stringify({ type: 'paymentType', data }) })
    e.currentTarget.reset()
    fetchData()
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
  }

  if (loading) return <div className="container mx-auto py-8">Loading...</div>

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8">NaJiki Setup</h1>
      
      {newApiKey && (
        <Alert className="mb-8 border-green-500 bg-green-50">
          <AlertDescription className="flex items-center gap-4">
            <div className="flex-1">
              <p className="font-bold text-green-800">Application API Key</p>
              <p className="text-green-700 font-mono break-all">{newApiKey}</p>
            </div>
            <Button onClick={() => copyToClipboard(newApiKey)} variant="default" size="sm">
              <Copy className="w-4 h-4 mr-2" /> Copy
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="applications">
        <TabsList className="mb-8">
          <TabsTrigger value="applications">Applications</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="tenants">Tenants</TabsTrigger>
          <TabsTrigger value="payment-types">Payment Types</TabsTrigger>
        </TabsList>

        <TabsContent value="applications">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Application</CardTitle>
                <CardDescription>Add a new application to NaJiki</CardDescription>
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
                    <Input name="webhookPath" required placeholder="/api/internal/payment-completed" defaultValue="/api/internal/payment-completed" />
                  </div>
                  <div>
                    <Label>Internal Secret Ref</Label>
                    <Input name="internalSecretRef" required placeholder="e.g. SACCO_INTERNAL_SECRET" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label>Active</Label>
                    <Switch name="isActive" defaultChecked />
                  </div>
                  <Button type="submit">Create Application</Button>
                </form>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Applications</h3>
              {applications.map((app) => (
                <Card key={app.id}>
                  <CardContent className="pt-6">
                    <h4 className="font-bold">{app.name} ({app.code})</h4>
                    <p className="text-sm text-muted-foreground">{app.baseUrl}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Tenants: {app.tenants?.length || 0} • Payment Types: {app.paymentTypes?.length || 0}
                    </p>
                    {app.apiKey && (
                      <div className="mt-3">
                        <Label className="text-xs">API Key:</Label>
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-xs font-mono bg-muted p-2 rounded flex-1 overflow-x-auto">
                            {app.apiKey}
                          </p>
                          <Button onClick={() => copyToClipboard(app.apiKey!)} variant="default" size="sm">
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="providers">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Provider</CardTitle>
                <CardDescription>Add a new payment provider to NaJiki</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateProvider} className="space-y-4">
                  <div>
                    <Label>Code</Label>
                    <Input name="code" required placeholder="e.g. livepay" />
                  </div>
                  <div>
                    <Label>Name</Label>
                    <Input name="name" required placeholder="e.g. LivePay" />
                  </div>
                  <div>
                    <Label>Credentials Ref</Label>
                    <Input name="credentialsRef" required placeholder="e.g. LIVEPAY_" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label>Active</Label>
                    <Switch name="isActive" defaultChecked />
                  </div>
                  <Button type="submit">Create Provider</Button>
                </form>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Providers</h3>
              {providers.map((provider) => (
                <Card key={provider.id}>
                  <CardContent className="pt-6">
                    <h4 className="font-bold">{provider.name} ({provider.code})</h4>
                    <p className="text-sm text-muted-foreground">{provider.credentialsRef}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="tenants">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Tenant</CardTitle>
                <CardDescription>Add a new tenant to an application</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreateTenant} className="space-y-4">
          <div>
            <Label>Application</Label>
            <select name="applicationId" required className="w-full p-2 border rounded">
              {applications.map((app) => (
                <option key={app.id} value={app.id}>{app.name} ({app.code})</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Code</Label>
            <Input name="code" required placeholder="e.g. abc-sacco" />
          </div>
          <div>
            <Label>Name</Label>
            <Input name="name" required placeholder="e.g. ABC SACCO" />
          </div>
          <div>
            <Label>Default Provider</Label>
            <select name="defaultProviderId" className="w-full p-2 border rounded">
              <option value="">None</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name} ({provider.code})</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Label>Active</Label>
            <Switch name="isActive" defaultChecked />
          </div>
          <Button type="submit">Create Tenant</Button>
        </form>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Tenants</h3>
              {applications.map((app) => (
                <div key={app.id} className="mb-4">
                  <h4 className="font-semibold mb-2">{app.name}</h4>
                  {app.tenants?.map((tenant) => (
                    <Card key={tenant.id} className="mb-2">
                      <CardContent className="pt-4">
                        <h5 className="font-medium">{tenant.name} ({tenant.code})</h5>
                        <p className="text-xs text-muted-foreground">{tenant.appType}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="payment-types">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <Card>
              <CardHeader>
                <CardTitle>Create Payment Type</CardTitle>
                <CardDescription>Add a new payment type to an application</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleCreatePaymentType} className="space-y-4">
                  <div>
                    <Label>Application</Label>
                    <select name="applicationId" required className="w-full p-2 border rounded">
                      {applications.map((app) => (
                        <option key={app.id} value={app.id}>{app.name} ({app.code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label>Code</Label>
                    <Input name="code" required placeholder="e.g. account_activation" />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea name="description" required placeholder="e.g. Account activation fee" />
                  </div>
                  <Button type="submit">Create Payment Type</Button>
                </form>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Existing Payment Types</h3>
              {applications.map((app) => (
                <div key={app.id} className="mb-4">
                  <h4 className="font-semibold mb-2">{app.name}</h4>
                  {app.paymentTypes?.map((pt) => (
                    <Card key={pt.id} className="mb-2">
                      <CardContent className="pt-4">
                        <h5 className="font-medium">{pt.code}</h5>
                        <p className="text-xs text-muted-foreground">{pt.description}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
