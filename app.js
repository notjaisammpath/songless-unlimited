'use strict'

/* ============================================================
   Songless Unlimited — Spotify mode
   Real tracks, clips start at true 0:00, catalog from your own listening.
   Requires Spotify Premium (Web Playback SDK restriction).
   ============================================================ */

const STAGES = [0.1, 0.5, 1, 2, 4, 7, 11, 16]
const MAX_ATTEMPTS = STAGES.length
const FULL = STAGES[STAGES.length - 1]

// Sub-second stages need a decimal; whole seconds should not show one.
const fmt = s => (s < 1 ? s.toFixed(1) : String(s))

// 0.1s on a linear 16s bar is an invisible sliver — sqrt scaling spreads
// the early stages across usable width.
const scale = t => Math.sqrt(Math.max(0, t) / FULL) * 100

// Public PKCE client id for this project's Spotify app. Not a secret — PKCE
// uses no client secret. Override it in-app via Settings if you swap apps.
const DEFAULT_CLIENT_ID = '71a99d582dc34ab9a458ff1e83b55bf0'

const K_CLIENT = 'sp-client-id'
const K_TOKEN = 'sp-token'
const K_VERIFIER = 'sp-verifier'
const K_CATALOG = 'sp-catalog'
const K_STATS = 'sp-stats'
const K_BAG = 'sp-bag'

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-top-read',
  'user-library-read',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ')

// Artist genres that count as hip-hop for catalog filtering.
const RAP_RE = /hip hop|hip-hop|\brap\b|trap|drill|grime|crunk|hyphy|bounce|phonk/i

/* ---------------- state ---------------- */

let CATALOG = []
let song = null
let guesses = []
let finished = false
let won = false
let selIdx = -1
let lastSuggestions = []

let player = null
let deviceId = null
let playerReady = false
let gen = 0
let pollId = null
let cutId = null
let isPlaying = false
let profile = null
let bootPhase = 'starting up'
let playbackErrors = 0

// Spotify's Web Playback SDK supports Chrome, Edge and Safari. Firefox's
// Widevine CDM gets rejected at the license endpoint with a 403, so playback
// never starts even though the device registers correctly.
const IS_FIREFOX = /firefox|fxios/i.test(navigator.userAgent)

const $ = id => document.getElementById(id)
const redirectUri = () => `${location.origin}/callback`

/* ---------------- small helpers ---------------- */

const norm = s => (s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

const label = s => `${s.artist} — ${s.title}`
const unlocked = () => STAGES[Math.min(guesses.length, MAX_ATTEMPTS - 1)]

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function toast(msg, ms = 2200) {
  const t = $('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { t.hidden = true }, ms)
}

const lsGet = (k, d = null) => {
  if (k === K_CLIENT) {
    try { return JSON.parse(localStorage.getItem(k)) || DEFAULT_CLIENT_ID } catch { return DEFAULT_CLIENT_ID }
  }
  try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d }
}
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

/* ============================================================
   PKCE auth — no client secret touches this machine
   ============================================================ */

function randomString(len) {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('')
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function login() {
  const clientId = lsGet(K_CLIENT)
  if (!clientId) { renderSetup('Enter your Client ID first.'); return }

  const verifier = randomString(64)
  lsSet(K_VERIFIER, verifier)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  })
  location.href = `https://accounts.spotify.com/authorize?${params}`
}

async function exchangeCode(code) {
  const clientId = lsGet(K_CLIENT)
  const verifier = lsGet(K_VERIFIER)
  if (!verifier) throw new Error('Missing PKCE verifier — start the login again.')

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    }),
  })

  const j = await res.json()
  if (!res.ok) throw new Error(j.error_description || j.error || `token exchange failed (${res.status})`)

  lsSet(K_TOKEN, { ...j, expires_at: Date.now() + (j.expires_in - 60) * 1000 })
  localStorage.removeItem(K_VERIFIER)
}

async function refresh() {
  const tok = lsGet(K_TOKEN)
  const clientId = lsGet(K_CLIENT)
  if (!tok?.refresh_token) throw new Error('No refresh token')

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: clientId,
    }),
  })

  const j = await res.json()
  if (!res.ok) throw new Error(j.error_description || 'refresh failed')

  // Spotify may or may not rotate the refresh token.
  lsSet(K_TOKEN, {
    ...tok, ...j,
    refresh_token: j.refresh_token || tok.refresh_token,
    expires_at: Date.now() + (j.expires_in - 60) * 1000,
  })
}

async function getToken() {
  let tok = lsGet(K_TOKEN)
  if (!tok?.access_token) throw new Error('Not connected')
  if (Date.now() >= tok.expires_at) {
    await refresh()
    tok = lsGet(K_TOKEN)
  }
  return tok.access_token
}

function logout() {
  for (const k of [K_TOKEN, K_VERIFIER, K_CATALOG, K_BAG]) localStorage.removeItem(k)
  location.href = `${location.origin}/spotify`
}

