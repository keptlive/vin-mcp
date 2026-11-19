/**
 * Where a reader checks one VIN's recall repairs. mcp.vin does not ask any manufacturer about a VIN: the makers' VIN
 * lookups are offered for personal, non-commercial use only (terms audit 2026-11-18), so since that day every report
 * gives LINKS instead: the maker's own public recall page and NHTSA's. Nothing in mcp.vin requests these pages; the
 * reader opens them. No maker host may appear anywhere else in lib/ (tests/no-maker-requests.test.mjs).
 *
 * MAKERS: per maker, its public recall-lookup `page`, and `vinUrl` only where it is shown that the page opens on (or
 * fills in) a VIN given in its address. How each was shown (`basis`), so a later reader can tell fact from hope:
 *   in_use       mcp.vin's former lookup read the maker's page at exactly this address for a VIN, and the page was
 *                that VIN's (2026-10-24 to 2026-11-18); no request has been made since
 *   browser_1118 opened once in a browser on 2026-11-18 (PR #34): the page filled in or opened on the VIN
 *   page_code    the plain page (no VIN) was opened once on 2026-11-18 and its own script reads the VIN from the
 *                address (research notes, safe-sources-2026-11-18)
 * A page whose VIN form is not shown gets vinUrl null: the reader pastes the VIN there. Makes not listed get NHTSA only.
 *
 * NHTSA (https://www.nhtsa.gov/recalls) is always given, as the official cross-maker route. Its address carries the
 * VIN (?vin=) because a parameter the page ignores does no harm, but whether the page reads it is NOT confirmed:
 * nhtsa.gov refuses automated requests from where mcp.vin is built (nhtsa_vin_prefilled null = unknown).
 */
import { normalizeVin, validateVin } from './validate.mjs';
import { InputError } from './research.mjs';

export const NHTSA_RECALLS = 'https://www.nhtsa.gov/recalls';
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * key -> {maker (short name, as in "Ford's recall page"), page, vinUrl(vin) or null, basis, covers}. `page` is the
 * maker's own public page; "loads" below = opened once, plain (no VIN), in a browser on 2026-11-18.
 */
export const MAKERS = Object.freeze({
  // Akamai refuses automated browsers; the VIN address is the one mcp.vin's former lookup read.
  ford: {maker: 'Ford', page: 'https://www.ford.com/support/recalls/', vinUrl: v => `https://www.ford.com/support/recalls-details/${v}/`, basis: 'in_use', covers: 'Ford, Lincoln, Mercury'},
  // Named by GM's own Takata page; refuses automated browsers. Whether ?vin= is read is not shown.
  gm: {maker: 'GM', page: 'https://experience.gm.com/ownercenter/recalls', vinUrl: null, basis: null, covers: 'Chevrolet, Buick, GMC, Cadillac, Pontiac, Oldsmobile, Saturn, Hummer, BrightDrop'},
  // Loads; its own script reads ?VIN= into the search field (queryParamMap.get("VIN")).
  tesla: {maker: 'Tesla', page: 'https://service.tesla.com/en-US/vin-recall-search', vinUrl: v => `https://service.tesla.com/en-US/vin-recall-search?VIN=${v}`, basis: 'page_code', covers: 'Tesla'},
  honda: {maker: 'Honda', page: 'https://mygarage.honda.com/s/recall-search?brand=honda', vinUrl: v => `https://mygarage.honda.com/s/recall-search?brand=honda&vin=${v}`, basis: 'browser_1118', covers: 'Honda'},
  acura: {maker: 'Acura', page: 'https://mygarage.honda.com/s/recall-search?brand=acura', vinUrl: v => `https://mygarage.honda.com/s/recall-search?brand=acura&vin=${v}`, basis: 'browser_1118', covers: 'Acura'},
  subaru: {maker: 'Subaru', page: 'https://www.subaru.com/recalls.html', vinUrl: v => `https://www.subaru.com/recalls.html?vin=${v}`, basis: 'browser_1118', covers: 'Subaru'},
  hyundai: {maker: 'Hyundai', page: 'https://autoservice.hyundaiusa.com/campaignhome', vinUrl: v => `https://autoservice.hyundaiusa.com/campaignhome?vin=${v}`, basis: 'browser_1118', covers: 'Hyundai'},
  // Loads; covers Toyota, Lexus and Scion (lexus.com/recall redirects here). Ignores a vin parameter (PR #34).
  toyota: {maker: 'Toyota', page: 'https://www.toyota.com/recall/', vinUrl: null, basis: null, covers: 'Toyota, Lexus, Scion'},
  kia: {maker: 'Kia', page: 'https://owners.kia.com/us/en/recalls.html', vinUrl: null, basis: null, covers: 'Kia'}, // loads; ignores vin (PR #34)
  nissan: {maker: 'Nissan', page: 'https://www.nissanusa.com/owners/recalls-vin.html', vinUrl: null, basis: null, covers: 'Nissan'}, // read by the former lookup
  infiniti: {maker: 'INFINITI', page: 'https://www.infinitiusa.com/owners/recalls-vin.html', vinUrl: null, basis: null, covers: 'INFINITI'}, // loads
  mopar: {maker: 'Mopar', page: 'https://www.mopar.com/en-us/my-vehicle/recalls/search.html', vinUrl: null, basis: null, covers: 'Chrysler, Dodge, Jeep, Ram, Fiat, Alfa Romeo, Plymouth'}, // refuses automated browsers
  vw: {maker: 'Volkswagen', page: 'https://www.vw.com/en/owners-and-services/about-my-vehicle/recalls.html', vinUrl: null, basis: null, covers: 'Volkswagen'}, // ignores vin (PR #34)
  audi: {maker: 'Audi', page: 'https://www.audiusa.com/en/recalls/', vinUrl: null, basis: null, covers: 'Audi'}, // refuses automated browsers
  landrover: {maker: 'Land Rover', page: 'https://www.landroverusa.com/ownership/vin-recall.html', vinUrl: null, basis: null, covers: 'Land Rover'}, // ignores vin (PR #34)
  jaguar: {maker: 'Jaguar', page: 'https://www.jaguar.com/en-us/jdx/ownership/vin-recall.html', vinUrl: null, basis: null, covers: 'Jaguar'}, // ignores vin (PR #34)
  mercedes: {maker: 'Mercedes-Benz', page: 'https://www.mbusa.com/en/recall', vinUrl: null, basis: null, covers: 'Mercedes-Benz'}, // loads; named in its NHTSA filings
  mazda: {maker: 'Mazda', page: 'https://www.mazdausa.com/owners/recalls', vinUrl: null, basis: null, covers: 'Mazda'}, // loads
  bmw: {maker: 'BMW', page: 'https://www.bmwusa.com/safety-and-emission-recalls.html', vinUrl: null, basis: null, covers: 'BMW'}, // loads
  lucid: {maker: 'Lucid', page: 'https://lucidmotors.com/recalls', vinUrl: null, basis: null, covers: 'Lucid'}, // loads
});
// Not listed (NHTSA's page only): Volvo (refuses automated browsers, page not confirmed), MINI and Genesis (no U.S.
// VIN page found), Mitsubishi (only a Takata page found), Porsche, Polestar, Rivian (its recall page sends owners to
// NHTSA), Saab and any other make.

