// Static verification of the game and catalog. No browser, no network.
//   node verify.mjs
// Exits non-zero if any check fails.

import { readFileSync } from 'node:fs'

// index.html is now the Spotify build (external app.js, no songs.json).
// These checks target the self-contained iTunes-preview build.
const html = readFileSync(new URL('./itunes.html', import.meta.url), 'utf8')
const songs = JSON.parse(readFileSync(new URL('./songs.json', import.meta.url), 'utf8'))

let fails = 0, warns = 0
const ok = m => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`)
const bad = m => { fails++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`) }
const warn = m => { warns++; console.log(`  \x1b[33mWARN\x1b[0m  ${m}`) }
const head = m => console.log(`\n${m}`)

/* ---------- pull real functions out of the page ---------- */

function extract(name) {
  // Grab `const name = ...` arrow functions or `function name(...)` bodies.
  const arrow = html.match(new RegExp(`const ${name} = ([^\\n]+(?:\\n\\s+\\.[^\\n]+)*)`))
  if (arrow) return arrow[1].replace(/\s+$/, '').replace(/^\s+/, '')
  const fn = html.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`))
  if (!fn) return null
  const start = html.indexOf(fn[0])
  let depth = 0, i = html.indexOf('{', start)
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (!depth) break }
  }
  return html.slice(start, i + 1)
}

const normSrc = extract('norm')
const bigArtSrc = extract('bigArt')
if (!normSrc || !bigArtSrc) {
  bad('could not extract norm()/bigArt() from index.html — the rest of the function checks are skipped')
}

const norm = normSrc ? new Function(`return (${normSrc})`)() : null
const bigArt = bigArtSrc ? new Function(`return (${bigArtSrc})`)() : null
const label = s => `${s.artist} — ${s.title}`

/* ---------- 1. catalog integrity ---------- */

head('1. Catalog integrity')

const BAD_TITLE = /\binstrumental\b|\ba ?capp?ella\b|karaoke|originally performed|made popular by|in the style of|tribute|backing track/i
const BAD_ARTIST = /karaoke|tribute|hit crew|soundalike|cover band|various artists/i

const malformed = songs.filter(s => !s.trackId || !s.previewUrl || !s.artist || !s.title)
malformed.length ? bad(`${malformed.length} malformed records`) : ok(`${songs.length} records, all have trackId/previewUrl/artist/title`)

const nonApple = songs.filter(s => !/^https:\/\/audio-ssl\.itunes\.apple\.com\//.test(s.previewUrl))
nonApple.length ? bad(`${nonApple.length} previewUrls not on Apple's host`) : ok('all previewUrls on audio-ssl.itunes.apple.com')

const badGenre = songs.filter(s => s.genre && !/hip[- ]?hop|rap/i.test(s.genre))
badGenre.length ? bad(`off-genre: ${badGenre.map(s => `${s.title} [${s.genre}]`).join(', ')}`) : ok('every genre is a Hip-Hop/Rap variant')

const covers = songs.filter(s => BAD_TITLE.test(s.title) || BAD_ARTIST.test(s.artist))
covers.length ? bad(`cover/instrumental slipped through: ${covers.map(label).join(', ')}`) : ok('no karaoke, tribute, instrumental or acapella entries')

const badYear = songs.filter(s => s.year && (s.year < 1970 || s.year > 2026))
badYear.length ? bad(`implausible years: ${badYear.map(s => `${s.title}(${s.year})`).join(', ')}`) : ok('all years within 1970–2026')

const noArt = songs.filter(s => !s.artworkUrl)
noArt.length ? warn(`${noArt.length} missing artwork (reveal screen hides the image)`) : ok('every track has artwork')

/* ---------- 2. duplicates and ambiguity ---------- */

head('2. Duplicates & guessability')

const ids = new Set()
const dupIds = songs.filter(s => ids.size === ids.add(s.trackId).size)
dupIds.length ? bad(`${dupIds.length} duplicate trackIds`) : ok('all trackIds unique')

if (norm) {
  // Two songs that normalize identically: only the first is ever reachable,
  // making the other impossible to guess correctly.
  const byNorm = new Map()
  for (const s of songs) {
    const k = norm(label(s))
    if (!byNorm.has(k)) byNorm.set(k, [])
    byNorm.get(k).push(s)
  }
  const collisions = [...byNorm.entries()].filter(([, v]) => v.length > 1)
  collisions.length
    ? bad(`${collisions.length} normalization collision(s) — second entry unguessable:\n` +
        collisions.map(([k, v]) => `          "${k}" ← ${v.map(x => `${x.artist}/${x.title}(${x.trackId})`).join('  vs  ')}`).join('\n'))
    : ok(`no two tracks normalize to the same string (${byNorm.size} distinct keys)`)

  // A title that vanishes under normalization can't be typed.
  const empty = songs.filter(s => !norm(s.title) || !norm(s.artist))
  empty.length ? bad(`${empty.length} track(s) normalize to empty artist or title`) : ok('no track normalizes to an empty string')

  // Resolution round-trip: typing the label must resolve back to the same song,
  // mirroring submitGuess()'s lookup order.
  const search = songs.map(s => ({ s, _search: `${norm(s.artist)} ${norm(s.title)}` }))
  let unresolvable = []
  for (const { s } of search) {
    const q = norm(label(s))
    const hit = search.find(x => norm(label(x.s)) === q) || search.find(x => x._search === q)
    if (!hit || hit.s.trackId !== s.trackId) unresolvable.push(s)
  }
  unresolvable.length
    ? bad(`${unresolvable.length} track(s) do not resolve to themselves: ${unresolvable.slice(0, 5).map(label).join(', ')}`)
    : ok('all 1:1 — typing a track\'s own label resolves to that exact track')

  // Autocomplete findability: typing the bare title must surface the track.
  const unfindable = search.filter(({ s, _search }) => {
    const q = norm(s.title)
    return q.length >= 2 && _search.indexOf(q) === -1
  })
  unfindable.length
    ? bad(`${unfindable.length} track(s) not findable by title: ${unfindable.slice(0, 5).map(x => label(x.s)).join(', ')}`)
    : ok('every track is findable by typing its title')
}

/* ---------- 2b. guess rules ---------- */

head('2b. Guess rules')

const scriptForRules = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1]

