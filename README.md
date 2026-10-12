# Songless Unlimited — Hip-Hop/Rap

A Songless/Heardle-style audio guessing game that never runs out. Hear a tenth of a second of
a track, name it. Every wrong guess or skip unlocks more:
**0.1s → 0.5s → 1s → 2s → 4s → 7s → 11s → 16s**, eight tries total. Catalog is hip-hop and rap only.

No daily limit, no accounts, no build step, no dependencies.

## Run it

```bash
node serve.mjs
```

Then open <http://localhost:3000>. The server prints a URL for every network
interface it finds, including your Tailscale address — hand that one to friends
who are on your tailnet and they can play from anywhere.

> Opening `index.html` directly off the disk does **not** work: browsers block
> `fetch` on `file://` URLs, so `songs.json` can't load. Use the server.

## Play

- **Space-less typing** — start typing an artist or title and pick from the dropdown.
  Arrow keys + Enter work. A guess only counts if it resolves to a catalog song.
- **Skip** banks the attempt and unlocks the next chunk of audio.
- **Share** copies your emoji result grid *plus* a challenge link
  (`#t=<trackId>`) that drops a friend on the exact same song — good for
  head-to-head.
- Stats (win rate, streak, distribution by number of tries) live in `localStorage`.
  A shuffle bag guarantees you see the whole catalog before any repeat.

## The catalog

`songs.json` holds tracks that have each been resolved against the
[iTunes Search API](https://performance-partners.apple.com/search-api) and
confirmed to have a **live 30-second preview**. Audio streams from Apple's
preview CDN at play time — nothing is downloaded or redistributed.

Each entry is `{artist, title, trackId, previewUrl, artworkUrl, album, year, genre}`.

### Adding your own songs

Write one `Artist - Title` per line, then resolve them:

```bash
node build-catalog.mjs my-songs.txt --merge
```

`--merge` adds to the existing catalog instead of replacing it. The resolver
drops anything that isn't genuinely hip-hop/rap, plus karaoke acts, tribute
bands, instrumentals, acapellas and dead previews — a wrong track in the game is
worse than a missing one.

### Re-checking previews

Apple rotates preview URLs occasionally. If tracks start failing:

```bash
node build-catalog.mjs --check
```

This re-requests every preview and rewrites `songs.json` with only the live
ones. The game also self-heals at runtime: a dead URL triggers a fresh
`lookup?id=<trackId>` call, and only if that fails does it rotate to another song.

### Rate limiting

The search API allows roughly **20 requests/minute** and returns `429` in bursts.
`build-catalog.mjs` serializes calls with a 3.2s floor and exponential backoff, so a
few hundred songs takes 10–15 minutes. Tune with `ITUNES_GAP_MS=4000 node build-catalog.mjs ...`
if you still get throttled.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole game — markup, styles, logic. No dependencies. |
| `songs.json` | Verified catalog. |
| `serve.mjs` | Zero-dep static server, binds `0.0.0.0`. |
| `build-catalog.mjs` | Resolve/verify/merge songs; `--check` revalidates previews. |
| `curated-seed.txt` | The `Artist - Title` list the catalog was built from. |
| `curated-meta.json` | Curation notes per track (fame score, intro description). |

## Notes

- Previews are 30s, so the 16s maximum reveal always fits. The timeline uses
  square-root scaling so the sub-second stages stay visible.
- Change the difficulty curve by editing `STAGES` near the top of the script in
  `index.html`; the UI ticks, share grid and stats all derive from it.
- Reset your stats: `localStorage.clear()` in the browser console.