/* ============================================================
   Web API
   ============================================================ */

async function api(path, opts = {}) {
  const token = await getToken()
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })

  if (res.status === 204) return null
  if (res.status === 429) {
    const wait = Number(res.headers.get('Retry-After') || 2)
    await new Promise(r => setTimeout(r, (wait + 1) * 1000))
    return api(path, opts)
  }
  if (!res.ok) {
    // Include the raw body and the request itself — a bare "403 Forbidden"
    // is useless when half a dozen different calls could have produced it.
    const raw = await res.text().catch(() => '')
    let detail = ''
    try { detail = JSON.parse(raw)?.error?.message || '' } catch {}
    if (!detail) detail = raw.slice(0, 300).replace(/\s+/g, ' ').trim() || res.statusText

    const err = new Error(`${res.status} ${detail}  [${opts.method || 'GET'} ${path}]`)
    err.status = res.status
    err.path = path
    console.error('Spotify API error', { status: res.status, path, method: opts.method || 'GET', body: raw })
    throw err
  }
  return res.json().catch(() => null)
}

/* ============================================================
   Catalog — built from what you actually listen to
   ============================================================ */

const ids_of = t => (t.artists || []).map(a => a.id).filter(Boolean)

async function buildCatalog(includeAllGenres = false) {
  const progress = m => { const el = $('build-status'); if (el) el.textContent = m }

  const tracks = new Map()

  // Top tracks across all three windows.
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    progress(`Reading your top tracks (${range.replace('_term', '')})…`)
    const r = await api(`/me/top/tracks?limit=50&time_range=${range}`)
    for (const t of r?.items || []) if (t?.id) tracks.set(t.id, t)
  }

  // Saved library.
  for (let page = 0; page < 6; page++) {
    progress(`Reading your saved songs… (${tracks.size} found)`)
    const r = await api(`/me/tracks?limit=50&offset=${page * 50}`)
    const items = r?.items || []
    for (const it of items) if (it?.track?.id) tracks.set(it.track.id, it.track)
    if (items.length < 50) break
  }

  if (!tracks.size) throw new Error('Spotify returned no tracks for your account.')

  // Artist genres are the only genre signal left to new apps (audio-features is
  // deprecated). But /artists itself 403s for apps stuck in Development Mode,
  // so treat it as best-effort enrichment and never let it abort the build.
  const artistIds = [...new Set([...tracks.values()].flatMap(t => (t.artists || []).map(a => a.id)).filter(Boolean))]
  const genreOf = new Map()
  let genresBlocked = false

  // Try the batch endpoint first. Development Mode bars it for some apps, but
  // the single-artist endpoint often still works, so fall back to that rather
  // than giving up on genre data entirely.
  let batchWorks = true

  for (let i = 0; i < artistIds.length && batchWorks; i += 20) {
    progress(`Checking genres… (${i}/${artistIds.length} artists)`)
    try {
      const r = await api(`/artists?ids=${artistIds.slice(i, i + 20).join(',')}`)
      for (const a of r?.artists || []) if (a?.id) genreOf.set(a.id, a.genres || [])
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err
      batchWorks = false
      console.warn('Batch /artists is barred for this app; falling back to single lookups.')
    }
  }

  if (!batchWorks) {
    // One request per artist. Slower, but it yields the real genre tags.
    for (const [n, id] of artistIds.entries()) {
      if (genreOf.has(id)) continue
      if (n % 5 === 0) progress(`Checking genres one by one… (${n}/${artistIds.length})`)
      try {
        const a = await api(`/artists/${id}`)
        if (a?.id) genreOf.set(a.id, a.genres || [])
      } catch (err) {
        if (err.status === 403 || err.status === 404) {
          console.warn('Single /artists is barred too; genre data unavailable.')
          break
        }
        // A one-off failure shouldn't abandon the remaining artists.
      }
    }
  }

  // Only claim the filter is unusable when coverage is genuinely too thin to
  // judge by. Filtering on mostly-missing data is what produced an empty
  // catalog before.
  const coverage = artistIds.length ? genreOf.size / artistIds.length : 0
  genresBlocked = coverage < 0.5
  console.log(`genre coverage: ${genreOf.size}/${artistIds.length} artists (${Math.round(coverage * 100)}%)`)

  const effectiveFilter = genresBlocked ? false : !includeAllGenres

  const out = []
  for (const t of tracks.values()) {
    const ids = (t.artists || []).map(a => a.id).filter(Boolean)
    const judgeable = ids.some(id => genreOf.has(id))
    const genres = ids.flatMap(id => genreOf.get(id) || [])
    const isRap = genres.some(g => RAP_RE.test(g))
    // Drop a track only when we actually know its genres and none qualify.
    if (effectiveFilter && judgeable && !isRap) continue
    if (t.is_local) continue
    if (!t.uri) continue

    out.push({
      id: t.id,
      uri: t.uri,
      title: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      primaryArtist: t.artists?.[0]?.name || '',
      album: t.album?.name || '',
      artworkUrl: t.album?.images?.[0]?.url || '',
      year: Number(String(t.album?.release_date || '').slice(0, 4)) || undefined,
      durationMs: t.duration_ms,
      genres: [...new Set(genres)].slice(0, 4),
    })
  }

  // Collapse the same song appearing as single + album + deluxe.
  const bySong = new Map()
  for (const s of out) {
    const k = `${norm(s.primaryArtist)}::${norm(s.title)}`
    if (!bySong.has(k)) bySong.set(k, s)
  }

  let catalog = [...bySong.values()]

  // If filtering wiped out essentially everything, the genre data was wrong or
  // absent rather than the library being empty — keep the tracks instead.
  if (catalog.length < 10 && tracks.size >= 20 && effectiveFilter) {
    console.warn('Genre filter emptied the catalog; keeping all scanned tracks.')
    const all = new Map()
    for (const t of tracks.values()) {
      if (t.is_local || !t.uri) continue
      const k = `${norm(t.artists?.[0]?.name || '')}::${norm(t.name)}`
      if (all.has(k)) continue
      all.set(k, {
        id: t.id,
        uri: t.uri,
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        primaryArtist: t.artists?.[0]?.name || '',
        album: t.album?.name || '',
        artworkUrl: t.album?.images?.[0]?.url || '',
        year: Number(String(t.album?.release_date || '').slice(0, 4)) || undefined,
        durationMs: t.duration_ms,
        genres: [...new Set(ids_of(t).flatMap(id => genreOf.get(id) || []))].slice(0, 4),
      })
    }
    catalog = [...all.values()]
    genresBlocked = true
  }

  lsSet(K_CATALOG, {
    builtAt: Date.now(),
    includeAllGenres,
    genresBlocked,
    songs: catalog,
    scanned: tracks.size,
  })
  return catalog
}

