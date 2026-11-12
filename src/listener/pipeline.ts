/**
 * Session + lap segmentation.
 *
 * Session = continuous run of IsRaceOn packets for one car/track. A new session
 * starts after a >30 s receive gap, a car/track change, or a race restart
 * (race clock jumps back >30 s or LapNumber drops by more than one).
 *
 * Laps:
 *  - LapNumber increment → close the current lap with LastLap as the
 *    authoritative time, open the next lap at the line.
 *  - CurrentLap resets while the race clock keeps running and LapNumber stays
 *    the same → line crossing without an increment (FM2023 keeps LapNumber 0 from
 *    the grid through the first timed lap). Close the segment as an incomplete
 *    out-lap and open a timed lap.
 *  - The first segment of every session is an out-lap: we can't know it started
 *    at the line.
 *
 * Rewinds (FM2023): the race clock steps back a little. Samples after the rewind
 * point are deleted, later laps in the session are removed, and the lap is
 * flagged had_rewind.
 */
import type { Telemetry } from "./parser.js";
import type { SampleRow, TelemetryStore } from "../store/store.js";

export const SESSION_GAP_MS = 30_000;
export const RESTART_JUMP_S = 30;
const REWIND_EPS_S = 0.05;
const LAP_RESET_DROP_S = 0.5;
const FLUSH_INTERVAL_MS = 250;
/** Sessions with less driving than this are deleted on close (menu blips, instant restarts). */
export const MIN_SESSION_MS = 10_000;

interface LapState {
  id: number;
  lapNumber: number;
  startDist: number;
  startRaceTime: number;
  isOutlap: boolean;
  hadRewind: boolean;
}

interface SessionState {
  id: number;
  key: string;
  startedAt: number;
  lastRecvMs: number;
  last: Telemetry;
  lap: LapState | null;
}

export interface PipelineEvent {
  type: "session_start" | "session_end" | "lap_start" | "lap_end" | "rewind" | "restart";
  sessionId: number;
  lapId?: number;
  lapNumber?: number;
  lapTimeS?: number | null;
  complete?: boolean;
  deleted?: boolean;
}

export class Pipeline {
  private session: SessionState | null = null;
  private lastFlushMs = 0;
  onEvent: (e: PipelineEvent) => void = () => {};
  /** Called for every stored sample, after segmentation (live dashboard / coach). */
  onSample: (row: SampleRow, t: Telemetry) => void = () => {};

  constructor(private store: TelemetryStore) {}

  get current() {
    const s = this.session;
    return s ? { sessionId: s.id, lapId: s.lap?.id ?? null, lapNumber: s.lap?.lapNumber ?? null, last: s.last } : null;
  }

  /** Feed one parsed IsRaceOn packet with its receive time. */
  push(t: Telemetry, recvMs: number): void {
    // Sled packets have no lap/position data: nothing to segment.
    if (t.lapNumber === null || t.currentRaceTime === null || t.currentLap === null || t.distanceTraveled === null) return;

    const key = `${t.format}|${t.carOrdinal}|${t.carPI}|${t.trackOrdinal ?? ""}`;
    let s = this.session;
    if (s && (recvMs - s.lastRecvMs > SESSION_GAP_MS || s.key !== key)) {
      this.endSession(s.lastRecvMs);
      s = null;
    }

    if (s) {
      const prev = s.last;
      const dClock = t.currentRaceTime - prev.currentRaceTime!;
      if (dClock < -RESTART_JUMP_S || t.lapNumber < prev.lapNumber! - 1) {
        this.onEvent({ type: "restart", sessionId: s.id });
        this.endSession(s.lastRecvMs);
        s = null;
      } else if (dClock < -REWIND_EPS_S) {
        this.rewind(s, t);
      } else if (s.lap) {
        if (t.lapNumber > prev.lapNumber!) {
          // Authoritative lap time from LastLap; only a lap that started at the line is complete.
          this.closeLap(s, s.lap.isOutlap ? null : t.lastLap, !s.lap.isOutlap, prev.fuel);
          this.openLap(s, t, recvMs, false);
        } else if (t.currentLap < prev.currentLap! - LAP_RESET_DROP_S && t.lapNumber === prev.lapNumber) {
          this.closeLap(s, null, false, prev.fuel);
          this.openLap(s, t, recvMs, false);
        }
      }
    }

    if (!s) s = this.startSession(t, recvMs, key);
    if (!s.lap) this.openLap(s, t, recvMs, true);

    const lap = s.lap!;
    const sl = t.slipRatio;
    const row: SampleRow = {
      lap_id: lap.id,
      t_ms: Math.round((t.currentRaceTime - lap.startRaceTime) * 1000),
      dist_m: t.distanceTraveled - lap.startDist,
      speed_ms: t.speedMs!,
      speed_kmh: t.speedKmh!,
      throttle: t.throttle!,
      brake: t.brake!,
      steer: t.steer!,
      gear: t.gear!,
      rpm: t.rpm,
      x: t.position!.x,
      y: t.position!.y,
      z: t.position!.z,
      slip_fl: sl[0],
      slip_fr: sl[1],
      slip_rl: sl[2],
      slip_rr: sl[3],
    };
    this.store.queueSample(row);
    s.last = t;
    s.lastRecvMs = recvMs;

    if (recvMs - this.lastFlushMs >= FLUSH_INTERVAL_MS) {
      this.store.flush();
      this.lastFlushMs = recvMs;
    }
    this.onSample(row, t);
  }

