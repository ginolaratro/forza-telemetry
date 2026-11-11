/**
 * MCP server exposing the telemetry store + analysis as coaching tools.
 * All tools are read-only; the listener is the only writer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DB } from "../store/db.js";
import { getLapInfo } from "../analysis/grid.js";
import {
  compareLaps,
  consistencyReport,
  cornersFor,
  fmtLap,
  lapSummary,
  lapTrace,
  referenceLapId,
  whereAmILosingTime,
} from "../analysis/report.js";

/** Listener heartbeat older than this means nothing is streaming. */
export const LIVE_STALE_MS = 5_000;
const MAX_TRACE_POINTS = 2_000;

const INSTRUCTIONS = `Forza Motorsport telemetry coach. Data comes from the game's Data Out stream, stored per session → lap → samples.
- Session ids and lap ids are database ids (lap_number is the in-game 0-based lap counter). Omit session_id to use the most recent session.
- Corners are named T1, T2, … numbered on the reference lap (fastest clean lap on that track); positions are meters from the start line.
- Sign conventions in comparisons: lap A is the baseline; positive time_delta_s = B slower, positive brake_delta_m = B brakes later, positive throttle_delta_m = B gets on throttle later.
- Laps flagged is_suspect (>130% of session median), is_outlap or had_rewind are excluded from best/median/consistency unless asked.
- Start with where_am_i_losing_time for "how do I go faster", consistency_report for "where am I inconsistent", compare_laps for two specific laps, and get_lap_trace only when you need the raw inputs through a specific corner.
- Car and track are game ordinals (numbers), not names.`;

type Opener = () => DB;

function json(v: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(v) }] };
}

