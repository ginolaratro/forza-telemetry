/**
 * Live coach: consumes the pipeline's samples/events as they happen and emits
 * dashboard messages.
 *
 *  - frame     ~20 Hz: inputs, speed, live delta to the reference lap (by distance), predicted lap time,
 *              current/next corner with the reference's brake point and minimum speed.
 *  - callout   once per corner, as soon as the car is far enough past it to measure: time gained/lost
 *              and one concrete instruction (same corner metrics as the MCP analysis).
 *  - cue       before a corner where the previous lap lost time: the instruction again, ahead of the
 *              braking zone, so it can be spoken in time.
 *  - frame.next.mark_in_s  time to the reference brake (or lift) point; frames go to every sample
 *              (~60 Hz) in the last MARK_DENSE_S so the dashboard can time its countdown beeps.
 *  - brake_hit when the driver first brakes near a marker: metres early/late vs the reference.
 *  - lockup    a wheel locked under braking (rate limited) — "ease off" while it is still happening.
 *  - lap       on every completed lap: time vs reference, biggest losses, focus for the next lap and the
 *              session's theoretical best from the best segment per corner.
 *
 * Reference = fastest clean complete lap on this track in this car (falls back to any car on the track).
 */
import type { DB } from "../store/db.js";
import type { SampleRow } from "../store/store.js";
import type { Telemetry } from "../listener/parser.js";
import type { PipelineEvent } from "../listener/pipeline.js";
import { getLapInfo, loadGrid, loadSamples, resample, type Grid, type LapInfo, type RawSample } from "../analysis/grid.js";
import { BRAKE_ON, detectCorners, LOCKUP_SLIP, measureCorner, type CornerDef } from "../analysis/corners.js";
import { diffCorner, fmtLap, maxLineOffset, OFF_LINE_M, referenceLapId, type CornerDiff, type Measured } from "../analysis/report.js";

export const FRAME_INTERVAL_MS = 50;
/** Distance past the apex needed before a corner can be fully measured (min-speed search + exit speed). */
const MEASURE_AFTER_APEX_M = 190;
/** Seconds of warning before the braking zone for a spoken cue. */
const CUE_LEAD_S = 3.5; // finishes speaking before the brake countdown beeps start
/** Send every sample (not 20 Hz) when the brake marker is this close in time. */
const MARK_DENSE_S = 2;
/** A brake application this far before / after the marker counts as aimed at it. */
const MARK_EARLY_WINDOW_M = 120;
const MARK_LATE_WINDOW_M = 80;
/** |offset| within this is "on the marker". */
const MARK_ON_M = 5;
/** Brake must stay on this long to count — a dab to settle the car isn't the braking point. */
const MARK_HOLD_MS = 120;
const LOCKUP_SAMPLES = 3;
const LOCKUP_REPEAT_MS = 1500;
const LOSS_S = 0.05;
const TRACE_STEP_M = 10;
/** Laps slower than this × reference don't feed the theoretical best. */
const THEORETICAL_MAX_FACTOR = 1.07;
/** Tips too vague to be worth a spoken cue before the corner. */
const VAGUE_TIP = /^(Small losses|Off the reference line|Matched)/;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface Reference {
  lapId: number;
  lapNumber: number;
  sessionId: number;
  lapTime: number;
  sameCar: boolean;
  grid: Grid;
  corners: CornerDef[];
  metrics: Measured[];
}

export interface CornerResult {
  id: string;
  index: number;
  lap_id: number;
  lap_number: number;
  time_delta_s: number; // + = slower than reference
  severity: "gain" | "even" | "loss";
  tip: string;
  speak: string;
  note: string;
  segment_time_s: number;
  off_line: boolean;
  diff: CornerDiff;
}

