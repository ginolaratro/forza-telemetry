/** Lap loading + resampling onto a fixed distance grid. */
import type { DB } from "../store/db.js";

export interface RawSample {
  t_ms: number;
  dist_m: number;
  speed_kmh: number;
  throttle: number;
  brake: number;
  steer: number;
  gear: number;
  rpm: number;
  x: number;
  y: number;
  z: number;
  slip_fl: number;
  slip_fr: number;
  slip_rl: number;
  slip_rr: number;
}

export interface LapInfo {
  id: number;
  session_id: number;
  lap_number: number;
  lap_time_s: number | null;
  is_complete: number;
  is_suspect: number;
  is_outlap: number;
  had_rewind: number;
  drivetrain: number;
  track_ordinal: number | null;
  car_ordinal: number;
}

/** Channels on a uniform distance grid: index i ↔ dist = i * step. */
export interface Grid {
  lapId: number;
  step: number;
  length: number; // meters covered
  dist: Float64Array;
  t: Float64Array; // seconds since lap start
  speed: Float64Array; // km/h
  throttle: Float64Array;
  brake: Float64Array;
  steer: Float64Array;
  gear: Int8Array;
  rpm: Float64Array;
  x: Float64Array;
  z: Float64Array;
  slip: [Float64Array, Float64Array, Float64Array, Float64Array]; // fl fr rl rr slip ratio
}

export function getLapInfo(db: DB, lapId: number): LapInfo | undefined {
  return db
    .prepare(
      `SELECT l.id, l.session_id, l.lap_number, l.lap_time_s, l.is_complete, l.is_suspect, l.is_outlap, l.had_rewind,
              s.drivetrain, s.track_ordinal, s.car_ordinal
       FROM laps l JOIN sessions s ON s.id = l.session_id WHERE l.id = ?`,
    )
    .get(lapId) as LapInfo | undefined;
}

export function loadSamples(db: DB, lapId: number): RawSample[] {
  return db
    .prepare(
      `SELECT t_ms, dist_m, speed_kmh, throttle, brake, steer, gear, rpm, x, y, z, slip_fl, slip_fr, slip_rl, slip_rr
       FROM samples WHERE lap_id = ? ORDER BY rowid`,
    )
    .all(lapId) as RawSample[];
}

/**
 * Resample a lap onto a fixed grid (default 1 m). Samples are first made strictly
 * increasing in distance (the car may roll back slightly). Continuous channels are
 * linearly interpolated; gear is held from the previous sample, and the FM2023
 * mid-shift value 11 is replaced by the last real gear.
 */
export function resample(lapId: number, samples: RawSample[], step = 1): Grid {
  const mono: RawSample[] = [];
  let lastGear = 1;
  for (const s of samples) {
    if (s.gear !== 11) lastGear = s.gear;
    const fixed = s.gear === 11 ? { ...s, gear: lastGear } : s;
    if (!mono.length || s.dist_m > mono[mono.length - 1]!.dist_m) mono.push(fixed);
  }
  if (mono.length < 2) throw new Error(`lap ${lapId} has too few samples`);
  const end = mono[mono.length - 1]!.dist_m;
  const n = Math.max(0, Math.floor(end / step)) + 1;
  const g: Grid = {
    lapId,
    step,
    length: (n - 1) * step,
    dist: new Float64Array(n),
    t: new Float64Array(n),
    speed: new Float64Array(n),
    throttle: new Float64Array(n),
    brake: new Float64Array(n),
    steer: new Float64Array(n),
    gear: new Int8Array(n),
    rpm: new Float64Array(n),
    x: new Float64Array(n),
    z: new Float64Array(n),
    slip: [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)],
  };
  let j = 0;
  for (let i = 0; i < n; i++) {
    // Grid starts at 0 m; anything before the first sample is clamped to it.
    const d = i * step;
    while (j < mono.length - 2 && mono[j + 1]!.dist_m < d) j++;
    const a = mono[j]!;
    const b = mono[j + 1]!;
    const f = Math.min(1, Math.max(0, (d - a.dist_m) / (b.dist_m - a.dist_m)));
    const L = (u: number, v: number) => u + (v - u) * f;
    g.dist[i] = d;
    g.t[i] = L(a.t_ms, b.t_ms) / 1000;
    g.speed[i] = L(a.speed_kmh, b.speed_kmh);
    g.throttle[i] = L(a.throttle, b.throttle);
    g.brake[i] = L(a.brake, b.brake);
    g.steer[i] = L(a.steer, b.steer);
    g.gear[i] = f < 1 ? a.gear : b.gear;
    g.rpm[i] = L(a.rpm, b.rpm);
    g.x[i] = L(a.x, b.x);
    g.z[i] = L(a.z, b.z);
    g.slip[0][i] = L(a.slip_fl, b.slip_fl);
    g.slip[1][i] = L(a.slip_fr, b.slip_fr);
    g.slip[2][i] = L(a.slip_rl, b.slip_rl);
    g.slip[3][i] = L(a.slip_rr, b.slip_rr);
  }
  return g;
}

export function loadGrid(db: DB, lapId: number, step = 1): Grid {
  return resample(lapId, loadSamples(db, lapId), step);
}

/** Value of a channel at distance d (nearest grid index, clamped). */
export function at(g: Grid, ch: ArrayLike<number>, d: number): number {
  const i = Math.min(ch.length - 1, Math.max(0, Math.round(d / g.step)));
  return ch[i]!;
}

/** Cumulative time delta b − a vs distance (positive = b slower). */
export function timeDelta(a: Grid, b: Grid): { dist: Float64Array; delta: Float64Array } {
  const n = Math.min(a.t.length, b.t.length);
  const dist = a.dist.slice(0, n);
  const delta = new Float64Array(n);
  for (let i = 0; i < n; i++) delta[i] = b.t[i]! - a.t[i]!;
  return { dist, delta };
}
