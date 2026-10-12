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
  // Recently played adds whatever is in rotation right now. Playlist scopes
  // are not requested: /playlists/{id}/tracks is 403 for this app, so the
  // listing alone yields nothing.
  'user-read-recently-played',
].join(' ')

// Bump when SCOPES changes: a token minted under the old set silently 403s on
// the new endpoints, so the stored token must be discarded and re-consented.
const SCOPE_VERSION = 3

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
let safetyId = null   // unconditional stop, armed before playback begins
let isPlaying = false
let profile = null
let bootPhase = 'starting up'
let playbackErrors = 0
// Set once audio has demonstrably come out of the speakers. The DRM wall is
// only ever correct when NOTHING has played — otherwise a stray transport
// error would tear down a working game.
let everPlayed = false
let userVolume = 0.75
let prepared = false
// Which track is actually buffered in the player. A bare boolean could not
// express this, so a stale "prepared" from the previous round made resume()
// replay the old song while the game asked about the new one.
let preparedUri = null
let priming = null   // in-flight prepareTrack(), so plays can wait it out
// Priming plays the track muted to buffer it. Doing that before the user has
// interacted means page load alone starts audio, so it waits for a gesture.
let gestured = false
let startMs = 0            // clip start; /audio-analysis is barred, so always 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Only safe to resume if the buffered track is the one being asked about.
const isPrimed = () => prepared && !!song && preparedUri === song.uri

// Spotify's Web Playback SDK supports Chrome, Edge and Safari. Firefox's
// Widevine CDM gets rejected at the license endpoint with a 403, so playback
// never starts even though the device registers correctly.
const IS_FIREFOX = /firefox|fxios/i.test(navigator.userAgent)

const $ = id => document.getElementById(id)
// Coarse pointer means touch: no hover, and an on-screen keyboard that should
// not be summoned on our initiative.
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

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

// Guess rows and the search box show the primary artist only — full credits
// like "Domo Genesis, The Alchemist, Earl Sweatshirt" are unreadable in a row.
// The reveal still shows everyone.
const label = s => `${s.primaryArtist || s.artist} — ${s.title}`
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

  lsSet(K_TOKEN, { ...j, scope_version: SCOPE_VERSION, expires_at: Date.now() + (j.expires_in - 60) * 1000 })
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

