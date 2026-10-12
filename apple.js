'use strict'

/* ============================================================
   Songless Unlimited — Apple Music mode

   Behind a "coming soon" gate until the Apple Developer key is in place.
   Append ?dev=1 to bypass it and exercise the real flow.

   Needs, in order:
     1. Apple Developer Program membership (paid) -> MusicKit private key
     2. APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_P8_PATH on the server
     3. An Apple Music subscription on the listening account
   ============================================================ */

const STAGES = [0.1, 0.5, 1, 2, 4, 7, 11, 16]
const MAX_ATTEMPTS = STAGES.length
const FULL = STAGES[STAGES.length - 1]

const fmt = s => (s < 1 ? s.toFixed(1) : String(s))
const scale = t => Math.sqrt(Math.max(0, t) / FULL) * 100

const K_STATS = 'am-stats'
const K_BAG = 'am-bag'
const K_CATALOG = 'am-catalog'
const K_SOURCES = 'am-sources'
const K_DEV = 'am-dev'

const SOURCES = [
  { key: 'songs', label: 'Library songs' },
  { key: 'albums', label: 'Library albums' },
  { key: 'recent', label: 'Recently played' },
  { key: 'heavy', label: 'Heavy rotation' },
]

/* ---------------- state ---------------- */

let music = null
let CATALOG = []
let song = null
let guesses = []
let finished = false
let won = false
let selIdx = -1
let lastSuggestions = []
let pendingSources = null

let isPlaying = false
let gen = 0
let pollId = null
let cutId = null
let safetyId = null
let queuedId = null      // which track is loaded in the player
let bootPhase = 'starting up'

const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/* ---------------- helpers ---------------- */

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

const lsGet = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

// Apple artwork URLs are templates containing {w} and {h}.
const art = (a, px = 600) => (a?.url ? a.url.replace('{w}', px).replace('{h}', px) : '')

/* ============================================================
   Gate
   ============================================================ */

function devMode() {
  const q = new URLSearchParams(location.search)
  if (q.get('dev') === '1') { lsSet(K_DEV, true); return true }
  if (q.get('dev') === '0') { localStorage.removeItem(K_DEV); return false }
  return !!lsGet(K_DEV)
}

function renderComingSoon(tokenState) {
  const steps = [
    { done: false, text: 'Apple Developer Program membership, which issues the MusicKit private key' },
    { done: tokenState === 'ready', text: 'That key configured on the server as <code>APPLE_TEAM_ID</code>, <code>APPLE_KEY_ID</code> and <code>APPLE_P8_PATH</code>' },
    { done: false, text: 'An Apple Music subscription on whichever account plays' },
  ]

  $('app').innerHTML = `
    <div class="card soon">
      <div class="glyph" aria-hidden="true">🍎</div>
      <h2>Coming soon</h2>
      <p>
        Apple Music needs a signed developer key before it can play anything.
        The game itself is built and waiting.
      </p>
      <div class="steps">
        ${steps.map((s, i) => `
          <div class="step ${s.done ? 'done' : ''}">
            <span class="num">${s.done ? '✓' : i + 1}</span>
            <span>${s.text}</span>
          </div>`).join('')}
      </div>
      <a class="btn-wide btn-primary" href="/itunes"
         style="display:block;text-align:center;text-decoration:none;padding:11px">Play Popular Hip-Hop instead</a>
      <p class="note">Developers: add <code>?dev=1</code> to this URL to run the real flow.</p>
    </div>`
}

/* ============================================================
   MusicKit
   ============================================================ */

function loadMusicKit() {
  return new Promise((resolve, reject) => {
    if (window.MusicKit) return resolve()
    // MusicKit announces readiness on the document, not via script.onload.
    document.addEventListener('musickitloaded', () => resolve(), { once: true })
    const s = document.createElement('script')
    s.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'
    s.onerror = () => reject(new Error('Could not load MusicKit (offline?)'))
    document.head.appendChild(s)
    setTimeout(() => (window.MusicKit ? resolve() : reject(new Error('MusicKit did not initialise'))), 15000)
  })
}