/* ============================================================
   Web Playback SDK
   ============================================================ */

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (window.Spotify) return resolve()
    window.onSpotifyWebPlaybackSDKReady = () => resolve()
    const s = document.createElement('script')
    s.src = 'https://sdk.scdn.co/spotify-player.js'
    s.onerror = () => reject(new Error('Could not load the Spotify player SDK (offline?)'))
    document.head.appendChild(s)
  })
}

async function initPlayer() {
  await loadSdk()

  player = new Spotify.Player({
    name: 'Songless Unlimited',
    volume: 0.75,
    getOAuthToken: cb => { getToken().then(cb).catch(() => {}) },
  })

  player.addListener('ready', ({ device_id }) => {
    deviceId = device_id
    playerReady = true
  })
  player.addListener('not_ready', () => { playerReady = false })

  player.addListener('initialization_error', ({ message }) => fatal(`Player init failed: ${message}`))
  player.addListener('authentication_error', ({ message }) => {
    fatal(`Spotify rejected the token: ${message}`, true)
  })
  player.addListener('account_error', () => {
    fatal('The Web Playback SDK requires Spotify Premium. This account was rejected as non-Premium.')
  })
  player.addListener('playback_error', ({ message }) => {
    console.error('playback_error', message)
    playbackErrors++
    // The SDK retries the licence request in a loop; one toast per attempt is
    // noise. After a couple of failures, say what is actually wrong.
    if (playbackErrors === 1) {
      toast('Playback error — check Spotify isn\'t playing elsewhere', 3000)
    } else if (playbackErrors === 3) {
      renderDrmWall()
    }
  })

  const connected = await player.connect()
  if (!connected) throw new Error('player.connect() returned false')

  // Wait for the device to register.
  for (let i = 0; i < 60 && !playerReady; i++) await new Promise(r => setTimeout(r, 250))
  if (!playerReady) throw new Error('Player never became ready (15s timeout)')
}

function stopPolling() {
  if (pollId) clearInterval(pollId)
  pollId = null
  if (cutId) clearTimeout(cutId)
  cutId = null
}

async function hardStop() {
  gen++
  stopPolling()
  isPlaying = false
  try { if (player) await player.pause() } catch {}
  setIcon(false)
  const p = document.querySelector('.played')
  if (p) p.style.width = '0%'
}

function setIcon(playing) {
  const el = $('play-ic')
  if (el) el.innerHTML = playing ? ICON_STOP : ICON_PLAY
}

