import type { DB } from "./db.js";

export interface SessionRow {
  started_at: number;
  game_format: string;
  car_ordinal: number;
  car_class: number;
  car_pi: number;
  drivetrain: number;
  track_ordinal: number | null;
}

export interface LapStart {
  session_id: number;
  lap_number: number;
  start_distance: number;
  is_outlap: boolean;
  start_race_time_s: number;
  started_at: number;
  fuel_start: number | null;
}

export interface SampleRow {
  lap_id: number;
  t_ms: number;
  dist_m: number;
  speed_ms: number;
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

export interface StatusRow {
  updated_at: number;
  last_packet_at: number | null;
  packets_per_sec: number;
  game_format: string | null;
  session_id: number | null;
  lap_id: number | null;
  lap_number: number | null;
  current_lap_s: number | null;
  speed_kmh: number | null;
}

export const SUSPECT_FACTOR = 1.3;

/**
 * Write side of the store. Samples are queued and written in one transaction per
 * flush (~every 250 ms of packet time); structural writes flush pending samples
 * first so ordering is preserved.
 */
export class TelemetryStore {
  private queue: SampleRow[] = [];
  private s;

  constructor(readonly db: DB) {
    this.s = {
      insertSession: db.prepare(
        `INSERT INTO sessions (started_at, game_format, car_ordinal, car_class, car_pi, drivetrain, track_ordinal)
         VALUES (@started_at, @game_format, @car_ordinal, @car_class, @car_pi, @drivetrain, @track_ordinal)`,
      ),
      endSession: db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`),
      deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
      insertLap: db.prepare(
        `INSERT INTO laps (session_id, lap_number, start_distance, is_outlap, start_race_time_s, started_at, fuel_start)
         VALUES (@session_id, @lap_number, @start_distance, @is_outlap, @start_race_time_s, @started_at, @fuel_start)`,
      ),
      finishLap: db.prepare(
        `UPDATE laps SET lap_time_s = @lap_time_s, is_complete = @is_complete, fuel_end = @fuel_end,
                had_rewind = had_rewind | @had_rewind WHERE id = @id`,
      ),
      reopenLap: db.prepare(`UPDATE laps SET lap_time_s = NULL, is_complete = 0, had_rewind = 1 WHERE id = ?`),
      markRewind: db.prepare(`UPDATE laps SET had_rewind = 1 WHERE id = ?`),
      deleteLap: db.prepare(`DELETE FROM laps WHERE id = ?`),
      insertSample: db.prepare(
        `INSERT INTO samples (lap_id, t_ms, dist_m, speed_ms, speed_kmh, throttle, brake, steer, gear, rpm, x, y, z,
                              slip_fl, slip_fr, slip_rl, slip_rr)
         VALUES (@lap_id, @t_ms, @dist_m, @speed_ms, @speed_kmh, @throttle, @brake, @steer, @gear, @rpm, @x, @y, @z,
                 @slip_fl, @slip_fr, @slip_rl, @slip_rr)`,
      ),
      truncateSamples: db.prepare(`DELETE FROM samples WHERE lap_id = ? AND t_ms > ?`),
      sessionLapsAfter: db.prepare(`SELECT id FROM laps WHERE session_id = ? AND id > ? ORDER BY id`),
      lapsInSession: db.prepare(
        `SELECT id, lap_number, start_distance, is_outlap, start_race_time_s, fuel_start FROM laps WHERE session_id = ? ORDER BY id`,
      ),
      completeLapTimes: db.prepare(`SELECT id, lap_time_s FROM laps WHERE session_id = ? AND is_complete = 1`),
      setSuspect: db.prepare(`UPDATE laps SET is_suspect = ? WHERE id = ?`),
      sampleCount: db.prepare(`SELECT COUNT(*) AS n, MAX(t_ms) AS t FROM samples s JOIN laps l ON l.id = s.lap_id WHERE l.session_id = ?`),
      upsertStatus: db.prepare(
        `INSERT INTO listener_status (id, updated_at, last_packet_at, packets_per_sec, game_format, session_id, lap_id, lap_number, current_lap_s, speed_kmh)
         VALUES (1, @updated_at, @last_packet_at, @packets_per_sec, @game_format, @session_id, @lap_id, @lap_number, @current_lap_s, @speed_kmh)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, last_packet_at = excluded.last_packet_at,
           packets_per_sec = excluded.packets_per_sec, game_format = excluded.game_format, session_id = excluded.session_id,
           lap_id = excluded.lap_id, lap_number = excluded.lap_number, current_lap_s = excluded.current_lap_s,
           speed_kmh = excluded.speed_kmh`,
      ),
      closeDangling: db.prepare(
        `UPDATE sessions SET ended_at = COALESCE(
           (SELECT last_packet_at FROM listener_status WHERE session_id = sessions.id),
           (SELECT MAX(started_at) FROM laps WHERE session_id = sessions.id),
           started_at)
         WHERE ended_at IS NULL`,
      ),
    };
  }

  private insertBatch = (rows: SampleRow[]) => {
    for (const r of rows) this.s.insertSample.run(r);
  };

  queueSample(row: SampleRow): void {
    this.queue.push(row);
  }

  get pending(): number {
    return this.queue.length;
  }

  flush(): void {
    if (!this.queue.length) return;
    const rows = this.queue;
    this.queue = [];
    this.db.transaction(this.insertBatch)(rows);
  }

  createSession(row: SessionRow): number {
    this.flush();
    return Number(this.s.insertSession.run(row).lastInsertRowid);
  }

  endSession(id: number, endedAt: number): void {
    this.flush();
    this.s.endSession.run(endedAt, id);
  }

  deleteSession(id: number): void {
    this.flush();
    this.s.deleteSession.run(id);
  }

  sessionStats(id: number): { samples: number } {
    this.flush();
    const r = this.s.sampleCount.get(id) as { n: number };
    return { samples: r.n };
  }

  createLap(row: LapStart): number {
    this.flush();
    return Number(this.s.insertLap.run({ ...row, is_outlap: row.is_outlap ? 1 : 0 }).lastInsertRowid);
  }

  finishLap(id: number, f: { lap_time_s: number | null; is_complete: boolean; fuel_end: number | null; had_rewind: boolean }): void {
    this.flush();
    this.s.finishLap.run({ id, lap_time_s: f.lap_time_s, is_complete: f.is_complete ? 1 : 0, fuel_end: f.fuel_end, had_rewind: f.had_rewind ? 1 : 0 });
  }

  lapsInSession(sessionId: number) {
    return this.s.lapsInSession.all(sessionId) as {
      id: number; lap_number: number; start_distance: number; is_outlap: number; start_race_time_s: number; fuel_start: number | null;
    }[];
  }

  /**
   * Rewind to `lapId` at lap-relative time `tMs`: delete every later lap in the
   * session, drop samples after tMs, and reopen the lap if it had been closed.
   */
  rewindTo(sessionId: number, lapId: number, tMs: number, reopen: boolean): void {
    this.flush();
    this.db.transaction(() => {
      for (const { id } of this.s.sessionLapsAfter.all(sessionId, lapId) as { id: number }[]) this.s.deleteLap.run(id);
      this.s.truncateSamples.run(lapId, tMs);
      if (reopen) this.s.reopenLap.run(lapId);
      else this.s.markRewind.run(lapId);
    })();
    this.updateSuspects(sessionId);
  }

  /** Flag complete laps slower than SUSPECT_FACTOR × session median. */
  updateSuspects(sessionId: number): void {
    const laps = this.s.completeLapTimes.all(sessionId) as { id: number; lap_time_s: number }[];
    const med = median(laps.map((l) => l.lap_time_s));
    this.db.transaction(() => {
      for (const l of laps) this.s.setSuspect.run(med !== null && l.lap_time_s > SUSPECT_FACTOR * med ? 1 : 0, l.id);
    })();
  }

  writeStatus(row: StatusRow): void {
    this.s.upsertStatus.run(row);
  }

  /** Close sessions left open by a crash/kill (best-effort end time); their open laps stay incomplete. */
  closeDanglingSessions(): number {
    return this.s.closeDangling.run().changes;
  }

  close(): void {
    this.flush();
  }
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
