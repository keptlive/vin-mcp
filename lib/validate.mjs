// VIN Validation Module
// All computation is local - no external API calls.

// ---------------------------------------------------------------------------
// Transliteration table  (VIN characters -> numeric values)
// I, O, Q are illegal and intentionally omitted.
// ---------------------------------------------------------------------------
const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};

// ---------------------------------------------------------------------------
// Position weights for checksum calculation (positions 1-17)
// ---------------------------------------------------------------------------
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// ---------------------------------------------------------------------------
// Illegal characters in a VIN
// ---------------------------------------------------------------------------
const ILLEGAL_CHARS = new Set(['I', 'O', 'Q']);

// ---------------------------------------------------------------------------
// Model year codes  (position 10)
// The code repeats on a 30-year cycle:
//   A=1980..Y=2000 (skip I,O,Q,U,Z), 1=2001..9=2009,
//   A=2010..Y=2030, 1=2031..9=2039, ...
// We build the canonical 30-code sequence then map each code to its possible
// calendar years (two cycles shown: 1980-2009 and 2010-2039).
// ---------------------------------------------------------------------------
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
//                  30 codes total

function buildYearMap() {
  const map = {};
  const baseYears = [1980, 2010]; // each 30-year cycle start
  for (let cycle = 0; cycle < baseYears.length; cycle++) {
    for (let i = 0; i < YEAR_CODES.length; i++) {
      const code = YEAR_CODES[i];
      const year = baseYears[cycle] + i;
      if (!map[code]) map[code] = [];
      map[code].push(year);
    }
  }
  return map;
}

const YEAR_MAP = buildYearMap();

// ---------------------------------------------------------------------------
// Country codes  (first character of VIN -> country / region)
// ---------------------------------------------------------------------------
const COUNTRY_MAP = {
  '1': { country: 'United States', region: 'North America' },
  '2': { country: 'Canada', region: 'North America' },
  '3': { country: 'Mexico', region: 'North America' },
  '4': { country: 'United States', region: 'North America' },
  '5': { country: 'United States', region: 'North America' },
  '6': { country: 'Australia', region: 'Oceania' },
  '7': { country: 'New Zealand', region: 'Oceania' },
  '8': { country: 'Argentina', region: 'South America' },
  '9': { country: 'Brazil', region: 'South America' },
  A: { country: 'South Africa', region: 'Africa' },
  B: { country: 'Angola', region: 'Africa' },
  C: { country: 'Benin', region: 'Africa' },
  D: { country: 'Egypt', region: 'Africa' },
  E: { country: 'Ethiopia', region: 'Africa' },
  F: { country: 'Ghana', region: 'Africa' },
  G: { country: 'Ghana', region: 'Africa' },
  H: { country: 'Ivory Coast', region: 'Africa' },
  J: { country: 'Japan', region: 'Asia' },
  K: { country: 'South Korea', region: 'Asia' },
  L: { country: 'China', region: 'Asia' },
  M: { country: 'India', region: 'Asia' },
  N: { country: 'Turkey', region: 'Asia' },
  P: { country: 'Philippines', region: 'Asia' },
  R: { country: 'Taiwan', region: 'Asia' },
  S: { country: 'United Kingdom', region: 'Europe' },
  T: { country: 'Switzerland', region: 'Europe' },
  U: { country: 'Romania', region: 'Europe' },
  V: { country: 'France', region: 'Europe' },
  W: { country: 'Germany', region: 'Europe' },
  X: { country: 'Russia', region: 'Europe' },
  Y: { country: 'Sweden', region: 'Europe' },
  Z: { country: 'Italy', region: 'Europe' },
};

