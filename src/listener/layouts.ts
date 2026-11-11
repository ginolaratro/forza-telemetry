/**
 * Forza "Data Out" packet layouts — single source of truth for offsets.
 *
 * All values little-endian. Layouts follow the official Forza Motorsport Data Out
 * documentation (support.forzamotorsport.net, "Forza Motorsport Data Out Documentation"):
 *
 *   Sled (232 B)   — FM7 / FM2023 "Sled" format: offsets 0..231 below.
 *   FM7 Dash (311 B) — Sled + DASH_FIELDS starting at 232.
 *   Horizon 4/5 (324 B) — Sled, then a 12-byte Horizon-only block at 232..243,
 *                    then DASH_FIELDS shifted by +12, plus 1 trailing pad byte.
 *   FM2023 (331 B) — FM7 Dash + FM2023_EXTRA_FIELDS at 311..330.
 *
 * Each table lists fields in order; offsets are written out explicitly (not
 * computed) so they can be audited line-by-line against the docs. A unit test
 * checks that offsets are contiguous and that each table ends at its documented
 * length.
 */

export type FieldType = "s32" | "u32" | "f32" | "u16" | "u8" | "s8";

export interface FieldDef {
  readonly name: string;
  readonly offset: number;
  readonly type: FieldType;
}

export const FIELD_SIZE: Record<FieldType, number> = { s32: 4, u32: 4, f32: 4, u16: 2, u8: 1, s8: 1 };

/** Offsets 0..231 — common to every format. */
export const SLED_FIELDS = [
  { name: "IsRaceOn", offset: 0, type: "s32" },
  { name: "TimestampMS", offset: 4, type: "u32" },
  { name: "EngineMaxRpm", offset: 8, type: "f32" },
  { name: "EngineIdleRpm", offset: 12, type: "f32" },
  { name: "CurrentEngineRpm", offset: 16, type: "f32" },
  // Car-local space: X = right, Y = up, Z = forward
  { name: "AccelerationX", offset: 20, type: "f32" },
  { name: "AccelerationY", offset: 24, type: "f32" },
  { name: "AccelerationZ", offset: 28, type: "f32" },
  { name: "VelocityX", offset: 32, type: "f32" },
  { name: "VelocityY", offset: 36, type: "f32" },
  { name: "VelocityZ", offset: 40, type: "f32" },
  { name: "AngularVelocityX", offset: 44, type: "f32" },
  { name: "AngularVelocityY", offset: 48, type: "f32" },
  { name: "AngularVelocityZ", offset: 52, type: "f32" },
  { name: "Yaw", offset: 56, type: "f32" },
  { name: "Pitch", offset: 60, type: "f32" },
  { name: "Roll", offset: 64, type: "f32" },
  // 0.0 = max stretch, 1.0 = max compression
  { name: "NormalizedSuspensionTravelFrontLeft", offset: 68, type: "f32" },
  { name: "NormalizedSuspensionTravelFrontRight", offset: 72, type: "f32" },
  { name: "NormalizedSuspensionTravelRearLeft", offset: 76, type: "f32" },
  { name: "NormalizedSuspensionTravelRearRight", offset: 80, type: "f32" },
  // 0 = 100% grip, |ratio| > 1.0 = loss of grip
  { name: "TireSlipRatioFrontLeft", offset: 84, type: "f32" },
  { name: "TireSlipRatioFrontRight", offset: 88, type: "f32" },
  { name: "TireSlipRatioRearLeft", offset: 92, type: "f32" },
  { name: "TireSlipRatioRearRight", offset: 96, type: "f32" },
  // radians/sec
  { name: "WheelRotationSpeedFrontLeft", offset: 100, type: "f32" },
  { name: "WheelRotationSpeedFrontRight", offset: 104, type: "f32" },
  { name: "WheelRotationSpeedRearLeft", offset: 108, type: "f32" },
  { name: "WheelRotationSpeedRearRight", offset: 112, type: "f32" },
  // 1 when wheel is on rumble strip
  { name: "WheelOnRumbleStripFrontLeft", offset: 116, type: "s32" },
  { name: "WheelOnRumbleStripFrontRight", offset: 120, type: "s32" },
  { name: "WheelOnRumbleStripRearLeft", offset: 124, type: "s32" },
  { name: "WheelOnRumbleStripRearRight", offset: 128, type: "s32" },
  // 0..1, 1 = deepest puddle
  { name: "WheelInPuddleDepthFrontLeft", offset: 132, type: "f32" },
  { name: "WheelInPuddleDepthFrontRight", offset: 136, type: "f32" },
  { name: "WheelInPuddleDepthRearLeft", offset: 140, type: "f32" },
  { name: "WheelInPuddleDepthRearRight", offset: 144, type: "f32" },
  { name: "SurfaceRumbleFrontLeft", offset: 148, type: "f32" },
  { name: "SurfaceRumbleFrontRight", offset: 152, type: "f32" },
  { name: "SurfaceRumbleRearLeft", offset: 156, type: "f32" },
  { name: "SurfaceRumbleRearRight", offset: 160, type: "f32" },
  // 0 = 100% grip, |angle| > 1.0 = loss of grip
  { name: "TireSlipAngleFrontLeft", offset: 164, type: "f32" },
  { name: "TireSlipAngleFrontRight", offset: 168, type: "f32" },
  { name: "TireSlipAngleRearLeft", offset: 172, type: "f32" },
  { name: "TireSlipAngleRearRight", offset: 176, type: "f32" },
  // 0 = 100% grip, |slip| > 1.0 = loss of grip
  { name: "TireCombinedSlipFrontLeft", offset: 180, type: "f32" },
  { name: "TireCombinedSlipFrontRight", offset: 184, type: "f32" },
  { name: "TireCombinedSlipRearLeft", offset: 188, type: "f32" },
  { name: "TireCombinedSlipRearRight", offset: 192, type: "f32" },
  // meters
  { name: "SuspensionTravelMetersFrontLeft", offset: 196, type: "f32" },
  { name: "SuspensionTravelMetersFrontRight", offset: 200, type: "f32" },
  { name: "SuspensionTravelMetersRearLeft", offset: 204, type: "f32" },
  { name: "SuspensionTravelMetersRearRight", offset: 208, type: "f32" },
  { name: "CarOrdinal", offset: 212, type: "s32" },
  { name: "CarClass", offset: 216, type: "s32" }, // 0 (D) .. 7 (X)
  { name: "CarPerformanceIndex", offset: 220, type: "s32" }, // 100..999
  { name: "DrivetrainType", offset: 224, type: "s32" }, // 0 FWD, 1 RWD, 2 AWD
  { name: "NumCylinders", offset: 228, type: "s32" },
] as const satisfies readonly FieldDef[];