/** Play the real track from 0:00 and cut it off at `seconds`. */
async function playClip(seconds) {
  if (!playerReady || !deviceId) { toast('Player not ready yet'); return }

  const my = ++gen
  stopPolling()

  try {
    await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [song.uri], position_ms: 0 }),
    })
  } catch (err) {
    // 404 NO_ACTIVE_DEVICE: transfer to our device, then retry once.
    if (/404|device/i.test(err.message)) {
      try {
        await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) })
        await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
          method: 'PUT',
          body: JSON.stringify({ uris: [song.uri], position_ms: 0 }),
        })
      } catch (e2) { toast(`Could not start playback: ${e2.message}`, 4000); return }
    } else {
      toast(`Could not start playback: ${err.message}`, 4000)
      return
    }
  }

  if (my !== gen) return
  isPlaying = true
  setIcon(true)

  const limit = seconds * 1000

  const cut = async () => {
    if (my !== gen) return
    stopPolling()
    isPlaying = false
    try { await player.pause() } catch {}
    setIcon(false)
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = '0%'
  }

  // The SDK reports real track position, so the cut stays accurate however long
  // the play request took. But a 0.1s clip is shorter than a comfortable poll
  // interval, so once playback is confirmed started we anchor a clock and
  // schedule the exact cut; polling then only drives the progress bar.
  let t0 = null

  pollId = setInterval(async () => {
    if (my !== gen) { stopPolling(); return }
    let st
    try { st = await player.getCurrentState() } catch { return }
    if (!st) return

    if (t0 === null && st.position > 0) {
      t0 = performance.now() - st.position
      cutId = setTimeout(cut, Math.max(20, limit - st.position))
    }

    const elapsed = t0 === null ? st.position : performance.now() - t0
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = `${Math.min(100, scale(elapsed / 1000))}%`

    // Backstop: if the timer never fires, or playback died outright.
    if (elapsed >= limit + 150 || (st.paused && st.position === 0 && t0 !== null)) cut()
  }, 10)
}

async function togglePlay() {
  if (isPlaying) { await hardStop(); return }
  await playClip(unlocked())
}

/** Reveal screen: play the whole track from the top. */
async function playFull() {
  if (!playerReady) { toast('Player not ready'); return }
  const my = ++gen
  stopPolling()
  try {
    await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [song.uri], position_ms: 0 }),
    })
    if (my !== gen) return
    isPlaying = true
    const b = $('full-ic'); if (b) b.textContent = '⏸'
  } catch (err) { toast(`Playback failed: ${err.message}`) }
}

async function pauseFull() {
  try { await player.pause() } catch {}
  isPlaying = false
  const b = $('full-ic'); if (b) b.textContent = '▶'
}

/* ============================================================
   Stats
   ============================================================ */

function loadStats() {
  return { played: 0, wins: 0, streak: 0, best: 0, dist: Array(MAX_ATTEMPTS).fill(0), ...(lsGet(K_STATS) || {}) }
}

function recordResult(didWin, attempts) {
  const s = loadStats()
  s.played++
  if (didWin) {
    s.wins++
    s.streak++
    s.best = Math.max(s.best, s.streak)
    s.dist[attempts - 1] = (s.dist[attempts - 1] || 0) + 1
  } else s.streak = 0
  lsSet(K_STATS, s)
}

/* ============================================================
   Song picking — shuffle bag, whole catalog before any repeat
   ============================================================ */

function nextFromBag() {
  let bag = lsGet(K_BAG, []) || []
  bag = Array.isArray(bag) ? bag.filter(id => CATALOG.some(s => s.id === id)) : []

  if (!bag.length) {
    bag = CATALOG.map(s => s.id)
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    if (song && bag.length > 1 && bag[bag.length - 1] === song.id) {
      ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
    }
  }

  const id = bag.pop()
  lsSet(K_BAG, bag)
  return CATALOG.find(s => s.id === id) || CATALOG[0]
}

/* ============================================================
   Icons
   ============================================================ */

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l10-6.5a1 1 0 0 0 0-1.74l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>'
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'

/* ============================================================
   Screens
   ============================================================ */

function hintFor(msg) {
  const m = String(msg)
  if (/403/.test(m) && /\/me\b|\/token/.test(m)) {
    return "A 403 here almost always means this Spotify account is not on the app's allowlist. "
      + "Spotify apps start in Development Mode: open the dashboard, go to Settings then User Management, "
      + "and add the exact email of the account you just logged in with."
  }
  if (/403/.test(m) && /player/.test(m)) {
    return "A 403 on a player call usually means the account is not Premium, or Spotify is already playing "
      + "on another device. It can also mean the browser blocked DRM playback \u2014 the SDK is only reliably "
      + "supported in Chrome."
  }
  if (/401/.test(m)) return "The token was rejected. Reconnecting should fix it."
  return ""
}

function fatal(msg, relogin = false) {
  const hint = hintFor(msg)
  $('app').innerHTML = `
    <div class="card">
      <div class="err"><b>Failed while ${esc(bootPhase)}</b><br>${esc(msg)}</div>
      ${hint ? `<p class="note" style="text-align:left;margin:0 0 14px">${esc(hint)}</p>` : ''}
      ${relogin ? `<button class="btn-wide btn-primary" id="btn-relogin">Reconnect Spotify</button>` : ''}
      <button class="btn-wide" id="btn-reset" style="margin-top:8px">Reset everything</button>
    </div>`
  const r = $('btn-relogin'); if (r) r.onclick = login
  $('btn-reset').onclick = () => { localStorage.clear(); location.href = location.origin }
}

