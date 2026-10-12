# Songless Unlimited

Name the rap track from a tenth of a second. Eight tries, each wrong guess or
skip unlocking more audio:

```
0.1s → 0.5s → 1s → 2s → 4s → 7s → 11s → 16s
```

No daily limit, no accounts, no build step, **no dependencies**.

Live at <https://songless.sammpath.dev>.

## Modes

| Route | Mode | Audio | Needs |
| --- | --- | --- | --- |
| `/itunes` | **Popular Hip-Hop** | 30s iTunes previews — start mid-song | nothing |
| `/spotify` | **My Spotify** | real tracks from 0:00 | Premium + allowlisted account |
| `/apple` | **Apple Music** | real tracks from 0:00 | *coming soon* — see below |

`/` is the picker. `/probe` checks every Spotify endpoint against your account.

## Run it

```bash
node serve.mjs          # http://127.0.0.1:3000
```

Use `127.0.0.1`, not `localhost` — Spotify rejects `localhost` as a redirect
host. The server prints a URL per interface, including the Tailscale address.

`HOST=127.0.0.1` binds loopback only (what the Pi uses, behind cloudflared);
the default `0.0.0.0` is reachable over LAN and tailnet.

## Checks

```bash
node verify.mjs         # 50+ static checks; exits non-zero on failure
```

Catalog integrity, guess resolution, duplicate rules, the DOM contract, stage
math, mobile CSS, era picker edge cases, and the playback invariants that were
learned the hard way — no runaway audio, no stale primed track, a stop always
scheduled before playback starts.

## Popular Hip-Hop

`songs.json` holds 267 tracks, each resolved against the
[iTunes Search API](https://performance-partners.apple.com/search-api) and
confirmed to have a live preview. Audio streams from Apple at play time;
nothing is downloaded or redistributed.

**Eras** in the toolbar filters by decade (80s 29 · 90s 84 · 00s 63 · 10s 65 ·
20s 26), applying to both the playable pool and the search box.

Add your own — one `Artist - Title` per line:

```bash
node build-catalog.mjs my-songs.txt --merge
node build-catalog.mjs --check          # re-verify every preview
```

The resolver drops anything that isn't genuinely hip-hop/rap, plus karaoke,
tribute acts, instrumentals and dead previews. The search endpoint allows
roughly 20 requests/minute and returns 403 in bursts, so it serialises with a
3.2s floor — a few hundred songs takes 10–15 minutes. Tune with
`ITUNES_GAP_MS=4000`.

`curated-seed.txt` is the list `songs.json` was built from; `curated-meta.json`
keeps the curation notes (recognisability score, what the intro sounds like).

## My Spotify

Catalog comes from your own library. **Settings** toggles the sources, each
showing its real size.

Spotify restricts a lot for apps in Development Mode. Confirmed for this app:

| Works | 403 |
| --- | --- |
| `/me`, `/me/top/tracks` (with offset) | `/artists?ids=` (batch) |
| `/me/tracks`, `/me/albums` | `/artists/{id}/top-tracks` |
| `/me/player/recently-played` | `/playlists/{id}/tracks` |
| `/artists/{id}` (single) | `/audio-analysis`, `/audio-features` |

Consequences: no genre filtering (artist genres need the batch endpoint, and
Spotify returns empty genre arrays anyway), clips start at 0:00 rather than the
first audible moment, and playlists cannot be read. **Saved albums carry most
of the catalog** for an album-based library.

Also: Development Mode caps the app at **25 allowlisted users**, and playback
needs **Premium**. On Firefox, turn off Enhanced Tracking Protection for the
site — it partitions the player's storage and the DRM licence request fails.

Run `/probe` to check all of this against your own account.

## Apple Music

Built and gated behind a coming-soon screen. Append `?dev=1` to `/apple` to run
the real flow. Needs a paid Apple Developer membership for the MusicKit key —
setup is in [`deploy/SETUP.md`](deploy/SETUP.md).

Worth it because Apple has **no 25-user cap** and none of the Development Mode
endpoint restrictions.

## Deploying

[`deploy/SETUP.md`](deploy/SETUP.md) covers the Pi: systemd unit, the
`cloudflared` ingress rule, DNS, and the Spotify/Apple credentials.

Updating:

```bash
cd ~/songless-unlimited && git pull && sudo systemctl restart songless
```

Only `serve.mjs` changes need the restart — pages and scripts are read per
request. `serve.mjs` stamps script URLs with the file's mtime, because
Cloudflare overrides the server's `no-cache` on `.js` with a 4-hour `max-age`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Mode picker |
| `itunes.html` | Popular Hip-Hop (self-contained game logic) |
| `spotify.html` + `app.js` | My Spotify |
| `apple.html` + `apple.js` | Apple Music, gated |
| `game.css` | Shared styles for all three game pages |
| `probe.html` | Spotify endpoint probe, run from any browser |
| `songs.json` | The 267-track verified catalog |
| `serve.mjs` | Zero-dep server; routes, cache-busting, Apple token signing |
| `build-catalog.mjs` | Resolve, verify and merge tracks into `songs.json` |
| `verify.mjs` | Static checks |

## Notes

- iTunes previews are 30s, so the 16s maximum reveal always fits.
- The timeline uses square-root scaling, or 0.1s would be an invisible sliver.
- Change the difficulty curve by editing `STAGES`; ticks, attempt count, stats
  buckets and the share grid all derive from it.
- Reset a mode: `localStorage.clear()` in its tab.
