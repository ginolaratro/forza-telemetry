/**
 * Progress over time: how a driver's pace, consistency and individual corners change from session to
 * session on one track in one car.
 *
 * A "combo" is track + car + tune. The tune is approximated by the car's PI: a PI change means the car was
 * upgraded/retuned, so lap times before and after aren't comparable. By default only sessions on the most
 * recent PI are used; `all_tunes` mixes them (each session still reports its PI).
 *
 * Every lap is measured against one corner layout (numbered on the track's current reference lap), so
 * T1 means the same corner in every session of a report.
 */
import type { DB } from "../store/db.js";
import { getLapInfo, type LapInfo } from "./grid.js";
import type { CornerDef } from "./corners.js";
import { median } from "../store/store.js";
import { bestSegmentLaps, cornersFor, diffCorner, fmtLap, measured, OFF_LINE_M, sd, type Measured } from "./report.js";

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const sgn = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const iso = (ms: number) => new Date(ms).toISOString();
/** Local calendar date (YYYY-MM-DD) — sessions are evening drives, UTC would shift them to the next day. */
const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE");

/** A corner whose median segment time moved by at least this much counts as improved / regressed. */
export const CORNER_CHANGE_S = 0.05;
/** Lap-time change that counts as real: the larger of 0.15 s and 0.2% of the lap. */
const lapChangeThreshold = (lapS: number) => Math.max(0.15, lapS * 0.002);
/** Sessions shown by default. */
export const DEFAULT_LAST_SESSIONS = 10;

export interface ProgressOptions {
  track_ordinal?: number;
  car_ordinal?: number;
  car_pi?: number;
  all_tunes?: boolean;
  last_sessions?: number;
}

export interface Combo {
  track_ordinal: number;
  car_ordinal: number;
  car_pi: number | null; // null = all tunes
}

interface SessionRow {
  id: number;
  started_at: number;
  car_pi: number | null;
}

export interface CornerStats {
  id: string;
  laps: number;
  best_s: number | null; // fastest on-line segment
  median_s: number;
  /** Median metrics of the session's clean laps, in the shape the lap comparison uses. */
  typical: Measured;
  lockup_rate: number; // share of laps with ≥ 5 m of lockup in this corner
  wheelspin_rate: number;
  off_line_rate: number;
}

export interface SessionStats {
  session_id: number;
  started_at: string;
  car_pi: number | null;
  clean_laps: number;
  best_s: number | null;
  best_lap_id: number | null;
  median_s: number | null;
  sd_s: number | null;
  theoretical_s: number | null;
  corners: CornerStats[];
}

// ---------------------------------------------------------------- combo + caching

/** Resolve the track/car/tune to report on: anything omitted comes from the most recent matching session. */
export function resolveCombo(db: DB, o: ProgressOptions = {}): Combo {
  const latest = db
    .prepare(
      `SELECT track_ordinal, car_ordinal, car_pi FROM sessions
       WHERE track_ordinal IS NOT NULL AND car_ordinal IS NOT NULL
         AND (@track IS NULL OR track_ordinal = @track) AND (@car IS NULL OR car_ordinal = @car)
       ORDER BY id DESC LIMIT 1`,
    )
    .get({ track: o.track_ordinal ?? null, car: o.car_ordinal ?? null }) as
    | { track_ordinal: number; car_ordinal: number; car_pi: number | null }
    | undefined;
  if (!latest) {
    const what = [o.track_ordinal != null && `track ${o.track_ordinal}`, o.car_ordinal != null && `car ${o.car_ordinal}`].filter(Boolean);
    throw new Error(what.length ? `no sessions for ${what.join(" in ")}` : "no sessions recorded yet");
  }
  return {
    track_ordinal: latest.track_ordinal,
    car_ordinal: latest.car_ordinal,
    car_pi: o.all_tunes ? null : (o.car_pi ?? latest.car_pi),
  };
}

function comboSessions(db: DB, c: Combo): SessionRow[] {
  return db
    .prepare(
      `SELECT id, started_at, car_pi FROM sessions
       WHERE track_ordinal = @track AND car_ordinal = @car AND (@pi IS NULL OR car_pi = @pi)
       ORDER BY started_at, id`,
    )
    .all({ track: c.track_ordinal, car: c.car_ordinal, pi: c.car_pi }) as SessionRow[];
}