// vPIC make names (upper case) -> maker key. A make not listed here gets NHTSA's page only.
const BY_MAKE = {
  FORD: 'ford', LINCOLN: 'ford', MERCURY: 'ford',
  CHEVROLET: 'gm', BUICK: 'gm', GMC: 'gm', CADILLAC: 'gm', PONTIAC: 'gm', OLDSMOBILE: 'gm', SATURN: 'gm', HUMMER: 'gm', BRIGHTDROP: 'gm',
  TESLA: 'tesla', HONDA: 'honda', ACURA: 'acura', SUBARU: 'subaru', HYUNDAI: 'hyundai',
  TOYOTA: 'toyota', LEXUS: 'toyota', SCION: 'toyota', KIA: 'kia', NISSAN: 'nissan', INFINITI: 'infiniti',
  CHRYSLER: 'mopar', DODGE: 'mopar', JEEP: 'mopar', RAM: 'mopar', FIAT: 'mopar', 'ALFA ROMEO': 'mopar', PLYMOUTH: 'mopar',
  VOLKSWAGEN: 'vw', AUDI: 'audi', 'LAND ROVER': 'landrover', JAGUAR: 'jaguar', 'MERCEDES-BENZ': 'mercedes', MAZDA: 'mazda', BMW: 'bmw', LUCID: 'lucid',
};