async function buildCatalog() {
  const progress = m => { const el = $('build-status'); if (el) el.textContent = m }

  const tracks = new Map()

  const MAX_TRACKS = 3000
  // Full album tracklists bring along skits, intros and interludes. They make
  // terrible guesses, and runtime plus the obvious names catch most of them.
  const FILLER = /\b(intro|outro|skit|interlude|prelude|reprise|commentary|voicemail)\b/i
  let skipped = 0

  const add = t => {
    if (!t || t.type === 'episode' || !t.id || t.is_local) return
    if (tracks.size >= MAX_TRACKS) return
    if (t.duration_ms && t.duration_ms < 75000) { skipped++; return }
    if (FILLER.test(t.name || '')) { skipped++; return }
    tracks.set(t.id, t)
  }

  // Top tracks across all three windows. The endpoint caps a page at 50 but
  // accepts an offset, so each window yields roughly 99 rather than 50.
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    for (const offset of [0, 49]) {
      progress(`Reading your top tracks (${range.replace('_term', '')})…`)
      try {
        const r = await api(`/me/top/tracks?limit=50&offset=${offset}&time_range=${range}`)
        const items = r?.items || []
        for (const t of items) add(t)
        if (items.length < 50) break
      } catch (err) {
        console.warn(`top tracks ${range} offset ${offset}:`, err.message)
        break
      }
    }
  }

  // Saved library — paginate until exhausted, not just the first few pages.
  for (let page = 0; page < 20; page++) {
    progress(`Reading your saved songs… (${tracks.size} found)`)
    const r = await api(`/me/tracks?limit=50&offset=${page * 50}`)
    const items = r?.items || []
    for (const it of items) add(it?.track)
    if (items.length < 50 || tracks.size >= MAX_TRACKS) break
  }

  // Recently played.
  try {
    progress(`Reading recently played… (${tracks.size} found)`)
    const r = await api('/me/player/recently-played?limit=50')
    for (const it of r?.items || []) add(it?.track)
  } catch (err) {
    console.warn('recently-played unavailable:', err.message)
  }

  // Saved albums — by far the largest source for an album-based library, and
  // completely invisible to /me/tracks.
  try {
    for (let page = 0; page < 10; page++) {
      if (tracks.size >= MAX_TRACKS) break
      progress(`Reading saved albums… (${tracks.size} found)`)
      const r = await api(`/me/albums?limit=50&offset=${page * 50}`)
      const items = r?.items || []
      for (const it of items) {
        const al = it?.album
        if (!al) continue
        // Album tracks are simplified objects with no album field of their own,
        // so graft the parent album on for artwork and year.
        for (const t of al.tracks?.items || []) {
          add({ ...t, album: { name: al.name, images: al.images, release_date: al.release_date } })
        }
      }
      if (items.length < 50) break
    }
  } catch (err) {
    console.warn('saved albums unavailable:', err.message)
  }

  if (tracks.size >= MAX_TRACKS) {
    console.warn(`hit the ${MAX_TRACKS}-track scan cap — some sources were not fully read`)
  }
  console.log(`scanned ${tracks.size} tracks total (${skipped} skits/short tracks skipped)`)

  if (!tracks.size) throw new Error('Spotify returned no tracks for your account.')

  const out = []
  for (const t of tracks.values()) {
    if (t.is_local || !t.uri) continue
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
    })
  }

  // Collapse the same song appearing as single + album + deluxe.
  const bySong = new Map()
  for (const s of out) {
    const k = `${norm(s.primaryArtist)}::${norm(s.title)}`
    if (!bySong.has(k)) bySong.set(k, s)
  }

  const catalog = [...bySong.values()]

  lsSet(K_CATALOG, { builtAt: Date.now(), songs: catalog, scanned: tracks.size })
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
    // "The operation is not allowed" is a transport-command race, not a
    // licence failure — escalating it to the DRM screen would be wrong.
    if (/not allowed/i.test(message || '')) return
    playbackErrors++

    // Audio has worked before, so this is a transient hiccup, not a licence
    // problem. Never replace the UI over it.
    if (everPlayed) {
      if (playbackErrors % 4 === 1) toast('Playback hiccup — press play again', 2500)
      return
    }

    // Nothing has ever played: the licence really may be refused.
    if (playbackErrors === 1) {
      toast('Playback error — check Spotify isn\'t playing elsewhere', 3000)
    } else if (playbackErrors >= 4) {
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
  if (safetyId) clearTimeout(safetyId)
  safetyId = null
}

async function hardStop() {
  gen++
  stopPolling()
  if (priming) { try { await priming } catch {} }
  if (player) { try { await forceStop(1500) } catch {} }
  isPlaying = false
  try { if (player) await player.pause() } catch {}
  setIcon(false)
  const p = document.querySelector('.played')
  if (p) p.style.width = '0%'
}

function setIcon(playing) {
  const el = $('play-ic')
  if (el) el.innerHTML = playing ? ICON_STOP : ICON_PLAY
  // Drive the pulse and the shimmer off the same state as the icon.
  const btn = $('btn-play')
  if (btn) btn.classList.toggle('playing', playing)
  const bar = document.querySelector('.track .unlocked')
  if (bar) bar.classList.toggle('live', playing)
}

/**
 * Load the track and leave it paused at 0:00 so the first clip starts almost
 * instantly. Without this, Spotify's start-up latency (easily >100ms) swallows
 * the whole 0.1s stage. Done muted so the priming playback is inaudible.
 */
/**
 * Pause and confirm it. player.pause() rejects while the player is mid
 * transition, and a swallowed rejection previously let muted priming playback
 * continue and then get un-muted. Returns true only when state says paused.
 */