/** Other tunes (PIs) of this car on this track, for the "you also have N sessions on PI x" hint. */
function otherTunes(db: DB, c: Combo) {
  if (c.car_pi === null) return [];
  return db
    .prepare(
      `SELECT car_pi, COUNT(*) AS sessions FROM sessions
       WHERE track_ordinal = ? AND car_ordinal = ? AND car_pi IS NOT ? GROUP BY car_pi ORDER BY car_pi`,
    )
    .all(c.track_ordinal, c.car_ordinal, c.car_pi) as { car_pi: number | null; sessions: number }[];
}

// Per-lap corner metrics are expensive (resampling + line offsets); cache them per DB, lap and layout.
const metricCache = new WeakMap<DB, Map<string, Measured[]>>();
function lapMetrics(db: DB, lap: LapInfo, corners: CornerDef[], refLapId: number): Measured[] {
  let m = metricCache.get(db);
  if (!m) metricCache.set(db, (m = new Map()));
  const key = `${lap.id}:${refLapId}:${corners.length}`;
  let v = m.get(key);
  if (!v) m.set(key, (v = measured(db, lap, corners, refLapId).metrics));
  return v;
}

function cleanLaps(db: DB, sessionId: number): LapInfo[] {
  const ids = db
    .prepare(`SELECT id FROM laps WHERE session_id = ? AND is_complete = 1 AND is_suspect = 0 ORDER BY id`)
    .all(sessionId) as { id: number }[];
  return ids.map((r) => getLapInfo(db, r.id)!);
}

/** Corner layout for the combo's track: numbered on the track reference lap. */
function layout(db: DB, sessions: SessionRow[]): { refLapId: number; corners: CornerDef[] } | null {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const lap = cleanLaps(db, sessions[i]!.id)[0];
    if (lap) return cornersFor(db, lap);
  }
  return null;
}

// ---------------------------------------------------------------- per-session stats

const medianOrNull = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  // a brake point / throttle pickup only counts if most laps had one
  return v.length * 2 >= xs.length ? median(v) : null;
};

function typicalCorner(ms: Measured[]): Measured {
  const med = (f: (m: Measured) => number) => median(ms.map(f))!;
  return {
    id: ms[0]!.id,
    brakePoint: medianOrNull(ms.map((m) => m.brakePoint)),
    peakBrake: med((m) => m.peakBrake),
    entrySpeed: med((m) => m.entrySpeed),
    minSpeed: med((m) => m.minSpeed),
    minSpeedAt: med((m) => m.minSpeedAt),
    throttlePickup: medianOrNull(ms.map((m) => m.throttlePickup)),
    exitSpeed: med((m) => m.exitSpeed),
    segmentTime: med((m) => m.segmentTime),
    lockupM: Math.round(med((m) => m.lockupM)),
    wheelspinM: Math.round(med((m) => m.wheelspinM)),
    offLineM: med((m) => m.offLineM),
  };
}

export function sessionStats(db: DB, s: SessionRow, corners: CornerDef[], refLapId: number): SessionStats {
  const laps = cleanLaps(db, s.id);
  const base = { session_id: s.id, started_at: iso(s.started_at), car_pi: s.car_pi, clean_laps: laps.length };
  if (!laps.length) {
    return { ...base, best_s: null, best_lap_id: null, median_s: null, sd_s: null, theoretical_s: null, corners: [] };
  }
  const times = laps.map((l) => l.lap_time_s!);
  const bestIdx = times.indexOf(Math.min(...times));
  const perLap = laps.map((l) => lapMetrics(db, l, corners, refLapId));
  const from = bestSegmentLaps(perLap, bestIdx);
  const theoretical = from.reduce((sum, li, k) => sum + perLap[li]![k]!.segmentTime, 0);
  const rate = (k: number, f: (m: Measured) => boolean) => r2(perLap.filter((m) => f(m[k]!)).length / perLap.length);
  return {
    ...base,
    best_s: times[bestIdx]!,
    best_lap_id: laps[bestIdx]!.id,
    median_s: r3(median(times)!),
    sd_s: laps.length >= 2 ? r3(sd(times)) : null,
    theoretical_s: r3(Math.min(theoretical, times[bestIdx]!)),
    corners: corners.map((c, k) => {
      const ms = perLap.map((m) => m[k]!);
      const onLine = ms.filter((m) => m.offLineM < OFF_LINE_M).map((m) => m.segmentTime);
      return {
        id: c.id,
        laps: ms.length,
        best_s: onLine.length ? r3(Math.min(...onLine)) : null,
        median_s: r3(median(ms.map((m) => m.segmentTime))!),
        typical: typicalCorner(ms),
        lockup_rate: rate(k, (m) => m.lockupM >= 5),
        wheelspin_rate: rate(k, (m) => m.wheelspinM >= 5),
        off_line_rate: rate(k, (m) => m.offLineM >= OFF_LINE_M),
      };
    }),
  };
}