// ---------------------------------------------------------------------------
// WMI -> Manufacturer  (first 3 characters)
// Comprehensive list of 50+ major manufacturers.
// ---------------------------------------------------------------------------
const WMI_MAP = {
  // --- United States ---
  '1B3': 'Dodge',
  '1B4': 'Dodge',
  '1B7': 'Dodge',
  '1C3': 'Chrysler',
  '1C4': 'Chrysler',
  '1C6': 'Ram',
  '1D7': 'Dodge',
  '1FA': 'Ford',
  '1FB': 'Ford',
  '1FC': 'Ford',
  '1FD': 'Ford',
  '1FM': 'Ford',
  '1FT': 'Ford',
  '1FU': 'Freightliner',
  '1FV': 'Freightliner',
  '1G1': 'Chevrolet',
  '1G2': 'Pontiac',
  '1G3': 'Oldsmobile',
  '1G4': 'Buick',
  '1G6': 'Cadillac',
  '1G8': 'Saturn',
  '1GC': 'Chevrolet',
  '1GM': 'Pontiac',
  '1GT': 'GMC',
  '1GY': 'Cadillac',
  '1HG': 'Honda',
  '1J4': 'Jeep',
  '1J8': 'Jeep',
  '1LN': 'Lincoln',
  '1ME': 'Mercury',
  '1N4': 'Nissan',
  '1N6': 'Nissan',
  '1NX': 'NUMMI (Toyota/GM)',
  '1VW': 'Volkswagen',
  '1YV': 'Mazda',
  '1ZV': 'Ford',

  // --- Canada ---
  '2C3': 'Chrysler',
  '2D3': 'Dodge',
  '2FA': 'Ford',
  '2FB': 'Ford',
  '2FM': 'Ford',
  '2FT': 'Ford',
  '2G1': 'Chevrolet',
  '2G2': 'Pontiac',
  '2HG': 'Honda',
  '2HK': 'Honda',
  '2HJ': 'Honda',
  '2HM': 'Hyundai',
  '2T1': 'Toyota',
  '2T2': 'Toyota',
  '2T3': 'Toyota',

  // --- Mexico ---
  '3C4': 'Chrysler',
  '3D7': 'Dodge',
  '3FA': 'Ford',
  '3G5': 'Chevrolet',
  '3GN': 'GMC',
  '3GT': 'GMC',
  '3GW': 'Buick',
  '3HG': 'Honda',
  '3N1': 'Nissan',
  '3N6': 'Nissan',
  '3TM': 'Toyota',
  '3VV': 'Volkswagen',
  '3VW': 'Volkswagen',

  // --- Japan ---
  JA3: 'Mitsubishi',
  JA4: 'Mitsubishi',
  JAE: 'Mitsubishi',
  JF1: 'Subaru',
  JF2: 'Subaru',
  JHM: 'Honda',
  JHL: 'Honda',
  JHG: 'Honda',
  JM1: 'Mazda',
  JM3: 'Mazda',
  JMZ: 'Mazda',
  JN1: 'Nissan',
  JN3: 'Nissan',
  JN6: 'Nissan',
  JN8: 'Nissan',
  JS1: 'Suzuki',
  JS2: 'Suzuki',
  JSA: 'Suzuki',
  JT2: 'Toyota',
  JT3: 'Toyota',
  JTD: 'Toyota',
  JTE: 'Toyota',
  JTH: 'Lexus',
  JTJ: 'Lexus',
  JTK: 'Toyota',
  JTN: 'Toyota',
  JYA: 'Yamaha',

  // --- South Korea ---
  KL1: 'GM Daewoo/Chevrolet',
  KL7: 'GM Daewoo/Chevrolet',
  KM8: 'Hyundai',
  KMH: 'Hyundai',
  KNA: 'Kia',
  KNB: 'Kia',
  KND: 'Kia',
  KNM: 'Renault Samsung',

  // --- China ---
  LFV: 'FAW-Volkswagen',
  LGB: 'Dongfeng Nissan',
  LHG: 'Beijing Hyundai',
  LSG: 'SAIC GM',
  LTV: 'Toyota China',
  LVS: 'Ford China',
  LVV: 'Chery',

  // --- India ---
  MA1: 'Mahindra',
  MA3: 'Suzuki India',
  MAJ: 'Ford India',
  MAK: 'Honda India',
  MAL: 'Hyundai India',
  MAT: 'Tata',
  MBH: 'Suzuki India',

  // --- United Kingdom ---
  SAJ: 'Jaguar',
  SAL: 'Land Rover',
  SAR: 'Rover',
  SCA: 'Rolls-Royce',
  SCB: 'Bentley',
  SCE: 'DeLorean',
  SCF: 'Aston Martin',
  SCC: 'Lotus',
  SDB: 'Peugeot UK',
  SFD: 'Alexander Dennis',

  // --- Germany ---
  WAU: 'Audi',
  WAP: 'Alpina',
  WA1: 'Audi',
  WBA: 'BMW',
  WBS: 'BMW M',
  WBY: 'BMW (electric)',
  WDB: 'Mercedes-Benz',
  WDC: 'Mercedes-Benz',
  WDD: 'Mercedes-Benz',
  WDF: 'Mercedes-Benz',
  WF0: 'Ford Germany',
  WMW: 'MINI',
  WP0: 'Porsche',
  WP1: 'Porsche',
  WUA: 'Audi',
  WVG: 'Volkswagen',
  WVW: 'Volkswagen',
  WV1: 'Volkswagen Commercial',
  WV2: 'Volkswagen Commercial',

  // --- Sweden ---
  YK1: 'Saab',
  YS3: 'Saab',
  YS2: 'Scania',
  YV1: 'Volvo',
  YV2: 'Volvo Truck',
  YV3: 'Volvo Bus',
  YV4: 'Volvo',

  // --- France ---
  VF1: 'Renault',
  VF3: 'Peugeot',
  VF6: 'Renault Truck',
  VF7: 'Citroen',
  VF8: 'Matra',
  VNE: 'Irisbus',
  VR1: 'Dacia',

  // --- Italy ---
  ZAM: 'Maserati',
  ZAP: 'Piaggio/Vespa',
  ZAR: 'Alfa Romeo',
  ZCF: 'Iveco',
  ZDM: 'Ducati',
  ZFA: 'Fiat',
  ZFF: 'Ferrari',
  ZHW: 'Lamborghini',
  ZLA: 'Lancia',

  // --- Spain ---
  VSS: 'SEAT',
  VS6: 'Ford Spain',
  VS7: 'Citroen Spain',
  VS9: 'Opel Spain',

  // --- Czech Republic / Slovakia ---
  TMA: 'Hyundai Czech',
  TMB: 'Skoda',
  TMP: 'Skoda',
  TMT: 'Tatra',

  // --- Turkey ---
  NMT: 'Toyota Turkey',
  NM0: 'Ford Turkey',
  NM4: 'Tofas/Fiat Turkey',

  // --- Brazil ---
  '9BG': 'Chevrolet Brazil',
  '9BW': 'Volkswagen Brazil',
  '9BF': 'Ford Brazil',
  '9BD': 'Fiat Brazil',
  '93H': 'Honda Brazil',

  // --- Electric / Newer ---
  '5YJ': 'Tesla',
  '7SA': 'Tesla',
  '5UX': 'BMW (US)',
  '5UN': 'Lincoln',
  '5NM': 'Hyundai (US)',
  '5N1': 'Nissan (US)',
  '5FN': 'Honda (US)',
  '5J6': 'Honda (US)',
  '5J8': 'Acura',
  '5LM': 'Lincoln',
  '5TD': 'Toyota (US)',
  '5TF': 'Toyota (US)',
  '5XY': 'Kia (US)',
};

