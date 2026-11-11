/**
 * Raw UDP capture. Writes every packet, untouched, to data/raw/<timestamp>.bin.
 * Usage: pnpm capture [--out file.bin]
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

const outArg = process.argv.indexOf("--out");
fs.mkdirSync(RAW_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = outArg > 0 && process.argv[outArg + 1] ? process.argv[outArg + 1]! : path.join(RAW_DIR, `capture-${stamp}.bin`);

const out = fs.openSync(outFile, "w");
fs.writeSync(out, CAPTURE_MAGIC);

// Monotonic clock anchored to wall time for sub-ms precision.
const t0Wall = Date.now();
const t0Perf = performance.now();
const nowMs = () => t0Wall + (performance.now() - t0Perf);

let total = 0;
let window = 0;
let raceOn = 0;
let bytes = 0;
const sizes = new Map<number, number>();

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
sock.on("message", (msg) => {
  fs.writeSync(out, encodeRecord(nowMs(), msg));
  total++;
  window++;
  bytes += msg.length;
  sizes.set(msg.length, (sizes.get(msg.length) ?? 0) + 1);
  // IsRaceOn is the first s32 in every Forza layout.
  if (msg.length >= 4 && msg.readInt32LE(0) !== 0) raceOn++;
});
sock.on("error", (err) => {
  console.error("socket error:", err.message);
  process.exit(1);
});
sock.bind(PORT, HOST, () => {
  console.log(`Capturing UDP on ${HOST}:${PORT} → ${outFile}`);
  console.log("Drive some laps, then Ctrl+C to stop.\n");
});

const timer = setInterval(() => {
  const sizeStr = [...sizes.entries()]
    .map(([len, n]) => `${len}B×${n}${KNOWN_SIZES[len] ? ` (${KNOWN_SIZES[len]})` : " (UNKNOWN)"}`)
    .join(", ") || "none yet";
  console.log(`${window} pkt/s | total ${total} | raceOn ${raceOn} | ${(bytes / 1024).toFixed(0)} KiB | sizes: ${sizeStr}`);
  window = 0;
}, 1000);

function stop() {
  clearInterval(timer);
  sock.close();
  fs.closeSync(out);
  console.log(`\nSaved ${total} packets (${raceOn} with IsRaceOn) to ${outFile}`);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
