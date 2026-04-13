/**
 * Local HTTP-CONNECT tunnel that bridges Playwright (plain HTTP proxy) to
 * BrightData's SSL proxy (port 33335).
 *
 * Playwright/Chromium only speaks plain-HTTP proxy (CONNECT over TCP).
 * BrightData's 33335 endpoint expects a TLS connection first.
 * This tunnel:
 *   1. Listens on 127.0.0.1:random_port as a plain HTTP proxy
 *   2. On CONNECT: opens a TLS socket to bdHost:33335
 *   3. Sends CONNECT + Proxy-Authorization to BrightData over TLS
 *   4. Pipes bytes bidirectionally once BrightData says 200
 */

import * as http from 'http'
import * as net  from 'net'
import * as tls  from 'tls'
import type { AddressInfo } from 'net'

export interface ProxyTunnel {
  /** Local port Playwright should connect to (http://127.0.0.1:<port>) */
  port:  number
  close: () => void
}

export function createBrightDataTunnel(
  bdHost:   string,
  bdPort:   number,
  username: string,
  password: string,
): Promise<ProxyTunnel> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()

    // Playwright always uses CONNECT for HTTPS targets
    server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
      const [targetHost, targetPortStr] = (req.url ?? '').split(':')
      const targetPort = parseInt(targetPortStr ?? '443', 10)

      // Open TLS connection to BrightData
      const bdSocket = tls.connect({
        host:               bdHost,
        port:               bdPort,
        rejectUnauthorized: false, // BrightData uses a self-signed / intermediate cert
      })

      bdSocket.once('error', (err) => {
        console.error('[proxy-tunnel] TLS connect error:', err.message)
        clientSocket.destroy()
      })

      bdSocket.once('secureConnect', () => {
        // Forward CONNECT with auth to BrightData over the TLS socket
        const auth = Buffer.from(`${username}:${password}`).toString('base64')
        const connectReq =
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          `\r\n`

        bdSocket.write(connectReq)

        // Read BrightData's response (wait for the blank line)
        let responseBuf = ''
        const onData = (chunk: Buffer) => {
          responseBuf += chunk.toString('binary')
          const headerEnd = responseBuf.indexOf('\r\n\r\n')
          if (headerEnd === -1) return

          bdSocket.removeListener('data', onData)

          const statusLine = responseBuf.split('\r\n')[0] ?? ''
          const leftover   = Buffer.from(responseBuf.slice(headerEnd + 4), 'binary')

          if (/^HTTP\/1\.[01] 200/.test(statusLine)) {
            // Tell Chromium the tunnel is open
            clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n')

            // Replay any bytes already buffered after the response headers
            if (leftover.length > 0) clientSocket.write(leftover)
            if (head && head.length > 0) bdSocket.write(head)

            // Bidirectional pipe
            bdSocket.pipe(clientSocket)
            clientSocket.pipe(bdSocket)

            clientSocket.on('error', () => bdSocket.destroy())
            bdSocket.on('error',     () => clientSocket.destroy())
          } else {
            console.error('[proxy-tunnel] BrightData rejected CONNECT:', statusLine)
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`)
            clientSocket.destroy()
            bdSocket.destroy()
          }
        }

        bdSocket.on('data', onData)
      })

      clientSocket.on('error', () => bdSocket.destroy())
    })

    // Ignore plain HTTP requests (Playwright only uses CONNECT for HTTPS)
    server.on('request', (_req, res) => {
      res.writeHead(405).end()
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      console.log(`[proxy-tunnel] Listening on 127.0.0.1:${port} → ${bdHost}:${bdPort} (TLS)`)
      resolve({
        port,
        close: () => server.close(),
      })
    })

    server.on('error', reject)
  })
}
