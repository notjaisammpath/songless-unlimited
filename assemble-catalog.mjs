// Assemble songs.json from the verify-agent output in a workflow transcript dir.
//
//   node assemble-catalog.mjs <transcriptDir> [--merge] [--no-preview-check]
//
// Agents return full records (trackId + previewUrl), so this needs no Search API
// access — which matters, because /search rate-limits to 403 for long stretches.
// Re-applies the quality filters locally as defense in depth: an agent can
// misjudge, and a karaoke track or instrumental in the game is worse than a gap.

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const OUT = new URL('./songs.json', import.meta.url)

const BAD_TITLE = /\binstrumental\b|\ba ?capp?ella\b|karaoke|originally performed|made popular by|in the style of|tribute|backing track|sped up|slowed|workout mix|8d audio/i
const BAD_ARTIST = /karaoke|tribute|hit crew|hit co\b|masters|soundalike|cover band|various artists|ringtone/i
const OK_GENRE = /hip[- ]?hop|rap/i

const args = process.argv.slice(2)
const dir = args.find(a => !a.startsWith('--'))
if (!dir) {
  console.error('usage: node assemble-catalog.mjs <transcriptDir> [--merge] [--no-preview-check]')
  process.exit(1)
}

/* ---------- harvest ---------- */

const raw = []
const files = (await readdir(dir)).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))

for (const f of files) {
  let lines
  try {
    lines = (await readFile(join(dir, f), 'utf8')).trim().split(/\r?\n/)
  } catch { continue }

  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const data = j?.attachment?.type === 'structured_output' && j.attachment.data
    if (data && Array.isArray(data.verified)) raw.push(...data.verified)
  }
}

console.log(`harvested ${raw.length} records from ${files.length} agent transcripts`)

/* ---------- validate ---------- */

const dropped = []
const clean = []

for (const r of raw) {
  const why = reject(r)
  if (why) { dropped.push({ r, why }); continue }
  clean.push({
    artist: String(r.artist).trim(),
    title: String(r.title).trim(),
    trackId: Number(r.trackId),
    previewUrl: r.previewUrl,
    artworkUrl: r.artworkUrl || '',
    album: r.album || '',
    year: Number(r.year) || undefined,
    genre: r.genre || '',
  })
}

function reject(r) {
  if (!r || typeof r !== 'object') return 'not an object'
  if (!r.artist || !r.title) return 'missing artist/title'
  if (!Number.isFinite(Number(r.trackId))) return 'bad trackId'
  if (typeof r.previewUrl !== 'string') return 'missing previewUrl'
  // Must be a genuine Apple preview URL, not something invented.
  if (!/^https:\/\/audio-ssl\.itunes\.apple\.com\/|^https:\/\/[a-z0-9-]+\.mzstatic\.com\//i.test(r.previewUrl)) {
    return `previewUrl not an Apple host: ${r.previewUrl.slice(0, 60)}`
  }
  if (r.genre && !OK_GENRE.test(r.genre)) return `genre "${r.genre}"`
  if (BAD_TITLE.test(r.title)) return `title looks like a cover/instrumental`
  if (BAD_ARTIST.test(r.artist)) return `artist looks like a karaoke/tribute act`
  return null
}

/* ---------- dedup ---------- */

const norm = s => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '')

const byId = new Map()
for (const s of clean) if (!byId.has(s.trackId)) byId.set(s.trackId, s)

// Also collapse the same recording appearing under different trackIds
// (album vs. single vs. deluxe release).
const bySong = new Map()
for (const s of byId.values()) {
  const k = `${norm(s.artist)}::${norm(s.title)}`
  if (!bySong.has(k)) bySong.set(k, s)
}

let catalog = [...bySong.values()]
console.log(`${clean.length} valid → ${byId.size} unique trackIds → ${catalog.length} unique songs`)

/* ---------- live preview check ---------- */

if (!args.includes('--no-preview-check')) {
  console.log(`\nchecking ${catalog.length} previews…`)
  const live = []
  let n = 0
  for (const s of catalog) {
    n++
    let ok = false
    try {
      const r = await fetch(s.previewUrl, { headers: { Range: 'bytes=0-2047' } })
      ok = r.status === 200 || r.status === 206
    } catch {}
    if (ok) live.push(s)
    else console.log(`  dead  ${s.artist} — ${s.title}`)
    if (n % 25 === 0) console.log(`  …${n}/${catalog.length}`)
  }
  console.log(`${live.length}/${catalog.length} previews live`)
  catalog = live
}

/* ---------- merge + write ---------- */

if (args.includes('--merge')) {
  let prev = []
  try { prev = JSON.parse(await readFile(OUT, 'utf8')) } catch {}
  const m = new Map(prev.map(s => [s.trackId, s]))
  for (const s of catalog) if (!m.has(s.trackId)) m.set(s.trackId, s)
  catalog = [...m.values()]
}

catalog.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))

await writeFile(OUT, JSON.stringify(catalog, null, 2))

console.log(`\nsongs.json written — ${catalog.length} tracks`)

if (dropped.length) {
  console.log(`\ndropped ${dropped.length} record(s):`)
  const seen = new Set()
  for (const d of dropped.slice(0, 25)) {
    const key = `${d.r?.artist} — ${d.r?.title}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`  - ${key}  (${d.why})`)
  }
}

const artists = new Set(catalog.map(s => s.artist))
const years = catalog.map(s => s.year).filter(Boolean)
if (years.length) {
  console.log(`\n${artists.size} distinct artists · years ${Math.min(...years)}–${Math.max(...years)}`)
}
