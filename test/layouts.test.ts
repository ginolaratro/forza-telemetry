import { describe, expect, it } from "vitest";
import { DASH_FIELDS, FIELD_SIZE, FM2023_EXTRA_FIELDS, LAYOUTS, SLED_FIELDS, type FieldDef } from "../src/listener/layouts.js";

function assertContiguous(fields: readonly FieldDef[], start: number): number {
  let off = start;
  for (const f of fields) {
    expect(f.offset, `${f.name} offset`).toBe(off);
    off += FIELD_SIZE[f.type];
  }
  return off;
}

describe("layout tables", () => {
  it("Sled fields are contiguous and end at 232", () => {
    expect(assertContiguous(SLED_FIELDS, 0)).toBe(232);
  });
  it("Dash fields are contiguous 232..311", () => {
    expect(assertContiguous(DASH_FIELDS, 232)).toBe(311);
  });
  it("FM2023 extras are contiguous 311..331", () => {
    expect(assertContiguous(FM2023_EXTRA_FIELDS, 311)).toBe(331);
  });
  it("every layout fits inside its packet length and has unique names", () => {
    for (const layout of Object.values(LAYOUTS)) {
      const names = new Set<string>();
      for (const f of layout.fields) {
        expect(f.offset + FIELD_SIZE[f.type]).toBeLessThanOrEqual(layout.length);
        expect(names.has(f.name), `${layout.format} dup ${f.name}`).toBe(false);
        names.add(f.name);
      }
    }
  });
  it("Horizon dash block starts after the 12-byte insert and leaves 1 pad byte", () => {
    const fh = LAYOUTS[324]!;
    const pos = fh.fields.find((f) => f.name === "PositionX")!;
    const last = fh.fields.at(-1)!;
    expect(pos.offset).toBe(244);
    expect(last.name).toBe("NormalizedAIBrakeDifference");
    expect(last.offset + 1).toBe(323);
  });
  it("known key offsets match the official docs", () => {
    const fm = Object.fromEntries(LAYOUTS[331]!.fields.map((f) => [f.name, f.offset]));
    expect(fm).toMatchObject({
      CurrentEngineRpm: 16, TireSlipRatioFrontLeft: 84, TireSlipAngleFrontLeft: 164, TireCombinedSlipFrontLeft: 180,
      CarOrdinal: 212, DrivetrainType: 224, PositionX: 232, Speed: 244, TireTempFrontLeft: 256, DistanceTraveled: 280,
      BestLap: 284, LastLap: 288, LapNumber: 300, Accel: 303, Gear: 307, Steer: 308, TireWearFrontLeft: 311, TrackOrdinal: 327,
    });
  });
});