scriptForRules.includes('already guessed that one')
  ? ok('a repeated guess is rejected instead of burning an attempt')
  : bad('no duplicate-guess guard — the same wrong answer can be submitted repeatedly')

scriptForRules.includes("toast('Pick a song from the list')")
  ? ok('free-text that matches nothing is rejected')
  : bad('unmatched free text is not rejected — a typo could count as a guess')

/* ---------- 2c. mobile ---------- */

head("2c. Mobile")

for (const [name, src] of [["itunes.html", html]]) {
  const css = src.slice(src.indexOf("<style>"), src.lastIndexOf("</style>"))
  const o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length
  if (o === c) ok(`${name} CSS braces balanced (${o})`)
  else bad(`${name} CSS braces unbalanced: ${o} open vs ${c} close`)

  // Anything under 16px makes iOS Safari zoom the page on focus.
  if (css.includes("input[type=text] { font-size: 16px")) ok("text input is 16px on mobile (no iOS zoom-on-focus)")
  else bad("mobile text input under 16px — iOS will zoom the page on focus")

  // :hover sticks after a tap on touch devices.
  if (css.includes("hover: none")) ok("hover states neutralised on touch devices")
  else bad("no (hover: none) block — tapped buttons stay stuck in hover state")

  if (css.includes("safe-area-inset")) ok("safe-area insets respected")
  else warn("no safe-area insets — content can sit under a notch or home bar")

  if (src.includes("viewport-fit=cover")) ok("viewport-fit=cover set")
  else warn("viewport-fit=cover missing, so safe-area insets resolve to 0")
}

/* ---------- 3. artwork upscaling ---------- */

head('3. Artwork')

if (bigArt) {
  const upscaled = songs.filter(s => s.artworkUrl).map(s => bigArt(s.artworkUrl))
  const notUpscaled = upscaled.filter(u => !/600x600bb\./.test(u))
  notUpscaled.length
    ? warn(`${notUpscaled.length} artwork URL(s) won't upscale to 600x600 (will render at 100px)`)
    : ok(`all ${upscaled.length} artwork URLs upscale to 600x600`)
}

/* ---------- 4. DOM contract ---------- */

head('4. DOM contract (JS ids vs. markup)')

