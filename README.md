# forza-telemetry

A real-time driving coach for Forza Motorsport. It captures the game's UDP "Data Out" telemetry, stores every lap
in SQLite, and turns it into live coaching on a phone/tablet dashboard, long-term progress reports, and an MCP server
so you can ask Claude *"where am I losing time?"* about your own laps.

Everything runs locally — no cloud, no accounts. TypeScript on Node ≥ 20.

## Highlights

- **Binary protocol parsing** — decodes the Forza Sled/Dash packet layouts (FM7, FM 2023, FH) from raw UDP
  datagrams, auto-detecting the format by packet length.
- **Robust lap & session segmentation** — handles rewinds (trims samples past the rewind point), race restarts,
  car/track changes, out-laps and idle gaps, and flags suspect laps.
- **Corner detection & scoring** — derives a corner layout per track from the reference lap, then scores every
  corner on brake point, apex speed, exit speed and line.
- **Live coaching at 60 Hz** — Server-Sent Events push live delta-to-reference, corner callouts and audio brake
  markers whose timing compensates for speed and acceleration so the final beep lands within milliseconds of the
  marker.
- **Progress analytics** — pace and consistency trends, personal-best history and per-corner trends across sessions,
  with explicit thresholds for what counts as "improved".
- **MCP server** — exposes the telemetry database to Claude (or any MCP client) as a set of typed analysis tools.
- **Record/replay** — raw captures can be replayed into the pipeline or over UDP, so the whole system can be
  developed and tested without the game running. The test suite runs against a real recorded race.

## Architecture

```
Forza ──UDP:5344──▶ listener ──▶ parser ──▶ pipeline (sessions/laps/rewinds) ──▶ SQLite (data/forza.db)
                                                   │                                    │
                                                   ▼                                    ├──▶ analysis (corners, reports, progress)
                                             live coach ──SSE:5345──▶ dashboard         │
                                                                                        └──▶ MCP server (stdio, read-only)
```

| Path | What it does |
| --- | --- |
| `src/listener/` | UDP socket, packet layouts + parser, session/lap pipeline, raw capture format |
| `src/store/` | SQLite schema, migrations and batched writes (`better-sqlite3`, WAL) |
| `src/analysis/` | distance-grid resampling, corner detection, lap/corner reports, progress over time |
| `src/live/` | real-time coach (delta, callouts, brake markers, lockups) and the HTTP/SSE dashboard server |
| `src/mcp/` | MCP server exposing the analysis as tools |
| `public/dash/` | dependency-free dashboard front-end (vanilla JS, Canvas, Web Audio, Speech Synthesis) |
| `scripts/` | capture, replay, inspect, analyze and progress CLIs |
| `test/` | Vitest suite, including a recorded FM 2023 race as a fixture |

**Stack:** TypeScript, Node.js, SQLite (`better-sqlite3`), Model Context Protocol SDK, Zod, Vitest.

## Quick start

```sh
pnpm install
pnpm test                   # runs the suite against the bundled race recording
pnpm listen                 # start the listener + dashboard
```

No game? Replay the bundled recording into a running listener to see the dashboard work:

```sh
pnpm listen                                                                     # terminal 1
pnpm replay test/fixtures/fm2023-race.bin.gz --udp 127.0.0.1:5344 --speed 4     # terminal 2
```

## Capture raw packets

```sh
ipconfig getifaddr en0      # your machine's LAN IP (macOS), enter this in-game
pnpm capture                # saves only while driving to data/raw/capture-<timestamp>.bin; Ctrl+C to stop
pnpm capture --all          # also keep menu/pause packets
```

In-game: Settings → HUD and Gameplay → Data Out = On, Data Out IP Address = your machine's LAN IP,
Data Out IP Port = 5344, Data Out Packet Format = Dash (FM7/FM 2023 only).

If no packets arrive, check your firewall allows incoming UDP for `node`.

## Run the listener

```sh
pnpm listen                 # UDP :5344 → data/forza.db; prints pkt/s, format, current lap
```

Sessions split on a >30 s gap, a car/track change or a race restart. Laps split when LapNumber
increments (time comes from LastLap) or when the lap timer resets at the line. Rewinds trim the samples
recorded after the rewind point and flag the lap `had_rewind`. Laps slower than 130% of the session
median are flagged `is_suspect`.

Configuration via environment variables: `FORZA_PORT` (UDP, default 5344), `FORZA_HOST` (default `0.0.0.0`),
`FORZA_DASH_PORT` (default 5345), `FORZA_DB`, `FORZA_DATA_DIR`.

## Live coaching dashboard

`pnpm listen` also serves a dashboard on port 5345 (`FORZA_DASH_PORT`; `--no-dash` to turn it off). It prints the
URL — open it on a tablet or phone on the same Wi-Fi and put it next to the screen.

