import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { createIngest } from "../src/listener/ingest.js";
import { LiveCoach, type CoachMessage } from "../src/live/coach.js";
import { startDashServer } from "../src/live/server.js";
import { loadFixture } from "./helpers/fixtures.js";

const db = openDb(":memory:");
const ingest = createIngest(db);
const coach = new LiveCoach(db);
ingest.pipeline.onEvent = coach.event;
ingest.pipeline.onSample = coach.sample;
const msgs: CoachMessage[] = [];
coach.subscribe((m) => msgs.push(m));
for (const p of loadFixture()) ingest.handle(p.data, p.recvMs);
const snapshotMidLap = coach.snapshot();
ingest.close();

const of = <T extends CoachMessage["type"]>(t: T) => msgs.filter((m) => m.type === t) as Extract<CoachMessage, { type: T }>[];

describe("live coach on the real race", () => {
  it("uses the first timed lap as the reference once it is complete", () => {
    const refs = of("reference");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.lap_time_s).toBeCloseTo(113.01, 2);
    expect(refs[0]!.corners.length).toBeGreaterThan(5);
    expect(of("lap")[0]!.summary).toMatch(/first timed lap/);
  });

  it("streams frames with a live delta that ends at the lap time difference", () => {
    const frames = of("frame");
    expect(frames.length).toBeGreaterThan(1000);
    const lap5 = frames.filter((f) => f.delta_s !== null && f.lap_number === 1);
    const last = lap5[lap5.length - 1]!;
    expect(last.delta_s!).toBeCloseTo(113.469 - 113.01, 0); // +0.46 s at the line, within distance-alignment noise
    expect(last.next).not.toBeNull();
    // ~20 Hz away from brake markers: frames are at least FRAME_INTERVAL_MS apart in lap time
    const far = lap5.filter((f) => (f.next?.mark_in_s ?? 99) > 3);
    const i = far.findIndex((f, k) => k > 0 && lap5.indexOf(f) === lap5.indexOf(far[k - 1]!) + 1);
    expect(far[i]!.lap_time_s - far[i - 1]!.lap_time_s).toBeGreaterThanOrEqual(0.049);
  });

  it("calls out every corner once per timed lap, in order, with a tip", () => {
    const nCorners = of("reference")[0]!.corners.length;
    const byLap = new Map<number, string[]>();
    for (const c of of("callout")) byLap.set(c.lap_id, [...(byLap.get(c.lap_id) ?? []), c.id]);
    const complete = [...byLap.values()].filter((ids) => ids.length === nCorners);
    expect(complete.length).toBe(2);
    for (const ids of complete) expect(ids).toEqual(Array.from({ length: nCorners }, (_, k) => `T${k + 1}`));
    for (const c of of("callout")) expect(c.tip.length).toBeGreaterThan(5);
    const t3 = of("callout").find((c) => c.id === "T3")!;
    expect(t3.severity).toBe("loss");
    expect(t3.tip).toMatch(/apex/);
  });

  it("cues the previous lap's losses before the corner and reports each lap", () => {
    const cues = of("cue");
    expect(cues.map((c) => c.id)).toContain("T3");
    expect(cues.every((c) => !/Small losses/.test(c.tip))).toBe(true);
    const laps = of("lap");
    expect(laps).toHaveLength(3);
    expect(laps[1]!.delta_s).toBeCloseTo(0.459, 3);
    expect(laps[1]!.focus?.id).toBe("T3");
    expect(laps[1]!.theoretical_best_s!).toBeLessThanOrEqual(113.01);
    // the 2:06 crash lap must not make the theoretical best faster
    expect(laps[2]!.theoretical_best_s).toBe(laps[1]!.theoretical_best_s);
  });

  it("counts down to the reference brake point accurately and densely", () => {
    const frames = of("frame").filter((f) => f.delta_s !== null && f.next?.mark_kind === "brake");
    // in the last 2 s before a marker every sample is sent (~60 Hz), not 20 Hz
    const near = frames.filter((f) => f.next!.mark_in_s !== null && f.next!.mark_in_s! < 1);
    const gaps = near.slice(1).map((f, i) => f.lap_time_s - near[i]!.lap_time_s).filter((g) => g > 0 && g < 0.2);
    expect(gaps.sort((a, b) => a - b)[gaps.length >> 1]!).toBeLessThan(0.03);
    // 0.25 s out, the prediction is within ~30 ms of when the car actually reaches the marker
    const errs: number[] = [];
    frames.forEach((f, i) => {
      if (Math.abs(f.next!.mark_in_s! - 0.25) > 0.02) return;
      const j = frames.findIndex((g, k) => k > i && (g.next!.id !== f.next!.id || g.next!.mark_in_m <= 0));
      if (j < 0 || frames[j]!.lap_id !== f.lap_id) return;
      const p = frames[j - 1]!;
      const cross = p.lap_time_s + (p.next!.id === f.next!.id ? p.next!.mark_in_m : 0) / (p.speed_kmh / 3.6);
      errs.push(cross - f.lap_time_s - f.next!.mark_in_s!);
    });
    expect(errs.length).toBeGreaterThan(10);
    expect(Math.abs(errs.sort((a, b) => a - b)[errs.length >> 1]!)).toBeLessThan(0.03);
  });

  it("reports where each brake application landed vs the reference marker", () => {
    const hits = of("brake_hit");
    expect(hits.length).toBeGreaterThan(8);
    for (const h of hits) {
      expect(h.offset_m).toBeGreaterThanOrEqual(-120);
      expect(h.offset_m).toBeLessThanOrEqual(80);
      expect(h.verdict).toBe(Math.abs(h.offset_m) <= 5 ? "on" : h.offset_m < 0 ? "early" : "late");
    }
    // at most one per corner per lap, and the lap report carries them
    const keys = hits.map((h) => `${h.lap_id}:${h.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const lap = of("lap")[1]!;
    expect(lap.brake_marks.length).toBe(hits.filter((h) => h.lap_id === lap.lap_id).length);
    expect(of("lockup").length).toBeGreaterThan(0);
  });

  it("snapshots the in-progress lap for late-joining dashboards", () => {
    expect(snapshotMidLap.reference).not.toBeNull();
    expect(snapshotMidLap.lap).not.toBeNull();
    expect(snapshotMidLap.recent.some((m) => m.type === "lap")).toBe(true);
  });
});

describe("dashboard server", () => {
  const server = startDashServer(coach, 0, "127.0.0.1", db);
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const get = (path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const port = (server.address() as { port: number }).port;
      const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (path === "/events" && body.includes("\n\n")) {
            req.destroy();
            resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body }));
      });
      req.on("error", reject);
    });

  it("serves the page, the event stream and refuses path traversal", async () => {
    await new Promise((r) => (server.listening ? r(null) : server.once("listening", r)));
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("dash.js");
    const ev = await get("/events");
    expect(ev.type).toMatch(/event-stream/);
    expect(JSON.parse(ev.body.replace(/^data: /, "")).type).toBe("init");
    expect((await get("/..%2Fpackage.json")).status).toBe(404);
    expect((await get("/../package.json")).status).toBe(404);
  });

  it("serves the progress page and its API", async () => {
    await new Promise((r) => (server.listening ? r(null) : server.once("listening", r)));
    const page = await get("/progress.html");
    expect(page.status).toBe(200);
    expect(page.body).toContain("progress.js");
    const combos = JSON.parse((await get("/api/progress/combos")).body);
    expect(combos.combos[0]).toMatchObject({ track_ordinal: 1620, car_ordinal: 2529, best_lap: "1:53.010" });
    const rep = await get("/api/progress?track=1620&last=5");
    expect(rep.type).toMatch(/json/);
    const r = JSON.parse(rep.body);
    expect(r.personal_best.lap_time_s).toBe(113.01);
    expect(r.corners[0].medians).toHaveLength(r.sessions.length);
    expect(JSON.parse((await get("/api/progress/corner?corner=T2")).body).corner.id).toBe("T2");
    const bad = await get("/api/progress?track=x");
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/track must be a whole number/);
    expect((await get("/api/progress/corner")).status).toBe(400);
  });
});