function renderSetup(err) {
  $('app').innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 12px;font-size:1rem">Connect your Spotify</h2>
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
      <p class="note" style="text-align:left;margin:0 0 14px">
        Create a free app at
        <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" style="color:var(--gold)">developer.spotify.com/dashboard</a>,
        set the redirect URI to exactly
        <code style="color:var(--gold)">${esc(redirectUri())}</code>,
        enable <b>Web API</b> + <b>Web Playback SDK</b>, then paste the Client ID below.
        Only the public Client ID is needed — no secret.
      </p>
      <input type="text" id="cid" placeholder="Client ID (32 hex characters)" autocomplete="off" spellcheck="false"
             value="${esc(lsGet(K_CLIENT) || '')}">
      <button class="btn-wide btn-primary" id="btn-save" style="margin-top:10px">Save &amp; connect</button>
    </div>`

  $('btn-save').onclick = () => {
    const v = $('cid').value.trim()
    if (!/^[0-9a-f]{32}$/i.test(v)) { renderSetup('That does not look like a Client ID (expected 32 hex characters).'); return }
    lsSet(K_CLIENT, v)
    login()
  }
  $('cid').onkeydown = e => { if (e.key === 'Enter') $('btn-save').click() }
}

function renderDrmWall() {
  stopPolling()
  $('app').innerHTML = `
    <div class="card">
      <div class="err">
        <b>Your browser won't play Spotify audio</b><br>
        The device registered fine, but Spotify refused the DRM licence
        (<code>403</code> on <code>/widevine-license</code>), so no sound can come out.
      </div>
      <p class="note" style="text-align:left;margin:0 0 14px">
        The Web Playback SDK only supports <b>Chrome, Edge and Safari</b>.${IS_FIREFOX
          ? ' You are on Firefox, whose Widevine configuration Spotify rejects — this is a known limitation, not a bug in the game.'
          : ' If you are on a Chromium browser, check that DRM playback is enabled and that no extension is blocking it.'}
      </p>
      <p class="note" style="text-align:left;margin:0 0 14px">
        Curated mode needs no DRM and works in every browser.
      </p>
      <a class="btn-wide btn-primary" href="/itunes"
         style="display:block;text-align:center;text-decoration:none;padding:11px">Play curated mode instead</a>
      <button class="btn-wide" id="btn-drm-retry" style="margin-top:8px">Try again anyway</button>
    </div>`
  $('btn-drm-retry').onclick = () => location.reload()
}

function renderConnect() {
  $('app').innerHTML = `
    <div class="card" style="text-align:center">
      <p class="note" style="margin:0 0 16px">
        Signed out. Reconnect to rebuild your catalog and play.
      </p>
      <button class="btn-wide btn-primary" id="btn-login">Connect Spotify</button>
      <button class="btn-wide" id="btn-rekey" style="margin-top:8px">Use a different Client ID</button>
    </div>`
  $('btn-login').onclick = login
  $('btn-rekey').onclick = () => renderSetup()
}

function renderBuilding() {
  $('app').innerHTML = `
    <div class="card" style="text-align:center">
      <div class="loading">
        <div style="font-weight:700;margin-bottom:8px">Building your catalog…</div>
        <div id="build-status" class="note" style="margin:0">Starting…</div>
      </div>
    </div>`
}

function renderThin(n, scanned) {
  $('app').innerHTML = `
    <div class="card">
      <div class="err">
        <b>Only ${n} hip-hop track${n === 1 ? '' : 's'} found</b><br>
        I scanned ${scanned} songs from your top tracks and saved library, but few were
        tagged hip-hop/rap by Spotify's artist genres.
      </div>
      <button class="btn-wide btn-primary" id="btn-all">Use all my music instead</button>
      <button class="btn-wide" id="btn-retry" style="margin-top:8px">Rescan</button>
    </div>`
  $('btn-all').onclick = async () => { renderBuilding(); CATALOG = await buildCatalog(true); afterCatalog() }
  $('btn-retry').onclick = async () => { renderBuilding(); CATALOG = await buildCatalog(false); afterCatalog() }
}

/* ============================================================
   Game render
   ============================================================ */

function nextGain() {
  const i = guesses.length
  const cur = STAGES[Math.min(i, MAX_ATTEMPTS - 1)]
  const nxt = STAGES[Math.min(i + 1, MAX_ATTEMPTS - 1)]
  return Math.round((nxt - cur) * 10) / 10
}

function render() {
  if (finished) { renderReveal(); return }

  const pct = scale(unlocked())

  $('app').innerHTML = `
    <div class="card">
      <div class="player">
        <button class="play-btn" id="btn-play" aria-label="Play clip"><span id="play-ic">${ICON_PLAY}</span></button>
        <div class="timeline">
          <div class="track">
            <div class="unlocked" style="width:${pct}%"></div>
            <div class="played"></div>
          </div>
          <div class="ticks">
            ${STAGES.map(s => `<span class="${s <= unlocked() ? 'on' : ''}" style="left:${scale(s)}%">${fmt(s)}s</span>`).join('')}
          </div>
          <div class="meta-row">
            <span><b style="color:var(--gold)">${fmt(unlocked())}s</b> from the top · ${MAX_ATTEMPTS - guesses.length} ${MAX_ATTEMPTS - guesses.length === 1 ? 'try' : 'tries'} left</span>
            <span class="vol"><span aria-hidden="true">🔊</span>
              <input type="range" id="vol" min="0" max="1" step="0.01" value="0.75" aria-label="Volume"></span>
          </div>
        </div>
      </div>

      <div class="guesses">
        ${Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
          const g = guesses[i]
          if (g) {
            const ic = g.kind === 'correct' ? '✔' : g.kind === 'skip' ? '⏭' : '✕'
            return `<div class="slot filled ${g.kind}"><span class="ic">${ic}</span><span class="txt">${esc(g.label)}</span></div>`
          }
          const active = i === guesses.length
          return `<div class="slot ${active ? 'active' : ''}"><span class="ic">${active ? '▸' : ''}</span><span class="txt">${active ? 'Your guess…' : ''}</span></div>`
        }).join('')}
      </div>

      <div class="guess-area">
        <div class="suggest" id="suggest"></div>
        <input type="text" id="guess" autocomplete="off" spellcheck="false" placeholder="Type an artist or song title…">
        <div class="actions">
          <button id="btn-skip">Skip (+${fmt(nextGain())}s)</button>
          <button class="btn-primary" id="btn-submit" disabled>Submit</button>
        </div>
      </div>
    </div>`

  $('btn-play').onclick = togglePlay
  $('btn-skip').onclick = doSkip
  $('btn-submit').onclick = submitGuess
  $('vol').oninput = e => { if (player) player.setVolume(Number(e.target.value)).catch(() => {}) }

  const input = $('guess')
  input.oninput = onInput
  input.onkeydown = onKeyDown
  input.focus()
}

function renderReveal() {
  const s = loadStats()
  $('app').innerHTML = `
    <div class="card reveal">
      ${song.artworkUrl ? `<img class="art" alt="" src="${esc(song.artworkUrl)}">` : ''}
      <div class="verdict ${won ? 'win' : 'lose'}">
        ${won ? `Got it in ${guesses.length} ${guesses.length === 1 ? 'try' : 'tries'}` : 'Out of tries'}
      </div>
      <div class="ttl">${esc(song.title)}</div>
      <div class="art-name">${esc(song.artist)}</div>
      <div class="alb">${esc(song.album)}${song.year ? ` · ${song.year}` : ''}</div>
      ${song.genres?.length ? `<div class="note" style="margin-top:6px">${esc(song.genres.join(' · '))}</div>` : ''}
      <div class="actions" style="margin-top:16px">
        <button id="btn-full"><span id="full-ic">▶</span> Full track</button>
        <button id="btn-share">Share</button>
      </div>
      <button class="btn-wide btn-primary" id="btn-next" style="margin-top:8px">Next song</button>
      <p class="note">Streak <b style="color:var(--gold)">${s.streak}</b> · ${s.wins}/${s.played} solved</p>
    </div>`

  $('btn-next').onclick = async () => { await hardStop(); newRound() }
  $('btn-share').onclick = share
  $('btn-full').onclick = () => { isPlaying ? pauseFull() : playFull() }
}

/* ============================================================
   Autocomplete
   ============================================================ */

function onInput() {
  const q = norm($('guess').value)
  const box = $('suggest')
  selIdx = -1

  if (q.length < 2) { box.innerHTML = ''; lastSuggestions = []; $('btn-submit').disabled = true; return }

  const starts = [], contains = []
  for (const s of CATALOG) {
    const i = s._search.indexOf(q)
    if (i === 0) starts.push(s)
    else if (i > 0) contains.push(s)
    if (starts.length >= 60) break
  }

  lastSuggestions = [...starts, ...contains].slice(0, 8)
  box.innerHTML = lastSuggestions
    .map((s, i) => `<div data-i="${i}"><span>${esc(s.title)}</span> <span class="ar">— ${esc(s.artist)}</span></div>`)
    .join('')
  for (const el of box.children) el.onclick = () => pick(Number(el.dataset.i))
  $('btn-submit').disabled = !lastSuggestions.length
}

function pick(i) {
  const s = lastSuggestions[i]
  if (!s) return
  $('guess').value = label(s)
  $('suggest').innerHTML = ''
  lastSuggestions = [s]
  selIdx = 0
  $('btn-submit').disabled = false
  submitGuess()
}

function onKeyDown(e) {
  const box = $('suggest')
  const n = box.children.length
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); selIdx = (selIdx + 1) % n; highlight() }
  else if (e.key === 'ArrowUp' && n) { e.preventDefault(); selIdx = selIdx <= 0 ? n - 1 : selIdx - 1; highlight() }
  else if (e.key === 'Enter') { e.preventDefault(); selIdx >= 0 ? pick(selIdx) : submitGuess() }
  else if (e.key === 'Escape') { box.innerHTML = ''; selIdx = -1 }
}

function highlight() {
  for (const [i, el] of [...$('suggest').children].entries()) el.classList.toggle('sel', i === selIdx)
}

/* ============================================================
   Game actions
   ============================================================ */

function submitGuess() {
  if (finished) return
  const raw = $('guess').value.trim()
  if (!raw) { toast('Type a guess, or hit Skip'); return }

  const q = norm(raw)
  const guessed = lastSuggestions.find(s => norm(label(s)) === q)
    || CATALOG.find(s => norm(label(s)) === q)
    || CATALOG.find(s => s._search === q)
    || (lastSuggestions.length === 1 ? lastSuggestions[0] : null)

  if (!guessed) { toast('Pick a song from the list'); return }

  const correct = guessed.id === song.id
    || (norm(guessed.title) === norm(song.title) && norm(guessed.primaryArtist) === norm(song.primaryArtist))

  guesses.push({ label: label(guessed), kind: correct ? 'correct' : 'wrong' })

  if (correct) finish(true)
  else if (guesses.length >= MAX_ATTEMPTS) finish(false)
  else { render(); playClip(unlocked()) }
}

function doSkip() {
  if (finished) return
  guesses.push({ label: `Skipped (+${fmt(nextGain())}s)`, kind: 'skip' })
  if (guesses.length >= MAX_ATTEMPTS) finish(false)
  else { render(); playClip(unlocked()) }
}

async function finish(didWin) {
  finished = true
  won = didWin
  await hardStop()
  recordResult(didWin, guesses.length)
  render()
}

function newRound() {
  guesses = []
  finished = false
  won = false
  selIdx = -1
  lastSuggestions = []
  song = nextFromBag()
  render()
}

function share() {
  const grid = guesses.map(g => g.kind === 'correct' ? '🟩' : g.kind === 'skip' ? '🟨' : '🟥').join('')
  const pad = '⬛'.repeat(Math.max(0, MAX_ATTEMPTS - guesses.length))
  const text = `🎤 Songless Unlimited — my Spotify\n${won ? `${guesses.length}/${MAX_ATTEMPTS}` : `X/${MAX_ATTEMPTS}`} ${grid}${pad}`
  navigator.clipboard?.writeText(text).then(() => toast('Result copied')).catch(() => toast('Copy failed'))
}

/* ============================================================
   Modals
   ============================================================ */

function openModal(html) {
  $('modal-body').innerHTML = html
  $('modal').hidden = false
}

function statsHtml() {
  const s = loadStats()
  const rate = s.played ? Math.round((s.wins / s.played) * 100) : 0
  const max = Math.max(1, ...s.dist)
  return `
    <h2>Your stats</h2>
    <div class="stat-grid">
      <div class="stat"><b>${s.played}</b><span>Played</span></div>
      <div class="stat"><b>${rate}%</b><span>Win rate</span></div>
      <div class="stat"><b>${s.streak}</b><span>Streak</span></div>
      <div class="stat"><b>${s.best}</b><span>Best</span></div>
    </div>
    <div class="dist">
      ${s.dist.map((n, i) => `
        <div class="row ${n === max && n > 0 ? 'best' : ''}">
          <span class="n">${i + 1}</span><div class="bar" style="width:${Math.max(8, (n / max) * 100)}%">${n}</div>
        </div>`).join('')}
    </div>
    <p class="note">${CATALOG.length} songs from your library${profile?.display_name ? ` · ${esc(profile.display_name)}` : ''}</p>
  `
}

function settingsHtml() {
  const c = lsGet(K_CATALOG)
  return `
    <h2>Settings</h2>
    <p class="note" style="text-align:left">
      ${CATALOG.length} songs in your catalog${c?.scanned ? `, filtered from ${c.scanned} scanned` : ''}.
      ${c?.genresBlocked
        ? 'Spotify returned <b>403 Forbidden</b> for the artist-genre lookup, which happens when an app is '
          + 'still in Development Mode. Without genre data there is nothing to filter on, so <b>everything</b> '
          + 'is included. Requesting Extended Quota Mode in the Spotify dashboard would restore it.'
        : (c?.includeAllGenres ? 'Currently using <b>all genres</b>.' : 'Currently <b>hip-hop/rap only</b>.')}
    </p>
    <button class="btn-wide" id="s-rebuild">Rebuild catalog from Spotify</button>
    <button class="btn-wide" id="s-toggle" style="margin-top:8px">
      ${c?.includeAllGenres ? 'Switch to hip-hop only' : 'Include all genres'}
    </button>
    <button class="btn-wide" id="s-logout" style="margin-top:8px">Disconnect Spotify</button>
  `
}

function wireSettings() {
  const c = lsGet(K_CATALOG)
  $('s-rebuild').onclick = async () => {
    $('modal').hidden = true
    renderBuilding()
    try { CATALOG = await buildCatalog(!!c?.includeAllGenres); afterCatalog() } catch (e) { fatal(e.message) }
  }
  $('s-toggle').onclick = async () => {
    $('modal').hidden = true
    renderBuilding()
    try { CATALOG = await buildCatalog(!c?.includeAllGenres); afterCatalog() } catch (e) { fatal(e.message) }
  }
  $('s-logout').onclick = logout
}

const HOW_HTML = `
  <h2>How to play</h2>
  <p style="font-size:.88rem;line-height:1.65;color:var(--dim)">
    ${MAX_ATTEMPTS} tries to name the track. Press play and you hear the
    <b style="color:var(--text)">first 0.1 seconds of the actual song</b> — from 0:00,
    not a mid-song preview. Wrong guesses and skips unlock more:
    <b style="color:var(--gold)">${STAGES.map(fmt).join('s → ')}s</b>.
  </p>
  <p style="font-size:.88rem;line-height:1.65;color:var(--dim)">
    Every song comes from your own Spotify — top tracks and saved library,
    filtered to hip-hop/rap. Playback runs through the Web Playback SDK, so
    Spotify must not be playing on another device at the same time.
  </p>