// ---------------------------------------------------------------- trends

/** Least-squares slope of ys over 0..n-1 (per session). */
export function slope(ys: number[]): number | null {
  const n = ys.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

type Verdict = "improving" | "steady" | "slower" | "not enough data";

function verdict(change: number | null, lapS: number): Verdict {
  if (change === null) return "not enough data";
  const th = lapChangeThreshold(lapS);
  return change <= -th ? "improving" : change >= th ? "slower" : "steady";
}

/** Personal-best progression across every clean lap of the combo (each lap that beat all before it). */
function pbHistory(db: DB, sessionIds: number[]) {
  if (!sessionIds.length) return [];
  const rows = db
    .prepare(
      `SELECT l.id, l.session_id, l.lap_number, l.lap_time_s, COALESCE(l.started_at, s.started_at) AS at
       FROM laps l JOIN sessions s ON s.id = l.session_id
       WHERE l.session_id IN (${sessionIds.map(() => "?").join(",")}) AND l.is_complete = 1 AND l.is_suspect = 0
       ORDER BY at, l.id`,
    )
    .all(...sessionIds) as { id: number; session_id: number; lap_number: number; lap_time_s: number; at: number }[];
  const out: { lap_id: number; session_id: number; lap_number: number; date: string; lap_time_s: number; lap_time: string; improvement_s: number | null }[] = [];
  let best = Infinity;
  for (const r of rows) {
    if (r.lap_time_s < best) {
      out.push({
        lap_id: r.id,
        session_id: r.session_id,
        lap_number: r.lap_number,
        date: iso(r.at),
        lap_time_s: r.lap_time_s,
        lap_time: fmtLap(r.lap_time_s),
        improvement_s: Number.isFinite(best) ? r3(best - r.lap_time_s) : null,
      });
      best = r.lap_time_s;
    }
  }
  return out;
}

function comboHeader(c: Combo) {
  return `track ${c.track_ordinal}, car ${c.car_ordinal}${c.car_pi === null ? " (all tunes)" : `, PI ${c.car_pi}`}`;
}

// ---------------------------------------------------------------- progress report

/** Session-by-session pace, consistency and corner trends for one combo. */
export function progressReport(db: DB, o: ProgressOptions = {}) {
  const combo = resolveCombo(db, o);
  const all = comboSessions(db, combo);
  const lay = layout(db, all);
  if (!lay) throw new Error(`no clean laps yet for ${comboHeader(combo)}`);
  const windowed = all.slice(-(o.last_sessions ?? DEFAULT_LAST_SESSIONS));
  const stats = windowed.map((s) => sessionStats(db, s, lay.corners, lay.refLapId));
  const timed = stats.filter((s) => s.best_s !== null);
  const first = timed[0]!;
  const latest = timed[timed.length - 1]!;
  const prev = timed.length >= 2 ? timed[timed.length - 2]! : null;
  const two = timed.length >= 2;
  const d = (a: number | null, b: number | null) => (two && a !== null && b !== null ? r3(b - a) : null);

  const pbs = pbHistory(db, all.map((s) => s.id));
  const pb = pbs[pbs.length - 1]!;

  const medianSlope = slope(timed.map((s) => s.median_s!));
  const medianChange = d(first.median_s, latest.median_s);
  const bestChange = d(first.best_s, latest.best_s);
  const sdChange = d(first.sd_s, latest.sd_s);
  const pace = verdict(medianChange, latest.median_s!);
  const consistency =
    sdChange === null ? "not enough data" : sdChange <= -0.1 ? "improving" : sdChange >= 0.1 ? "worse" : "steady";

  // per-corner: first vs latest typical lap, plus how far the latest typical lap is from the best you've ever done there
  const corners = lay.corners.map((c, k) => {
    const series = timed.map((s) => s.corners[k]!);
    const f = series[0]!;
    const l = series[series.length - 1]!;
    const bestEver = Math.min(...series.map((x) => x.best_s ?? Infinity));
    const change = two ? r3(l.median_s - f.median_s) : null;
    const status = change === null ? "new" : change <= -CORNER_CHANGE_S ? "improved" : change >= CORNER_CHANGE_S ? "regressed" : "steady";
    return {
      id: c.id,
      status,
      first_median_s: f.median_s,
      latest_median_s: l.median_s,
      change_s: change,
      trend_s_per_session: (() => {
        const v = slope(series.map((x) => x.median_s));
        return v === null ? null : r3(v);
      })(),
      best_ever_s: Number.isFinite(bestEver) ? r3(bestEver) : null,
      latest_gap_to_best_s: Number.isFinite(bestEver) ? r3(l.median_s - bestEver) : null,
      lockup_rate: { first: f.lockup_rate, latest: l.lockup_rate },
      off_line_rate: { first: f.off_line_rate, latest: l.off_line_rate },
      // what changed in the typical lap through this corner (first session = baseline)
      note: two ? diffCorner(f.typical, l.typical).note : `${c.id}: one session so far`,
    };
  });
  const improved = corners.filter((c) => c.status === "improved").sort((a, b) => a.change_s! - b.change_s!);
  const regressed = corners.filter((c) => c.status === "regressed").sort((a, b) => b.change_s! - a.change_s!);
  const opportunities = [...corners]
    .filter((c) => (c.latest_gap_to_best_s ?? 0) >= CORNER_CHANGE_S)
    .sort((a, b) => b.latest_gap_to_best_s! - a.latest_gap_to_best_s!)
    .slice(0, 3);

  const others = otherTunes(db, combo);
  const lines = [
    `${comboHeader(combo)}: ${timed.length} session${timed.length === 1 ? "" : "s"} with clean laps` +
      (windowed.length < all.length ? ` (last ${windowed.length} of ${all.length})` : "") +
      `, ${day(Date.parse(first.started_at))} → ${day(Date.parse(latest.started_at))}.`,
    two
      ? `Pace ${pace}: median lap ${fmtLap(first.median_s)} → ${fmtLap(latest.median_s)} (${sgn(medianChange!)} s), ` +
        `best ${fmtLap(first.best_s)} → ${fmtLap(latest.best_s)} (${sgn(bestChange!)} s)` +
        (medianSlope !== null ? `, trend ${sgn(medianSlope)} s/session` : "") +
        "."
      : `Only one session so far: best ${fmtLap(latest.best_s)}, median ${fmtLap(latest.median_s)}. Drive another session to see a trend.`,
    `Personal best ${pb.lap_time} (session ${pb.session_id}, ${day(Date.parse(pb.date))})` +
      (pbs.length > 1 ? `, improved ${pbs.length - 1} time${pbs.length === 2 ? "" : "s"} since your first lap` : "") +
      `; latest session's theoretical best ${fmtLap(latest.theoretical_s)}.`,
  ];
  if (sdChange !== null) lines.push(`Consistency ${consistency}: lap-time sd ${first.sd_s?.toFixed(2)} → ${latest.sd_s?.toFixed(2)} s.`);
  if (improved.length) lines.push(`Improved: ${improved.slice(0, 3).map((c) => `${c.id} ${sgn(c.change_s!)} s`).join(", ")}.`);
  if (regressed.length) lines.push(`Got slower: ${regressed.slice(0, 3).map((c) => c.note).join("; ")}.`);
  if (opportunities.length) {
    lines.push(
      `Most left on the table vs your best-ever segment: ${opportunities.map((c) => `${c.id} (${c.latest_gap_to_best_s!.toFixed(2)} s)`).join(", ")}.`,
    );
  }
  if (others.length) lines.push(`Other tunes not included: ${others.map((t) => `PI ${t.car_pi ?? "?"} (${t.sessions} sessions)`).join(", ")}.`);

  return {
    ...combo,
    corner_layout_lap_id: lay.refLapId,
    sessions_total: all.length,
    other_tunes: others,
    sessions: stats.map(({ corners: _c, ...s }) => ({
      ...s,
      best: fmtLap(s.best_s),
      median: fmtLap(s.median_s),
      theoretical: fmtLap(s.theoretical_s),
    })),
    trend: {
      pace,
      consistency,
      best_change_s: bestChange,
      best_change_vs_previous_s: prev ? r3(latest.best_s! - prev.best_s!) : null,
      median_change_s: medianChange,
      median_change_vs_previous_s: prev ? r3(latest.median_s! - prev.median_s!) : null,
      median_slope_s_per_session: medianSlope === null ? null : r3(medianSlope),
      sd_change_s: sdChange,
    },
    personal_best: pb,
    pb_history: pbs,
    corners,
    improved: improved.map((c) => c.id),
    regressed: regressed.map((c) => c.id),
    biggest_opportunities: opportunities.map((c) => ({ id: c.id, gap_s: c.latest_gap_to_best_s })),
    summary: lines.join(" "),
  };
}

// ---------------------------------------------------------------- one corner over time

/** Session-by-session detail for one corner: segment time, brake point, speeds, throttle, mistakes. */
export function cornerProgress(db: DB, corner: string, o: ProgressOptions = {}) {
  const combo = resolveCombo(db, o);
  const all = comboSessions(db, combo);
  const lay = layout(db, all);
  if (!lay) throw new Error(`no clean laps yet for ${comboHeader(combo)}`);
  const id = corner.trim().toUpperCase().replace(/^(\d+)$/, "T$1");
  const k = lay.corners.findIndex((c) => c.id === id);
  if (k < 0) throw new Error(`no corner ${corner} on track ${combo.track_ordinal} (T1–T${lay.corners.length})`);
  const def = lay.corners[k]!;
  const stats = all
    .slice(-(o.last_sessions ?? DEFAULT_LAST_SESSIONS))
    .map((s) => sessionStats(db, s, lay.corners, lay.refLapId))
    .filter((s) => s.best_s !== null);
  const rows = stats.map((s) => {
    const c = s.corners[k]!;
    const t = c.typical;
    return {
      session_id: s.session_id,
      started_at: s.started_at,
      car_pi: s.car_pi,
      laps: c.laps,
      best_s: c.best_s,
      median_s: c.median_s,
      brake_m: t.brakePoint === null ? null : Math.round(t.brakePoint),
      entry_kmh: r1(t.entrySpeed),
      min_kmh: r1(t.minSpeed),
      min_at_m: Math.round(t.minSpeedAt),
      throttle_m: t.throttlePickup === null ? null : Math.round(t.throttlePickup),
      exit_kmh: r1(t.exitSpeed),
      lockup_rate: c.lockup_rate,
      wheelspin_rate: c.wheelspin_rate,
      off_line_rate: c.off_line_rate,
    };
  });
  const f = stats[0]!.corners[k]!;
  const l = stats[stats.length - 1]!.corners[k]!;
  const bestEver = Math.min(...rows.map((r) => r.best_s ?? Infinity));
  const two = stats.length >= 2;
  const change = two ? r3(l.median_s - f.median_s) : null;
  const mistakes = (c: CornerStats) =>
    [
      c.lockup_rate > 0 && `locked up on ${Math.round(c.lockup_rate * 100)}% of laps`,
      c.wheelspin_rate > 0 && `wheelspin on ${Math.round(c.wheelspin_rate * 100)}%`,
      c.off_line_rate > 0 && `off line on ${Math.round(c.off_line_rate * 100)}%`,
    ].filter(Boolean).join(", ");
  const lm = mistakes(l);
  return {
    ...combo,
    corner: { id: def.id, zone_m: [def.zoneStart, def.zoneEnd], apex_m: def.apex, segment_m: [def.segStart, def.segEnd] },
    sessions: rows,
    change_s: change,
    trend_s_per_session: (() => {
      const v = slope(rows.map((r) => r.median_s));
      return v === null ? null : r3(v);
    })(),
    best_ever_s: Number.isFinite(bestEver) ? r3(bestEver) : null,
    latest_gap_to_best_s: Number.isFinite(bestEver) ? r3(l.median_s - bestEver) : null,
    summary:
      `${def.id} on ${comboHeader(combo)}, ${stats.length} session${stats.length === 1 ? "" : "s"}: ` +
      (two
        ? `typical segment ${f.median_s.toFixed(2)} → ${l.median_s.toFixed(2)} s (${sgn(change!)} s). ` +
          `Versus your first session: ${diffCorner(f.typical, l.typical).note.replace(/^T\d+: /, "")}. `
        : `typical segment ${l.median_s.toFixed(2)} s. `) +
      (Number.isFinite(bestEver) ? `Best ever ${bestEver.toFixed(2)} s, ${(l.median_s - bestEver).toFixed(2)} s quicker than your latest typical lap. ` : "") +
      (lm ? `Latest session: ${lm}.` : "No lockups, wheelspin or off-line laps in the latest session."),
  };
}

// ---------------------------------------------------------------- personal bests

/** Best lap per track + car + tune, with how much it improved since that combo's first session. */
export function personalBests(db: DB, o: { track_ordinal?: number; car_ordinal?: number } = {}) {
  const rows = db
    .prepare(
      `SELECT s.track_ordinal, s.car_ordinal, s.car_pi,
              COUNT(DISTINCT s.id) AS sessions, COUNT(l.id) AS clean_laps,
              MIN(s.started_at) AS first_at, MAX(s.started_at) AS last_at
       FROM sessions s JOIN laps l ON l.session_id = s.id AND l.is_complete = 1 AND l.is_suspect = 0
       WHERE s.track_ordinal IS NOT NULL AND (@track IS NULL OR s.track_ordinal = @track) AND (@car IS NULL OR s.car_ordinal = @car)
       GROUP BY s.track_ordinal, s.car_ordinal, s.car_pi ORDER BY last_at DESC`,
    )
    .all({ track: o.track_ordinal ?? null, car: o.car_ordinal ?? null }) as {
    track_ordinal: number;
    car_ordinal: number;
    car_pi: number | null;
    sessions: number;
    clean_laps: number;
    first_at: number;
    last_at: number;
  }[];
  const best = db.prepare(
    `SELECT l.id, l.session_id, l.lap_time_s, COALESCE(l.started_at, s.started_at) AS at
     FROM laps l JOIN sessions s ON s.id = l.session_id
     WHERE s.track_ordinal = ? AND s.car_ordinal = ? AND s.car_pi IS ? AND l.is_complete = 1 AND l.is_suspect = 0
     ORDER BY l.lap_time_s, l.id LIMIT 1`,
  );
  const firstBest = db.prepare(
    `SELECT MIN(l.lap_time_s) AS t FROM laps l
     WHERE l.is_complete = 1 AND l.is_suspect = 0 AND l.session_id = (
       SELECT s.id FROM sessions s JOIN laps x ON x.session_id = s.id AND x.is_complete = 1 AND x.is_suspect = 0
       WHERE s.track_ordinal = ? AND s.car_ordinal = ? AND s.car_pi IS ? ORDER BY s.started_at, s.id LIMIT 1)`,
  );
  const combos = rows.map((r) => {
    const b = best.get(r.track_ordinal, r.car_ordinal, r.car_pi) as { id: number; session_id: number; lap_time_s: number; at: number };
    const f = (firstBest.get(r.track_ordinal, r.car_ordinal, r.car_pi) as { t: number }).t;
    return {
      track_ordinal: r.track_ordinal,
      car_ordinal: r.car_ordinal,
      car_pi: r.car_pi,
      sessions: r.sessions,
      clean_laps: r.clean_laps,
      first_driven: iso(r.first_at),
      last_driven: iso(r.last_at),
      best_lap_s: b.lap_time_s,
      best_lap: fmtLap(b.lap_time_s),
      best_lap_id: b.id,
      best_session_id: b.session_id,
      best_set_at: iso(b.at),
      first_session_best_s: f,
      improvement_since_first_session_s: r3(f - b.lap_time_s),
    };
  });
  return {
    combos,
    summary: combos.length
      ? combos
          .map(
            (c) =>
              `Track ${c.track_ordinal}, car ${c.car_ordinal} (PI ${c.car_pi ?? "?"}): ${c.best_lap} on ${day(Date.parse(c.best_set_at))}` +
              (c.sessions > 1
                ? c.improvement_since_first_session_s > 0
                  ? `, ${c.improvement_since_first_session_s.toFixed(2)} s faster than your first session`
                  : ", still from your first session"
                : "") +
              ` (${c.sessions} session${c.sessions === 1 ? "" : "s"}, ${c.clean_laps} clean laps).`,
          )
          .join(" ")
      : "No clean laps recorded yet.",
  };
}
