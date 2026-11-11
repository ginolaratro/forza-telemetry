/** Print the analysis reports for a session. Usage: pnpm analyze [session_id] [--json] */
import { DB_PATH } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { getLapInfo } from "../src/analysis/grid.js";
import { compareLaps, consistencyReport, cornersFor, lapSummary, whereAmILosingTime } from "../src/analysis/report.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const db = openDb(DB_PATH, { readonly: true });
const sid = Number(args.find((a) => /^\d+$/.test(a)) ?? (db.prepare(`SELECT MAX(id) id FROM sessions`).get() as { id: number }).id);
const laps = db.prepare(`SELECT id FROM laps WHERE session_id = ? AND is_complete = 1 ORDER BY id`).all(sid) as { id: number }[];
const out = (label: string, v: unknown) => {
  console.log(`\n=== ${label} ===`);
  if (json) console.log(JSON.stringify(v, null, 1));
  else console.log((v as { summary?: string }).summary ?? v);
};
const { refLapId, corners } = cornersFor(db, getLapInfo(db, laps[0]!.id)!);
console.log(`session ${sid}, reference lap #${refLapId}, ${corners.length} corners:`);
for (const c of corners) console.log(`  ${c.id}: zone ${c.zoneStart}–${c.zoneEnd} m, apex ${c.apex} m, segment ${c.segStart}→${c.segEnd} m`);
for (const l of laps) out(`lap #${l.id}`, lapSummary(db, l.id));
for (const l of laps.slice(1)) out(`compare #${laps[0]!.id} → #${l.id}`, compareLaps(db, refLapId, l.id));
out("where am I losing time", whereAmILosingTime(db, sid));
out("consistency", consistencyReport(db, sid));
