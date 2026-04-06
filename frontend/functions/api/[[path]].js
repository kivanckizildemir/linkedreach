/**
 * Cloudflare Pages Function — proxies ALL /api/* requests to Railway.
 * The _redirects 200-rewrite only works for GET. This Workers function
 * handles every HTTP method (POST, PUT, PATCH, DELETE, etc.).
 */
const RAILWAY_URL = 'https://api-production-5994.up.railway.app'

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  // Rewrite origin to Railway
  const target = `${RAILWAY_URL}${url.pathname}${url.search}`

  const headers = new Headers(request.headers)
  headers.set('host', 'api-production-5994.up.railway.app')

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'

  const proxied = new Request(target, {
    method:  request.method,
    headers,
    body:    hasBody ? request.body : null,
    redirect: 'follow',
    duplex:  hasBody ? 'half' : undefined,
  })

  return fetch(proxied)
}
