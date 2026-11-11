# forza-telemetry

Local Forza Data Out → SQLite → MCP coaching system. Work in progress (step 1: raw capture).

## Capture raw packets

```sh
pnpm install
ipconfig getifaddr en0      # Mac's LAN IP, enter this in-game
pnpm capture                # writes data/raw/capture-<timestamp>.bin; Ctrl+C to stop
```

In-game: Settings → HUD and Gameplay → Data Out = On, Data Out IP Address = the Mac's LAN IP,
Data Out IP Port = 5344, Data Out Packet Format = Dash (FM7/FM 2023 only).

If no packets arrive, check System Settings → Network → Firewall: allow incoming connections for `node`.