// World manufacturer identifiers that name one maker's recall page on their own, used only when the decode gave no
// make. Codes shared by two makers' pages (Nissan and INFINITI: JN1, JN8, 5N1) are left out.
const BY_WMI = {
  ford: ['1FA', '1FB', '1FC', '1FD', '1FM', '1FT', '1LN', '1ME', '2FA', '2FM', '2FT', '2LM', '2LN', '2ME', '3FA', '3FD', '3FM', '3FT', '3LN', '3MA', 'NM0', 'WF0'],
  gm: ['1G1', '1G2', '1G3', '1G4', '1G6', '1G8', '1GC', '1GK', '1GT', '1GY', '1GZ', '2G1', '2G2', '2G4', '2G6', '2G8', '2GC', '2GK', '2GT', '2GY', '3G1', '3G5', '3G7', '3GC', '3GK', '3GN', '3GT', '3GY', '5GA', '5GR', 'KL1', 'KL4', 'KL7', 'KL8'],
  tesla: ['5YJ', '7SA', '7G2', 'LRW', 'XP7'],
  honda: ['1HG', '19X', '2HG', '2HK', '3CZ', '5FN', '5FP', '5J6', '5KB', '7FA', 'JHM', 'JHL'],
  acura: ['19U', '19V', '2HN', '5FR', '5J8', '5KC', 'JH4'],
  subaru: ['4S3', '4S4', 'JF1', 'JF2'],
  hyundai: ['5NM', '5NP', '5NT', 'KM8', 'KMH'],
  toyota: ['1NX', '2T1', '2T2', '2T3', '2T4', '3TM', '3TY', '4T1', '4T3', '4T4', '4TA', '5TB', '5TD', '5TE', '5TF', '5YF', '58A', '7MU', '7SV', 'JT2', 'JT3', 'JT4', 'JT5', 'JT6', 'JT8', 'JTD', 'JTE', 'JTH', 'JTJ', 'JTK', 'JTM', 'JTN'],
  kia: ['5XX', '5XY', 'KNA', 'KND', 'KNE'],
  nissan: ['1N4', '1N6', '3N1', '3N6', '5BZ', 'JN6'],
  mopar: ['1B3', '1B4', '1B7', '1C3', '1C4', '1C6', '1D3', '1D4', '1D7', '1D8', '1J4', '1J8', '1P3', '1P4', '2B3', '2B4', '2B5', '2B7', '2C3', '2C4', '2D4', '2D7', '2D8', '3B7', '3C3', '3C4', '3C6', '3D3', '3D4', '3D6', '3D7', '3D2', 'ZAC', 'ZAR', 'ZFA'],
  vw: ['1VW', '1V1', '1V2', '3VW', '3VV', 'WVW', 'WVG'],
  audi: ['WAU', 'WA1', 'WUA', 'TRU'],
  landrover: ['SAL'],
  jaguar: ['SAJ', 'SAD'],
};
const WMI = new Map(Object.entries(BY_WMI).flatMap(([key, codes]) => codes.map(c => [c, key])));

/** The maker key for a VIN: by the decoded make first (vPIC names the make of this VIN), else by its WMI; or null. */
export function makerKey(vin, make = '') {
  const m = String(make || '').trim().toUpperCase();
  if (m) return Object.hasOwn(BY_MAKE, m) ? BY_MAKE[m] : null;
  return WMI.get(String(vin || '').slice(0, 3).toUpperCase()) ?? null;
}

/** NHTSA's recall page with the VIN in its address (see the header: not confirmed that the page reads it). */
export function nhtsaRecallUrl(vin) {
  const v = normalizeVin(vin || '');
  return VIN_RE.test(v) ? `${NHTSA_RECALLS}?vin=${v}` : NHTSA_RECALLS;
}

/** The links for one VIN. Pure: no request is made. */
export function recallLinks(input, make = '') {
  const vin = normalizeVin(input || '');
  const key = makerKey(vin, make), m = key ? MAKERS[key] : null;
  const prefilled = !!(m && m.vinUrl && VIN_RE.test(vin));
  return {
    maker: m ? m.maker : null,
    manufacturer_lookup_url: m ? (prefilled ? m.vinUrl(vin) : m.page) : null,
    manufacturer_page_url: m ? m.page : null,
    vin_prefilled: m ? prefilled : null,
    nhtsa_lookup_url: nhtsaRecallUrl(vin),
    nhtsa_vin_prefilled: null,
  };
}

/**
 * The report's `recall_status` block (the website, REST /api/vin/{vin} and /recall-status, MCP decode_vin and
 * vin_recall_status, comparisons). Kept under its old name so clients do not break, but it never carries a status:
 * available false, reason "manufacturer_link_only", counts null (unknown, never zero), and the links. `recalls` stays
 * an empty list only for clients that read it; it is not a finding. Throws for an invalid VIN.
 */
export function recallStatusFor(input, make = '') {
  const vin = normalizeVin(input || '');
  if (!validateVin(vin).valid) throw new InputError('Provide a valid 17-character VIN including checksum');
  const links = recallLinks(vin, make), who = links.maker || 'the manufacturer';
  const where = links.maker
    ? `${links.maker}'s recall page (manufacturer_lookup_url${links.vin_prefilled ? ', opens on this VIN' : '; enter the VIN there'}) or NHTSA's (nhtsa_lookup_url)`
    : `NHTSA's recall page (nhtsa_lookup_url); no manufacturer page is listed for this make`;
  return {
    vin, scope: 'vin', vin_specific: true, available: false, reason: 'manufacturer_link_only', checked_by_mcp_vin: false,
    ...links,
    verification_url: links.manufacturer_lookup_url || links.nhtsa_lookup_url,
    open_count: null, completed_count: null, recalls: [],
    note: `mcp.vin does not check this VIN with ${who} or NHTSA, so whether this vehicle has open or completed recall repairs is unknown here (never zero). The report lists NHTSA's recall campaigns for the model year (recalls). Only the manufacturer or NHTSA can say whether this exact car's repairs are done: check ${where}.`,
  };
}