function fail(e: unknown) {
  return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

/** `db` may be a handle or a lazy opener, so the server can start before the listener has created the DB. */
export function createServer(db: DB | Opener): McpServer {
  let handle: DB | null = typeof db === "function" ? null : db;
  const getDb = () => (handle ??= (db as Opener)());

  const server = new McpServer({ name: "forza-telemetry", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    fn: (db: DB, args: z.infer<z.ZodObject<S>>) => unknown,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          return json(fn(getDb(), args));
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );

  const latestSession = (db: DB): number => {
    const r = db.prepare(`SELECT MAX(id) AS id FROM sessions`).get() as { id: number | null };
    if (r.id === null) throw new Error("no sessions recorded yet — run `pnpm listen` and drive some laps");
    return r.id;
  };
  const sessionArg = { session_id: z.number().int().optional().describe("Session id; defaults to the most recent session") };

  tool("get_status", "Whether the listener is receiving telemetry right now, and the live session/lap/speed.", {}, (db) => {
    const s = db.prepare(`SELECT * FROM listener_status WHERE id = 1`).get() as Record<string, unknown> | undefined;
    if (!s) return { live: false, summary: "The listener has never run against this database." };
    const age = Date.now() - Number(s.last_packet_at ?? s.updated_at);
    const live = s.last_packet_at != null && age < LIVE_STALE_MS;
    return {
      live,
      seconds_since_last_packet: s.last_packet_at == null ? null : Math.round(age / 1000),
      packets_per_sec: s.packets_per_sec,
      session_id: s.session_id,
      lap_id: s.lap_id,
      lap_number: s.lap_number,
      current_lap_s: s.current_lap_s,
      speed_kmh: s.speed_kmh,
      summary: live
        ? `Live: session ${s.session_id}, lap ${s.lap_number}, ${fmtLap(s.current_lap_s as number)} into the lap at ${Math.round(Number(s.speed_kmh))} km/h.`
        : `Not live; last packet ${s.last_packet_at == null ? "never" : `${Math.round(age / 1000)} s ago`}.`,
    };
  });

  tool(
    "list_sessions",
    "Recent sessions with car, track, lap counts and best lap time.",
    {
      limit: z.number().int().min(1).max(100).default(10),
      track_ordinal: z.number().int().optional().describe("Only sessions on this track"),
      car_ordinal: z.number().int().optional().describe("Only sessions in this car"),
    },
    (db, { limit, track_ordinal, car_ordinal }) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.started_at, s.ended_at, s.game_format, s.car_ordinal, s.car_class, s.car_pi, s.drivetrain, s.track_ordinal,
                  COUNT(l.id) AS laps, COALESCE(SUM(l.is_complete), 0) AS complete_laps,
                  MIN(CASE WHEN l.is_complete AND NOT l.is_suspect THEN l.lap_time_s END) AS best_lap_s
           FROM sessions s LEFT JOIN laps l ON l.session_id = s.id
           WHERE (@track IS NULL OR s.track_ordinal = @track) AND (@car IS NULL OR s.car_ordinal = @car)
           GROUP BY s.id ORDER BY s.id DESC LIMIT @limit`,
        )
        .all({ track: track_ordinal ?? null, car: car_ordinal ?? null, limit }) as Record<string, number | string | null>[];
      return rows.map((r) => ({
        ...r,
        started_at: new Date(r.started_at as number).toISOString(),
        ended_at: r.ended_at == null ? null : new Date(r.ended_at as number).toISOString(),
        best_lap: fmtLap(r.best_lap_s as number | null),
      }));
    },
  );

  tool("list_laps", "All laps of a session with times and quality flags.", sessionArg, (db, { session_id }) => {
    const sid = session_id ?? latestSession(db);
    const laps = db
      .prepare(
        `SELECT id, lap_number, lap_time_s, is_complete, is_suspect, is_outlap, had_rewind, fuel_start, fuel_end
         FROM laps WHERE session_id = ? ORDER BY id`,
      )
      .all(sid) as Record<string, number | null>[];
    if (!laps.length && !db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sid)) throw new Error(`session ${sid} not found`);
    const best = Math.min(...laps.filter((l) => l.is_complete && !l.is_suspect).map((l) => l.lap_time_s!));
    return {
      session_id: sid,
      laps: laps.map((l) => ({
        id: l.id,
        lap_number: l.lap_number,
        lap_time: fmtLap(l.lap_time_s),
        lap_time_s: l.lap_time_s,
        gap_to_best_s: l.is_complete && Number.isFinite(best) ? Math.round((l.lap_time_s! - best) * 1000) / 1000 : null,
        is_complete: !!l.is_complete,
        is_suspect: !!l.is_suspect,
        is_outlap: !!l.is_outlap,
        had_rewind: !!l.had_rewind,
        fuel_used: l.fuel_start != null && l.fuel_end != null ? Math.round((l.fuel_start - l.fuel_end) * 1000) / 1000 : null,
      })),
    };
  });

  tool(
    "get_track_corners",
    "Corner layout (T1…Tn) for a session's track: braking zone, apex and timing segment in meters from the line.",
    sessionArg,
    (db, { session_id }) => {
      const sid = session_id ?? latestSession(db);
      const lap = db.prepare(`SELECT id FROM laps WHERE session_id = ? ORDER BY is_complete DESC, id LIMIT 1`).get(sid) as
        | { id: number }
        | undefined;
      if (!lap) throw new Error(`session ${sid} has no laps`);
      const { refLapId, corners } = cornersFor(db, getLapInfo(db, lap.id)!);
      return {
        reference_lap_id: refLapId,
        corners: corners.map((c) => ({
          id: c.id,
          zone_m: [c.zoneStart, c.zoneEnd],
          apex_m: c.apex,
          segment_m: [c.segStart, c.segEnd],
        })),
      };
    },
  );

  tool(
    "lap_summary",
    "One lap: throttle/brake/coasting shares, top speed, and per-corner brake point, entry/min/exit speed, throttle pickup, lockups and wheelspin.",
    { lap_id: z.number().int() },
    (db, { lap_id }) => lapSummary(db, lap_id),
  );

  tool(
    "compare_laps",
    "Corner-by-corner comparison of lap B against baseline lap A, with a distance-based delta curve. Omit lap_a to compare against the reference (fastest clean) lap on that track.",
    {
      lap_b: z.number().int().describe("The lap being analysed"),
      lap_a: z.number().int().optional().describe("Baseline lap; defaults to the track reference lap"),
    },
    (db, { lap_a, lap_b }) => {
      let a = lap_a;
      if (a === undefined) {
        const info = getLapInfo(db, lap_b);
        if (!info) throw new Error(`lap ${lap_b} not found`);
        a = referenceLapId(db, info) ?? undefined;
        if (a === undefined) throw new Error("no clean complete lap on this track to compare against");
      }
      return compareLaps(db, a, lap_b);
    },
  );

  tool(
    "where_am_i_losing_time",
    "Best vs median lap of a session, corners ranked by time lost, plus the theoretical best lap from the best segment per corner.",
    sessionArg,
    (db, { session_id }) => whereAmILosingTime(db, session_id ?? latestSession(db)),
  );

  tool(
    "consistency_report",
    "Lap-to-lap variation per corner (segment time, brake point, min/exit speed spread) and counts of lockups, wheelspin and off-line laps.",
    { ...sessionArg, include_suspect: z.boolean().default(false).describe("Include laps flagged as suspect (very slow)") },
    (db, { session_id, include_suspect }) => consistencyReport(db, session_id ?? latestSession(db), include_suspect),
  );

  tool(
    "get_lap_trace",
    `Raw inputs along a lap section, resampled by distance: speed, throttle, brake, steer, gear, rpm, position. Use a corner's segment from get_track_corners as the range. At most ${MAX_TRACE_POINTS} points.`,
    {
      lap_id: z.number().int(),
      start_m: z.number().min(0).default(0),
      end_m: z.number().positive().optional().describe("Defaults to the end of the lap"),
      step_m: z.number().min(1).max(100).default(5),
    },
    (db, { lap_id, start_m, end_m, step_m }) => {
      if (end_m !== undefined && end_m <= start_m) throw new Error("end_m must be greater than start_m");
      const trace = lapTrace(db, lap_id, start_m, end_m, step_m);
      if (trace.points.length > MAX_TRACE_POINTS) {
        throw new Error(`${trace.points.length} points requested; narrow the range or raise step_m (max ${MAX_TRACE_POINTS})`);
      }
      return trace;
    },
  );

  return server;
}
