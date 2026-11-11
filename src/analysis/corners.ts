/**
 * Corner detection (on a reference lap) and per-corner measurement (on any lap).
 *
 * A corner zone is a braking zone (brake > 0.15), a sustained speed drop
 * (≥ 8 km/h from a local peak to the following minimum), or a sustained
 * part-throttle stretch (throttle < 0.7 for ≥ 25 m above 80 km/h — fast kinks
 * where speed barely drops). Zones closer than 30 m are merged; zones whose apex
 * sits within 20 m of the lap start/end are dropped as partial. Corners are numbered T1..Tn in lap order on the
 * reference lap; every other lap is measured inside the reference windows so the
 * same corner keeps the same ID across laps.
 *
 * The lap is partitioned into corner segments: segment Ti runs from 50 m before
 * Ti's zone start to 50 m before T(i+1)'s zone start — braking, apex, exit and
 * the following straight. The stretch before T1 wraps onto the last corner, so
 * segment times sum to the lap time.
 */
import { at, type Grid } from "./grid.js";

export const BRAKE_ON = 0.15;
export const LIFT_DROP_KMH = 8;
export const MERGE_GAP_M = 30;
export const SEGMENT_LEAD_M = 50;
export const EXIT_AFTER_APEX_M = 100;
export const THROTTLE_PICKUP = 0.25;
/** |slip ratio| > 1 means the tire has lost grip (Forza Data Out docs). */
export const SLIP_LIMIT = 1;
/**
 * Under ABS the fronts sit around −1…−2 for most of a hard stop (observed in FM2023),
 * so only slip beyond −2 counts as a lockup.
 */
export const LOCKUP_SLIP = 2;
export const PART_THROTTLE = 0.7;
export const PART_THROTTLE_MIN_M = 25;
export const PART_THROTTLE_MIN_KMH = 80;

export interface CornerDef {
  id: string; // "T1"
  index: number;
  zoneStart: number; // m, first brake / start of speed drop
  zoneEnd: number; // m, end of braking / speed drop
  apex: number; // m, min speed location on the reference lap
  segStart: number;
  segEnd: number; // may be < segStart for the wrapping last corner
  wraps: boolean;
}

export interface CornerMetrics {
  id: string;
  brakePoint: number | null; // m; null = lift / no brake
  peakBrake: number;
  entrySpeed: number; // km/h at brake point (or zone start)
  minSpeed: number;
  minSpeedAt: number;
  throttlePickup: number | null; // m
  exitSpeed: number; // km/h 100 m after the min-speed point
  segmentTime: number; // s
  lockupM: number; // meters with brake on and a wheel beyond LOCKUP_SLIP (negative slip)
  wheelspinM: number; // meters on throttle with a driven wheel beyond the slip limit
}

function smooth(src: Float64Array, half: number): Float64Array {
  const out = new Float64Array(src.length);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < src.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(src.length - 1, i + half);
    while (hi < b) sum += src[++hi]!;
    while (lo < a) sum -= src[lo++]!;
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

export function detectCorners(ref: Grid): CornerDef[] {
  const n = ref.speed.length;
  const step = ref.step;
  const zones: [number, number][] = [];

  // Braking zones
  for (let i = 0; i < n; ) {
    if (ref.brake[i]! > BRAKE_ON) {
      let j = i;
      while (j + 1 < n && ref.brake[j + 1]! > BRAKE_ON) j++;
      if ((j - i) * step >= 3) zones.push([i, j]);
      i = j + 1;
    } else i++;
  }

  // Sustained speed drops (lifts): local max → following local min with ≥ LIFT_DROP_KMH drop
  const sp = smooth(ref.speed, Math.round(5 / step));
  let peak = 0;
  for (let i = 1; i < n; i++) {
    if (sp[i]! > sp[peak]!) peak = i;
    const falling = sp[i]! < sp[i - 1]!;
    const nextRising = i + 1 < n && sp[i + 1]! >= sp[i]!;
    if (falling && nextRising) {
      if (sp[peak]! - sp[i]! >= LIFT_DROP_KMH) zones.push([peak, i]);
      peak = i;
    }
  }

  // Sustained part-throttle (fast kinks)
  for (let i = 0; i < n; ) {
    if (ref.throttle[i]! < PART_THROTTLE && ref.brake[i]! <= BRAKE_ON && ref.speed[i]! > PART_THROTTLE_MIN_KMH) {
      let j = i;
      while (j + 1 < n && ref.throttle[j + 1]! < PART_THROTTLE && ref.brake[j + 1]! <= BRAKE_ON && ref.speed[j + 1]! > PART_THROTTLE_MIN_KMH) j++;
      if ((j - i) * step >= PART_THROTTLE_MIN_M) zones.push([i, j]);
      i = j + 1;
    } else i++;
  }

  // Merge overlapping / close zones
  zones.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const z of zones) {
    const last = merged[merged.length - 1];
    if (last && (z[0] - last[1]) * step < MERGE_GAP_M) last[1] = Math.max(last[1], z[1]);
    else merged.push([z[0], z[1]]);
  }

  // apex: min speed from zone start until the next zone (bounded to 150 m past the zone)
  const withApex = merged.map(([a, b], k) => {
    const nextStart = k + 1 < merged.length ? merged[k + 1]![0] : n - 1;
    const lim = Math.min(nextStart, b + Math.round(150 / step));
    let apex = a;
    for (let i = a; i <= lim; i++) if (ref.speed[i]! < ref.speed[apex]!) apex = i;
    return { a, b, apex };
  });

  // Drop partial zones whose apex touches the lap start/end
  const edge = Math.round(20 / step);
  const kept = withApex.filter((z) => z.apex > edge && z.apex < n - 1 - edge);

  const defs: CornerDef[] = kept.map(({ a, b, apex }, k) => ({
    id: `T${k + 1}`, index: k, zoneStart: a * step, zoneEnd: b * step, apex: apex * step, segStart: 0, segEnd: 0, wraps: false,
  }));

  for (let k = 0; k < defs.length; k++) {
    const d = defs[k]!;
    d.segStart = k === 0 ? Math.max(0, d.zoneStart - SEGMENT_LEAD_M) : Math.max(defs[k - 1]!.apex + 10, d.zoneStart - SEGMENT_LEAD_M);
  }
  for (let k = 0; k < defs.length; k++) {
    const d = defs[k]!;
    const last = k === defs.length - 1;
    d.segEnd = last ? defs[0]!.segStart : defs[k + 1]!.segStart;
    d.wraps = last;
  }
  return defs;
}

