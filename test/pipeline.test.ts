import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { createIngest } from "../src/listener/ingest.js";
import { Pipeline, type PipelineEvent } from "../src/listener/pipeline.js";
import { TelemetryStore } from "../src/store/store.js";
import { parsePacket, type Telemetry } from "../src/listener/parser.js";
import { loadFixture } from "./helpers/fixtures.js";

function replayFixture() {
  const db = openDb(":memory:");
  const ingest = createIngest(db);
  const events: PipelineEvent[] = [];
  ingest.pipeline.onEvent = (e) => events.push(e);
  for (const p of loadFixture()) ingest.handle(p.data, p.recvMs);
  ingest.close();
  return { db, events };
}

describe("pipeline replay of real FM2023 race", () => {
  const { db, events } = replayFixture();
  const sessions = db.prepare(`SELECT * FROM sessions`).all() as any[];
  const laps = db.prepare(`SELECT * FROM laps ORDER BY id`).all() as any[];

  it("drops the instant restart and keeps one session with car/track metadata", () => {
    expect(events.filter((e) => e.type === "restart")).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ game_format: "fm2023", car_ordinal: 2529, car_class: 4, car_pi: 699, drivetrain: 1, track_ordinal: 1620 });
    expect(sessions[0].ended_at).toBeGreaterThan(sessions[0].started_at + 300_000);
  });

  it("segments laps: out-lap, three timed laps (LastLap times), incomplete final lap", () => {
    expect(laps.map((l) => [l.lap_number, l.lap_time_s, l.is_complete, l.is_outlap])).toEqual([
      [0, null, 0, 1],
      [0, 113.01, 1, 0],
      [1, 113.469, 1, 0],
      [2, 126.164, 1, 0],
      [3, null, 0, 0],
    ]);
    expect(laps.every((l) => l.is_suspect === 0)).toBe(true); // 126.2 < 1.3 × median 113.5
  });

  it("handles rewinds: flags the lap and leaves no duplicate/backwards samples", () => {
    expect(events.filter((e) => e.type === "rewind").length).toBeGreaterThanOrEqual(2);
    expect(laps[1].had_rewind).toBe(1);
    expect(laps[2].had_rewind).toBe(0);
    for (const lap of laps) {
      const rows = db.prepare(`SELECT t_ms, dist_m FROM samples WHERE lap_id = ? ORDER BY rowid`).all(lap.id) as { t_ms: number; dist_m: number }[];
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.t_ms, `lap ${lap.id} sample ${i}`).toBeGreaterThanOrEqual(rows[i - 1]!.t_ms);
        // the car can roll back a little, but never by more than a few meters
        expect(rows[i]!.dist_m).toBeGreaterThan(rows[i - 1]!.dist_m - 5);
      }
    }
  });

  it("timed laps start at the line and span the whole track", () => {
    for (const lap of laps.filter((l) => l.is_complete)) {
      const r = db.prepare(`SELECT MIN(dist_m) lo, MAX(dist_m) hi, MIN(t_ms) t0, MAX(t_ms) t1, COUNT(*) n FROM samples WHERE lap_id = ?`).get(lap.id) as any;
      expect(r.lo).toBeGreaterThan(-5);
      expect(r.lo).toBeLessThan(5);
      expect(r.hi).toBeGreaterThan(4465);
      expect(r.hi).toBeLessThan(4480);
      expect(r.t0).toBeLessThan(50);
      expect(Math.abs(r.t1 / 1000 - lap.lap_time_s)).toBeLessThan(0.05);
      expect(r.n).toBeGreaterThan(lap.lap_time_s * 55); // ~60 Hz
    }
  });

  it("stores normalized sample values", () => {
    const r = db.prepare(`SELECT MIN(throttle) a, MAX(throttle) b, MIN(brake) c, MAX(brake) d, MIN(steer) e, MAX(steer) f, MAX(speed_kmh) g FROM samples`).get() as any;
    expect([r.a, r.c]).toEqual([0, 0]);
    expect([r.b, r.d]).toEqual([1, 1]);
    expect(r.e).toBeGreaterThanOrEqual(-1);
    expect(r.f).toBeLessThanOrEqual(1);
    expect(r.g).toBeGreaterThan(260);
  });
});

describe("pipeline rules (synthetic)", () => {
  const base = parsePacket(loadFixture()[10_000]!.data)!;
  const frame = (o: Partial<Telemetry>): Telemetry => ({ ...base, ...o });

  function run(frames: [Telemetry, number][]) {
    const db = openDb(":memory:");
    const p = new Pipeline(new TelemetryStore(db));
    for (const [t, ms] of frames) p.push(t, ms);
    p.close();
    return db;
  }

  /** Drive `laps` laps of `lapTime` seconds at 10 Hz on a 1000 m track. */
  function laps(lapTimes: number[], opts: { startMs?: number; car?: number } = {}): [Telemetry, number][] {
    const out: [Telemetry, number][] = [];
    let race = 0, ms = opts.startMs ?? 1_000_000, last = 0;
    lapTimes.forEach((lt, n) => {
      for (let t = 0; t < lt; t += 0.1) {
        out.push([frame({ lapNumber: n, currentLap: t, currentRaceTime: race + t, distanceTraveled: (n + t / lt) * 1000, lastLap: last, carOrdinal: opts.car ?? base.carOrdinal }), ms]);
        ms += 100;
      }
      race += lt;
      last = lt;
    });
    out.push([frame({ lapNumber: lapTimes.length, currentLap: 0, currentRaceTime: race, distanceTraveled: lapTimes.length * 1000, lastLap: last, carOrdinal: opts.car ?? base.carOrdinal }), ms]);
    return out;
  }

  it("marks laps >130% of the session median as suspect", () => {
    const db = run(laps([30, 30, 31, 30, 45]));
    const rows = db.prepare(`SELECT lap_number, lap_time_s, is_complete, is_suspect FROM laps ORDER BY id`).all() as any[];
    const timed = rows.filter((r) => r.is_complete);
    expect(timed.map((r) => r.lap_time_s)).toEqual([30, 31, 30, 45]);
    expect(timed.map((r) => r.is_suspect)).toEqual([0, 0, 0, 1]);
  });

  it("starts a new session after a >30 s gap and on car change", () => {
    const a = laps([30, 30]);
    const b = laps([30, 30], { startMs: a.at(-1)![1] + 31_000 });
    const c = laps([30, 30], { startMs: b.at(-1)![1] + 1000, car: 9999 });
    const db = run([...a, ...b, ...c]);
    const s = db.prepare(`SELECT car_ordinal FROM sessions ORDER BY id`).all() as any[];
    expect(s.map((r) => r.car_ordinal)).toEqual([base.carOrdinal, base.carOrdinal, 9999]);
  });

  it("discards sessions shorter than 10 s", () => {
    const db = run(laps([5]));
    expect(db.prepare(`SELECT COUNT(*) n FROM sessions`).get()).toEqual({ n: 0 });
  });
});
