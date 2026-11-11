import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/store/db.js";
import { createIngest } from "../src/listener/ingest.js";
import { createServer } from "../src/mcp/server.js";
import { loadFixture } from "./helpers/fixtures.js";

const db = openDb(":memory:");
const ingest = createIngest(db);
for (const p of loadFixture()) ingest.handle(p.data, p.recvMs);
ingest.close();

const server = createServer(db);
const client = new Client({ name: "test", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: !!r.isError, text: r.content[0]!.text, data: r.isError ? null : JSON.parse(r.content[0]!.text) };
}

describe("mcp server", () => {
  it("lists the coaching tools as read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_laps", "consistency_report", "get_lap_trace", "get_status", "get_track_corners",
      "lap_summary", "list_laps", "list_sessions", "where_am_i_losing_time",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("lists sessions and laps, defaulting to the latest session", async () => {
    const sessions = (await call("list_sessions")).data;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ car_ordinal: 2529, track_ordinal: 1620, complete_laps: 3, best_lap: "1:53.010" });
    const { laps } = (await call("list_laps")).data;
    expect(laps.filter((l: { is_complete: boolean }) => l.is_complete)).toHaveLength(3);
    expect(laps.find((l: { gap_to_best_s: number | null }) => l.gap_to_best_s === 0)).toBeTruthy();
  });

  it("runs the session analyses", async () => {
    const loss = (await call("where_am_i_losing_time")).data;
    expect(loss.theoretical_best_s).toBeLessThanOrEqual(loss.best_lap.lap_time_s);
    const cons = (await call("consistency_report")).data;
    expect(cons.laps_used.length).toBeGreaterThanOrEqual(2);
    const { corners } = (await call("get_track_corners")).data;
    expect(corners.length).toBe(cons.corners.length);
  });

  it("compares against the reference lap by default", async () => {
    const { laps } = (await call("list_laps")).data;
    const complete = laps.filter((l: { is_complete: boolean }) => l.is_complete);
    const slowest = complete.reduce((p: { lap_time_s: number }, c: { lap_time_s: number }) => (c.lap_time_s > p.lap_time_s ? c : p));
    const cmp = (await call("compare_laps", { lap_b: slowest.id })).data;
    expect(cmp.lap_a.id).toBe(cmp.reference_lap_id);
    expect(cmp.total_delta_s).toBeGreaterThan(0);
  });

  it("returns a bounded trace and readable errors", async () => {
    const { reference_lap_id, corners } = (await call("get_track_corners")).data;
    const [lo, hi] = corners[0].segment_m;
    const trace = (await call("get_lap_trace", { lap_id: reference_lap_id, start_m: lo, end_m: hi, step_m: 10 })).data;
    expect(trace.points[0]).toHaveProperty("kmh");
    expect((await call("get_lap_trace", { lap_id: reference_lap_id, step_m: 1 })).text).toMatch(/narrow the range/);
    const missing = await call("lap_summary", { lap_id: 99999 });
    expect(missing).toMatchObject({ isError: true, text: "Error: lap 99999 not found" });
    expect((await call("get_status")).data.live).toBe(false);
  });
});
