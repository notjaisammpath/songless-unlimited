// Zero-dependency static server for Songless Unlimited.
// Binds 0.0.0.0 so other devices on your LAN / tailnet can play.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createSign } from 'node:crypto'
import { join, extname, normalize } from 'node:path'
import { networkInterfaces } from 'node:os'

const ROOT = import.meta.dirname
const PORT = Number(process.env.PORT ?? 3000)
// Behind a Cloudflare tunnel, bind loopback only: HOST=127.0.0.1
// For LAN/tailnet access, leave the default.
const HOST = process.env.HOST ?? '0.0.0.0'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/* ============================================================
   Apple MusicKit developer token

   MusicKit needs an ES256 JWT signed with a private key from the Apple
   Developer Program. The key must never reach the browser, so it is signed
   here and handed out as a short-lived token.

   Configure via environment (see deploy/SETUP.md):
     APPLE_TEAM_ID   10-character Team ID
     APPLE_KEY_ID    10-character MusicKit Key ID
     APPLE_P8_PATH   path to the AuthKey_XXXXXXXXXX.p8 file
   ============================================================ */

const APPLE = {
  teamId: process.env.APPLE_TEAM_ID,
  keyId: process.env.APPLE_KEY_ID,
  p8Path: process.env.APPLE_P8_PATH,
}

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let cachedToken = null   // { token, exp }

async function appleDeveloperToken() {
  const now = Math.floor(Date.now() / 1000)
  // Reuse until it is within an hour of expiry.
  if (cachedToken && cachedToken.exp - now > 3600) return cachedToken.token

  const pem = await readFile(APPLE.p8Path, 'utf8')
  const header = { alg: 'ES256', kid: APPLE.keyId, typ: 'JWT' }
  // Apple caps developer tokens at 180 days; 30 is plenty and limits exposure.
  const exp = now + 30 * 24 * 60 * 60
  const payload = { iss: APPLE.teamId, iat: now, exp }

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  // JWT requires the raw r||s form, not DER.
  const sig = createSign('SHA256').update(signingInput)
    .sign({ key: pem, dsaEncoding: 'ieee-p1363' })

  cachedToken = { token: `${signingInput}.${b64url(sig)}`, exp }
  return cachedToken.token
}

function appleMissing() {
  const missing = []
  if (!APPLE.teamId) missing.push('APPLE_TEAM_ID')
  if (!APPLE.keyId) missing.push('APPLE_KEY_ID')
  if (!APPLE.p8Path) missing.push('APPLE_P8_PATH')
  return missing
}

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)

    // Mint a MusicKit developer token. Returns 503 with the exact missing
    // configuration until the Apple Developer key is in place.
    if (path === '/apple-token') {
      const missing = appleMissing()
      const send = (code, obj) => res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }).end(JSON.stringify(obj))

      if (missing.length) {
        send(503, {
          error: 'not_configured',
          missing,
          hint: 'Set these in the songless service environment, then restart it.',
        })
        return
      }
      try {
        send(200, { token: await appleDeveloperToken() })
      } catch (err) {
        send(500, { error: 'sign_failed', detail: err.message })
      }
      return
    }

    // Clean routes. /callback MUST resolve to the Spotify page — that's where
    // Spotify sends the OAuth code, and the landing page can't handle it.
    const ROUTES = {
      '/': '/index.html',
      '/spotify': '/spotify.html',
      '/callback': '/spotify.html',
      '/itunes': '/itunes.html',
      '/probe': '/probe.html',
      '/apple': '/apple.html',
    }
    if (ROUTES[path]) path = ROUTES[path]
    else if (!extname(path)) path = '/index.html'

    // Keep requests inside ROOT.
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''))
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }

    let body = await readFile(full)
    const ext = extname(full).toLowerCase()

    // Cloudflare ignores `no-cache` on .js and imposes its own max-age=14400,
    // so a redeploy would otherwise serve stale code to browsers for 4 hours.
    // Stamp the script URL with app.js's mtime: new deploy, new URL, no stale hit.
    if (ext === '.html') {
      let v = '0'
      try { v = String(Math.floor((await stat(join(ROOT, 'app.js'))).mtimeMs)) } catch {}
      body = Buffer.from(
        body.toString('utf8').replace(/src="app\.js(?:\?[^"]*)?"/g, `src="app.js?v=${v}"`),
        'utf8',
      )
    }

    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // HTML must never be held, or the versioned script URL never updates.
      'Cache-Control': ext === '.html' ? 'no-store, must-revalidate' : 'no-cache',
    }).end(body)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Server error: ${err.message}`)
  }
})

server.listen(PORT, HOST, () => {
  const addrs = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push({ name, ip: ni.address })
    }
  }
  console.log(`\n  🎤  Songless Unlimited\n`)
  // Spotify no longer accepts `localhost` as a redirect-URI host, so 127.0.0.1
  // is the address that actually works for the OAuth round trip.
  console.log(`      PLAY HERE   http://127.0.0.1:${PORT}`)
  console.log(`      itunes mode http://127.0.0.1:${PORT}/itunes   (no Spotify needed)`)
  console.log('')
  for (const a of addrs) {
    const tag = /tailscale/i.test(a.name) ? 'tailnet' : 'network'
    console.log(`      ${tag.padEnd(11)} http://${a.ip}:${PORT}   (${a.name})`)
  }
  console.log(`\n      Ctrl+C to stop\n`)
})
