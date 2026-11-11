import { describe, expect, it, vi } from "vitest";
import { LAYOUTS, type Layout } from "../src/listener/layouts.js";
import { createDecoder, parsePacket, readRaw } from "../src/listener/parser.js";
import { loadFixture } from "./helpers/fixtures.js";

const packets = loadFixture();
const parsed = packets.map((p) => parsePacket(p.data)!);

describe("parser on real FM2023 capture", () => {
  it("parses every packet as fm2023", () => {
    expect(packets.length).toBeGreaterThan(20000);
    for (const t of parsed) expect(t.format).toBe("fm2023");
  });

  it("produces sane, finite values", () => {
    for (const t of parsed) {
      expect(t.speedMs!).toBeGreaterThanOrEqual(0);
      expect(t.speedKmh!).toBeCloseTo(t.speedMs! * 3.6, 6);
      expect(t.speedKmh!).toBeLessThan(500);
      // 0 = reverse, 1..10 forward; FM2023 reports 11 for ~130 ms mid-shift (neutral)
      expect(t.gear!).toBeGreaterThanOrEqual(0);
      expect(t.gear!).toBeLessThanOrEqual(11);
      for (const v of [t.throttle!, t.brake!, t.clutch!, t.handbrake!, t.fuel!]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(t.steer!)).toBeLessThanOrEqual(1);
      expect(t.rpm).toBeGreaterThanOrEqual(0);
      expect(t.rpm).toBeLessThanOrEqual(t.engineMaxRpm + 1);
      for (const c of t.tireTempC!) expect(c).toBeGreaterThan(-40), expect(c).toBeLessThan(400);
      for (const w of t.tireWear!) expect(w).toBeGreaterThanOrEqual(0), expect(w).toBeLessThanOrEqual(1);
      for (const v of [t.position!.x, t.position!.y, t.position!.z, ...t.slipRatio, ...t.combinedSlip]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("has a constant car/track for the session", () => {
    const keys = new Set(parsed.map((t) => `${t.carOrdinal}/${t.carClass}/${t.carPI}/${t.drivetrain}/${t.trackOrdinal}`));
    expect([...keys]).toEqual(["2529/4/699/1/1620"]);
  });

  it("lap numbers are monotonic and LastLap at each increment matches the lap timer", () => {
    let prev = parsed[0]!;
    const transitions: number[] = [];
    for (const t of parsed.slice(1)) {
      expect(t.lapNumber!).toBeGreaterThanOrEqual(prev.lapNumber!);
      if (t.lapNumber! > prev.lapNumber!) {
        expect(t.lapNumber).toBe(prev.lapNumber! + 1);
        // CurrentLap just before the line ≈ LastLap just after (within a couple of frames)
        expect(Math.abs(t.lastLap! - prev.currentLap!)).toBeLessThan(0.05);
        transitions.push(t.lastLap!);
      }
      prev = t;
    }
    expect(transitions.map((x) => x.toFixed(3))).toEqual(["113.010", "113.469", "126.164"]);
    expect(Math.min(...parsed.filter((t) => t.lapNumber! >= 1).map((t) => t.bestLap!))).toBeCloseTo(113.01, 2);
  });

  it("throttle/brake are normalized from bytes", () => {
    const p = packets.find((x) => x.data.readUInt8(303) === 255)!;
    expect(parsePacket(p.data)!.throttle).toBe(1);
  });
});

/** Re-encode a parsed raw map into another layout (round-trip through the tables). */
function encode(layout: Layout, raw: Record<string, number>): Buffer {
  const buf = Buffer.alloc(layout.length);
  for (const f of layout.fields) {
    const v = raw[f.name] ?? 0;
    switch (f.type) {
      case "s32": buf.writeInt32LE(v, f.offset); break;
      case "u32": buf.writeUInt32LE(v, f.offset); break;
      case "f32": buf.writeFloatLE(v, f.offset); break;
      case "u16": buf.writeUInt16LE(v, f.offset); break;
      case "u8": buf.writeUInt8(v, f.offset); break;
      case "s8": buf.writeInt8(v, f.offset); break;
    }
  }
  return buf;
}

describe("other formats (synthesized from real values)", () => {
  const sample = packets[5000]!.data;
  const raw = readRaw(sample, LAYOUTS[331]!) as Record<string, number>;
  const ref = parsePacket(sample)!;

  it("FM7 Dash (311) parses the same dash values", () => {
    const t = parsePacket(encode(LAYOUTS[311]!, raw))!;
    expect(t.format).toBe("fm7_dash");
    expect(t.speedKmh).toBeCloseTo(ref.speedKmh!, 4);
    expect(t.lapNumber).toBe(ref.lapNumber);
    expect(t.gear).toBe(ref.gear);
    expect(t.tireWear).toBeNull();
    expect(t.trackOrdinal).toBeNull();
  });

  it("Horizon (324) reads dash fields after the 12-byte insert", () => {
    const buf = encode(LAYOUTS[324]!, raw);
    buf.fill(0xab, 232, 244); // garbage in the Horizon-only block must not leak into dash fields
    const t = parsePacket(buf)!;
    expect(t.format).toBe("fh");
    expect(t.position).toEqual(ref.position);
    expect(t.speedKmh).toBeCloseTo(ref.speedKmh!, 4);
    expect(t.steer).toBeCloseTo(ref.steer!, 6);
    expect(t.lapNumber).toBe(ref.lapNumber);
  });

  it("Sled (232) has null dash fields", () => {
    const t = parsePacket(sample.subarray(0, 232))!;
    expect(t.format).toBe("fm7_sled");
    expect(t.rpm).toBeCloseTo(ref.rpm, 4);
    expect(t.speedKmh).toBeNull();
    expect(t.lapNumber).toBeNull();
  });
});

describe("createDecoder", () => {
  it("drops IsRaceOn=0, logs unknown sizes and Sled once", () => {
    const onUnknownSize = vi.fn();
    const onSledFormat = vi.fn();
    const decode = createDecoder({ onUnknownSize, onSledFormat });
    const live = packets[5000]!.data;
    const idle = Buffer.from(live);
    idle.writeInt32LE(0, 0);
    expect(decode(live)).not.toBeNull();
    expect(decode(idle)).toBeNull();
    expect(decode(Buffer.alloc(100))).toBeNull();
    expect(decode(Buffer.alloc(100))).toBeNull();
    expect(onUnknownSize).toHaveBeenCalledTimes(1);
    expect(onUnknownSize).toHaveBeenCalledWith(100);
    decode(live.subarray(0, 232));
    decode(live.subarray(0, 232));
    expect(onSledFormat).toHaveBeenCalledTimes(1);
  });
});
