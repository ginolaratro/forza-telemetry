import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { createIngest } from "../src/listener/ingest.js";
import { loadGrid, resample, type RawSample } from "../src/analysis/grid.js";
import { detectCorners, measureLap } from "../src/analysis/corners.js";
import { compareLaps, consistencyReport, lapSummary, lapTrace, whereAmILosingTime } from "../src/analysis/report.js";
import { loadFixture } from "./helpers/fixtures.js";

const db = openDb(":memory:");
const ingest = createIngest(db);
for (const p of loadFixture()) ingest.handle(p.data, p.recvMs);
ingest.close();
const laps = db.prepare(`SELECT id, lap_time_s FROM laps WHERE is_complete = 1 ORDER BY id`).all() as { id: number; lap_time_s: number }[];
const sessionId = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id;
const best = laps[0]!; // 1:53.010

describe("resampling", () => {
  it("produces a 1 m grid with monotonic time covering the lap", () => {
    const g = loadGrid(db, best.id);
    expect(g.step).toBe(1);
    expect(g.length).toBeGreaterThan(4465);
    for (let i = 1; i < g.t.length; i++) expect(g.t[i]!).toBeGreaterThanOrEqual(g.t[i - 1]!);
    expect(g.t[g.t.length - 1]!).toBeCloseTo(best.lap_time_s, 1);
    expect([...g.gear].every((x) => x >= 0 && x <= 10)).toBe(true); // mid-shift 11 replaced
  });

  it("interpolates between samples", () => {
    const s = (d: number, t: number, v: number): RawSample => ({
      t_ms: t, dist_m: d, speed_kmh: v, throttle: 0, brake: 0, steer: 0, gear: 3, rpm: 0, x: d, y: 0, z: 0,
      slip_fl: 0, slip_fr: 0, slip_rl: 0, slip_rr: 0,
    });
    const g = resample(1, [s(0, 0, 100), s(10, 1000, 200), s(9, 1100, 0) /* rollback dropped */, s(20, 2000, 100)]);
    expect(g.length).toBe(20);
    expect(g.t[5]).toBeCloseTo(0.5);
    expect(g.speed[15]).toBeCloseTo(150);
  });
});

describe("corners on the real lap", () => {
  const g = loadGrid(db, best.id);
  const corners = detectCorners(g);

  it("finds a plausible, ordered set of corners", () => {
    expect(corners.length).toBeGreaterThanOrEqual(10);
    expect(corners.length).toBeLessThanOrEqual(16);
    corners.forEach((c, k) => {
      expect(c.id).toBe(`T${k + 1}`);
      if (k) expect(c.zoneStart).toBeGreaterThan(corners[k - 1]!.zoneStart);
      expect(c.apex).toBeGreaterThanOrEqual(c.zoneStart);
    });
    // T1 is the heavy stop at the end of the main straight
    expect(corners[0]!.apex).toBeGreaterThan(150);
    expect(corners[0]!.apex).toBeLessThan(230);
  });

  it("corner segment times sum to the lap time", () => {
    const m = measureLap(g, corners, 1, best.lap_time_s);
    const sum = m.reduce((s, x) => s + x.segmentTime, 0);
    expect(sum).toBeCloseTo(best.lap_time_s, 2);
    const t1 = m[0]!;
    expect(t1.brakePoint).not.toBeNull();
    expect(t1.entrySpeed).toBeGreaterThan(t1.minSpeed + 100);
    expect(t1.exitSpeed).toBeGreaterThan(t1.minSpeed);
  });
});

describe("reports", () => {
  it("lap summary is compact and has a summary string", () => {
    const s = lapSummary(db, best.id);
    expect(s.lap_time_s).toBe(113.01);
    expect(s.corners.length).toBeGreaterThanOrEqual(10);
    expect(s.summary).toMatch(/^Lap 0 1:53\.010/);
    expect(JSON.stringify(s).length).toBeLessThan(5000);
  });

  it("comparing a lap with itself is all zeros", () => {
    const c = compareLaps(db, best.id, best.id);
    expect(c.total_delta_s).toBe(0);
    for (const d of c.corners) expect(d.time_delta_s).toBe(0);
  });

  it("corner deltas add up to the lap time difference", () => {
    const c = compareLaps(db, best.id, laps[1]!.id);
    const sum = c.corners.reduce((s, d) => s + d.time_delta_s, 0);
    expect(c.total_delta_s).toBeCloseTo(0.459, 3);
    expect(Math.abs(sum - c.total_delta_s!)).toBeLessThan(0.02);
    expect(c.summary).toContain("+0.459 s");
    expect(c.corners.find((d) => d.id === "T1")!.note).toMatch(/^T1: braked \d+ m later/);
  });

  it("where am I losing time ranks corners and bounds the theoretical best", () => {
    const w = whereAmILosingTime(db, sessionId);
    expect(w.best_lap.lap_time_s).toBe(113.01);
    expect(w.median_lap.lap_time_s).toBe(113.469);
    expect(w.theoretical_best_s).toBeLessThanOrEqual(113.01);
    const lost = w.ranked_losses.map((r) => r.lost_s);
    expect(lost).toEqual([...lost].sort((a, b) => b - a));
    // T11's apparent gain on lap 2 was paid back by going off in T12, so it must not count
    expect(w.best_segments.find((b) => b.id === "T11")?.from_lap).not.toBe(2);
  });

  it("consistency report covers every corner", () => {
    const c = consistencyReport(db, sessionId);
    expect(c.laps_used).toHaveLength(3);
    expect(c.corners.length).toBe(lapSummary(db, best.id).corners.length);
    expect(c.summary).toMatch(/^3 laps/);
  });

  it("lap trace downsamples a segment", () => {
    const t = lapTrace(db, best.id, 100, 200, 10);
    expect(t.points.map((p) => p.m)).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
  });
});