function idx(g: Grid, d: number) {
  return Math.min(g.speed.length - 1, Math.max(0, Math.round(d / g.step)));
}

function segmentTime(g: Grid, c: CornerDef, lapTime?: number): number {
  const ts = at(g, g.t, c.segStart);
  if (!c.wraps) return at(g, g.t, c.segEnd) - ts;
  const total = lapTime ?? g.t[g.t.length - 1]!;
  return total - ts + at(g, g.t, c.segEnd);
}

/** Driven wheels for DrivetrainType 0 FWD, 1 RWD, 2 AWD. */
function drivenWheels(drivetrain: number): number[] {
  return drivetrain === 0 ? [0, 1] : drivetrain === 1 ? [2, 3] : [0, 1, 2, 3];
}

export function measureCorner(g: Grid, c: CornerDef, next: CornerDef | undefined, drivetrain: number, lapTime?: number): CornerMetrics {
  const step = g.step;
  // Search windows anchored on the reference corner.
  const nextZone = next && !c.wraps ? next.zoneStart : g.length;
  const bLo = idx(g, Math.max(c.segStart, c.zoneStart - 120));
  const bHi = idx(g, c.apex);
  let brakeIdx: number | null = null;
  for (let i = bLo; i <= bHi; i++) if (g.brake[i]! > BRAKE_ON) { brakeIdx = i; break; }

  const mLo = idx(g, Math.max(c.segStart, c.zoneStart - 30));
  const mHi = idx(g, Math.min(nextZone - 10, c.apex + 80));
  let minIdx = mLo;
  for (let i = mLo; i <= mHi; i++) if (g.speed[i]! < g.speed[minIdx]!) minIdx = i;

  let peakBrake = 0;
  let brakeEnd = brakeIdx;
  if (brakeIdx !== null) {
    for (let i = brakeIdx; i <= Math.max(minIdx, bHi); i++) {
      peakBrake = Math.max(peakBrake, g.brake[i]!);
      if (g.brake[i]! > BRAKE_ON) brakeEnd = i;
    }
  }

  let pickup: number | null = null;
  const pLo = brakeEnd ?? Math.max(mLo, minIdx - Math.round(60 / step));
  const pHi = idx(g, Math.min(nextZone, c.apex + 150));
  for (let i = pLo; i <= pHi; i++) {
    if (g.throttle[i]! >= THROTTLE_PICKUP && g.brake[i]! < 0.05) {
      pickup = i * step;
      break;
    }
  }

  const sLo = idx(g, c.segStart);
  const sHi = c.wraps ? g.speed.length - 1 : idx(g, c.segEnd);
  const driven = drivenWheels(drivetrain);
  let lockup = 0;
  let spin = 0;
  for (let i = sLo; i <= sHi; i++) {
    if (g.brake[i]! > BRAKE_ON && g.slip.some((s) => s[i]! < -LOCKUP_SLIP)) lockup += step;
    if (g.throttle[i]! > 0.3 && g.brake[i]! < 0.05 && driven.some((w) => g.slip[w]![i]! > SLIP_LIMIT)) spin += step;
  }

  const entryIdx = brakeIdx ?? idx(g, c.zoneStart);
  return {
    id: c.id,
    brakePoint: brakeIdx === null ? null : brakeIdx * step,
    peakBrake,
    entrySpeed: g.speed[entryIdx]!,
    minSpeed: g.speed[minIdx]!,
    minSpeedAt: minIdx * step,
    throttlePickup: pickup,
    exitSpeed: at(g, g.speed, minIdx * step + EXIT_AFTER_APEX_M),
    segmentTime: segmentTime(g, c, lapTime),
    lockupM: lockup,
    wheelspinM: spin,
  };
}

export function measureLap(g: Grid, corners: CornerDef[], drivetrain: number, lapTime?: number): CornerMetrics[] {
  return corners.map((c, k) => measureCorner(g, c, corners[k + 1], drivetrain, lapTime));
}
