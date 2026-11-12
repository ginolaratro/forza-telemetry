/**
 * Dashboard HTTP server: static page from public/dash + a Server-Sent Events stream of coach messages.
 * GET /          dashboard
 * GET /events    SSE: one `init` snapshot, then every CoachMessage as JSON
 * GET /api/state current snapshot (debugging)
 * GET /progress.html                progress over time (static page)
 * GET /api/progress/combos          personal bests per track + car + tune (the page's combo picker)
 * GET /api/progress?track&car&pi&all_tunes=1&last   progress report
 * GET /api/progress/corner?corner=T3&track&car&pi&all_tunes=1&last   one corner over time
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../config.js";
import type { LiveCoach } from "./coach.js";
import type { DB } from "../store/db.js";
import { cornerProgress, personalBests, progressReport, type ProgressOptions } from "../analysis/progress.js";

const STATIC_DIR = path.join(ROOT, "public", "dash");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startDashServer(coach: LiveCoach, port: number, host = "0.0.0.0", db?: DB): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/events") return stream(coach, req, res);
    if (url.pathname.startsWith("/api/progress")) return progressApi(db, url, res);
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(coach.snapshot()));
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(STATIC_DIR, rel);
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, host);
  return server;
}

function sendJson(res: http.ServerResponse, status: number, v: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify(v));
}

/** Query string → progress options (anything missing defaults to the latest session's combo). */
export function progressOptions(q: URLSearchParams): ProgressOptions {
  const int = (k: string) => {
    const v = q.get(k);
    if (v === null || v === "") return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`${k} must be a whole number`);
    return Number(v);
  };
  const last = int("last");
  return {
    track_ordinal: int("track"),
    car_ordinal: int("car"),
    car_pi: int("pi"),
    all_tunes: q.get("all_tunes") === "1",
    last_sessions: last === undefined ? undefined : Math.min(100, Math.max(1, last)),
  };
}

// Analysis runs synchronously on the listener's thread; a report over a few dozen laps takes well under a second
// and per-lap metrics are cached, so UDP packets only queue briefly in the socket buffer.
function progressApi(db: DB | undefined, url: URL, res: http.ServerResponse) {
  if (!db) return sendJson(res, 503, { error: "progress needs the database (start the dashboard from `pnpm listen`)" });
  try {
    if (url.pathname === "/api/progress/combos") return sendJson(res, 200, personalBests(db));
    const opts = progressOptions(url.searchParams);
    if (url.pathname === "/api/progress/corner") {
      const corner = url.searchParams.get("corner");
      if (!corner) return sendJson(res, 400, { error: "corner is required, e.g. ?corner=T3" });
      return sendJson(res, 200, cornerProgress(db, corner, opts));
    }
    if (url.pathname === "/api/progress") return sendJson(res, 200, progressReport(db, opts));
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function stream(coach: LiveCoach, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  const send = (m: unknown) => res.write(`data: ${JSON.stringify(m)}\n\n`);
  send(coach.snapshot());
  const unsub = coach.subscribe((m) => {
    // Drop frames for a client that can't keep up instead of buffering without bound.
    if (m.type === "frame" && res.writableLength > 256 * 1024) return;
    send(m);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    unsub();
    clearInterval(ping);
  });
}

/** http://<lan-ip>:port for every IPv4 interface, LAN first. */
export function dashUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  out.push(`http://localhost:${port}`);
  return out;
}