/** Dash fields, offsets as in FM7 Car Dash / FM2023 (base 232). */
export const DASH_FIELDS = [
  { name: "PositionX", offset: 232, type: "f32" }, // world meters
  { name: "PositionY", offset: 236, type: "f32" },
  { name: "PositionZ", offset: 240, type: "f32" },
  { name: "Speed", offset: 244, type: "f32" }, // m/s
  { name: "Power", offset: 248, type: "f32" }, // watts
  { name: "Torque", offset: 252, type: "f32" }, // newton meters
  { name: "TireTempFrontLeft", offset: 256, type: "f32" }, // °F
  { name: "TireTempFrontRight", offset: 260, type: "f32" },
  { name: "TireTempRearLeft", offset: 264, type: "f32" },
  { name: "TireTempRearRight", offset: 268, type: "f32" },
  { name: "Boost", offset: 272, type: "f32" },
  { name: "Fuel", offset: 276, type: "f32" },
  { name: "DistanceTraveled", offset: 280, type: "f32" }, // meters
  { name: "BestLap", offset: 284, type: "f32" }, // seconds
  { name: "LastLap", offset: 288, type: "f32" },
  { name: "CurrentLap", offset: 292, type: "f32" },
  { name: "CurrentRaceTime", offset: 296, type: "f32" },
  { name: "LapNumber", offset: 300, type: "u16" },
  { name: "RacePosition", offset: 302, type: "u8" },
  { name: "Accel", offset: 303, type: "u8" }, // 0..255
  { name: "Brake", offset: 304, type: "u8" },
  { name: "Clutch", offset: 305, type: "u8" },
  { name: "HandBrake", offset: 306, type: "u8" },
  { name: "Gear", offset: 307, type: "u8" },
  { name: "Steer", offset: 308, type: "s8" }, // -127..127
  { name: "NormalizedDrivingLine", offset: 309, type: "s8" },
  { name: "NormalizedAIBrakeDifference", offset: 310, type: "s8" },
] as const satisfies readonly FieldDef[];

/** FM2023-only trailing fields (base 311). */
export const FM2023_EXTRA_FIELDS = [
  { name: "TireWearFrontLeft", offset: 311, type: "f32" },
  { name: "TireWearFrontRight", offset: 315, type: "f32" },
  { name: "TireWearRearLeft", offset: 319, type: "f32" },
  { name: "TireWearRearRight", offset: 323, type: "f32" },
  { name: "TrackOrdinal", offset: 327, type: "s32" },
] as const satisfies readonly FieldDef[];

/** Horizon 4/5 inserts 12 bytes at 232 (undocumented car-category data); dash fields shift by +12. */
export const HORIZON_DASH_SHIFT = 12;

export type SledFieldName = (typeof SLED_FIELDS)[number]["name"];
export type DashFieldName = (typeof DASH_FIELDS)[number]["name"];
export type Fm2023FieldName = (typeof FM2023_EXTRA_FIELDS)[number]["name"];
export type FieldName = SledFieldName | DashFieldName | Fm2023FieldName;

export type GameFormat = "fm7_sled" | "fm7_dash" | "fh" | "fm2023";

export interface Layout {
  readonly format: GameFormat;
  readonly length: number;
  readonly label: string;
  readonly hasDash: boolean;
  readonly fields: readonly FieldDef[];
}

const shift = (fields: readonly FieldDef[], by: number): FieldDef[] =>
  fields.map((f) => ({ ...f, offset: f.offset + by }));

export const LAYOUTS: Record<number, Layout> = {
  232: { format: "fm7_sled", length: 232, label: "Forza Motorsport Sled", hasDash: false, fields: SLED_FIELDS },
  311: { format: "fm7_dash", length: 311, label: "Forza Motorsport 7 Dash", hasDash: true, fields: [...SLED_FIELDS, ...DASH_FIELDS] },
  324: {
    format: "fh",
    length: 324,
    label: "Forza Horizon 4/5",
    hasDash: true,
    fields: [...SLED_FIELDS, ...shift(DASH_FIELDS, HORIZON_DASH_SHIFT)],
  },
  331: {
    format: "fm2023",
    length: 331,
    label: "Forza Motorsport (2023)",
    hasDash: true,
    fields: [...SLED_FIELDS, ...DASH_FIELDS, ...FM2023_EXTRA_FIELDS],
  },
};
