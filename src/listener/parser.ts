import { FIELD_SIZE, LAYOUTS, type FieldDef, type FieldName, type GameFormat, type Layout } from "./layouts.js";

export type Quad = [fl: number, fr: number, rl: number, rr: number];

/** One parsed + unit-normalized telemetry frame. Dash-only fields are null for Sled packets. */
export interface Telemetry {
  format: GameFormat;
  isRaceOn: boolean;
  timestampMs: number; // game clock, wraps at 2^32
  engineMaxRpm: number;
  engineIdleRpm: number;
  rpm: number;
  accel: { x: number; y: number; z: number }; // m/s², car-local
  velocity: { x: number; y: number; z: number }; // m/s, car-local
  angularVelocity: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  roll: number;
  suspensionTravel: Quad; // normalized 0..1
  slipRatio: Quad;
  slipAngle: Quad;
  combinedSlip: Quad;
  wheelOnRumble: Quad;
  carOrdinal: number;
  carClass: number;
  carPI: number;
  drivetrain: number;
  numCylinders: number;

  // --- Dash formats only ---
  position: { x: number; y: number; z: number } | null;
  speedMs: number | null;
  speedKmh: number | null;
  powerW: number | null;
  torqueNm: number | null;
  tireTempF: Quad | null;
  tireTempC: Quad | null;
  boost: number | null;
  fuel: number | null; // 0..1
  distanceTraveled: number | null; // m
  bestLap: number | null; // s
  lastLap: number | null;
  currentLap: number | null;
  currentRaceTime: number | null;
  lapNumber: number | null; // 0-based
  racePosition: number | null;
  throttle: number | null; // 0..1
  brake: number | null; // 0..1
  clutch: number | null; // 0..1
  handbrake: number | null; // 0..1
  gear: number | null; // 0 = reverse, 1..10 forward (11 = neutral in some titles)
  steer: number | null; // -1..1

  // --- FM2023 only ---
  tireWear: Quad | null;
  trackOrdinal: number | null;
}

export type RawFields = Partial<Record<FieldName, number>>;

function readField(buf: Buffer, f: FieldDef): number {
  switch (f.type) {
    case "s32": return buf.readInt32LE(f.offset);
    case "u32": return buf.readUInt32LE(f.offset);
    case "f32": return buf.readFloatLE(f.offset);
    case "u16": return buf.readUInt16LE(f.offset);
    case "u8": return buf.readUInt8(f.offset);
    case "s8": return buf.readInt8(f.offset);
  }
}

export function layoutFor(length: number): Layout | undefined {
  return LAYOUTS[length];
}

/** Read every field of a layout into a name → value map (no unit conversion). */
export function readRaw(buf: Buffer, layout: Layout): RawFields {
  const out: RawFields = {};
  for (const f of layout.fields) {
    if (f.offset + FIELD_SIZE[f.type] > buf.length) throw new RangeError(`field ${f.name} past end of packet`);
    out[f.name as FieldName] = readField(buf, f);
  }
  return out;
}

const F_TO_C = (f: number) => ((f - 32) * 5) / 9;
const MS_TO_KMH = 3.6;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parse a raw UDP payload. Returns null for unknown packet sizes. */
export function parsePacket(buf: Buffer): Telemetry | null {
  const layout = layoutFor(buf.length);
  if (!layout) return null;
  const r = readRaw(buf, layout);
  const g = (n: FieldName): number => r[n] ?? 0;
  const q = (prefix: string): Quad => [
    g(`${prefix}FrontLeft` as FieldName),
    g(`${prefix}FrontRight` as FieldName),
    g(`${prefix}RearLeft` as FieldName),
    g(`${prefix}RearRight` as FieldName),
  ];
  const dash = layout.hasDash;
  const fm23 = layout.format === "fm2023";
  const speedMs = dash ? g("Speed") : null;
  const tireTempF = dash ? q("TireTemp") : null;

  return {
    format: layout.format,
    isRaceOn: g("IsRaceOn") !== 0,
    timestampMs: g("TimestampMS"),
    engineMaxRpm: g("EngineMaxRpm"),
    engineIdleRpm: g("EngineIdleRpm"),
    rpm: g("CurrentEngineRpm"),
    accel: { x: g("AccelerationX"), y: g("AccelerationY"), z: g("AccelerationZ") },
    velocity: { x: g("VelocityX"), y: g("VelocityY"), z: g("VelocityZ") },
    angularVelocity: { x: g("AngularVelocityX"), y: g("AngularVelocityY"), z: g("AngularVelocityZ") },
    yaw: g("Yaw"),
    pitch: g("Pitch"),
    roll: g("Roll"),
    suspensionTravel: q("NormalizedSuspensionTravel"),
    slipRatio: q("TireSlipRatio"),
    slipAngle: q("TireSlipAngle"),
    combinedSlip: q("TireCombinedSlip"),
    wheelOnRumble: q("WheelOnRumbleStrip"),
    carOrdinal: g("CarOrdinal"),
    carClass: g("CarClass"),
    carPI: g("CarPerformanceIndex"),
    drivetrain: g("DrivetrainType"),
    numCylinders: g("NumCylinders"),

    position: dash ? { x: g("PositionX"), y: g("PositionY"), z: g("PositionZ") } : null,
    speedMs,
    speedKmh: speedMs === null ? null : speedMs * MS_TO_KMH,
    powerW: dash ? g("Power") : null,
    torqueNm: dash ? g("Torque") : null,
    tireTempF,
    tireTempC: tireTempF ? (tireTempF.map(F_TO_C) as Quad) : null,
    boost: dash ? g("Boost") : null,
    fuel: dash ? g("Fuel") : null,
    distanceTraveled: dash ? g("DistanceTraveled") : null,
    bestLap: dash ? g("BestLap") : null,
    lastLap: dash ? g("LastLap") : null,
    currentLap: dash ? g("CurrentLap") : null,
    currentRaceTime: dash ? g("CurrentRaceTime") : null,
    lapNumber: dash ? g("LapNumber") : null,
    racePosition: dash ? g("RacePosition") : null,
    throttle: dash ? g("Accel") / 255 : null,
    brake: dash ? g("Brake") / 255 : null,
    clutch: dash ? g("Clutch") / 255 : null,
    handbrake: dash ? g("HandBrake") / 255 : null,
    gear: dash ? g("Gear") : null,
    steer: dash ? clamp(g("Steer") / 127, -1, 1) : null,

    tireWear: fm23 ? q("TireWear") : null,
    trackOrdinal: fm23 ? g("TrackOrdinal") : null,
  };
}

export interface DecoderEvents {
  onUnknownSize?: (length: number) => void;
  onSledFormat?: () => void;
}

/**
 * Stateful decoder for the live stream: drops IsRaceOn = 0, reports each unknown
 * packet size once and warns once about the limited Sled format.
 */
export function createDecoder(events: DecoderEvents = {}) {
  const seenUnknown = new Set<number>();
  let warnedSled = false;
  return (buf: Buffer): Telemetry | null => {
    const t = parsePacket(buf);
    if (!t) {
      if (!seenUnknown.has(buf.length)) {
        seenUnknown.add(buf.length);
        (events.onUnknownSize ?? ((n) => console.warn(`[forza] unknown packet size ${n} bytes — ignoring`)))(buf.length);
      }
      return null;
    }
    if (t.format === "fm7_sled" && !warnedSled) {
      warnedSled = true;
      (events.onSledFormat ??
        (() => console.warn("[forza] receiving Sled format (232 B) — set Data Out Packet Format to Dash for laps/inputs")))();
    }
    return t.isRaceOn ? t : null;
  };
}
