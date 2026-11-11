/**
 * Replay raw captures through the parser → pipeline → SQLite.
 * Usage: pnpm replay <capture.bin[.gz]>... [--speed 1|10|max] [--db path]
 *   --speed  playback multiplier (default max = as fast as possible)
 *   --db     target database (default data/forza.db; use :memory: for a dry run)
 *   --udp    host:port — send packets over UDP instead (e.g. to a running `pnpm listen`);
 *            defaults to real-time speed
 */
import dgram from "node:dgram";
import fs from "node:fs";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { DB_PATH } from "../src/config.js";
import { decodeCapture } from "../src/listener/capture-format.js";
import { createIngest } from "../src/listener/ingest.js";
import { openDb } from "../src/store/db.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const udp = opt("--udp");
const speedArg = opt("--speed") ?? (udp ? "1" : "max");
const dbPath = opt("--db") ?? DB_PATH;
const files = args;
if (!files.length) {
  console.error("usage: pnpm replay <capture.bin[.gz]>... [--speed 1|10|max] [--db path]");
  process.exit(1);
}
const speed = speedArg === "max" ? Infinity : Number(speedArg);

if (udp) {
  const [host = "127.0.0.1", port = "5344"] = udp.split(":");
  await sendUdp(host, Number(port));
  process.exit(0);
}

async function sendUdp(host: string, port: number) {
  const sock = dgram.createSocket("udp4");
  let sent = 0;
  for (const file of files) {
    let buf = fs.readFileSync(file);
    if (file.endsWith(".gz")) buf = zlib.gunzipSync(buf);
    let first: number | null = null;
    const wallStart = performance.now();
    for (const p of decodeCapture(buf)) {
      first ??= p.recvMs;
      const due = (p.recvMs - first) / (Number.isFinite(speed) ? speed : 1e9) - (performance.now() - wallStart);
      if (due > 2) await sleep(due);
      await new Promise<void>((res, rej) => sock.send(p.data, port, host, (e) => (e ? rej(e) : res())));
      if (++sent % 600 === 0) process.stdout.write(`\rsent ${sent} packets`);
    }
  }
  sock.close();
  console.log(`\nsent ${sent} packets to ${host}:${port}`);
}

const db = openDb(dbPath);
const ingest = createIngest(db);
const fmt = (s: number | null | undefined) => (s == null ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`);
ingest.pipeline.onEvent = (e) => {
  if (e.type === "lap_end") console.log(`  lap ${e.lapNumber} (#${e.lapId}) ${e.complete ? fmt(e.lapTimeS) : "incomplete"}`);
  else if (e.type === "session_start") console.log(`session #${e.sessionId} start`);
  else if (e.type === "session_end") console.log(`session #${e.sessionId} end${e.deleted ? " (too short, discarded)" : ""}`);
  else if (e.type === "rewind") console.log(`  rewind → lap ${e.lapNumber} (#${e.lapId})`);
  else if (e.type === "restart") console.log(`  race restart`);
};

const t0 = performance.now();
let n = 0;
for (const file of files) {
  let buf = fs.readFileSync(file);
  if (file.endsWith(".gz")) buf = zlib.gunzipSync(buf);
  let firstRecv: number | null = null;
  const wallStart = performance.now();
  for (const p of decodeCapture(buf)) {
    firstRecv ??= p.recvMs;
    if (Number.isFinite(speed)) {
      const due = (p.recvMs - firstRecv) / speed - (performance.now() - wallStart);
      if (due > 2) await sleep(due);
    }
    ingest.handle(p.data, p.recvMs);
    n++;
  }
}
ingest.close();
console.log(`\nreplayed ${n} packets in ${((performance.now() - t0) / 1000).toFixed(2)} s → ${dbPath}`);
for (const r of db.prepare(
  `SELECT l.session_id, l.id, l.lap_number, l.lap_time_s, l.is_complete, l.is_suspect, l.is_outlap, l.had_rewind,
          COUNT(s.rowid) AS samples, ROUND(MAX(s.dist_m)) AS max_dist
   FROM laps l LEFT JOIN samples s ON s.lap_id = l.id GROUP BY l.id ORDER BY l.id`,
).all()) console.log(r);
db.close();
