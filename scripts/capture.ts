/**
 * Raw UDP capture. Writes packets, untouched, to data/raw/<timestamp>.bin.
 *
 * By default only packets with IsRaceOn != 0 (you're actually driving) are saved;
 * menu/pause/idle packets are counted but discarded. The file is only created once
 * the first driving packet arrives, so sitting in menus leaves nothing on disk.
 *
 * Usage: pnpm capture [--out file.bin] [--all]
 *   --all   also save idle packets (IsRaceOn = 0)
 */
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { HOST, PORT, RAW_DIR } from "../src/config.js";
import { CAPTURE_MAGIC, encodeRecord } from "../src/listener/capture-format.js";

const KNOWN_SIZES: Record<number, string> = {
  232: "FM7 Sled (enable Dash format for full data!)",
  311: "FM7 Car Dash",
  324: "Forza Horizon 4/5",
  331: "Forza Motorsport (2023)",
};

const args = process.argv.slice(2);
const saveAll = args.includes("--all");
const outIdx = args.indexOf("--out");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : path.join(RAW_DIR, `capture-${stamp}.bin`);

let out: number | null = null; // opened lazily on first saved packet
function ensureOpen(): number {
  if (out === null) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    out = fs.openSync(outFile, "w");
    fs.writeSync(out, CAPTURE_MAGIC);
    console.log(`Recording started → ${outFile}`);
  }
  return out;
}

// Monotonic clock anchored to wall time for sub-ms precision.
const t0Wall = Date.now();
const t0Perf = performance.now();
const nowMs = () => t0Wall + (performance.now() - t0Perf);

let received = 0;
let windowRx = 0;
let windowDriving = 0;
let saved = 0;
let savedBytes = 0;
const sizes = new Map<number, number>();

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("message", (msg) => {
  received++;
  windowRx++;
  sizes.set(msg.length, (sizes.get(msg.length) ?? 0) + 1);
  // IsRaceOn is the first s32 in every Forza layout.
  const driving = msg.length >= 4 && msg.readInt32LE(0) !== 0;
  if (driving) windowDriving++;
  if (!driving && !saveAll) return;
  const rec = encodeRecord(nowMs(), msg);
  fs.writeSync(ensureOpen(), rec);
  saved++;
  savedBytes += rec.length;
});
sock.on("error", (err) => {
  console.error("socket error:", err.message);
  process.exit(1);
});
sock.bind(PORT, HOST, () => {
  console.log(`Listening on ${HOST}:${PORT} (${saveAll ? "saving ALL packets" : "saving only while driving"})`);
  console.log("Drive some laps, then Ctrl+C to stop.\n");
});

const timer = setInterval(() => {
  const state = windowRx === 0 ? "no data" : windowDriving > 0 ? "DRIVING" : "idle   ";
  const sizeStr = [...sizes.entries()]
    .map(([len, n]) => `${len}B×${n}${KNOWN_SIZES[len] ? ` (${KNOWN_SIZES[len]})` : " (UNKNOWN)"}`)
    .join(", ") || "none yet";
  console.log(
    `${state} | ${windowRx} pkt/s | saved ${saved} (${(savedBytes / 1024).toFixed(0)} KiB) | received ${received} | sizes: ${sizeStr}`,
  );
  windowRx = 0;
  windowDriving = 0;
}, 1000);

function stop() {
  clearInterval(timer);
  sock.close();
  if (out !== null) {
    fs.closeSync(out);
    console.log(`\nSaved ${saved} of ${received} packets to ${outFile}`);
  } else {
    console.log(`\nNo driving packets received (${received} idle) — nothing saved.`);
  }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