// ---------------------------------------------------------------------------
// normalizeVin(vin)
// Uppercase, trim, strip spaces and dashes.
// ---------------------------------------------------------------------------
export function normalizeVin(vin) {
  if (typeof vin !== 'string') return '';
  return vin.toUpperCase().trim().replace(/[\s\-]/g, '');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function checkLength(vin) {
  if (vin.length !== 17) {
    return `VIN must be exactly 17 characters (got ${vin.length})`;
  }
  return null;
}

function checkIllegalChars(vin) {
  const found = [];
  for (const ch of vin) {
    if (ILLEGAL_CHARS.has(ch)) {
      found.push(ch);
    }
  }
  if (found.length > 0) {
    return `VIN contains illegal character(s): ${[...new Set(found)].join(', ')}`;
  }
  return null;
}

function checkValidChars(vin) {
  const invalid = [];
  for (const ch of vin) {
    // Skip chars already reported as illegal (I, O, Q)
    if (ILLEGAL_CHARS.has(ch)) continue;
    if (!(ch in TRANSLITERATION)) {
      invalid.push(ch);
    }
  }
  if (invalid.length > 0) {
    return `VIN contains invalid character(s): ${[...new Set(invalid)].join(', ')}`;
  }
  return null;
}

function computeChecksum(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = TRANSLITERATION[ch];
    if (value === undefined) return { valid: false, expected: '?', actual: vin[8] };
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  const actual = vin[8];
  return {
    valid: expected === actual,
    expected,
    actual,
  };
}

function decodeWmi(vin) {
  const code = vin.substring(0, 3);
  const firstChar = vin[0];

  const location = COUNTRY_MAP[firstChar] || { country: 'Unknown', region: 'Unknown' };
  const manufacturer = WMI_MAP[code] || 'Unknown';

  return {
    code,
    country: location.country,
    region: location.region,
    manufacturer,
  };
}

function decodeYear(vin) {
  const code = vin[9];
  const possibleYears = YEAR_MAP[code] || [];
  return {
    code,
    possible_years: possibleYears,
  };
}

// ---------------------------------------------------------------------------
// validateVin(vin)
// Full validation returning a structured result object.
// ---------------------------------------------------------------------------
export function validateVin(vin) {
  const normalized = normalizeVin(vin);
  const errors = [];

  // Length check
  const lengthErr = checkLength(normalized);
  if (lengthErr) errors.push(lengthErr);

  // Illegal characters (I, O, Q)
  const illegalErr = checkIllegalChars(normalized);
  if (illegalErr) errors.push(illegalErr);

  // Any non-alphanumeric or otherwise unrecognized characters
  const validErr = checkValidChars(normalized);
  if (validErr) errors.push(validErr);

  // Checksum (only meaningful if length is 17 and chars are valid)
  let checksum = { valid: false, expected: '?', actual: '?' };
  if (normalized.length === 17 && !illegalErr && !validErr) {
    checksum = computeChecksum(normalized);
    if (!checksum.valid) {
      errors.push(
        `Checksum invalid: position 9 is '${checksum.actual}' but expected '${checksum.expected}'`
      );
    }
  }

  // Decode sections (best-effort even if VIN is invalid)
  const wmi = normalized.length >= 3
    ? decodeWmi(normalized)
    : { code: normalized.substring(0, 3), country: 'Unknown', region: 'Unknown', manufacturer: 'Unknown' };

  const vds = normalized.length >= 8 ? normalized.substring(3, 8) : normalized.substring(3);

  const year = normalized.length >= 10
    ? decodeYear(normalized)
    : { code: '', possible_years: [] };

  const plant = normalized.length >= 11 ? normalized[10] : '';

  const sequential = normalized.length >= 12 ? normalized.substring(11) : '';

  return {
    valid: errors.length === 0,
    vin: normalized,
    errors,
    checksum,
    wmi,
    vds,
    year,
    plant,
    sequential,
  };
}