export interface Frame {
  type: "frame";
  lap_id: number;
  lap_number: number;
  is_outlap: boolean;
  lap_time_s: number;
  dist_m: number;
  speed_kmh: number;
  gear: number;
  rpm: number;
  rpm_max: number;
  throttle: number;
  brake: number;
  steer: number;
  x: number;
  z: number;
  delta_s: number | null;
  predicted_s: number | null;
  ref_lap_s: number | null;
  last_lap_s: number | null;
  best_lap_s: number | null;
  race_position: number | null;
  fuel: number | null;
  tire_temp_c: number[] | null;
  corner: string | null;
  next: {
    id: string;
    to_zone_m: number;
    ref_brake_in_m: number | null; // null = reference only lifts
    ref_min_kmh: number;
    ref_gear: number;
    last: { time_delta_s: number; tip: string } | null;
    /** The marker to hit: the reference's brake point, or where it lifts when it doesn't brake. */
    mark_kind: "brake" | "lift";
    mark_in_m: number;
    /** Seconds to the marker at the current speed and acceleration; null when not approaching. */
    mark_in_s: number | null;
  } | null;
}

export interface BrakeHit {
  id: string;
  lap_id: number;
  /** + = braked later than the reference, − = earlier. */
  offset_m: number;
  verdict: "early" | "on" | "late";
}

export type CoachMessage =
  | Frame
  | { type: "session"; session_id: number; car_ordinal: number; car_class: number; car_pi: number; track_ordinal: number | null }
  | { type: "session_end"; session_id: number }
  | ReturnType<typeof referenceMessage>
  | { type: "no_reference" }
  | { type: "lap_start"; lap_id: number; lap_number: number; is_outlap: boolean; has_reference: boolean }
  | ({ type: "callout" } & CornerResult)
  | { type: "cue"; id: string; tip: string; speak: string }
  | ({ type: "brake_hit" } & BrakeHit)
  | { type: "lockup"; lap_id: number; dist_m: number; wheels: "front" | "rear" | "all"; corner: string | null }
  | ({ type: "lap" } & LapReport)
  | { type: "rewind"; lap_id: number; lap_number: number; dist_m: number };

export interface LapReport {
  lap_id: number;
  lap_number: number;
  lap_time_s: number;
  reference_lap_id: number | null;
  reference_lap_s: number | null;
  delta_s: number | null;
  session_best_s: number | null;
  theoretical_best_s: number | null;
  losses: { id: string; time_delta_s: number; tip: string }[];
  gains: { id: string; time_delta_s: number; note: string }[];
  focus: { id: string; tip: string } | null;
  brake_marks: { id: string; offset_m: number; verdict: BrakeHit["verdict"] }[];
  summary: string;
}

interface LapState {
  info: LapInfo;
  samples: RawSample[];
  results: (CornerResult | null)[];
  cued: Set<string>;
  trace: [number, number][]; // [dist, delta] every TRACE_STEP_M
  lastFrameT: number;
  marks: Map<string, BrakeHit>;
  braking: boolean;
  /** Onset of the current brake application, until it has been held long enough to judge. */
  brakeOn: { d: number; t: number } | null;
  lockSamples: number;
  lastLockT: number;
}

const newLapState = (info: LapInfo, samples: RawSample[] = []): LapState => ({
  info, samples, results: [], cued: new Set(), trace: [], lastFrameT: -Infinity,
  marks: new Map(), braking: false, brakeOn: null, lockSamples: 0, lastLockT: -Infinity,
});

function referenceMessage(ref: Reference) {
  const g = ref.grid;
  const map: [number, number][] = [];
  for (let d = 0; d <= g.length; d += 5) map.push([r1(g.x[d]!), r1(g.z[d]!)]);
  return {
    type: "reference" as const,
    lap_id: ref.lapId,
    lap_number: ref.lapNumber,
    session_id: ref.sessionId,
    lap_time_s: ref.lapTime,
    same_car: ref.sameCar,
    length_m: Math.round(g.length),
    map,
    corners: ref.corners.map((c, k) => ({
      id: c.id,
      zone_start: c.zoneStart,
      apex: c.apex,
      seg_start: c.segStart,
      seg_end: c.segEnd,
      wraps: c.wraps,
      x: r1(g.x[c.apex]!),
      z: r1(g.z[c.apex]!),
      ref_brake_m: ref.metrics[k]!.brakePoint,
      ref_min_kmh: r1(ref.metrics[k]!.minSpeed),
    })),
  };
}