async function forceStop(maxMs = 4000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try { await player.pause() } catch {}
    const st = await player.getCurrentState().catch(() => null)
    if (!st || st.paused) return true
    await sleep(120)
  }
  return false
}

/**
 * Start a track on our device, recovering from the web player going idle.
 *
 * Spotify drops an inactive web-player device, after which /play returns
 * 404 NO_ACTIVE_DEVICE. Transferring playback to it revives it. Every caller
 * needs this — playFull() lacked it and failed outright on the reveal screen.
 */
async function playFrom(uri, positionMs) {
  const url = `/me/player/play?device_id=${encodeURIComponent(deviceId)}`
  const body = JSON.stringify({ uris: [uri], position_ms: positionMs })

  try {
    await api(url, { method: 'PUT', body })
    return
  } catch (err) {
    if (err.status !== 404 && !/device/i.test(err.message)) throw err
    console.warn('device went idle; transferring playback and retrying')
  }

  await api('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  })
  // The transfer needs a moment to register before /play will take.
  await sleep(350)
  await api(url, { method: 'PUT', body })
}

async function prepareTrack() {
  prepared = false
  preparedUri = null
  if (!playerReady || !deviceId || !song) return
  // Without a prior gesture, priming would make page load play music.
  if (!gestured) return

  const target = song.uri

  priming = (async () => {
    try {
      await player.setVolume(0)
      await playFrom(target, startMs)

      // Wait for the stream to actually begin before pausing it.
      for (let i = 0; i < 80; i++) {
        const st = await player.getCurrentState().catch(() => null)
        if (st && !st.paused && st.position > 0) { everPlayed = true; playbackErrors = 0; break }
        await sleep(50)
      }
    } catch (err) {
      console.warn('pre-buffer failed; will cold start instead', err.message)
    } finally {
      // CRITICAL: confirm the stop before restoring volume. A swallowed
      // pause() rejection used to leave a muted stream running and then
      // un-mute it, playing the whole song with nothing tracking it.
      const stopped = await forceStop()
      try { await player.seek(startMs) } catch {}

      if (stopped) {
        try { await player.setVolume(userVolume) } catch {}
        prepared = !!song && song.uri === target
        preparedUri = prepared ? target : null
      } else {
        // Could not stop it. Staying muted is far better than blasting the
        // track, and a cold start will recover on the next press.
        console.error('could not pause priming playback — staying muted')
        prepared = false
        preparedUri = null
      }
      priming = null
    }
  })()

  return priming
}

/** Play the real track from 0:00 and cut it off at `seconds`. */
async function playClip(seconds) {
  if (!playerReady || !deviceId) { toast('Player not ready yet'); return }

  // Never issue transport commands while priming is mid-flight — overlapping
  // play/pause/seek is what produces "The operation is not allowed."
  if (priming) {
    toast('Buffering…', 1200)
    try { await priming } catch {}
  }

  const my = ++gen
  stopPolling()

  const limit = seconds * 1000

  const cut = async () => {
    if (my !== gen) return
    stopPolling()
    isPlaying = false
    try { await player.pause() } catch {}
    // Park back at the start so the next, longer clip is also primed. Record
    // which track that is — the next round must not resume this one.
    try {
      await player.seek(startMs)
      prepared = true
      preparedUri = song?.uri ?? null
    } catch {
      prepared = false
      preparedUri = null
    }
    setIcon(false)
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = '0%'
  }

  // Arm an unconditional stop BEFORE playback starts. The precise cut depends
  // on the SDK reporting a position; if that never arrives there would
  // otherwise be nothing to stop the track and it would play to the end.
  // cut must already be defined here — a `const` referenced from the timer
  // while still in its temporal dead zone would throw instead of stopping.
  safetyId = setTimeout(() => {
    console.warn('safety stop fired — the SDK never reported a usable position')
    cut()
  }, limit + 2500)

  try {
    if (isPrimed()) {
      // Already buffered and parked at the start — resume is near-instant.
      try {
        await player.seek(startMs)
        await player.resume()
      } catch (e) {
        console.warn('resume rejected, cold starting instead:', e.message)
        prepared = false
        preparedUri = null
        await playFrom(song.uri, startMs)
      }
    } else {
      await playFrom(song.uri, startMs)
    }
  } catch (err) {
    stopPolling()
    toast(`Could not start playback: ${err.message}`, 4000)
    return
  }

  if (my !== gen) { stopPolling(); return }
  isPlaying = true
  setIcon(true)

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

    // Everything is measured from startMs, not from 0:00.
    const into = st.position - startMs

    if (t0 === null && into > 0) {
      // Real audio position advanced — playback works.
      everPlayed = true
      playbackErrors = 0
      t0 = performance.now() - into
      const remaining = limit - into
      if (remaining <= 0) {
        // Start-up latency already overran this stage. Give it a short audible
        // floor rather than cutting instantly and playing nothing at all.
        console.warn(`stage ${seconds}s: first report was ${into}ms into the clip`)
        cutId = setTimeout(cut, 60)
      } else {
        cutId = setTimeout(cut, remaining)
      }
    }

    const elapsed = t0 === null ? Math.max(0, into) : performance.now() - t0
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = `${Math.min(100, scale(elapsed / 1000))}%`

    // Backstop: if the timer never fires, or playback died outright.
    if (elapsed >= limit + 150 || (st.paused && into <= 0 && t0 !== null)) cut()
  }, 10)
}