`

/* ============================================================
   Boot
   ============================================================ */

function afterCatalog() {
  for (const s of CATALOG) s._search = `${norm(s.artist)} ${norm(s.title)}`
  const meta = lsGet(K_CATALOG) || {}
  $('foot').innerHTML = `${CATALOG.length} songs from your Spotify · clips start at 0:00`
    + (meta.genresBlocked
      ? '<br><span style="color:var(--amber)">Spotify blocked the genre lookup for this app, '
        + 'so every saved song is included — not just hip-hop.</span>'
      : '')
  newRound()
}

async function boot() {
  $('btn-stats').onclick = () => openModal(statsHtml())
  $('btn-how').onclick = () => openModal(HOW_HTML)
  $('btn-settings').onclick = () => { openModal(settingsHtml()); wireSettings() }
  $('modal-close').onclick = () => { $('modal').hidden = true }
  $('modal').onclick = e => { if (e.target.id === 'modal') $('modal').hidden = true }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').hidden = true })

  // Spotify rejects `localhost` as a redirect host for new apps.
  if (location.hostname === 'localhost') {
    $('app').innerHTML = `
      <div class="card">
        <div class="err"><b>Open this on 127.0.0.1, not localhost</b><br>
        Spotify no longer accepts <code>localhost</code> as a redirect URI host.</div>
        <a class="btn-wide btn-primary" style="display:block;text-align:center;text-decoration:none;padding:10px"
           href="http://127.0.0.1:${location.port || 3000}/spotify">Switch to 127.0.0.1</a>
      </div>`
    return
  }

  // OAuth callback.
  const qs = new URLSearchParams(location.search)
  if (qs.get('error')) { fatal(`Spotify returned "${qs.get('error')}". If this says invalid_client, the Client ID is wrong; if redirect_uri_mismatch, the dashboard URI must be exactly ${redirectUri()}`); return }

  if (qs.get('code')) {
    renderBuilding()
    bootPhase = 'exchanging the authorization code for a token'
    $('build-status').textContent = 'Exchanging authorization code…'
    try {
      await exchangeCode(qs.get('code'))
      // Drop the code from the URL and settle on the Spotify route, not the
      // landing page at /.
      history.replaceState({}, '', '/spotify')
    } catch (e) { fatal(e.message, true); return }
  }

  if (!lsGet(K_CLIENT)) { renderSetup(); return }
  if (!lsGet(K_TOKEN)) { renderConnect(); return }

  renderBuilding()

  try {
    bootPhase = 'reading your Spotify profile (GET /me)'
    $('build-status').textContent = 'Checking your account…'
    profile = await api('/me')
    if (profile?.product !== 'premium') {
      fatal(`This account is "${profile?.product}", and the Web Playback SDK requires Premium. The iTunes-preview version at /itunes-mode.html works on any account.`)
      return
    }

    if (IS_FIREFOX) {
      console.warn('Firefox detected — the Spotify Web Playback SDK is not supported here.')
      toast('Firefox can\'t play Spotify audio — use Chrome, or try curated mode', 6000)
    }

    bootPhase = 'starting the Web Playback SDK player'
    $('build-status').textContent = 'Starting the player…'
    await initPlayer()

    const cached = lsGet(K_CATALOG)
    if (cached?.songs?.length) {
      CATALOG = cached.songs
    } else {
      bootPhase = 'building your catalog from top tracks and saved songs'
      CATALOG = await buildCatalog(false)
      if (CATALOG.length < 20) { renderThin(CATALOG.length, cached?.scanned || 0); return }
    }

    afterCatalog()
  } catch (e) {
    fatal(e.message, /token|auth/i.test(e.message))
  }
}

boot()