/** One instruction for a corner: the biggest, most actionable difference from the reference. */
export function coachTip(ref: Measured, live: Measured, d: CornerDiff): { tip: string; speak: string } {
  const dt = d.time_delta_s;
  const turn = `Turn ${live.id.slice(1)}`;
  const tenths = (x: number) => `${Math.abs(x).toFixed(1)}`;
  if (dt <= -LOSS_S) {
    const why =
      d.brake_delta_m !== null && d.brake_delta_m >= 5 ? `braked ${d.brake_delta_m} m later`
      : d.min_delta_kmh >= 2 ? `${d.min_delta_kmh.toFixed(0)} km/h more at the apex`
      : d.exit_delta_kmh >= 3 ? `better exit`
      : null;
    return { tip: `Faster than reference${why ? ` — ${why}` : ""}. Keep it.`, speak: `${turn}, gained ${tenths(dt)}.` };
  }
  if (dt < LOSS_S) return { tip: "Matched the reference.", speak: "" };

  const brake = d.brake_delta_m;
  let tip: string;
  if (live.lockupM >= 5 && live.lockupM > ref.lockupM + 3) {
    tip = brake !== null && brake >= 5 ? "Locked up braking late — brake earlier and softer" : "Locked up — ease off the brake pressure";
  } else if (live.offLineM >= OFF_LINE_M && (brake === null || brake >= 0 || d.entry_delta_kmh > 3)) {
    tip = brake !== null && brake >= 5 ? `Ran wide — brake ${brake} m earlier` : "Ran wide — slower entry, tighter line";
  } else if (brake !== null && brake <= -8) {
    tip = `Brake ${-brake} m later`;
  } else if (ref.brakePoint === null && live.brakePoint !== null) {
    tip = "Reference only lifts here — try a lift, not the brake";
  } else if (d.min_delta_kmh <= -3) {
    tip = `Carry ${(-d.min_delta_kmh).toFixed(0)} km/h more to the apex — release the brake earlier`;
  } else if (d.throttle_delta_m !== null && d.throttle_delta_m >= 10) {
    tip = `Back on the throttle ${d.throttle_delta_m} m sooner`;
  } else if (live.wheelspinM >= 5 && live.wheelspinM > ref.wheelspinM + 3) {
    tip = "Wheelspin on exit — feed the throttle in smoother";
  } else if (d.exit_delta_kmh <= -3) {
    tip = `Exit ${(-d.exit_delta_kmh).toFixed(0)} km/h slower — straighten the wheel earlier and get on power`;
  } else if (live.offLineM >= OFF_LINE_M) {
    tip = "Off the reference line";
  } else {
    tip = "Small losses everywhere — smoother through the whole corner";
  }
  return { tip, speak: `${turn}, lost ${tenths(dt)}. ${tip.replace(/ — .*/, "").replace(/(\d+) m\b/, "$1 metres")}.` };
}

export class LiveCoach {
  private listeners = new Set<(m: CoachMessage) => void>();
  private refCache = new Map<number, Reference>();
  private ref: Reference | null = null;
  private lap: LapState | null = null;
  private session: CoachMessage | null = null;
  private lastFrame: Frame | null = null;
  private lastReport: LapReport | null = null;
  private prevLap: { lap_id: number; trace: [number, number][]; results: CornerResult[] } | null = null;
  private recent: CoachMessage[] = [];
  /** Previous result per corner id (same reference) — drives the pre-corner cues. */
  private lastByCorner = new Map<string, CornerResult>();
  /** Best clean segment time per corner this session (same reference) — theoretical best. */
  private bestSeg = new Map<string, number>();
  private sessionBest: number | null = null;

  constructor(private db: DB) {}