  /** End the current session (listener shutdown / end of replay). */
  close(): void {
    if (this.session) this.endSession(this.session.lastRecvMs);
    this.store.flush();
  }

  private startSession(t: Telemetry, recvMs: number, key: string): SessionState {
    const id = this.store.createSession({
      started_at: Math.round(recvMs),
      game_format: t.format,
      car_ordinal: t.carOrdinal,
      car_class: t.carClass,
      car_pi: t.carPI,
      drivetrain: t.drivetrain,
      track_ordinal: t.trackOrdinal,
    });
    this.session = { id, key, startedAt: recvMs, lastRecvMs: recvMs, last: t, lap: null };
    this.onEvent({ type: "session_start", sessionId: id });
    return this.session;
  }

  private endSession(endMs: number): void {
    const s = this.session!;
    if (s.lap) this.closeLap(s, null, false, s.last.fuel);
    const deleted = endMs - s.startedAt < MIN_SESSION_MS;
    if (deleted) this.store.deleteSession(s.id);
    else {
      this.store.endSession(s.id, Math.round(endMs));
      this.store.updateSuspects(s.id);
    }
    this.onEvent({ type: "session_end", sessionId: s.id, deleted });
    this.session = null;
  }

  private openLap(s: SessionState, t: Telemetry, recvMs: number, isOutlap: boolean): void {
    // For a lap opened at the line, back-date the start by CurrentLap so dist/time start at ~0.
    const sinceLine = isOutlap ? 0 : t.currentLap!;
    const startDist = t.distanceTraveled! - sinceLine * (t.speedMs ?? 0);
    const startRaceTime = t.currentRaceTime! - sinceLine;
    const id = this.store.createLap({
      session_id: s.id,
      lap_number: t.lapNumber!,
      start_distance: startDist,
      is_outlap: isOutlap,
      start_race_time_s: startRaceTime,
      started_at: Math.round(recvMs),
      fuel_start: t.fuel,
    });
    s.lap = { id, lapNumber: t.lapNumber!, startDist, startRaceTime, isOutlap, hadRewind: false };
    this.onEvent({ type: "lap_start", sessionId: s.id, lapId: id, lapNumber: t.lapNumber! });
  }

  private closeLap(s: SessionState, lapTime: number | null, complete: boolean, fuel: number | null): void {
    const lap = s.lap!;
    const ok = complete && lapTime !== null && lapTime > 0;
    if (ok) lapTime = Math.round(lapTime! * 1000) / 1000; // f32 noise → ms
    this.store.finishLap(lap.id, { lap_time_s: ok ? lapTime : null, is_complete: ok, fuel_end: fuel, had_rewind: lap.hadRewind });
    if (ok) this.store.updateSuspects(s.id);
    this.onEvent({ type: "lap_end", sessionId: s.id, lapId: lap.id, lapNumber: lap.lapNumber, lapTimeS: ok ? lapTime : null, complete: ok });
    s.lap = null;
  }

  /** Race clock stepped back: find the lap containing the new time and truncate everything after it. */
  private rewind(s: SessionState, t: Telemetry): void {
    const target = t.currentRaceTime!;
    const laps = this.store.lapsInSession(s.id);
    let row = laps[0];
    for (const l of laps) if (l.start_race_time_s <= target + 1e-6) row = l;
    if (!row) return;
    const reopen = !s.lap || row.id !== s.lap.id;
    this.store.rewindTo(s.id, row.id, Math.round((target - row.start_race_time_s) * 1000), reopen);
    s.lap = {
      id: row.id,
      lapNumber: row.lap_number,
      startDist: row.start_distance,
      startRaceTime: row.start_race_time_s,
      isOutlap: !!row.is_outlap,
      hadRewind: true,
    };
    this.onEvent({ type: "rewind", sessionId: s.id, lapId: row.id, lapNumber: row.lap_number });
  }
}