async function developerToken() {
  const res = await fetch('/apple-token', { cache: 'no-store' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(j.error === 'not_configured'
      ? `Server is missing ${(j.missing || []).join(', ')}`
      : (j.detail || `token endpoint returned ${res.status}`))
    err.state = j.error
    err.missing = j.missing
    throw err
  }
  return j.token
}

/** Apple library/catalog request with both tokens attached. */
async function api(path, params = {}) {
  const url = new URL(`https://api.music.apple.com${path}`)
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${music.developerToken}`,
      'Music-User-Token': music.musicUserToken,
    },
  })

  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let detail = ''
    try { detail = JSON.parse(raw)?.errors?.[0]?.detail || '' } catch {}
    const err = new Error(`${res.status} ${detail || res.statusText}  [GET ${path}]`)
    err.status = res.status
    console.error('Apple Music API error', { status: res.status, path, body: raw })
    throw err
  }
  return res.json()
}

/* ============================================================
   Catalog
   ============================================================ */

function loadSources() {
  const v = lsGet(K_SOURCES)
  const clean = Array.isArray(v) ? v.filter(k => SOURCES.some(s => s.key === k)) : []
  return clean.length ? clean : SOURCES.map(s => s.key)
}

const FILLER = /\b(intro|outro|skit|interlude|prelude|reprise|commentary|voicemail)\b/i

function toTrack(item) {
  const a = item?.attributes
  // playParams.id is what setQueue needs; without it the track cannot be played.
  const playId = a?.playParams?.catalogId || a?.playParams?.id || item?.id
  if (!a?.name || !playId) return null
  if (a.durationInMillis && a.durationInMillis < 75000) return null
  if (FILLER.test(a.name)) return null

  return {
    id: String(item.id),
    playId: String(playId),
    title: a.name,
    artist: a.artistName || '',
    album: a.albumName || '',
    artworkUrl: art(a.artwork),
    year: Number(String(a.releaseDate || '').slice(0, 4)) || undefined,
  }
}

async function buildCatalog() {
  const progress = m => { const el = $('build-status'); if (el) el.textContent = m }
  const chosen = loadSources()
  const use = k => chosen.includes(k)
  const MAX = 3000
  const found = new Map()

  const add = it => {
    if (found.size >= MAX) return
    const t = toTrack(it)
    if (t) found.set(t.id, t)
  }

  // Paginate an endpoint that reports `next`.
  async function page(path, params, onItems, cap = 20) {
    let offset = 0
    for (let i = 0; i < cap; i++) {
      if (found.size >= MAX) return
      const r = await api(path, { ...params, offset })
      const items = r?.data || []
      onItems(items)
      if (!r?.next || items.length === 0) return
      offset += items.length
    }
  }

  if (use('songs')) {
    try {
      progress('Reading your library songs…')
      await page('/v1/me/library/songs', { limit: 100 }, items => {
        for (const it of items) add(it)
        progress(`Reading your library songs… (${found.size} found)`)
      })
    } catch (err) { console.warn('library songs:', err.message) }
  }

  if (use('albums')) {
    try {
      const albums = []
      await page('/v1/me/library/albums', { limit: 100 }, items => albums.push(...items), 10)
      for (const [i, al] of albums.entries()) {
        if (found.size >= MAX) break
        if (i % 5 === 0) progress(`Reading library albums… (${i}/${albums.length} · ${found.size} found)`)
        try {
          const r = await api(`/v1/me/library/albums/${al.id}/tracks`, { limit: 100 })
          for (const it of r?.data || []) add(it)
        } catch (err) { console.warn(`album ${al.id}:`, err.message) }
      }
    } catch (err) { console.warn('library albums:', err.message) }
  }

  if (use('recent')) {
    try {
      progress('Reading recently played…')
      const r = await api('/v1/me/recent/played/tracks', { limit: 30 })
      for (const it of r?.data || []) add(it)
    } catch (err) { console.warn('recently played:', err.message) }
  }

  if (use('heavy')) {
    try {
      progress('Reading heavy rotation…')
      const r = await api('/v1/me/history/heavy-rotation', { limit: 10 })
      for (const it of r?.data || []) add(it)
    } catch (err) { console.warn('heavy rotation:', err.message) }
  }

  if (!found.size) {
    throw new Error(`No tracks came back from the selected source${chosen.length === 1 ? '' : 's'} (${chosen.join(', ')}).`)
  }

  // Collapse the same song across album and single releases.
  const bySong = new Map()
  for (const t of found.values()) {
    const k = `${norm(t.artist)}::${norm(t.title)}`
    if (!bySong.has(k)) bySong.set(k, t)
  }

  const catalog = [...bySong.values()]
  lsSet(K_CATALOG, { builtAt: Date.now(), songs: catalog, scanned: found.size, sources: chosen })
  console.log(`Apple catalog: ${catalog.length} songs from ${found.size} scanned`)
  return catalog
}

/* ============================================================
   Playback
   ============================================================ */

function stopTimers() {
  if (pollId) clearInterval(pollId)
  pollId = null
  if (cutId) clearTimeout(cutId)
  cutId = null
  if (safetyId) clearTimeout(safetyId)
  safetyId = null
}

function setIcon(playing) {
  const el = $('play-ic')
  if (el) el.innerHTML = playing ? ICON_STOP : ICON_PLAY
  const btn = $('btn-play')
  if (btn) btn.classList.toggle('playing', playing)
  const bar = document.querySelector('.track .unlocked')
  if (bar) bar.classList.toggle('live', playing)
}

/**
 * Queue the track without playing it. Unlike Spotify's SDK, setQueue does not
 * start playback, so priming here needs no muting and cannot run away.
 */
async function prime() {
  if (!music || !song) return
  if (queuedId === song.playId) return
  try {
    await music.setQueue({ song: song.playId })
    queuedId = song.playId
  } catch (err) {
    queuedId = null
    console.warn('could not queue track:', err.message)
  }
}

async function hardStop() {
  gen++
  stopTimers()
  isPlaying = false
  try { await music.pause() } catch {}
  setIcon(false)
  const bar = document.querySelector('.played')
  if (bar) bar.style.width = '0%'
}

async function playClip(seconds) {
  if (!music || !song) return

  const my = ++gen
  stopTimers()
  const limit = seconds * 1000

  const cut = async () => {
    if (my !== gen) return
    stopTimers()
    isPlaying = false
    try { await music.pause() } catch {}
    try { await music.seekToTime(0) } catch {}
    setIcon(false)
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = '0%'
  }

  // Never start audio without a stop already scheduled.
  safetyId = setTimeout(() => {
    console.warn('safety stop fired — no usable playback time was reported')
    cut()
  }, limit + 2500)

  try {
    if (queuedId !== song.playId) await prime()
    await music.play()
    await music.seekToTime(0)
  } catch (err) {
    stopTimers()
    toast(`Could not start playback: ${err.message}`, 4000)
    return
  }

  if (my !== gen) { stopTimers(); return }
  isPlaying = true
  setIcon(true)

  let t0 = null
  pollId = setInterval(() => {
    if (my !== gen) { stopTimers(); return }
    const into = (music.playbackTime || 0) * 1000

    if (t0 === null && into > 0) {
      t0 = performance.now() - into
      const remaining = limit - into
      cutId = setTimeout(cut, remaining > 0 ? remaining : 60)
    }

    const elapsed = t0 === null ? Math.max(0, into) : performance.now() - t0
    const bar = document.querySelector('.played')
    if (bar) bar.style.width = `${Math.min(100, scale(elapsed / 1000))}%`

    if (elapsed >= limit + 150) cut()
  }, 10)
}

async function togglePlay() {
  if (isPlaying) { await hardStop(); return }
  await playClip(unlocked())
}

/* ============================================================
   Stats + song selection
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
   Icons + render
   ============================================================ */

const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l10-6.5a1 1 0 0 0 0-1.74l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>'
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'

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
          <div class="track"><div class="unlocked" style="width:${pct}%"></div><div class="played"></div></div>
          <div class="ticks">
            ${STAGES.map(s => `<span class="${s <= unlocked() ? 'on' : ''}" style="left:${scale(s)}%">${fmt(s)}s</span>`).join('')}
          </div>
          <div class="meta-row">
            <span><b style="color:var(--gold)">${fmt(unlocked())}s</b> from the top · ${MAX_ATTEMPTS - guesses.length} ${MAX_ATTEMPTS - guesses.length === 1 ? 'try' : 'tries'} left</span>
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

  const input = $('guess')
  input.oninput = onInput
  input.onkeydown = onKeyDown
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
        <button id="btn-share">Share</button>
        <button class="btn-primary" id="btn-next">Next song</button>
      </div>
      <p class="note">Streak <b style="color:var(--gold)">${s.streak}</b> · ${s.wins}/${s.played} solved</p>
    </div>`

  $('btn-next').onclick = async () => { await hardStop(); newRound() }
  $('btn-share').onclick = share
}

/* ============================================================
   Guessing
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

  if (guesses.some(g => g.id && g.id === guessed.id)) {
    toast('You already guessed that one')
    $('guess').select()
    return
  }

  const correct = guessed.id === song.id
    || (norm(guessed.title) === norm(song.title) && norm(guessed.artist) === norm(song.artist))

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
  queuedId = null
  song = nextFromBag()
  render()
  prime()
}

function share() {
  const grid = guesses.map(g => g.kind === 'correct' ? '🟩' : g.kind === 'skip' ? '🟨' : '🟥').join('')
  const pad = '⬛'.repeat(Math.max(0, MAX_ATTEMPTS - guesses.length))
  const text = `🎤 Songless Unlimited — Apple Music\n${won ? `${guesses.length}/${MAX_ATTEMPTS}` : `X/${MAX_ATTEMPTS}`} ${grid}${pad}`
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
    <p class="note">${CATALOG.length} songs from your Apple Music library.</p>`
}

function settingsHtml() {
  const c = lsGet(K_CATALOG)
  return `
    <h2>Settings</h2>
    <p class="note" style="text-align:left;margin:0 0 13px">
      ${CATALOG.length} songs, collapsed from ${c?.scanned ?? CATALOG.length} scanned.
    </p>
    <div class="srcs">
      ${SOURCES.map(src => {
        const on = pendingSources.includes(src.key)
        return `<button class="src ${on ? 'on' : ''}" data-k="${src.key}" aria-pressed="${on}">
          <span class="box" aria-hidden="true">✓</span>
          <span class="txt"><b>${esc(src.label)}</b><span>${on ? 'included' : 'off'}</span></span>
        </button>`
      }).join('')}
    </div>
    <button class="btn-wide btn-primary" id="s-rebuild" style="margin-top:13px" ${pendingSources.length ? '' : 'disabled'}>
      ${pendingSources.length ? 'Rebuild from these' : 'Pick at least one source'}
    </button>`
}

function wireSettings() {
  for (const b of document.querySelectorAll('.src')) {
    b.onclick = () => {
      const k = b.dataset.k
      pendingSources = pendingSources.includes(k) ? pendingSources.filter(x => x !== k) : [...pendingSources, k]
      openModal(settingsHtml())
      wireSettings()
    }
  }
  const rebuild = $('s-rebuild')
  if (rebuild) rebuild.onclick = async () => {
    lsSet(K_SOURCES, pendingSources)
    localStorage.removeItem(K_BAG)
    $('modal').hidden = true
    renderBuilding()
    try { CATALOG = await buildCatalog(); afterCatalog() } catch (e) { fatal(e.message) }
  }
}

const HOW_HTML = `
  <h2>How to play</h2>
  <p style="font-size:.88rem;line-height:1.65;color:var(--dim)">
    ${MAX_ATTEMPTS} tries to name the track. Press play and you hear the
    <b style="color:var(--text)">first 0.1 seconds of the actual song</b>.
    Wrong guesses and skips unlock more:
    <b style="color:var(--gold)">${STAGES.map(fmt).join('s → ')}s</b>.
  </p>
  <p style="font-size:.88rem;line-height:1.65;color:var(--dim)">
    Songs come from your own Apple Music library. Playback needs an active
    subscription, and Apple Music must not be playing elsewhere.
  </p>`

/* ============================================================
   Boot
   ============================================================ */

function renderBuilding() {
  $('app').innerHTML = `
    <div class="card" style="text-align:center">
      <div class="loading">
        <div style="font-weight:700;margin-bottom:8px">Building your catalog…</div>
        <div id="build-status" class="note" style="margin:0">Starting…</div>
      </div>
    </div>`
}

function fatal(msg) {
  $('app').innerHTML = `
    <div class="card">
      <div class="err"><b>Failed while ${esc(bootPhase)}</b><br>${esc(msg)}</div>
      <button class="btn-wide" id="btn-reset">Reset everything</button>
    </div>`
  $('btn-reset').onclick = () => {
    for (const k of [K_CATALOG, K_BAG, K_SOURCES]) localStorage.removeItem(k)
    location.reload()
  }
}

function afterCatalog() {
  for (const s of CATALOG) s._search = `${norm(s.artist)} ${norm(s.title)}`
  newRound()
}

function renderConnect() {
  $('app').innerHTML = `
    <div class="card" style="text-align:center">
      <p class="note" style="margin:0 0 16px">
        Connect Apple Music to build a catalog from your library.
      </p>
      <button class="btn-wide btn-primary" id="btn-login">Connect Apple Music</button>
    </div>`
  $('btn-login').onclick = async () => {
    try {
      await music.authorize()
      start()
    } catch (err) {
      fatal(`Authorisation failed: ${err.message}`)
    }
  }
}

async function start() {
  renderBuilding()
  try {
    const cached = lsGet(K_CATALOG)
    if (cached?.songs?.length) CATALOG = cached.songs
    else {
      bootPhase = 'building your catalog from Apple Music'
      CATALOG = await buildCatalog()
    }
    afterCatalog()
  } catch (e) {
    fatal(e.message)
  }
}

async function boot() {
  $('btn-stats').onclick = () => openModal(statsHtml())
  $('btn-how').onclick = () => openModal(HOW_HTML)
  $('btn-settings').onclick = () => {
    pendingSources = loadSources()
    openModal(settingsHtml())
    wireSettings()
  }
  $('modal-close').onclick = () => { $('modal').hidden = true }
  $('modal').onclick = e => { if (e.target.id === 'modal') $('modal').hidden = true }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').hidden = true })

  // Is the server able to mint a token yet?
  let token = null
  let tokenState = 'missing'
  try {
    token = await developerToken()
    tokenState = 'ready'
  } catch (err) {
    console.warn('developer token unavailable:', err.message)
  }

  if (!devMode()) { renderComingSoon(tokenState); return }

  if (!token) {
    $('app').innerHTML = `
      <div class="card">
        <div class="err"><b>No developer token</b><br>
        The server cannot sign one yet. Set <code>APPLE_TEAM_ID</code>,
        <code>APPLE_KEY_ID</code> and <code>APPLE_P8_PATH</code>, then restart the service.</div>
        <p class="note" style="text-align:left">Check <code>/apple-token</code> directly to see what is missing.</p>
      </div>`
    return
  }

  try {
    bootPhase = 'loading MusicKit'
    await loadMusicKit()
    bootPhase = 'configuring MusicKit'
    music = await MusicKit.configure({
      developerToken: token,
      app: { name: 'Songless Unlimited', build: '1.0' },
    })
  } catch (err) {
    fatal(err.message)
    return
  }

  if (!music.isAuthorized) { renderConnect(); return }
  start()
}

boot()