const scriptBody = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1]
const referenced = [...new Set([...scriptBody.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))]
const declaredStatic = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
// Ids created by render()/renderReveal() inside template literals count too.
const declaredDynamic = new Set([...scriptBody.matchAll(/id="([^"]+)"/g)].map(m => m[1]))

const missing = referenced.filter(id => !declaredStatic.has(id) && !declaredDynamic.has(id))
missing.length
  ? bad(`JS references ids that are never created: ${missing.join(', ')}`)
  : ok(`all ${referenced.length} ids referenced by $() are created in markup or render()`)

const handlers = [...new Set([...scriptBody.matchAll(/\$\('([^']+)'\)\.(onclick|oninput|onkeydown)/g)].map(m => m[1]))]
const handlerMissing = handlers.filter(id => !declaredStatic.has(id) && !declaredDynamic.has(id))
handlerMissing.length
  ? bad(`handlers bound to nonexistent ids: ${handlerMissing.join(', ')}`)
  : ok(`all ${handlers.length} event-handler targets exist`)

/* ---------- 5. game constants ---------- */

head('5. Game constants')

const stagesMatch = scriptBody.match(/const STAGES = \[([^\]]+)\]/)
const STAGES = stagesMatch ? stagesMatch[1].split(',').map(n => Number(n.trim())) : []

STAGES.length ? ok(`STAGES = [${STAGES.join(', ')}]`) : bad('could not parse STAGES')

const ascending = STAGES.every((v, i) => i === 0 || v > STAGES[i - 1])
ascending ? ok('reveal durations strictly increase') : bad(`STAGES not strictly ascending: ${STAGES}`)

const maxStage = Math.max(...STAGES)
maxStage <= 29
  ? ok(`longest reveal ${maxStage}s fits inside a 30s preview`)
  : bad(`longest reveal ${maxStage}s exceeds the 30s preview length`)

const slots = (scriptBody.match(/length: MAX_ATTEMPTS/g) || []).length
slots >= 1 ? ok('guess slots derive from MAX_ATTEMPTS (UI stays in sync with STAGES)') : warn('guess slot count may be hardcoded')

// Preferred form is derived from MAX_ATTEMPTS so it can never drift from STAGES.
if (/dist: Array\(MAX_ATTEMPTS\)\.fill\(0\)/.test(scriptBody)) {
  ok(`stats histogram derives from MAX_ATTEMPTS (${STAGES.length} buckets, cannot drift)`)
} else {
  const lit = scriptBody.match(/dist: \[([^\]]+)\]/)
  const distLen = lit ? lit[1].split(',').length : 0
  distLen === STAGES.length
    ? ok(`stats histogram has ${distLen} buckets, matching ${STAGES.length} attempts`)
    : bad(`stats histogram has ${distLen} hardcoded buckets but there are ${STAGES.length} attempts`)
}

// Sub-second stages must render with a decimal, and the timeline must not be
// linear or 0.1s becomes an invisible sliver.
if (STAGES.some(s => s < 1)) {
  const hasFmt = scriptBody.includes('const fmt = s => (s < 1')
  const hasSqrt = scriptBody.includes('Math.sqrt')
  const hasCutTimer = scriptBody.includes('cutId = setTimeout')

  if (hasFmt) ok('sub-second stages format with a decimal')
  else bad('STAGES has sub-second values but no fmt() helper — labels render inconsistently')

  if (hasSqrt) ok('timeline uses square-root scaling, so early stages stay visible')
  else warn('linear timeline with sub-second stages — 0.1s renders ~0.6% wide')

  if (hasCutTimer) ok('clip cut is timer-driven (an animation frame is too coarse for 0.1s)')
  else warn('no timer-based cut — a 0.1s clip can overshoot by 15%+ on rAF alone')
}

/* ---------- 6. shape the page expects ---------- */

head('6. Catalog shape vs. what index.html reads')

const used = ['artist', 'title', 'trackId', 'previewUrl', 'artworkUrl', 'album', 'year']
for (const f of used) {
  const n = songs.filter(s => s[f] !== undefined && s[f] !== '').length
  const pct = Math.round((n / songs.length) * 100)
  if (f === 'artist' || f === 'title' || f === 'trackId' || f === 'previewUrl') {
    n === songs.length ? ok(`${f}: ${n}/${songs.length}`) : bad(`${f}: only ${n}/${songs.length} (required)`)
  } else {
    console.log(`  \x1b[90mINFO\x1b[0m  ${f}: ${n}/${songs.length} (${pct}%)`)
  }
}

/* ---------- 7. coverage ---------- */

head('7. Coverage')

const artists = new Set(songs.map(s => s.artist))
const years = songs.map(s => s.year).filter(Boolean)
const decades = {}
for (const y of years) { const d = Math.floor(y / 10) * 10; decades[d] = (decades[d] || 0) + 1 }

console.log(`  \x1b[90mINFO\x1b[0m  ${songs.length} tracks · ${artists.size} artists · ${Math.min(...years)}–${Math.max(...years)}`)
console.log(`  \x1b[90mINFO\x1b[0m  by decade: ${Object.entries(decades).sort().map(([d, n]) => `${d}s:${n}`).join('  ')}`)

const counts = {}
for (const s of songs) counts[s.artist] = (counts[s.artist] || 0) + 1
const hogs = Object.entries(counts).filter(([, n]) => n > 6).sort((a, b) => b[1] - a[1])
hogs.length ? warn(`artists over 6 tracks: ${hogs.map(([a, n]) => `${a}(${n})`).join(', ')}`) : ok('no artist dominates the catalog (max 6 tracks)')

songs.length >= 150 ? ok(`${songs.length} tracks is plenty for repeat play`) : warn(`${songs.length} tracks is on the small side`)

/* ---------- 8. Spotify mode ---------- */

head('8. Spotify mode (app.js)')

let appjs = ''
try { appjs = readFileSync(new URL('./app.js', import.meta.url), 'utf8') } catch {}

if (!appjs) {
  warn('app.js not found — Spotify-mode checks skipped')
} else {
  // The priming playback is muted; if it can exit without pausing, the track
  // plays on at full volume with nothing tracking it.
  const prep = appjs.slice(appjs.indexOf('async function prepareTrack'), appjs.indexOf('/** Play the real track'))
  const bodyAfterGuard = prep.slice(prep.indexOf('priming = ('))
  // The stop must happen on every exit path, not just the happy one.
  const stopsInFinally = /\bfinally\b[\s\S]*(forceStop\(\)|player\.pause\(\))/.test(prep)
  const hasEarlyBail = /my !== gen\) return/.test(bodyAfterGuard)
  if (stopsInFinally && !hasEarlyBail) ok('pre-buffer stops playback on every exit path (no runaway playback)')
  else bad('pre-buffer can exit without stopping — muted priming would play on un-muted')

  appjs.includes('if (priming) {')
    ? ok('playback waits for in-flight priming instead of racing it')
    : bad('no priming guard — overlapping transport commands cause "operation is not allowed"')

  const guardsRace = /not allowed/.test(appjs) && appjs.includes("playbackErrors++")
  if (guardsRace) ok("transport races are not mistaken for DRM failures")
  else warn("a transport race may escalate to the DRM screen")

  // Look for a real call site, not the word in a comment or log message.
  const artistCallSite = 'api(`/artists'
  const noGenreFilter = !appjs.includes('RAP_RE') && !appjs.includes(artistCallSite)
  if (noGenreFilter) ok("no genre filtering (every scanned track is kept)")
  else bad("genre filtering code is still present")

  const armsSafety = appjs.includes("safetyId = setTimeout")
  const cutBeforeSafety = appjs.indexOf("const cut = async") < appjs.indexOf("safetyId = setTimeout")
  if (armsSafety && cutBeforeSafety) ok("an unconditional stop is armed before playback, after cut() exists")
  else if (armsSafety) bad("safety timer references cut() before its declaration (temporal dead zone)")
  else bad("no unconditional stop — a clip can play forever if position is never reported")

  const gated = appjs.includes("if (!gestured) return")
  if (gated) ok("priming waits for a user gesture (page load cannot autoplay)")
  else bad("priming runs unprompted — loading the page can start a full song")

  const verifiedStop = appjs.includes("const stopped = await forceStop()") && appjs.includes("if (stopped) {")
  if (verifiedStop) ok("volume is restored only after the stop is confirmed")
  else bad("volume can be restored after a failed pause — the track would play on")

  appjs.includes("guesses.some(g => g.id && g.id === guessed.id)")
    ? ok('repeated guesses rejected')
    : bad('repeated guesses consume an attempt')
}

/* ---------- summary ---------- */

console.log(`\n${'─'.repeat(52)}`)
console.log(fails ? `\x1b[31m${fails} failure(s)\x1b[0m, ${warns} warning(s)` : `\x1b[32mAll checks passed\x1b[0m${warns ? `, ${warns} warning(s)` : ''}`)
process.exit(fails ? 1 : 0)
