// Resolve "Artist - Title" lines into a verified songs.json via the iTunes Search API.
//
//   node build-catalog.mjs seed.txt            -> writes songs.json
//   node build-catalog.mjs seed.txt --merge    -> merges into existing songs.json
//   node build-catalog.mjs --check             -> re-checks every preview in songs.json
//
// Filters out karaoke acts, tribute bands, instrumentals and dead previews.

import { readFile, writeFile } from 'node:fs/promises'

const OUT = new URL('./songs.json', import.meta.url)

// A bare "(Instrumental)" or "(Acapella)" is fatal for a guessing game, so these
// match the word anywhere in the title — not just the phrase "instrumental version".
const BAD_TITLE = /\binstrumental\b|\ba ?capp?ella\b|karaoke|originally performed|made popular by|in the style of|tribute|backing track|sped up|slowed|\bcover\b|workout mix|8d audio/i
const BAD_ARTIST = /karaoke|tribute|hit crew|hit co\b|masters|soundalike|cover band|the rap band|various artists|ringtone|\bdj mix\b/i
const OK_GENRE = /hip[- ]?hop|rap/i

const norm = s => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '')

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The search endpoint allows roughly 20 calls/min; exceed it and every call 429s
// for a while. Serial requests with a floor gap, plus backoff on 429/403.
const MIN_GAP_MS = Number(process.env.ITUNES_GAP_MS ?? 3200)
let lastCall = 0

async function search(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=15`

  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall))
    if (wait) await sleep(wait)
    lastCall = Date.now()

    try {
      const r = await fetch(url)
      if (r.status === 429 || r.status === 403) {
        const backoff = 5000 * Math.pow(2, attempt)   // 5s, 10s, 20s, 40s, 80s
        console.log(`      rate limited (${r.status}), backing off ${backoff / 1000}s`)
        await sleep(backoff)
        continue
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()).results || []
    } catch (err) {
      if (attempt === 4) throw err
      await sleep(1500 * (attempt + 1))
    }
  }
  throw new Error('rate limited after 5 attempts')
}

async function previewLives(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-2047' } })
    return r.status === 200 || r.status === 206
  } catch {
    return false
  }
}

function score(hit, wantArtist, wantTitle) {
  if (!hit.previewUrl) return -1
  if (!OK_GENRE.test(hit.primaryGenreName || '')) return -1
  if (BAD_TITLE.test(hit.trackName || '')) return -1
  if (BAD_ARTIST.test(hit.artistName || '')) return -1

  const a = norm(hit.artistName), t = norm(hit.trackName)
  const wa = norm(wantArtist), wt = norm(wantTitle)

  // The artist must genuinely be who we asked for (either direction, for "feat." cases).
  if (!a.includes(wa) && !wa.includes(a)) return -1
  if (!t.includes(wt) && !wt.includes(t)) return -1

  let s = 100
  if (t === wt) s += 40
  if (a === wa) s += 20
  if (/live|remix|edit|re-?record|version/i.test(hit.trackName)) s -= 25
  if (/greatest hits|compilation|now that|essential/i.test(hit.collectionName || '')) s -= 10
  return s
}

async function resolve(artist, title) {
  const results = await search(`${artist} ${title}`)
  const ranked = results
    .map(h => ({ h, s: score(h, artist, title) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)

  for (const { h } of ranked.slice(0, 3)) {
    if (await previewLives(h.previewUrl)) {
      return {
        artist: h.artistName,
        title: h.trackName,
        trackId: h.trackId,
        previewUrl: h.previewUrl,
        artworkUrl: h.artworkUrl100,
        album: h.collectionName,
        year: Number(String(h.releaseDate || '').slice(0, 4)) || undefined,
        genre: h.primaryGenreName,
      }
    }
  }
  return null
}

/* ---------------- main ---------------- */

const args = process.argv.slice(2)

if (args.includes('--check')) {
  const existing = JSON.parse(await readFile(OUT, 'utf8'))
  const kept = []
  for (const s of existing) {
    const alive = await previewLives(s.previewUrl)
    if (alive) kept.push(s)
    else console.log(`  dead  ${s.artist} — ${s.title}`)
    await sleep(60)
  }
  await writeFile(OUT, JSON.stringify(kept, null, 2))
  console.log(`\n${kept.length}/${existing.length} previews alive — songs.json rewritten`)
  process.exit(0)
}

const seedFile = args.find(a => !a.startsWith('--'))
if (!seedFile) {
  console.error('usage: node build-catalog.mjs <seed.txt> [--merge]')
  process.exit(1)
}

const lines = (await readFile(seedFile, 'utf8'))
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))

console.log(`Resolving ${lines.length} tracks…\n`)

const out = []
const failed = []

for (const [i, line] of lines.entries()) {
  const m = line.split(/\s+[-–—]\s+/)
  if (m.length < 2) { failed.push(`${line}  (unparseable — use "Artist - Title")`); continue }

  const artist = m[0].trim()
  const title = m.slice(1).join(' - ').trim()

  try {
    const hit = await resolve(artist, title)
    if (hit) {
      out.push(hit)
      console.log(`  ${String(i + 1).padStart(3)}. ✓ ${hit.artist} — ${hit.title}`)
    } else {
      failed.push(line)
      console.log(`  ${String(i + 1).padStart(3)}. ✗ ${line}`)
    }
  } catch (err) {
    failed.push(`${line}  (${err.message})`)
    console.log(`  ${String(i + 1).padStart(3)}. ! ${line} — ${err.message}`)
  }
  // No extra delay needed — search() enforces the inter-call gap itself.
}

let final = out
if (args.includes('--merge')) {
  let prev = []
  try { prev = JSON.parse(await readFile(OUT, 'utf8')) } catch {}
  const byId = new Map(prev.map(s => [s.trackId, s]))
  for (const s of out) if (!byId.has(s.trackId)) byId.set(s.trackId, s)
  final = [...byId.values()]
}

// Dedup by trackId regardless of mode.
final = [...new Map(final.map(s => [s.trackId, s])).values()]

await writeFile(OUT, JSON.stringify(final, null, 2))

console.log(`\n${out.length}/${lines.length} resolved — songs.json now holds ${final.length} tracks`)
if (failed.length) {
  console.log(`\nUnresolved (${failed.length}):`)
  for (const f of failed) console.log(`  - ${f}`)
}
