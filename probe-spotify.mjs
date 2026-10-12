// Probe every Spotify endpoint the game uses, so failures surface here instead
// of in the browser console mid-game.
//
//   node probe-spotify.mjs <access-token>
//   SPOTIFY_TOKEN=... node probe-spotify.mjs
//
// Get a token from the running game: open https://songless.sammpath.dev/spotify,
// then in the browser console:
//
//   copy(JSON.parse(localStorage['sp-token']).access_token)
//
// Tokens last an hour. The token is never printed, and nothing is written to
// disk — the output is only status codes and counts.

const token = process.argv[2] || process.env.SPOTIFY_TOKEN
if (!token) {
  console.error('usage: node probe-spotify.mjs <access-token>   (or set SPOTIFY_TOKEN)')
  process.exit(1)
}

const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m',
}

let pass = 0, fail = 0

async function hit(label, path, { note = '', count = null } = {}) {
  let status = 0
  let body = null
  let detail = ''

  try {
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    status = res.status
    const raw = await res.text()
    try { body = raw ? JSON.parse(raw) : null } catch {}
    if (!res.ok) detail = body?.error?.message || raw.slice(0, 80)
  } catch (err) {
    detail = err.message
  }

  const good = status >= 200 && status < 300
  good ? pass++ : fail++

  const n = good && count ? count(body) : null
  const colour = good ? C.ok : (status === 403 ? C.warn : C.bad)
  const tag = good ? 'OK ' : String(status).padEnd(3)

  console.log(
    `  ${colour}${tag}${C.off} ${label.padEnd(34)}`
    + (n !== null ? `${String(n).padStart(4)} items` : '          ')
    + (detail ? `  ${C.dim}${detail}${C.off}` : '')
    + (note ? `  ${C.dim}${note}${C.off}` : ''),
  )

  return body
}

const len = k => b => (b?.[k]?.length ?? b?.items?.length ?? 0)

console.log('\nIdentity')
const me = await hit('GET /me', '/me')
if (!me?.id) {
  console.error('\nToken rejected — grab a fresh one, they expire after an hour.')
  process.exit(1)
}
const market = me.country || 'US'
console.log(`  ${C.dim}account: ${me.display_name || me.id} · ${me.product} · ${market}${C.off}`)

console.log('\nCatalog sources')
const top = await hit('GET /me/top/tracks (offset 0)', '/me/top/tracks?limit=50&time_range=medium_term', { count: len('items') })
await hit('GET /me/top/tracks (offset 49)', '/me/top/tracks?limit=50&offset=49&time_range=medium_term', { count: len('items'), note: 'pagination past 50' })
const saved = await hit('GET /me/tracks', '/me/tracks?limit=50', { count: len('items') })
await hit('GET /me/player/recently-played', '/me/player/recently-played?limit=50', { count: len('items') })
const albums = await hit('GET /me/albums', '/me/albums?limit=50', { count: len('items'), note: 'saved albums' })
const follows = await hit('GET /me/following', '/me/following?type=artist&limit=50', { count: b => b?.artists?.items?.length ?? 0 })
const lists = await hit('GET /me/playlists', '/me/playlists?limit=50', { count: len('items') })

console.log('\nThings Development Mode tends to bar')
const pid = lists?.items?.find(Boolean)?.id
if (pid) await hit('GET /playlists/{id}/tracks', `/playlists/${pid}/tracks?limit=20`, { count: len('items') })
else console.log(`  ${C.dim}no playlists to test${C.off}`)

const aid = top?.items?.[0]?.artists?.[0]?.id
const tid = top?.items?.[0]?.id

if (aid) {
  await hit('GET /artists/{id}', `/artists/${aid}`, { note: 'single artist' })
  await hit('GET /artists?ids= (batch)', `/artists?ids=${aid}`, { count: b => b?.artists?.length ?? 0 })
  await hit('GET /artists/{id}/top-tracks', `/artists/${aid}/top-tracks?market=${market}`, { count: b => b?.tracks?.length ?? 0 })
  await hit('GET /artists/{id}/albums', `/artists/${aid}/albums?limit=20&market=${market}`, { count: len('items'), note: 'untapped source' })
} else {
  console.log(`  ${C.dim}no artist id available to test${C.off}`)
}

if (tid) {
  await hit('GET /audio-analysis/{id}', `/audio-analysis/${tid}`, { note: 'onset detection' })
  await hit('GET /audio-features/{id}', `/audio-features/${tid}`, { note: 'deprecated for new apps' })
  await hit('GET /recommendations', `/recommendations?limit=10&seed_tracks=${tid}`, { count: b => b?.tracks?.length ?? 0, note: 'deprecated for new apps' })
}

console.log('\nPlayback')
await hit('GET /me/player/devices', '/me/player/devices', { count: b => b?.devices?.length ?? 0 })

/* ---------- how big could the catalog get ---------- */

console.log('\nEstimated reach')
const savedTotal = saved?.total ?? 0
const albumTotal = albums?.total ?? 0
const followTotal = follows?.artists?.total ?? 0
console.log(`  ${C.dim}saved tracks: ${savedTotal} · saved albums: ${albumTotal} · artists followed: ${followTotal}${C.off}`)
console.log(`  ${C.dim}top tracks: up to ~99 per window x 3 windows${C.off}`)

console.log(`\n${pass} ok, ${fail} failed`)
console.log(`${C.dim}403 means the app is restricted for that endpoint (Development Mode), not that you lack permission.${C.off}\n`)