async function togglePlay() {
  const firstEver = !gestured
  gestured = true
  // If a failed prime left us muted, bring the volume back now that there is
  // a gesture to justify audio.
  try { await player.setVolume(userVolume) } catch {}

  if (isPlaying) { await hardStop(); return }

  // Priming is gesture-gated, so the very first press has nothing buffered.
  // Prime now rather than cold-starting: the cold path cannot guarantee an
  // accurate short clip, and 0.1s is the stage that suffers most.
  if (firstEver && !isPrimed() && !priming) {
    toast('Buffering…', 1500)
    try { await prepareTrack() } catch {}
  }

  await playClip(unlocked())
}

/** Reveal screen: play the whole track from the top. */
async function playFull() {
  if (!playerReady) { toast('Player not ready'); return }
  const my = ++gen
  stopPolling()
  try {
    await playFrom(song.uri, 0)
    if (my !== gen) return
    isPlaying = true
    const b = $('full-ic'); if (b) b.textContent = '⏸'
  } catch (err) { toast(`Playback failed: ${err.message}`) }
}

async function pauseFull() {
  try { await player.pause() } catch {}
  // The full track left the player mid-song, so nothing is primed any more.
  prepared = false
  preparedUri = null
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
        <b>Only ${n} playable track${n === 1 ? '' : 's'} found</b><br>
        Spotify returned ${scanned} song${scanned === 1 ? '' : 's'} across your top tracks,
        saved library, saved albums and recently played. If that seems low,
        your account may have little saved yet.
      </div>
      <button class="btn-wide btn-primary" id="btn-retry">Rescan</button>
    </div>`
  $('btn-retry').onclick = async () => {
    renderBuilding()
    try { CATALOG = await buildCatalog(); afterCatalog() } catch (e) { fatal(e.message) }
  }
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
              <input type="range" id="vol" min="0" max="1" step="0.01" value="${userVolume}" aria-label="Volume"></span>
          </div>
        </div>
      </div>

      <div class="guesses">
        ${Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
          const g = guesses[i]
          if (g) {
            const ic = g.kind === 'correct' ? '✔' : g.kind === 'skip' ? '⏭' : '✕'
            const just = i === guesses.length - 1 ? ' just' : ''
            return `<div class="slot filled ${g.kind}${just}"><span class="ic">${ic}</span><span class="txt">${esc(g.label)}</span></div>`
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
  $('vol').oninput = e => {
    userVolume = Number(e.target.value)
    if (player) player.setVolume(userVolume).catch(() => {})
  }

  const input = $('guess')
  input.oninput = onInput
  input.onkeydown = onKeyDown
  // On a phone, re-focusing after every guess or skip yanks the keyboard back
  // open and shoves the layout around. Let the user decide when to type.
  if (!COARSE) input.focus()
}

function renderReveal() {
  const s = loadStats()
  $('app').innerHTML = `
    <div class="card reveal ${won ? 'win' : 'lose'}">
      ${won ? `<div class="confetti" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>` : ''}
      ${song.artworkUrl ? `<img class="art" alt="" src="${esc(song.artworkUrl)}">` : ''}
      <div class="verdict ${won ? 'win' : 'lose'}">
        ${won ? `Got it in ${guesses.length} ${guesses.length === 1 ? 'try' : 'tries'}` : 'Out of tries'}
      </div>
      <div class="ttl">${esc(song.title)}</div>
      <div class="art-name">${esc(song.artist)}</div>
      <div class="alb">${esc(song.album)}${song.year ? ` · ${song.year}` : ''}</div>
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
    .map((s, i) => `<div data-i="${i}"><span>${esc(s.title)}</span> <span class="ar">— ${esc(s.primaryArtist || s.artist)}</span></div>`)
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

  // A repeat of an earlier guess shouldn't burn an attempt.
  if (guesses.some(g => g.id && g.id === guessed.id)) {
    toast('You already guessed that one')
    $('guess').select()
    return
  }

  const correct = guessed.id === song.id
    || (norm(guessed.title) === norm(song.title) && norm(guessed.primaryArtist) === norm(song.primaryArtist))

  guesses.push({ label: label(guessed), id: guessed.id, kind: correct ? 'correct' : 'wrong' })

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
  startMs = 0
  // Clear synchronously: priming resolves asynchronously, and pressing play in
  // that window would otherwise resume the previous round's track.
  prepared = false
  preparedUri = null
  render()

  // Resolve the onset first so priming buffers the right position.
  prepareTrack()
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
      ${CATALOG.length} songs, collapsed from ${c?.scanned ?? CATALOG.length} scanned across your
      top tracks, saved library, saved albums and recently played.
    </p>
    <button class="btn-wide" id="s-rebuild">Rebuild catalog from Spotify</button>
    <button class="btn-wide" id="s-logout" style="margin-top:8px">Disconnect Spotify</button>
  `
}

function wireSettings() {
  $('s-rebuild').onclick = async () => {
    $('modal').hidden = true
    renderBuilding()
    try { CATALOG = await buildCatalog(); afterCatalog() } catch (e) { fatal(e.message) }
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
    Every song comes from your own Spotify — top tracks, saved library, recently
    played and saved albums. Playback runs through the Web Playback SDK, so
    Spotify must not be playing on another device at the same time.
  </p>
`

/* ============================================================
   Boot
   ============================================================ */

function afterCatalog() {
  for (const s of CATALOG) s._search = `${norm(s.artist)} ${norm(s.title)}`
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

  const tok = lsGet(K_TOKEN)
  if (tok && tok.scope_version !== SCOPE_VERSION) {
    // The stored token predates the current scope list, so it would 403 on the
    // newer endpoints. Discard it and ask for consent again.
    console.log('scope list changed — re-authorisation required')
    for (const k of [K_TOKEN, K_CATALOG, K_BAG]) localStorage.removeItem(k)
    $('app').innerHTML = `
      <div class="card" style="text-align:center">
        <p class="note" style="margin:0 0 16px">
          Songless now reads more of your library — saved albums, artists you follow
          and more of your top tracks — which needs fresh permission from Spotify.
        </p>
        <button class="btn-wide btn-primary" id="btn-reconsent">Reconnect Spotify</button>
      </div>`
    $('btn-reconsent').onclick = login
    return
  }

  if (!tok) { renderConnect(); return }

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
      bootPhase = 'building your catalog from your Spotify library'
      CATALOG = await buildCatalog()
      if (CATALOG.length < 5) { renderThin(CATALOG.length, lsGet(K_CATALOG)?.scanned || 0); return }
    }

    afterCatalog()
  } catch (e) {
    fatal(e.message, /token|auth/i.test(e.message))
  }
}

boot()
