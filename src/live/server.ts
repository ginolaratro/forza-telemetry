/**
 * Dashboard HTTP server: static page from public/dash + a Server-Sent Events stream of coach messages.
 * GET /          dashboard
 * GET /events    SSE: one `init` snapshot, then every CoachMessage as JSON
 * GET /api/state current snapshot (debugging)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../config.js";
import type { LiveCoach } from "./coach.js";

const STATIC_DIR = path.join(ROOT, "public", "dash");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startDashServer(coach: LiveCoach, port: number, host = "0.0.0.0"): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/events") return stream(coach, req, res);
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
