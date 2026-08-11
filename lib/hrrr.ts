import { encode as encodePng } from "fast-png";
import { decodeGrib2, type LccGrid } from "./grib2.ts";

// Turn a decoded HRRR composite-reflectivity field (Lambert-Conformal grid) into
// web-mercator {z}/{x}/{y} radar tiles the app renders like any tile source.
// Pure TS: LCC forward projection to look up the grid cell under each mercator
// pixel, an N0Q-style dBZ colour ramp, and a PNG encode.

const R_EARTH = 6371229; // WMO sphere radius HRRR uses (m)
const D2R = Math.PI / 180;
const TILE = 256;

function normLon(lon: number): number { return ((lon + 180) % 360 + 360) % 360 - 180; }

/** Precomputed Lambert-Conformal forward projection for a grid. */
export interface HrrrField {
  grid: LccGrid;
  values: Float32Array;
  n: number; F: number; rho0: number; lon0: number; // proj constants (radians)
  x1: number; y1: number; // LCC metres of grid point (0,0)
}

/** Decode a REFC GRIB2 message and precompute its projection. */
export function prepareHrrr(buf: Uint8Array): HrrrField {
  const { grid, values } = decodeGrib2(buf);
  const phi1 = grid.latin1 * D2R, phi2 = grid.latin2 * D2R;
  const lon0 = normLon(grid.lov) * D2R;
  const n = Math.abs(phi1 - phi2) < 1e-9
    ? Math.sin(phi1)
    : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
      Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n) / n;
  const rho0 = R_EARTH * F / Math.pow(Math.tan(Math.PI / 4 + grid.lad * D2R / 1), n);
  const field: HrrrField = { grid, values, n, F, rho0, lon0, x1: 0, y1: 0 };
  const p0 = lccXY(field, grid.la1 * D2R, normLon(grid.lo1) * D2R);
  field.x1 = p0.x; field.y1 = p0.y;
  return field;
}

function lccXY(f: HrrrField, phi: number, lam: number): { x: number; y: number } {
  const rho = R_EARTH * f.F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), f.n);
  const theta = f.n * (lam - f.lon0);
  return { x: rho * Math.sin(theta), y: f.rho0 - rho * Math.cos(theta) };
}

/** Reflectivity (dBZ) at a lat/lon, or NaN outside the grid. Nearest cell. */
export function sampleDbz(f: HrrrField, latDeg: number, lonDeg: number): number {
  const { x, y } = lccXY(f, latDeg * D2R, normLon(lonDeg) * D2R);
  const i = Math.round((x - f.x1) / f.grid.dx);
  const j = Math.round((y - f.y1) / f.grid.dy);   // scanMode 64: +j = north
  if (i < 0 || i >= f.grid.nx || j < 0 || j >= f.grid.ny) return NaN;
  return f.values[j * f.grid.nx + i];
}

// ── dBZ → RGBA (N0Q ramp) ────────────────────────────────────────────────────

const RAMP: Array<[number, number, number, number]> = [
  [5, 0x04, 0xe9, 0xe7], [10, 0x01, 0x9f, 0xf4], [15, 0x03, 0x00, 0xf4],
  [20, 0x02, 0xfd, 0x02], [25, 0x01, 0xc5, 0x01], [30, 0x00, 0x8e, 0x00],
  [35, 0xfd, 0xf6, 0x02], [40, 0xe5, 0xbc, 0x00], [45, 0xfd, 0x95, 0x00],
  [50, 0xfd, 0x00, 0x00], [55, 0xd4, 0x00, 0x00], [60, 0xbc, 0x00, 0x00],
  [65, 0xf8, 0x00, 0xfd], [70, 0x98, 0x54, 0xc6], [75, 0xfd, 0xfd, 0xfd],
];

/** dBZ → [r,g,b,a]; transparent below ~10 dBZ (drizzle/no-echo), else fully
 *  opaque. Partial alpha reads as washed-out grey/white once MapKit premultiplies
 *  it, so echo pixels are solid — the overlay's own opacity does the fade. */
function dbzColor(dbz: number): [number, number, number, number] {
  if (!Number.isFinite(dbz) || dbz < 10) return [0, 0, 0, 0];
  let c = RAMP[0];
  for (const anchor of RAMP) { if (dbz >= anchor[0]) c = anchor; else break; }
  return [c[1], c[2], c[3], 255];
}

// ── tile render ──────────────────────────────────────────────────────────────

/** Web-mercator pixel → lat/lon (degrees). */
function pixelLatLon(worldX: number, worldY: number, worldSize: number): { lat: number; lon: number } {
  const lon = (worldX / worldSize) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY / worldSize))) / D2R;
  return { lat, lon };
}

/** Render one {z}/{x}/{y} tile to PNG bytes, or null if the tile has no echo
 *  (so the app draws nothing there). */
export function renderTile(f: HrrrField, z: number, x: number, y: number): Uint8Array | null {
  const worldSize = TILE * Math.pow(2, z);
  const rgba = new Uint8Array(TILE * TILE * 4);
  let any = false;
  for (let py = 0; py < TILE; py++) {
    const worldY = y * TILE + py;
    for (let px = 0; px < TILE; px++) {
      const worldX = x * TILE + px;
      const { lat, lon } = pixelLatLon(worldX + 0.5, worldY + 0.5, worldSize);
      const [r, g, b, a] = dbzColor(sampleDbz(f, lat, lon));
      if (a === 0) continue;
      const o = (py * TILE + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
      any = true;
    }
  }
  if (!any) return null;
  return encodePng({ width: TILE, height: TILE, data: rgba, channels: 4, depth: 8 });
}
