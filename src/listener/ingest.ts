import { createDecoder, type DecoderEvents } from "./parser.js";
import { Pipeline } from "./pipeline.js";
import { TelemetryStore } from "../store/store.js";
import type { DB } from "../store/db.js";

/** Wire decoder → pipeline → store. Shared by the live listener and replay. */
export function createIngest(db: DB, events: DecoderEvents = {}) {
  const store = new TelemetryStore(db);
  const pipeline = new Pipeline(store);
  const decode = createDecoder(events);
  let lastFormat: string | null = null;
  return {
    store,
    pipeline,
    get lastFormat() {
      return lastFormat;
    },
    /** Returns true if the packet was a parsed IsRaceOn frame. */
    handle(buf: Buffer, recvMs: number): boolean {
      const t = decode(buf);
      if (!t) return false;
      lastFormat = t.format;
      pipeline.push(t, recvMs);
      return true;
    },
    close() {
      pipeline.close();
      store.close();
    },
  };
}
