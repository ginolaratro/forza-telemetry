import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { decodeCapture, type CapturedPacket } from "../../src/listener/capture-format.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const cache = new Map<string, CapturedPacket[]>();

/** Real FM2023 race capture: Data Out Dash, car 2529, track 1620, 3 completed laps + rewinds. */
export function loadFixture(name = "fm2023-race.bin.gz"): CapturedPacket[] {
  let pkts = cache.get(name);
  if (!pkts) {
    const buf = zlib.gunzipSync(fs.readFileSync(path.join(DIR, name)));
    pkts = [...decodeCapture(buf)];
    cache.set(name, pkts);
  }
  return pkts;
}
