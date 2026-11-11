/** Summarize a capture: per-field ranges, laps, car/track. Usage: tsx scripts/inspect.ts <file.bin> */
import { readCapture } from "../src/listener/capture-format.js";
import { parsePacket, type Telemetry } from "../src/listener/parser.js";

const file = process.argv[2];
if (!file) throw new Error("usage: inspect.ts <capture.bin>");
const rows: Telemetry[] = [];
for (const p of readCapture(file)) { const t = parsePacket(p.data); if (t) rows.push(t); }
console.log(`${rows.length} parsed packets, format(s): ${[...new Set(rows.map((r) => r.format))].join(",")}`);

const range = (name: string, vals: (number | null)[]) => {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return console.log(`${name.padEnd(18)} (none)`);
  let lo = Infinity, hi = -Infinity, s = 0;
  for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); s += x; }
  console.log(`${name.padEnd(18)} min ${lo.toFixed(3).padStart(11)}  max ${hi.toFixed(3).padStart(11)}  mean ${(s / v.length).toFixed(3).padStart(11)}`);
};
range("speedKmh", rows.map((r) => r.speedKmh));
range("rpm", rows.map((r) => r.rpm));
range("engineMaxRpm", rows.map((r) => r.engineMaxRpm));
range("gear", rows.map((r) => r.gear));
range("throttle", rows.map((r) => r.throttle));
range("brake", rows.map((r) => r.brake));
range("clutch", rows.map((r) => r.clutch));
range("handbrake", rows.map((r) => r.handbrake));
range("steer", rows.map((r) => r.steer));
range("fuel", rows.map((r) => r.fuel));
range("tireTempC FL", rows.map((r) => r.tireTempC?.[0] ?? null));
range("tireWear FL", rows.map((r) => r.tireWear?.[0] ?? null));
range("slipRatio RL", rows.map((r) => r.slipRatio[2]));
range("combinedSlip FL", rows.map((r) => r.combinedSlip[0]));
range("powerKW", rows.map((r) => (r.powerW ?? 0) / 1000));
range("torqueNm", rows.map((r) => r.torqueNm));
range("distTraveled", rows.map((r) => r.distanceTraveled));
range("posX", rows.map((r) => r.position?.x ?? null));
range("posZ", rows.map((r) => r.position?.z ?? null));
range("racePosition", rows.map((r) => r.racePosition));

const combos = new Map<string, number>();
for (const r of rows) {
  const k = `car ${r.carOrdinal} class ${r.carClass} PI ${r.carPI} drive ${r.drivetrain} cyl ${r.numCylinders} track ${r.trackOrdinal}`;
  combos.set(k, (combos.get(k) ?? 0) + 1);
}
console.log("\ncar/track combos:"); for (const [k, n] of combos) console.log(`  ${k}: ${n}`);

console.log("\nlap transitions:");
let prev: Telemetry | undefined;
for (const r of rows) {
  if (!prev || r.lapNumber !== prev.lapNumber) {
    console.log(`  lap ${r.lapNumber}  lastLap ${r.lastLap?.toFixed(3)}  bestLap ${r.bestLap?.toFixed(3)}  prevCurrentLap ${prev?.currentLap?.toFixed(3)}  dist ${r.distanceTraveled?.toFixed(0)}  raceTime ${r.currentRaceTime?.toFixed(1)}`);
  }
  prev = r;
}
