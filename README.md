# forza-telemetry

Local Forza Data Out → SQLite → MCP coaching system. Work in progress: capture, parser and storage done; analysis, dashboard and MCP server next.

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

## Replay a capture

```sh
pnpm replay data/raw/capture-XXXX.bin                 # straight into data/forza.db, as fast as possible
pnpm replay file.bin --db :memory:                    # dry run, prints the laps
pnpm replay file.bin --udp 127.0.0.1:5344 --speed 4   # send over UDP to a running `pnpm listen`
pnpm inspect file.bin                                 # field ranges + lap transitions
```
