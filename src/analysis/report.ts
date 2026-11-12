/**
 * High-level analyses returned by the MCP tools. Everything here returns compact
 * JSON plus a short plain-language `summary`.
 */
import type { DB } from "../store/db.js";
import { getLapInfo, loadGrid, at, timeDelta, type Grid, type LapInfo } from "./grid.js";
import { detectCorners, measureLap, SLIP_LIMIT, type CornerDef, type CornerMetrics } from "./corners.js";
import { median } from "../store/store.js";

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const sgn = (x: number, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
export const fmtLap = (s: number | null | undefined) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

// ---------------------------------------------------------------- reference

/** Fastest complete, non-suspect lap for the lap's track (falls back to its session). */
export function referenceLapId(db: DB, lap: LapInfo): number | null {
  const row =
    lap.track_ordinal !== null
      ? db
          .prepare(
            `SELECT l.id FROM laps l JOIN sessions s ON s.id = l.session_id
             WHERE s.track_ordinal = ? AND l.is_complete = 1 AND l.is_suspect = 0
             ORDER BY l.lap_time_s, l.id LIMIT 1`,
          )
          .get(lap.track_ordinal)
      : db
          .prepare(`SELECT id FROM laps WHERE session_id = ? AND is_complete = 1 AND is_suspect = 0 ORDER BY lap_time_s, id LIMIT 1`)
          .get(lap.session_id);
  return (row as { id: number } | undefined)?.id ?? null;
}

const cornerCache = new Map<number, CornerDef[]>();
/** Corner layout for the lap's track, numbered on the reference lap. */
export function cornersFor(db: DB, lap: LapInfo): { refLapId: number; corners: CornerDef[] } {
  const refId = referenceLapId(db, lap) ?? lap.id;
  let corners = cornerCache.get(refId);
  if (!corners) {
    corners = detectCorners(loadGrid(db, refId));
    cornerCache.set(refId, corners);
  }
  return { refLapId: refId, corners };
}

function requireLap(db: DB, id: number): LapInfo {
  const lap = getLapInfo(db, id);
  if (!lap) throw new Error(`lap ${id} not found`);
  return lap;
}

function sessionLaps(db: DB, sessionId: number): LapInfo[] {
  const ids = db.prepare(`SELECT id FROM laps WHERE session_id = ? ORDER BY id`).all(sessionId) as { id: number }[];
  return ids.map((r) => requireLap(db, r.id));
}

// ---------------------------------------------------------------- lap summary

export function lapSummary(db: DB, lapId: number) {
  const lap = requireLap(db, lapId);
  const g = loadGrid(db, lapId);
  const { refLapId, corners } = cornersFor(db, lap);
  const metrics = measureLap(g, corners, lap.drivetrain, lap.lap_time_s ?? undefined);
  let maxSpeed = 0, fullThrottle = 0, braking = 0, coasting = 0, brakeFull = 0, brakeOverLimit = 0;
  for (let i = 0; i < g.speed.length; i++) {
    maxSpeed = Math.max(maxSpeed, g.speed[i]!);
    if (g.throttle[i]! > 0.98) fullThrottle++;
    if (g.brake[i]! > 0.15) {
      braking++;
      if (g.brake[i]! > 0.98) brakeFull++;
      if (Math.min(g.slip[0][i]!, g.slip[1][i]!) < -SLIP_LIMIT) brakeOverLimit++;
    }
    if (g.throttle[i]! < 0.1 && g.brake[i]! < 0.05) coasting++;
  }
  const n = g.speed.length;
  const lockups = metrics.filter((m) => m.lockupM >= 5).map((m) => `${m.id} (${m.lockupM} m)`);
  const spins = metrics.filter((m) => m.wheelspinM >= 5).map((m) => `${m.id} (${m.wheelspinM} m)`);
  return {
    lap_id: lap.id,
    session_id: lap.session_id,
    lap_number: lap.lap_number,
    lap_time_s: lap.lap_time_s,
    is_complete: !!lap.is_complete,
    is_suspect: !!lap.is_suspect,
    had_rewind: !!lap.had_rewind,
    distance_m: Math.round(g.length),
    reference_lap_id: refLapId,
    max_speed_kmh: r1(maxSpeed),
    pct_full_throttle: r1((100 * fullThrottle) / n),
    pct_braking: r1((100 * braking) / n),
    pct_coasting: r1((100 * coasting) / n),
    // share of braking distance at 100% pedal, and with the fronts past the grip limit (ABS working)
    pct_braking_at_full: braking ? r1((100 * brakeFull) / braking) : 0,
    pct_braking_fronts_over_limit: braking ? r1((100 * brakeOverLimit) / braking) : 0,
    corners: metrics.map(compactMetrics),
    summary:
      `Lap ${lap.lap_number} ${fmtLap(lap.lap_time_s)}${lap.is_complete ? "" : " (incomplete)"}: top ${maxSpeed.toFixed(0)} km/h, ` +
      `${((100 * fullThrottle) / n).toFixed(0)}% full throttle, ${((100 * coasting) / n).toFixed(0)}% coasting, ${corners.length} corners.` +
      (lockups.length ? ` Lockups: ${lockups.join(", ")}.` : "") +
      (spins.length ? ` Wheelspin: ${spins.join(", ")}.` : ""),
  };
}

function compactMetrics(m: CornerMetrics) {
  return {
    id: m.id,
    brake_m: m.brakePoint === null ? null : Math.round(m.brakePoint),
    peak_brake: r2(m.peakBrake),
    entry_kmh: r1(m.entrySpeed),
    min_kmh: r1(m.minSpeed),
    min_at_m: Math.round(m.minSpeedAt),
    throttle_m: m.throttlePickup === null ? null : Math.round(m.throttlePickup),
    exit_kmh: r1(m.exitSpeed),
    time_s: r3(m.segmentTime),
    lockup_m: m.lockupM,
    wheelspin_m: m.wheelspinM,
  };
}

// ---------------------------------------------------------------- compare

export interface CornerDiff {
  id: string;
  time_delta_s: number; // + = lap B slower in this corner
  brake_delta_m: number | null; // + = B brakes later
  entry_delta_kmh: number;
  min_delta_kmh: number;
  min_at_delta_m: number;
  throttle_delta_m: number | null; // + = B picks up throttle later
  exit_delta_kmh: number;
  lockup_m_b: number;
  wheelspin_m_b: number;
  off_line_m_b: number;
  note: string;
}

export function diffCorner(a: Measured, b: Measured): CornerDiff {
  const dt = b.segmentTime - a.segmentTime;
  const db_ = a.brakePoint !== null && b.brakePoint !== null ? b.brakePoint - a.brakePoint : null;
  const dtp = a.throttlePickup !== null && b.throttlePickup !== null ? b.throttlePickup - a.throttlePickup : null;
  const parts: string[] = [];
  if (db_ !== null && Math.abs(db_) >= 5) parts.push(`braked ${Math.abs(db_).toFixed(0)} m ${db_ < 0 ? "earlier" : "later"}`);
  else if (a.brakePoint === null && b.brakePoint !== null) parts.push("braked where the reference only lifted");
  else if (a.brakePoint !== null && b.brakePoint === null) parts.push("lifted where the reference braked");
  if (Math.abs(b.minSpeed - a.minSpeed) >= 2) parts.push(`min speed ${sgn(b.minSpeed - a.minSpeed)} km/h`);
  if (dtp !== null && Math.abs(dtp) >= 10) parts.push(`throttle ${Math.abs(dtp).toFixed(0)} m ${dtp > 0 ? "later" : "earlier"}`);
  if (Math.abs(b.exitSpeed - a.exitSpeed) >= 3) parts.push(`exit ${sgn(b.exitSpeed - a.exitSpeed)} km/h`);
  if (b.lockupM >= 5 && b.lockupM > a.lockupM + 3) parts.push(`locked up ${b.lockupM} m`);
  if (b.wheelspinM >= 5 && b.wheelspinM > a.wheelspinM + 3) parts.push(`wheelspin ${b.wheelspinM} m`);
  if (b.offLineM >= OFF_LINE_M && b.offLineM > a.offLineM + 3) parts.push(`${b.offLineM.toFixed(0)} m off the reference line`);
  const verdict = Math.abs(dt) < 0.02 ? "even" : `${dt > 0 ? "lost" : "gained"} ${Math.abs(dt).toFixed(2)} s`;
  return {
    id: a.id,
    time_delta_s: r3(dt),
    brake_delta_m: db_ === null ? null : Math.round(db_),
    entry_delta_kmh: r1(b.entrySpeed - a.entrySpeed),
    min_delta_kmh: r1(b.minSpeed - a.minSpeed),
    min_at_delta_m: Math.round(b.minSpeedAt - a.minSpeedAt),
    throttle_delta_m: dtp === null ? null : Math.round(dtp),
    exit_delta_kmh: r1(b.exitSpeed - a.exitSpeed),
    lockup_m_b: b.lockupM,
    wheelspin_m_b: b.wheelspinM,
    off_line_m_b: r1(b.offLineM),
    note: `${a.id}: ${parts.length ? parts.join(", ") + ", " : ""}${verdict}`,
  };
}

/** A corner where the car strays this far from the reference line is "off line" (ran wide / off track / cut). */
export const OFF_LINE_M = 8;

/** Max distance (m) of lap g's path from the reference path over [lo, hi), sampled every 5 m. */
export function maxLineOffset(g: Grid, ref: Grid, lo: number, hi: number): number {
  let worst = 0;
  const n = Math.min(g.x.length, ref.x.length);
  for (let d = Math.max(0, Math.round(lo)); d < Math.min(n, Math.round(hi)); d += 5) {
    let best = Infinity;
    for (let j = Math.max(0, d - 80); j < Math.min(ref.x.length, d + 80); j++) {
      const v = Math.hypot(g.x[d]! - ref.x[j]!, g.z[d]! - ref.z[j]!);
      if (v < best) best = v;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

export type Measured = CornerMetrics & { offLineM: number };

export function measured(db: DB, lap: LapInfo, corners: CornerDef[], refLapId: number): { grid: Grid; metrics: Measured[] } {
  const grid = loadGrid(db, lap.id);
  const ref = refLapId === lap.id ? grid : loadGrid(db, refLapId);
  const metrics = measureLap(grid, corners, lap.drivetrain, lap.lap_time_s ?? undefined).map((m, k) => {
    const c = corners[k]!;
    const off = ref === grid ? 0 : c.wraps
      ? Math.max(maxLineOffset(grid, ref, c.segStart, grid.length), maxLineOffset(grid, ref, 0, c.segEnd))
      : maxLineOffset(grid, ref, c.segStart, c.segEnd);
    return { ...m, offLineM: off };
  });
  return { grid, metrics };
}

/** Corner-by-corner comparison of lap B against lap A (A is the baseline). */
export function compareLaps(db: DB, lapA: number, lapB: number) {
  const a = requireLap(db, lapA);
  const b = requireLap(db, lapB);
  if (a.track_ordinal !== b.track_ordinal) throw new Error("laps are on different tracks");
  const { refLapId, corners } = cornersFor(db, a);
  const ma = measured(db, a, corners, refLapId);
  const mb = measured(db, b, corners, refLapId);
  const diffs = corners.map((_, k) => diffCorner(ma.metrics[k]!, mb.metrics[k]!));
  const total = a.lap_time_s !== null && b.lap_time_s !== null ? b.lap_time_s - a.lap_time_s : null;
  const delta = timeDelta(ma.grid, mb.grid);
  const ranked = [...diffs].sort((x, y) => y.time_delta_s - x.time_delta_s);
  const losses = ranked.filter((d) => d.time_delta_s >= 0.05).slice(0, 3);
  const gains = [...ranked].reverse().filter((d) => d.time_delta_s <= -0.05).slice(0, 2);
  return {
    lap_a: { id: a.id, lap_number: a.lap_number, lap_time_s: a.lap_time_s },
    lap_b: { id: b.id, lap_number: b.lap_number, lap_time_s: b.lap_time_s },
    reference_lap_id: refLapId,
    total_delta_s: total === null ? null : r3(total),
    // delta curve at 100 m steps — enough to see where the gap opens up
    delta_curve: Array.from({ length: Math.floor((delta.dist.length - 1) / 100) + 1 }, (_, k) => ({
      m: k * 100,
      delta_s: r3(delta.delta[k * 100]!),
    })),
    corners: diffs,
    summary:
      `Lap ${b.lap_number} (${fmtLap(b.lap_time_s)}) vs lap ${a.lap_number} (${fmtLap(a.lap_time_s)})` +
      (total === null ? "" : `: ${sgn(total, 3)} s`) +
      `. ${losses.length ? "Biggest losses — " + losses.map((d) => d.note).join("; ") + "." : "No corner lost more than 0.05 s."}` +
      (gains.length ? ` Gains — ${gains.map((d) => d.note).join("; ")}.` : ""),
  };
}

// ---------------------------------------------------------------- session

/**
 * For each corner, the index of the lap with the fastest clean segment: skips off-line corners and
 * corners whose "gain" was paid back by going off in the next one. Falls back to `fallback`.
 */
export function bestSegmentLaps(perLap: Measured[][], fallback: number): number[] {
  const nCorners = perLap[0]?.length ?? 0;
  return Array.from({ length: nCorners }, (_, k) => {
    let bi = -1;
    perLap.forEach((m, li) => {
      const c = m[k]!;
      const next = m[(k + 1) % m.length]!;
      const clean = c.offLineM < OFF_LINE_M && next.offLineM < OFF_LINE_M;
      if (clean && (bi < 0 || c.segmentTime < perLap[bi]![k]!.segmentTime)) bi = li;
    });
    return bi < 0 ? fallback : bi;
  });
}

function completeLaps(db: DB, sessionId: number, includeSuspect = false) {
  return sessionLaps(db, sessionId).filter((l) => l.is_complete && (includeSuspect || !l.is_suspect));
}

/** Best lap vs the median lap of the session, corners ranked by time lost. */
export function whereAmILosingTime(db: DB, sessionId: number) {
  const laps = completeLaps(db, sessionId);
  if (laps.length < 2) throw new Error("need at least two complete laps in the session");
  const sorted = [...laps].sort((x, y) => x.lap_time_s! - y.lap_time_s!);
  const best = sorted[0]!;
  const medTime = median(laps.map((l) => l.lap_time_s!))!;
  // the "median lap" is the actual lap closest to the median time (excluding the best)
  const medianLap = sorted.slice(1).reduce((p, c) => (Math.abs(c.lap_time_s! - medTime) < Math.abs(p.lap_time_s! - medTime) ? c : p));
  const cmp = compareLaps(db, best.id, medianLap.id);
  const { corners, refLapId } = cornersFor(db, best);

  // theoretical best: sum of the fastest on-line segment per corner across complete laps
  const perLap = laps.map((l) => measured(db, l, corners, refLapId).metrics);
  const bestFrom = bestSegmentLaps(perLap, laps.indexOf(best));
  const optimal = bestFrom.reduce((s, li, k) => s + perLap[li]![k]!.segmentTime, 0);
  const bestSegments = corners.map((c, k) => {
    const li = bestFrom[k]!;
    const gain = perLap[laps.indexOf(best)]![k]!.segmentTime - perLap[li]![k]!.segmentTime;
    return { id: c.id, from_lap: laps[li]!.lap_number, from_lap_id: laps[li]!.id, gain_vs_best_s: r3(gain) };
  });

  const ranked = [...cmp.corners].sort((x, y) => y.time_delta_s - x.time_delta_s);
  return {
    session_id: sessionId,
    best_lap: { id: best.id, lap_number: best.lap_number, lap_time_s: best.lap_time_s },
    median_lap: { id: medianLap.id, lap_number: medianLap.lap_number, lap_time_s: medianLap.lap_time_s },
    median_time_s: r3(medTime),
    theoretical_best_s: r3(optimal),
    gap_to_theoretical_s: r3(best.lap_time_s! - optimal),
    // where the theoretical best comes from (corners another lap did faster than your best lap)
    best_segments: bestSegments.filter((b) => b.gain_vs_best_s > 0.02).sort((x, y) => y.gain_vs_best_s - x.gain_vs_best_s),
    ranked_losses: ranked.map((d) => ({ id: d.id, lost_s: d.time_delta_s, note: d.note })),
    summary:
      `Best ${fmtLap(best.lap_time_s)}, median ${fmtLap(medTime)}, theoretical best ${fmtLap(optimal)} ` +
      `(${(best.lap_time_s! - optimal).toFixed(2)} s left in your best lap). Median vs best loses most in: ` +
      ranked.filter((d) => d.time_delta_s > 0.02).slice(0, 3).map((d) => d.note).join("; ") + ".",
  };
}

export const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

/** Lap-to-lap variance per corner. */
export function consistencyReport(db: DB, sessionId: number, includeSuspect = false) {
  const laps = completeLaps(db, sessionId, includeSuspect);
  if (laps.length < 2) throw new Error("need at least two complete laps in the session");
  const { corners, refLapId } = cornersFor(db, laps[0]!);
  const perLap = laps.map((l) => measured(db, l, corners, refLapId).metrics);
  const rows = corners.map((c, k) => {
    const ms = perLap.map((m) => m[k]!);
    const bps = ms.map((m) => m.brakePoint).filter((x): x is number => x !== null);
    const times = ms.map((m) => m.segmentTime);
    return {
      id: c.id,
      time_sd_s: r3(sd(times)),
      time_range_s: r3(Math.max(...times) - Math.min(...times)),
      min_speed_sd_kmh: r1(sd(ms.map((m) => m.minSpeed))),
      brake_point_sd_m: bps.length >= 2 ? r1(sd(bps)) : null,
      exit_speed_sd_kmh: r1(sd(ms.map((m) => m.exitSpeed))),
      lockup_laps: ms.filter((m) => m.lockupM >= 5).length,
      off_line_laps: ms.filter((m) => m.offLineM >= OFF_LINE_M).length,
      wheelspin_laps: ms.filter((m) => m.wheelspinM >= 5).length,
    };
  });
  const worst = [...rows].sort((a, b) => b.time_sd_s - a.time_sd_s).slice(0, 3);
  const lapTimes = laps.map((l) => l.lap_time_s!);
  return {
    session_id: sessionId,
    laps_used: laps.map((l) => ({ id: l.id, lap_number: l.lap_number, lap_time_s: l.lap_time_s })),
    lap_time_sd_s: r3(sd(lapTimes)),
    corners: rows,
    summary:
      `${laps.length} laps, lap time spread ${(Math.max(...lapTimes) - Math.min(...lapTimes)).toFixed(2)} s (sd ${sd(lapTimes).toFixed(2)} s). ` +
      `Least consistent: ${worst.map((w) => `${w.id} (±${w.time_sd_s.toFixed(2)} s, brake point ±${w.brake_point_sd_m ?? "–"} m, min speed ±${w.min_speed_sd_kmh} km/h)`).join("; ")}.`,
  };
}

/** Downsampled trace of a lap segment (for the MCP get_lap_trace tool and the dashboard). */
export function lapTrace(db: DB, lapId: number, startM = 0, endM?: number, stepM = 5) {
  requireLap(db, lapId);
  const g = loadGrid(db, lapId);
  const end = Math.min(endM ?? g.length, g.length);
  const pts = [];
  for (let d = Math.max(0, startM); d <= end; d += stepM) {
    pts.push({
      m: Math.round(d),
      t: r3(at(g, g.t, d)),
      kmh: r1(at(g, g.speed, d)),
      thr: r2(at(g, g.throttle, d)),
      brk: r2(at(g, g.brake, d)),
      steer: r2(at(g, g.steer, d)),
      gear: at(g, g.gear, d),
      rpm: Math.round(at(g, g.rpm, d)),
      x: r1(at(g, g.x, d)),
      z: r1(at(g, g.z, d)),
    });
  }
  return { lap_id: lapId, start_m: startM, end_m: Math.round(end), step_m: stepM, points: pts };
}
