import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { createIngest } from "../src/listener/ingest.js";
import { cornerProgress, personalBests, progressReport, slope } from "../src/analysis/progress.js";
import { loadFixture } from "./helpers/fixtures.js";

const DAY = 86_400_000;

/** The fixture race driven `times` times, a day apart: one session each. */
function db(times: number) {
  const d = openDb(":memory:");
  const ingest = createIngest(d);
  for (let k = 0; k < times; k++) for (const p of loadFixture()) ingest.handle(p.data, p.recvMs + k * DAY);
  ingest.close();
  return d;
}
const sessions = (d: ReturnType<typeof db>) => (d.prepare(`SELECT id FROM sessions ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

describe("slope", () => {
  it("needs three points and fits a line", () => {
    expect(slope([1, 2])).toBeNull();
    expect(slope([3, 2, 1])).toBeCloseTo(-1);
    expect(slope([5, 5, 5, 5])).toBe(0);
  });
});

describe("progress report", () => {
  it("one session: no trend yet", () => {
    const r = progressReport(db(1));
    expect(r).toMatchObject({ track_ordinal: 1620, car_ordinal: 2529, sessions_total: 1 });
    expect(r.trend.pace).toBe("not enough data");
    expect(r.personal_best.lap_time_s).toBe(113.01);
    expect(r.corners.every((c) => c.status === "new")).toBe(true);
    expect(r.summary).toMatch(/Only one session so far/);
  });

  it("identical sessions are steady", () => {
    const r = progressReport(db(2));
    expect(r.sessions).toHaveLength(2);
    expect(r.trend).toMatchObject({ pace: "steady", best_change_s: 0, median_change_s: 0, consistency: "steady" });
    expect(r.corners.every((c) => c.status === "steady" && c.change_s === 0)).toBe(true);
    expect(r.pb_history).toHaveLength(1); // the second session only matched the PB
  });

  it("detects improvement when the later session is faster", () => {
    const d = db(2);
    const [s1] = sessions(d);
    // first session without its fastest lap → its best and median get slower, so session 2 is an improvement
    d.prepare(`UPDATE laps SET is_suspect = 1 WHERE session_id = ? AND lap_time_s = 113.01`).run(s1);
    const r = progressReport(d);
    expect(r.trend.pace).toBe("improving");
    expect(r.trend.best_change_s).toBeCloseTo(113.01 - 113.469, 3);
    expect(r.pb_history.map((p) => p.lap_time_s)).toEqual([113.469, 113.01]);
    expect(r.personal_best.session_id).toBe(sessions(d)[1]);
    expect(r.summary).toMatch(/^track 1620, car 2529, PI \d+: 2 sessions/);
    expect(r.summary).toMatch(/Pace improving/);
    // corner medians sum to (roughly) the session median lap, so some corners must have improved
    expect(r.improved.length).toBeGreaterThan(0);
  });

  it("keeps other tunes separate unless asked", () => {
    const d = db(2);
    const [s1] = sessions(d);
    d.prepare(`UPDATE sessions SET car_pi = car_pi - 10 WHERE id = ?`).run(s1);
    const r = progressReport(d);
    expect(r.sessions).toHaveLength(1);
    expect(r.other_tunes).toHaveLength(1);
    expect(r.summary).toMatch(/Other tunes not included/);
    expect(progressReport(d, { all_tunes: true }).sessions).toHaveLength(2);
  });

  it("windows to the last N sessions and rejects unknown combos", () => {
    const d = db(3);
    expect(progressReport(d, { last_sessions: 2 }).sessions).toHaveLength(2);
    expect(() => progressReport(d, { track_ordinal: 9999 })).toThrow(/no sessions for track 9999/);
  });
});

describe("corner progress", () => {
  it("reports one corner per session and accepts '3' for T3", () => {
    const r = cornerProgress(db(2), "3");
    expect(r.corner.id).toBe("T3");
    expect(r.sessions).toHaveLength(2);
    expect(r.change_s).toBe(0);
    expect(r.sessions[0]).toHaveProperty("min_kmh");
    expect(() => cornerProgress(db(1), "T99")).toThrow(/no corner T99/);
  });
});

describe("personal bests", () => {
  it("one row per track + car + tune", () => {
    const d = db(2);
    const [s1] = sessions(d);
    d.prepare(`UPDATE laps SET is_suspect = 1 WHERE session_id = ? AND lap_time_s = 113.01`).run(s1);
    const { combos, summary } = personalBests(d);
    expect(combos).toHaveLength(1);
    expect(combos[0]).toMatchObject({ sessions: 2, best_lap: "1:53.010", first_session_best_s: 113.469 });
    expect(combos[0]!.improvement_since_first_session_s).toBeCloseTo(0.459, 3);
    expect(summary).toMatch(/0\.46 s faster than your first session/);
  });
});