> The dashboard has no authentication and listens on all interfaces so a phone can reach it. Run it on a trusted
> home network only.

- **Delta to reference**: live time gained/lost against your fastest clean lap on this track in this car (falls back
  to any car on the track, marked `*`), plus the predicted lap time and whether you're gaining or losing right now.
- **Corner callouts**: as soon as you clear each corner it's scored against the reference — time gained/lost and one
  instruction ("Brake 15 m later", "Carry 10 km/h more to the apex", "Ran wide — brake earlier").
- **Next corner**: countdown to the reference brake point, the reference's apex speed and gear, and what went wrong
  there last lap. Corners where you lost ≥ 0.1 s last lap get a cue *before* the braking zone.
- **Brake markers**: three short beeps then a long one *at* the reference brake point (beep · beep · beep · BEEEP —
  press on the last tone; don't react to it), plus a full-screen BRAKE / LIFT flash. The time to the marker accounts for
  speed and acceleration, and frames go out at ~60 Hz in the last 2 s, so the final beep lands within a few
  milliseconds of the marker. Right after you brake you see how far off you were ("T2 · braked 29 m late", a chime
  when you're within 5 m), each corner chip keeps it, and the lap report sums it up. If you're consistently late,
  set *Timing* to play the beeps earlier.
- **Lockups**: a wheel locking under braking flashes EASE OFF with a low buzz while it's happening.
- **Lap report**: time vs reference, the three biggest losses with fixes, one focus for the next lap, and the
  session's theoretical best.
- **Voice**: tap *Voice on* and the callouts, cues and lap reports are spoken (browser speech, no setup).
  *Full screen* also keeps the screen awake.

The first timed lap on a new track/car becomes the reference; coaching starts on the lap after it.

## Replay a capture

```sh
pnpm replay data/raw/capture-XXXX.bin                 # straight into data/forza.db, as fast as possible
pnpm replay file.bin --db :memory:                    # dry run, prints the laps
pnpm replay file.bin --udp 127.0.0.1:5344 --speed 4   # send over UDP to a running `pnpm listen`
pnpm inspect file.bin                                 # field ranges + lap transitions
```

## Track your progress over time

```sh
pnpm progress                      # latest track + car: pace trend, PB history, corners improved / got slower
pnpm progress 1620 --car 2529      # a specific track (and car)
pnpm progress --corner T3          # one corner session by session: brake point, min/exit speed, lockups
pnpm progress --pbs                # personal bests for every track + car
pnpm progress --all-tunes --last 5 --json
```

The same reports are on the dashboard: open `/progress.html` (the **Progress** link on the live page). It shows your PB,
pace and consistency verdicts, lap time by session (best, median, theoretical best), lap-time spread, how much each
corner gained or lost from your first to your latest session, a corner table with trend sparklines, and the
personal-best history. Tap a corner for its session-by-session detail (brake point, speeds, lockups, off-line laps).
Pick the track/car and session window at the top; the URL keeps the selection, so it can be bookmarked.

Progress is tracked per track + car + tune, where the tune is the car's PI: a PI change means the car was
upgraded or retuned, so by default only sessions on the latest PI count (`--all-tunes` mixes them). Every lap
is measured against one corner layout, so T3 is the same corner in every session. For each session you get the
best, median and theoretical-best lap and the lap-time spread. Pace counts as improving or slower when the
median lap moves by more than 0.15 s (or 0.2% of the lap), and a corner as improved or regressed when its
typical (median) segment time moves by 0.05 s. "Most left on the table" ranks corners by the gap between your
latest typical lap and your best-ever segment there.

## Ask Claude about your driving (MCP server)

```sh
claude mcp add forza-telemetry -- pnpm --dir "$(pwd)" -s mcp   # register with Claude Code (stdio)
pnpm mcp                                                     # or run it directly
```

Opens `data/forza.db` read-only, so it can run alongside `pnpm listen`. Tools: `get_status`, `list_sessions`,
`list_laps`, `get_track_corners`, `lap_summary`, `compare_laps`, `where_am_i_losing_time`, `consistency_report`,
`get_lap_trace`, `progress_report`, `corner_progress`, `personal_bests`. Session arguments default to the most recent
session; `compare_laps` defaults its baseline to the fastest clean lap on that track. Then just ask: "where am I losing
time?", "why was lap 3 slow?", "what am I doing differently in T1 on my best lap?", "am I improving at this track?",
"how has my T6 changed?"

## Development

```sh
pnpm typecheck
pnpm test
```

Your own telemetry (`data/forza.db`, `data/raw/`) is git-ignored.

---

*Not affiliated with or endorsed by Microsoft, Xbox Game Studios or Turn 10 Studios. Forza Motorsport is a trademark of
Microsoft Corporation.*
