# forza-telemetry

Local Forza Data Out → SQLite → MCP coaching system. Capture, parser, storage, analysis, live coaching dashboard and MCP server.

## Capture raw packets

```sh
pnpm install
ipconfig getifaddr en0      # Mac's LAN IP, enter this in-game
pnpm capture                # saves only while driving to data/raw/capture-<timestamp>.bin; Ctrl+C to stop
pnpm capture --all          # also keep menu/pause packets
```

In-game: Settings → HUD and Gameplay → Data Out = On, Data Out IP Address = the Mac's LAN IP,
Data Out IP Port = 5344, Data Out Packet Format = Dash (FM7/FM 2023 only).

If no packets arrive, check System Settings → Network → Firewall: allow incoming connections for `node`.

## Run the listener

```sh
pnpm listen                 # UDP :5344 → data/forza.db; prints pkt/s, format, current lap
```

Sessions split on a >30 s gap, a car/track change or a race restart. Laps split when LapNumber
increments (time comes from LastLap) or when the lap timer resets at the line. Rewinds trim the samples
recorded after the rewind point and flag the lap `had_rewind`. Laps slower than 130% of the session
median are flagged `is_suspect`.

## Live coaching dashboard

`pnpm listen` also serves a dashboard on port 5345 (`FORZA_DASH_PORT`; `--no-dash` to turn it off). It prints the
URL — open it on a tablet or phone on the same Wi-Fi and put it next to the screen.

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
Test without the game: `pnpm listen` in one terminal, `pnpm replay data/raw/capture-XXXX.bin --udp 127.0.0.1:5344 --speed 4` in another.

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
`get_lap_trace`, `progress_report`, `corner_progress`, `personal_bests`. Session arguments default to the most recent session; `compare_laps` defaults its baseline to the
fastest clean lap on that track. Then just ask: "where am I losing time?", "why was lap 3 slow?", "what am I doing
differently in T1 on my best lap?", "am I improving at this track?", "how has my T6 changed?"

