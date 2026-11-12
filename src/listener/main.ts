/**
 * Live listener: UDP → parser → pipeline → SQLite.
 * Prints packets/sec, detected format and current lap once a second, and writes
 * a heartbeat row (listener_status) that the MCP server reads.
 * Also serves the live coaching dashboard (disable with --no-dash).
 */
import dgram from "node:dgram";
import { DASH_PORT, DB_PATH, HOST, PORT } from "../config.js";
import { LAYOUTS } from "./layouts.js";
import { createIngest } from "./ingest.js";
import { openDb } from "../store/db.js";
import { LiveCoach } from "../live/coach.js";
import { dashUrls, startDashServer } from "../live/server.js";

const db = openDb(DB_PATH);
const ingest = createIngest(db);
const dangling = ingest.store.closeDanglingSessions();
if (dangling) console.log(`closed ${dangling} session(s) left open by a previous run`);

const fmtLap = (s: number | null | undefined) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

const coach = new LiveCoach(db);
// The coach must never take the recorder down: log the first error, keep storing telemetry.
let coachFailed = false;
ingest.pipeline.onSample = (row, t) => {
  try {
    coach.sample(row, t);
  } catch (err) {
    if (!coachFailed) console.error("coach error (telemetry is still being recorded):", err);
    coachFailed = true;
  }
};
const dash = process.argv.includes("--no-dash") ? null : startDashServer(coach, DASH_PORT);
dash?.on("listening", () => console.log(`Dashboard: ${dashUrls(DASH_PORT).join("  ")}`));
dash?.on("error", (err) => console.error(`dashboard server error: ${err.message} (set FORZA_DASH_PORT or use --no-dash)`));

ingest.pipeline.onEvent = (e) => {
  try {
    coach.event(e);
  } catch (err) {
    console.error("coach error:", err);
  }
  const ts = new Date().toLocaleTimeString();
  if (e.type === "session_start") console.log(`[${ts}] session #${e.sessionId} started`);
  else if (e.type === "session_end") console.log(`[${ts}] session #${e.sessionId} ended${e.deleted ? " (too short, discarded)" : ""}`);
  else if (e.type === "lap_end") console.log(`[${ts}] lap ${e.lapNumber} ${e.complete ? fmtLap(e.lapTimeS) : "(incomplete)"}`);
  else if (e.type === "rewind") console.log(`[${ts}] rewind detected — trimmed lap ${e.lapNumber}`);
  else if (e.type === "restart") console.log(`[${ts}] race restart`);
};

let windowRx = 0;
let windowRace = 0;
let lastPacketAt: number | null = null;
let lastRaceAt: number | null = null;
let lastLen: number | null = null;

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("message", (msg) => {
  const now = Date.now();
  windowRx++;
  lastPacketAt = now;
  lastLen = msg.length;
  if (ingest.handle(msg, now)) {
    windowRace++;
    lastRaceAt = now;
  }
});
sock.on("error", (err) => {
  console.error("socket error:", err.message);
  process.exit(1);
});
sock.bind(PORT, HOST, () => console.log(`Listening on ${HOST}:${PORT} → ${DB_PATH}`));

// If no driving packets for a while (menus, game closed), close the session so ended_at is accurate.
const IDLE_CLOSE_MS = 30_000;

const timer = setInterval(() => {
  const now = Date.now();
  const cur = ingest.pipeline.current;
  if (cur && lastRaceAt && now - lastRaceAt > IDLE_CLOSE_MS) ingest.pipeline.close();
  ingest.store.flush();
  const fmt = lastLen ? (LAYOUTS[lastLen]?.label ?? `unknown (${lastLen} B)`) : "—";
  const state = windowRx === 0 ? "no data" : windowRace > 0 ? "DRIVING" : "idle   ";
  const lap = cur?.last;
  const lapStr = cur && lap ? `lap ${lap.lapNumber} ${fmtLap(lap.currentLap)} | last ${fmtLap(lap.lastLap)} | best ${fmtLap(lap.bestLap)} | ${lap.speedKmh?.toFixed(0)} km/h` : "no session";
  console.log(`${state} | ${String(windowRx).padStart(3)} pkt/s | ${fmt} | ${lapStr}`);
  ingest.store.writeStatus({
    updated_at: now,
    last_packet_at: lastPacketAt,
    packets_per_sec: windowRx,
    game_format: ingest.lastFormat,
    session_id: cur?.sessionId ?? null,
    lap_id: cur?.lapId ?? null,
    lap_number: cur?.lapNumber ?? null,
    current_lap_s: lap?.currentLap ?? null,
    speed_kmh: lap?.speedKmh ?? null,
  });
  windowRx = 0;
  windowRace = 0;
}, 1000);

function stop() {
  clearInterval(timer);
  dash?.close();
  dash?.closeAllConnections();
  sock.close();
  ingest.close();
  ingest.store.writeStatus({
    updated_at: Date.now(), last_packet_at: lastPacketAt, packets_per_sec: 0, game_format: ingest.lastFormat,
    session_id: null, lap_id: null, lap_number: null, current_lap_s: null, speed_kmh: null,
  });
  db.close();
  console.log("listener stopped");
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
