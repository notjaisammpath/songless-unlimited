// Zero-dependency static server for Songless Unlimited.
// Binds 0.0.0.0 so other devices on your LAN / tailnet can play.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
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

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)

    // Clean routes. /callback MUST resolve to the Spotify page — that's where
    // Spotify sends the OAuth code, and the landing page can't handle it.
    const ROUTES = {
      '/': '/index.html',
      '/spotify': '/spotify.html',
      '/callback': '/spotify.html',
      '/itunes': '/itunes.html',
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

    const body = await readFile(full)
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
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
