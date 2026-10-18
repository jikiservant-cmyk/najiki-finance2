import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function jsonError(message: string, status = 404) {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store, max-age=0' } })
}

export async function GET() {
  return jsonError('Not found: this API endpoint does not exist', 404)
}
export async function POST() {
  return jsonError('Not found: this API endpoint does not exist', 404)
}
export async function PUT() {
  return jsonError('Not found: this API endpoint does not exist', 404)
}
export async function DELETE() {
  return jsonError('Not found: this API endpoint does not exist', 404)
}
export async function PATCH() {
  return jsonError('Not found: this API endpoint does not exist', 404)
}
export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin') || ''
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Idempotency-Key',
    Vary: 'Origin',
  }
  if (allowedOrigins.length === 0) headers['Access-Control-Allow-Origin'] = '*'
  else if (origin && allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  else headers['Access-Control-Allow-Origin'] = 'null'
  return new NextResponse(null, { status: 204, headers })
}
