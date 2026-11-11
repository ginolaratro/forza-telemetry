/**
 * Raw capture file format (.bin), little-endian:
 *
 *   header:  8 bytes  ASCII "FZCAP001"
 *   record:  float64  receive time, ms since Unix epoch (sub-ms precision)
 *            uint16   payload length N
 *            N bytes  raw UDP payload, untouched
 *
 * Records are appended as packets arrive, so a file truncated by a crash is
 * still readable up to the last complete record.
 */
import fs from "node:fs";

export const CAPTURE_MAGIC = Buffer.from("FZCAP001", "ascii");
const RECORD_HEADER = 10;

export interface CapturedPacket {
  recvMs: number;
  data: Buffer;
}

export function encodeRecord(recvMs: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(RECORD_HEADER + data.length);
  out.writeDoubleLE(recvMs, 0);
  out.writeUInt16LE(data.length, 8);
  data.copy(out, RECORD_HEADER);
  return out;
}

export function* decodeCapture(buf: Buffer): Generator<CapturedPacket> {
  if (buf.length < CAPTURE_MAGIC.length || !buf.subarray(0, 8).equals(CAPTURE_MAGIC)) {
    throw new Error("Not a Forza capture file (bad magic)");
  }
  let off = CAPTURE_MAGIC.length;
  while (off + RECORD_HEADER <= buf.length) {
    const recvMs = buf.readDoubleLE(off);
    const len = buf.readUInt16LE(off + 8);
    const start = off + RECORD_HEADER;
    if (start + len > buf.length) break; // truncated tail
    yield { recvMs, data: buf.subarray(start, start + len) };
    off = start + len;
  }
}

export function readCapture(file: string): Generator<CapturedPacket> {
  return decodeCapture(fs.readFileSync(file));
}
