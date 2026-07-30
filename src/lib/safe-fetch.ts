process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

export async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return fetch(input, init)
}
