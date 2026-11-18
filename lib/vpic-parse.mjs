/**
 * The flat vPIC decode (DecodeVinValues keys) parsed into the report's categories. Shared by lib/nhtsa.mjs (every
 * decode) and lib/decode-checks.mjs (the official values behind an mcp.vin rule fix).
 */

/**
 * Convert empty strings and "Not Applicable" to null, trim whitespace.
 */
export function clean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'Not Applicable') return null;
    return trimmed;
  }
  return value;
}

/**
 * Parse a numeric string, returning null if not a valid number.
 */
export function num(value) {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a NHTSA decoded result into categorized fields.
 */
export function parseDecodedResult(r) {
  return {
    vehicle: {
      year: num(r.ModelYear),
      make: clean(r.Make),
      make_id: num(r.MakeID),
      model: clean(r.Model),
      model_id: num(r.ModelID),
      trim: clean(r.Trim),
      body_class: clean(r.BodyClass),
      doors: num(r.Doors),
      vehicle_type: clean(r.VehicleType),
    },
    engine: {
      type: clean(r.EngineModel),
      cylinders: num(r.EngineCylinders),
      displacement_cc: num(r.DisplacementCC),
      displacement_l: num(r.DisplacementL),
      hp: num(r.EngineHP),
      fuel_type: clean(r.FuelTypePrimary),
      fuel_injection: clean(r.FuelInjectionType),
      turbo: clean(r.Turbo),
      ev_type: clean(r.ElectrificationLevel),
      battery_kwh: num(r.BatteryKWh),
    },
    transmission: {
      type: clean(r.TransmissionStyle),
      speeds: num(r.TransmissionSpeeds),
      drive_type: clean(r.DriveType),
    },
    dimensions: {
      gvwr: clean(r.GVWR),
      gvwr_to: clean(r.GVWR_to),
      curb_weight: num(r.CurbWeightLB),
      wheel_base: num(r.WheelBaseShort),
      track_width: num(r.TrackWidth),
    },
    plant: {
      city: clean(r.PlantCity),
      state: clean(r.PlantState),
      country: clean(r.PlantCountry),
      company: clean(r.PlantCompanyName),
    },
    safety: {
      abs: clean(r.ABS),
      esc: clean(r.ESC),
      traction_control: clean(r.TractionControl),
      tpms: clean(r.TPMS),
      airbags_front: clean(r.AirBagLocFront),
      airbags_side: clean(r.AirBagLocSide),
      airbags_curtain: clean(r.AirBagLocCurtain),
      airbags_knee: clean(r.AirBagLocKnee),
      forward_collision_warning: clean(r.ForwardCollisionWarning),
      lane_departure_warning: clean(r.LaneDepartureWarning),
      lane_keeping: clean(r.LaneKeepSystem),
      adaptive_cruise: clean(r.AdaptiveCruiseControl),
      backup_camera: clean(r.RearVisibilitySystem) || clean(r.BackupCamera),
      parking_assist: clean(r.ParkAssist),
      blind_spot: clean(r.BlindSpotMon),
      auto_emergency_braking: clean(r.CIB) || clean(r.AutomaticEmergencyBraking),
      pedestrian_detection: clean(r.PedestrianAutomaticEmergencyBraking),
      daytime_running_lights: clean(r.DaytimeRunningLight),
      headlamp_type: clean(r.AdaptiveHeadlights),
      pretensioner: clean(r.Pretensioner),
      seat_belt_type: clean(r.SeatBeltsAll),
    },
    raw: { ...r },
  };
}
