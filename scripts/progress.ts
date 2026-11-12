/**
 * Print progress over time. Usage:
 *   pnpm progress                    latest track + car
 *   pnpm progress 1620 [--car 2529] [--all-tunes] [--last 10] [--corner T3] [--json]
 *   pnpm progress --pbs              personal bests for every track + car
 */
import { DB_PATH } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { cornerProgress, personalBests, progressReport, type ProgressOptions } from "../src/analysis/progress.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const json = args.includes("--json");
const db = openDb(DB_PATH, { readonly: true });
const opts: ProgressOptions = {
  track_ordinal: num(args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith("--"))),
  car_ordinal: num(flag("--car")),
  all_tunes: args.includes("--all-tunes"),
  last_sessions: num(flag("--last")),
};

if (args.includes("--pbs")) {
  const pbs = personalBests(db);
  if (json) console.log(JSON.stringify(pbs, null, 1));
  else for (const c of pbs.combos) {
    console.log(
      `track ${c.track_ordinal}  car ${c.car_ordinal}  PI ${c.car_pi ?? "?"}  ${c.best_lap}  ` +
        `(${c.sessions} sessions, ${c.clean_laps} laps, ` +
        (c.improvement_since_first_session_s > 0 ? `−${c.improvement_since_first_session_s.toFixed(3)} s since first session)` : "PB from first session)"),
    );
  }
} else if (flag("--corner")) {
  const r = cornerProgress(db, flag("--corner")!, opts);
  if (json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(r.summary + "\n");
    console.log("session  date        laps  median  best    brake  min    exit   lockup  off-line");
    for (const s of r.sessions) {
      console.log(
        [
          String(s.session_id).padEnd(7),
          new Date(s.started_at).toLocaleDateString("sv-SE").padEnd(10),
          String(s.laps).padStart(4),
          s.median_s.toFixed(2).padStart(7),
          (s.best_s?.toFixed(2) ?? "—").padStart(6),
          (s.brake_m === null ? "lift" : `${s.brake_m}m`).padStart(6),
          String(Math.round(s.min_kmh)).padStart(5),
          String(Math.round(s.exit_kmh)).padStart(6),
          `${Math.round(s.lockup_rate * 100)}%`.padStart(7),
          `${Math.round(s.off_line_rate * 100)}%`.padStart(9),
        ].join("  "),
      );
    }
  }
} else {
  const r = progressReport(db, opts);
  if (json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(r.summary.replace(/\. (?=[A-Z])/g, ".\n") + "\n");
    console.log("session  date        PI   laps  best      median    sd     theoretical");
    for (const s of r.sessions) {
      console.log(
        [
          String(s.session_id).padEnd(7),
          new Date(s.started_at).toLocaleDateString("sv-SE").padEnd(10),
          String(s.car_pi ?? "?").padEnd(3),
          String(s.clean_laps).padStart(4),
          s.best.padEnd(8),
          s.median.padEnd(8),
          (s.sd_s?.toFixed(2) ?? "—").padStart(5),
          "  " + s.theoretical,
        ].join("  "),
      );
    }
    console.log("\ncorner  status     first   latest  change  best-ever  gap");
    for (const c of r.corners) {
      console.log(
        [
          c.id.padEnd(6),
          c.status.padEnd(9),
          c.first_median_s.toFixed(2).padStart(6),
          c.latest_median_s.toFixed(2).padStart(7),
          (c.change_s === null ? "—" : `${c.change_s >= 0 ? "+" : "−"}${Math.abs(c.change_s).toFixed(2)}`).padStart(6),
          (c.best_ever_s?.toFixed(2) ?? "—").padStart(9),
          (c.latest_gap_to_best_s?.toFixed(2) ?? "—").padStart(5),
        ].join("  "),
      );
    }
  }
}