  subscribe(fn: (m: CoachMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: CoachMessage) {
    if (m.type === "callout" || m.type === "lap" || m.type === "cue") {
      this.recent.push(m);
      if (this.recent.length > 30) this.recent.shift();
    }
    for (const fn of this.listeners) fn(m);
  }

  /** Everything a freshly connected dashboard needs to draw the current state. */
  snapshot() {
    return {
      type: "init" as const,
      session: this.session,
      reference: this.ref ? referenceMessage(this.ref) : null,
      lap: this.lap
        ? {
            lap_id: this.lap.info.id,
            lap_number: this.lap.info.lap_number,
            is_outlap: !!this.lap.info.is_outlap,
            results: this.lap.results.filter((r): r is CornerResult => r !== null),
            trace: this.lap.trace,
            marks: [...this.lap.marks.values()],
          }
        : null,
      prev_lap: this.prevLap,
      last_lap: this.lastReport,
      recent: this.recent,
      frame: this.lastFrame,
    };
  }

  // ------------------------------------------------------------ pipeline hooks

  event = (e: PipelineEvent): void => {
    if (e.type === "session_start") {
      const s = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(e.sessionId) as {
        id: number; car_ordinal: number; car_class: number; car_pi: number; track_ordinal: number | null;
      };
      this.session = { type: "session", session_id: s.id, car_ordinal: s.car_ordinal, car_class: s.car_class, car_pi: s.car_pi, track_ordinal: s.track_ordinal };
      this.lastByCorner.clear();
      this.bestSeg.clear();
      this.sessionBest = null;
      this.lastReport = null;
      this.prevLap = null;
      this.emit(this.session);
    } else if (e.type === "session_end") {
      this.lap = null;
      this.emit({ type: "session_end", session_id: e.sessionId });
    } else if (e.type === "lap_start") {
      this.startLap(e.lapId!);
    } else if (e.type === "lap_end") {
      if (e.complete && e.lapTimeS != null) this.finishLap(e.lapTimeS);
      if (this.lap && !this.lap.info.is_outlap) {
        this.prevLap = { lap_id: this.lap.info.id, trace: this.lap.trace, results: this.lap.results.filter((r): r is CornerResult => r !== null) };
      }
      this.lap = null;
    } else if (e.type === "rewind") {
      this.rewind(e.lapId!);
    }
  };

  sample = (row: SampleRow, t: Telemetry): void => {
    const lap = this.lap;
    if (!lap || lap.info.id !== row.lap_id) return;
    lap.samples.push(row);
    const d = row.dist_m;
    const ref = this.ref;
    const timed = !lap.info.is_outlap && ref !== null;

    let delta: number | null = null;
    if (timed && d >= 0 && d <= ref.grid.length) {
      delta = row.t_ms / 1000 - interp(ref.grid, d);
      const next = lap.trace.length ? lap.trace[lap.trace.length - 1]![0] + TRACE_STEP_M : 0;
      if (d >= next) lap.trace.push([Math.round(d), r3(delta)]);
    }

    if (timed) {
      this.finishCorners(false);
      this.maybeCue(d, row.speed_ms);
      this.checkBrakeMark(row);
    }
    this.checkLockup(row, timed ? ref : null);
    lap.braking = row.brake > BRAKE_ON;

    const f = this.frame(row, t, delta, timed ? ref : null);
    const s = f.next?.mark_in_s;
    const dense = s != null && s <= MARK_DENSE_S;
    if (dense || !this.lastFrame || Math.abs(row.t_ms - lap.lastFrameT) >= FRAME_INTERVAL_MS || this.lastFrame.lap_id !== lap.info.id) {
      lap.lastFrameT = row.t_ms;
      this.lastFrame = f;
      this.emit(f);
    }
  };

  /** First brake application near a corner's marker: how far from the reference brake point was it? */
  private checkBrakeMark(row: SampleRow) {
    const lap = this.lap!;
    const ref = this.ref!;
    if (row.brake <= BRAKE_ON) { lap.brakeOn = null; return; }
    if (!lap.braking) lap.brakeOn = { d: row.dist_m, t: row.t_ms };
    if (!lap.brakeOn || row.t_ms - lap.brakeOn.t < MARK_HOLD_MS) return;
    const d = lap.brakeOn.d;
    lap.brakeOn = null; // judged (or not near any marker)
    for (let k = 0; k < ref.corners.length; k++) {
      const c = ref.corners[k]!;
      const mark = ref.metrics[k]!.brakePoint;
      if (mark === null || lap.marks.has(c.id)) continue;
      const from = Math.max(mark - MARK_EARLY_WINDOW_M, k > 0 ? ref.corners[k - 1]!.apex + 10 : -Infinity);
      if (d < from || d > mark + MARK_LATE_WINDOW_M) continue;
      const off = Math.round(d - mark);
      const hit: BrakeHit = { id: c.id, lap_id: lap.info.id, offset_m: off, verdict: Math.abs(off) <= MARK_ON_M ? "on" : off < 0 ? "early" : "late" };
      lap.marks.set(c.id, hit);
      this.emit({ type: "brake_hit", ...hit });
      return;
    }
  }

  private checkLockup(row: SampleRow, ref: Reference | null) {
    const lap = this.lap!;
    const lim = -LOCKUP_SLIP;
    const front = row.slip_fl < lim || row.slip_fr < lim;
    const rear = row.slip_rl < lim || row.slip_rr < lim;
    lap.lockSamples = row.brake > BRAKE_ON && (front || rear) ? lap.lockSamples + 1 : 0;
    if (lap.lockSamples !== LOCKUP_SAMPLES || row.t_ms - lap.lastLockT < LOCKUP_REPEAT_MS) return;
    lap.lastLockT = row.t_ms;
    const d = row.dist_m;
    const corner = ref?.corners.find((c) => (c.wraps ? d >= c.segStart || d < c.segEnd : d >= c.segStart && d < c.segEnd))?.id ?? null;
    this.emit({ type: "lockup", lap_id: lap.info.id, dist_m: Math.round(d), wheels: front && rear ? "all" : front ? "front" : "rear", corner });
  }

  // ------------------------------------------------------------ laps

  private startLap(lapId: number) {
    const info = getLapInfo(this.db, lapId);
    if (!info) return;
    this.lap = newLapState(info);
    this.loadReference(info);
    this.emit({ type: "lap_start", lap_id: info.id, lap_number: info.lap_number, is_outlap: !!info.is_outlap, has_reference: !!this.ref });
  }

  private rewind(lapId: number) {
    const info = getLapInfo(this.db, lapId);
    if (!info) return;
    const samples = loadSamples(this.db, lapId);
    const old = this.lap?.info.id === lapId ? this.lap : null;
    this.lap = newLapState(info, samples);
    const lap = this.lap;
    const ref = this.ref;
    const rewoundTo = samples.length ? samples[samples.length - 1]!.dist_m : 0;
    // keep brake marks the car is still past; the ones after the rewind point get driven again
    if (old && ref) {
      for (const [id, hit] of old.marks) {
        const k = ref.corners.findIndex((c) => c.id === id);
        const mark = ref.metrics[k]?.brakePoint;
        if (mark != null && mark + MARK_LATE_WINDOW_M < rewoundTo) lap.marks.set(id, hit);
      }
    }
    if (ref && !info.is_outlap && samples.length >= 2) {
      // rebuild the delta trace and the corner results up to the rewind point, without re-announcing
      const g = resample(lapId, samples);
      for (let d = 0; d <= Math.min(g.length, ref.grid.length); d += TRACE_STEP_M) lap.trace.push([d, r3(g.t[d]! - interp(ref.grid, d))]);
      this.finishCorners(false, true);
    }
    const dist = samples.length ? samples[samples.length - 1]!.dist_m : 0;
    this.emit({ type: "rewind", lap_id: info.id, lap_number: info.lap_number, dist_m: Math.round(dist) });
  }

  /** Measure every corner the car is now far enough past. At lap end (`lapTime`), measure the rest incl. the wrap. */
  private finishCorners(atLapEnd: boolean, silent = false, lapTime?: number) {
    const lap = this.lap!;
    const ref = this.ref!;
    const d = lap.samples.length ? lap.samples[lap.samples.length - 1]!.dist_m : 0;
    let grid: Grid | null = null;
    for (let k = 0; k < ref.corners.length; k++) {
      if (lap.results[k]) continue;
      const c = ref.corners[k]!;
      const ready = atLapEnd || (!c.wraps && d >= Math.max(c.segEnd, c.apex + MEASURE_AFTER_APEX_M));
      if (!ready) continue;
      if (lap.samples.length < 2) return;
      grid ??= resample(lap.info.id, lap.samples);
      const res = this.measure(k, grid, lapTime);
      lap.results[k] = res;
      if (!silent) this.emit({ type: "callout", ...res });
    }
  }

  private measure(k: number, g: Grid, lapTime?: number): CornerResult {
    const ref = this.ref!;
    const lap = this.lap!;
    const c = ref.corners[k]!;
    const m = measureCorner(g, c, ref.corners[k + 1], lap.info.drivetrain, lapTime);
    const off = c.wraps
      ? Math.max(maxLineOffset(g, ref.grid, c.segStart, g.length), maxLineOffset(g, ref.grid, 0, c.segEnd))
      : maxLineOffset(g, ref.grid, c.segStart, c.segEnd);
    const live: Measured = { ...m, offLineM: off };
    const a = ref.metrics[k]!;
    const diff = diffCorner(a, live);
    const { tip, speak } = coachTip(a, live, diff);
    const dt = diff.time_delta_s;
    return {
      id: c.id,
      index: k,
      lap_id: lap.info.id,
      lap_number: lap.info.lap_number,
      time_delta_s: dt,
      severity: dt >= LOSS_S ? "loss" : dt <= -LOSS_S ? "gain" : "even",
      tip,
      speak,
      note: diff.note,
      segment_time_s: r3(m.segmentTime),
      off_line: off >= OFF_LINE_M,
      diff,
    };
  }

  private maybeCue(d: number, speedMs: number) {
    const lap = this.lap!;
    const ref = this.ref!;
    const lead = Math.max(60, speedMs * CUE_LEAD_S);
    for (const c of ref.corners) {
      if (lap.cued.has(c.id)) continue;
      const cueAt = c.zoneStart - lead;
      if (d < cueAt || d > c.zoneStart) continue;
      lap.cued.add(c.id);
      const prev = this.lastByCorner.get(c.id);
      if (prev && prev.severity === "loss" && prev.time_delta_s >= 0.1 && !VAGUE_TIP.test(prev.tip)) {
        const tip = prev.tip.replace(/ — .*/, "");
        this.emit({ type: "cue", id: c.id, tip: prev.tip, speak: `Turn ${c.id.slice(1)}: ${tip.replace(/(\d+) m\b/, "$1 metres")}.` });
      }
    }
  }

  private finishLap(lapTime: number) {
    const lap = this.lap;
    if (!lap) return;
    const ref = this.ref;
    if (ref && !lap.info.is_outlap) this.finishCorners(true, false, lapTime);
    this.sessionBest = this.sessionBest === null ? lapTime : Math.min(this.sessionBest, lapTime);

    const results = lap.results.filter((r): r is CornerResult => r !== null);
    const complete = ref !== null && results.length === ref.corners.length;
    if (complete) {
      // Theoretical best uses the same rule as the session analysis: skip an off-line corner and the one after it
      // (time "gained" there is usually paid back by running wide). Laps far off the pace (crash, spin) are
      // skipped entirely: after an off, distance no longer lines up with the reference.
      const clean = lapTime <= ref.lapTime * THEORETICAL_MAX_FACTOR;
      results.forEach((r, k) => {
        this.lastByCorner.set(r.id, r);
        const next = results[(k + 1) % results.length]!;
        if (clean && !r.off_line && !next.off_line) this.bestSeg.set(r.id, Math.min(this.bestSeg.get(r.id) ?? Infinity, r.segment_time_s));
      });
    }
    let theoretical: number | null = null;
    if (ref && this.bestSeg.size) {
      theoretical = r3(ref.corners.reduce((s, c, k) => s + Math.min(ref.metrics[k]!.segmentTime, this.bestSeg.get(c.id) ?? Infinity), 0));
    }

    const losses = results.filter((r) => r.severity === "loss").sort((a, b) => b.time_delta_s - a.time_delta_s).slice(0, 3);
    const gains = results.filter((r) => r.severity === "gain").sort((a, b) => a.time_delta_s - b.time_delta_s).slice(0, 2);
    const delta = ref ? r3(lapTime - ref.lapTime) : null;
    const focus = losses[0] ? { id: losses[0].id, tip: losses[0].tip } : null;
    const report: LapReport = {
      lap_id: lap.info.id,
      lap_number: lap.info.lap_number,
      lap_time_s: lapTime,
      reference_lap_id: ref?.lapId ?? null,
      reference_lap_s: ref?.lapTime ?? null,
      delta_s: delta,
      session_best_s: this.sessionBest,
      theoretical_best_s: theoretical,
      losses: losses.map((r) => ({ id: r.id, time_delta_s: r.time_delta_s, tip: r.tip })),
      gains: gains.map((r) => ({ id: r.id, time_delta_s: r.time_delta_s, note: r.note })),
      focus,
      brake_marks: ref
        ? ref.corners.flatMap((c) => {
            const h = lap.marks.get(c.id);
            return h ? [{ id: h.id, offset_m: h.offset_m, verdict: h.verdict }] : [];
          })
        : [],
      summary: !ref
        ? `Lap ${fmtLap(lapTime)} — first timed lap here; it's now your reference.`
        : `Lap ${fmtLap(lapTime)}, ${delta! >= 0 ? "+" : "−"}${Math.abs(delta!).toFixed(3)} vs reference.` +
          (lapTime < ref.lapTime ? " New reference lap!" : "") +
          (focus ? ` Focus next lap: ${focus.id} — ${focus.tip}.` : ""),
    };
    this.lastReport = report;
    this.emit({ type: "lap", ...report });
  }

  // ------------------------------------------------------------ reference

  private loadReference(info: LapInfo) {
    const id = this.pickReference(info);
    if (id === null) {
      if (this.ref) this.emit({ type: "no_reference" });
      this.ref = null;
      return;
    }
    if (this.ref?.lapId === id) return;
    let ref = this.refCache.get(id);
    if (!ref) {
      const ri = getLapInfo(this.db, id)!;
      const grid = loadGrid(this.db, id);
      const corners = detectCorners(grid);
      const metrics = corners.map((c, k) => ({ ...measureCorner(grid, c, corners[k + 1], ri.drivetrain, ri.lap_time_s!), offLineM: 0 }));
      ref = {
        lapId: id,
        lapNumber: ri.lap_number,
        sessionId: ri.session_id,
        lapTime: ri.lap_time_s!,
        sameCar: ri.car_ordinal === info.car_ordinal,
        grid,
        corners,
        metrics,
      };
      this.refCache.set(id, ref);
    }
    // corner ids/segments change with the reference: per-corner history no longer lines up
    if (this.ref) {
      this.lastByCorner.clear();
      this.bestSeg.clear();
    }
    this.ref = ref;
    this.emit(referenceMessage(ref));
  }

  private pickReference(info: LapInfo): number | null {
    const same =
      info.track_ordinal !== null
        ? this.db
            .prepare(
              `SELECT l.id FROM laps l JOIN sessions s ON s.id = l.session_id
               WHERE s.track_ordinal = ? AND s.car_ordinal = ? AND l.is_complete = 1 AND l.is_suspect = 0
               ORDER BY l.lap_time_s, l.id LIMIT 1`,
            )
            .get(info.track_ordinal, info.car_ordinal)
        : undefined;
    return (same as { id: number } | undefined)?.id ?? referenceLapId(this.db, info);
  }

  // ------------------------------------------------------------ frame

  /** m/s² over the last ~200 ms of samples (0 when there isn't enough history). */
  private accel(row: SampleRow): number {
    const ss = this.lap!.samples;
    for (let i = ss.length - 2; i >= 0 && i >= ss.length - 30; i--) {
      const dt = (row.t_ms - ss[i]!.t_ms) / 1000;
      if (dt >= 0.2) return dt > 0.5 ? 0 : (row.speed_kmh - ss[i]!.speed_kmh) / 3.6 / dt;
    }
    return 0;
  }

  private frame(row: SampleRow, t: Telemetry, delta: number | null, ref: Reference | null): Frame {
    const lap = this.lap!;
    const d = row.dist_m;
    let corner: string | null = null;
    let next: Frame["next"] = null;
    if (ref) {
      const cs = ref.corners;
      const k = cs.findIndex((c) => (c.wraps ? d >= c.segStart || d < c.segEnd : d >= c.segStart && d < c.segEnd));
      corner = k >= 0 ? cs[k]!.id : null;
      // next corner = first whose marker (brake point, else zone start) is still ahead (wraps to T1 for the next lap)
      const markOf = (k: number) => Math.max(cs[k]!.zoneStart, ref.metrics[k]!.brakePoint ?? cs[k]!.zoneStart);
      let n = cs.findIndex((_, k) => markOf(k) > d);
      const ahead = n >= 0 ? 0 : ref.grid.length;
      if (n < 0) n = 0;
      const c = cs[n];
      if (c) {
        const m = ref.metrics[n]!;
        const prev = this.lastByCorner.get(c.id);
        const markIn = markOf(n) + ahead - d;
        next = {
          id: c.id,
          to_zone_m: Math.round(c.zoneStart + ahead - d),
          ref_brake_in_m: m.brakePoint === null ? null : Math.round(m.brakePoint + ahead - d),
          ref_min_kmh: r1(m.minSpeed),
          ref_gear: ref.grid.gear[Math.round(c.apex)] ?? 0,
          last: prev ? { time_delta_s: prev.time_delta_s, tip: prev.tip } : null,
          mark_kind: m.brakePoint === null ? "lift" : "brake",
          mark_in_m: Math.round(markIn * 10) / 10,
          mark_in_s: timeTo(markIn, row.speed_ms, this.accel(row)),
        };
      }
    }
    return {
      type: "frame",
      lap_id: lap.info.id,
      lap_number: lap.info.lap_number,
      is_outlap: !!lap.info.is_outlap,
      lap_time_s: r3(row.t_ms / 1000),
      dist_m: Math.round(d),
      speed_kmh: r1(row.speed_kmh),
      gear: row.gear,
      rpm: Math.round(row.rpm),
      rpm_max: Math.round(t.engineMaxRpm),
      throttle: Math.round(row.throttle * 100) / 100,
      brake: Math.round(row.brake * 100) / 100,
      steer: Math.round(row.steer * 100) / 100,
      x: r1(row.x),
      z: r1(row.z),
      delta_s: delta === null ? null : r3(delta),
      predicted_s: delta === null || !ref ? null : r3(ref.lapTime + delta),
      ref_lap_s: ref?.lapTime ?? null,
      last_lap_s: t.lastLap && t.lastLap > 0 ? r3(t.lastLap) : null,
      best_lap_s: t.bestLap && t.bestLap > 0 ? r3(t.bestLap) : null,
      race_position: t.racePosition,
      fuel: t.fuel,
      tire_temp_c: t.tireTempC ? t.tireTempC.map((x) => Math.round(x)) : null,
      corner,
      next,
    };
  }
}

/** Seconds to cover `s` metres from speed v (m/s) with constant acceleration a; null if not approaching. */
export function timeTo(s: number, v: number, a: number): number | null {
  if (s < 0 || v < 3) return null;
  a = Math.max(-6, Math.min(12, a));
  let t: number;
  if (Math.abs(a) < 0.05) t = s / v;
  else {
    const disc = v * v + 2 * a * s;
    t = disc <= 0 ? s / v : (-v + Math.sqrt(disc)) / a;
  }
  return t > 30 ? null : Math.round(t * 1000) / 1000;
}

/** Linear interpolation of the grid's time channel at distance d. */
function interp(g: Grid, d: number): number {
  const f = d / g.step;
  const i = Math.min(g.t.length - 2, Math.max(0, Math.floor(f)));
  const u = Math.min(1, Math.max(0, f - i));
  return g.t[i]! + (g.t[i + 1]! - g.t[i]!) * u;
}
