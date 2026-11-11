import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

/** Ordered migrations; index + 1 = schema version stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    INTEGER NOT NULL,          -- epoch ms (receive time)
    ended_at      INTEGER,                   -- epoch ms, NULL while live
    game_format   TEXT NOT NULL,
    car_ordinal   INTEGER,
    car_class     INTEGER,
    car_pi        INTEGER,
    drivetrain    INTEGER,
    track_ordinal INTEGER
  );

  CREATE TABLE laps (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    lap_number        INTEGER NOT NULL,      -- game LapNumber (0-based)
    lap_time_s        REAL,                  -- from LastLap at the transition; NULL if incomplete
    is_complete       INTEGER NOT NULL DEFAULT 0,
    is_suspect        INTEGER NOT NULL DEFAULT 0,
    start_distance    REAL,                  -- DistanceTraveled at the lap start line
    is_outlap         INTEGER NOT NULL DEFAULT 0, -- segment that didn't start at the line (grid, pit, joined mid-lap)
    had_rewind        INTEGER NOT NULL DEFAULT 0,
    start_race_time_s REAL,                  -- CurrentRaceTime at lap start (for rewind handling)
    started_at        INTEGER,               -- epoch ms
    fuel_start        REAL,
    fuel_end          REAL
  );
  CREATE INDEX laps_session ON laps(session_id, lap_number);

  CREATE TABLE samples (
    lap_id    INTEGER NOT NULL REFERENCES laps(id) ON DELETE CASCADE,
    t_ms      INTEGER NOT NULL,              -- time since lap start
    dist_m    REAL NOT NULL,                 -- distance since lap start
    speed_ms  REAL,
    speed_kmh REAL,
    throttle  REAL,                          -- 0..1
    brake     REAL,                          -- 0..1
    steer     REAL,                          -- -1..1
    gear      INTEGER,
    rpm       REAL,
    x REAL, y REAL, z REAL,
    slip_fl REAL, slip_fr REAL, slip_rl REAL, slip_rr REAL  -- tire slip ratio
  );
  CREATE INDEX samples_lap_dist ON samples(lap_id, dist_m);

  -- Single-row heartbeat written by the listener so other processes (MCP) can see live state.
  CREATE TABLE listener_status (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    updated_at      INTEGER NOT NULL,
    last_packet_at  INTEGER,
    packets_per_sec REAL,
    game_format     TEXT,
    session_id      INTEGER,
    lap_id          INTEGER,
    lap_number      INTEGER,
    current_lap_s   REAL,
    speed_kmh       REAL
  );
  `,
];

export function openDb(file: string, opts: { readonly?: boolean } = {}): DB {
  if (file !== ":memory:" && !opts.readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
  if (opts.readonly) {
    db.pragma("query_only = ON");
    return db;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
