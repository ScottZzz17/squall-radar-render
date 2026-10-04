import { decode as decodePng, encode as encodePng } from "fast-png";
import { dbzColor } from "./hrrr.ts";

// NOAA MRMS MergedReflectivityQCComposite: a 0.01° lat/lon grid (template 3.0)
// PNG-packed (template 5.41). Values below -30 are "missing / no coverage".

export interface MrmsField {
  ni: number; nj: number;
  la1: number; lo1: number; // first point, lon in −180…180
  di: number; dj: number;   // degrees
  northFirst: boolean;
  values: Float32Array;
}

function u16(d: Uint8Array, o: number) { return (d[o] << 8) | d[o + 1]; }
function u32(d: Uint8Array, o: number) { return d[o] * 0x1000000 + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]; }
function s16(d: Uint8Array, o: number) { const v = u16(d, o); return v & 0x8000 ? -(v & 0x7fff) : v; }
function s32(d: Uint8Array, o: number) { const v = u32(d, o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; }
function f32(d: Uint8Array, o: number) { return new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0, false); }

export function decodeMrms(buf: Uint8Array): MrmsField {
  if (buf[0] !== 0x47 || buf[1] !== 0x52) throw new Error("not GRIB2");
  let grid: Omit<MrmsField, "values"> | null = null;
  let R = 0, E = 0, D = 0, tmpl5 = -1, npts = 0;
  let png: Uint8Array | null = null;
  let i = 16;
  while (i < buf.length - 4) {
    if (buf[i] === 0x37 && buf[i + 1] === 0x37 && buf[i + 2] === 0x37 && buf[i + 3] === 0x37) break;
    const len = u32(buf, i), sec = buf[i + 4];
    if (sec === 3) {
      if (u16(buf, i + 12) !== 0) throw new Error("grid template != 3.0");
      const t = i + 14;
      const scan = buf[t + 57];
      let lo1 = u32(buf, t + 36) * 1e-6; if (lo1 > 180) lo1 -= 360;
      grid = {
        ni: u32(buf, t + 16), nj: u32(buf, t + 20),
        la1: s32(buf, t + 32) * 1e-6, lo1,
        di: u32(buf, t + 49) * 1e-6, dj: u32(buf, t + 53) * 1e-6,
        northFirst: (scan & 0x40) === 0,
      };
    } else if (sec === 5) {
      npts = u32(buf, i + 5);
      tmpl5 = u16(buf, i + 9);
      const t = i + 11;
      R = f32(buf, t); E = s16(buf, t + 4); D = s16(buf, t + 6);
    } else if (sec === 7) {
      png = buf.subarray(i + 5, i + len);
    }
    i += len;
  }
  if (!grid || !png) throw new Error("missing sections");
  if (tmpl5 !== 41) throw new Error(`data template ${tmpl5} != 5.41 (PNG)`);
  const img = decodePng(png);
  const raw = img.data as Uint8Array | Uint16Array;
  const twoE = 2 ** E, tenD = 10 ** D;
  const values = new Float32Array(npts);
  for (let k = 0; k < npts; k++) values[k] = (R + raw[k] * twoE) / tenD;
  return { ...grid, values };
}

/** dBZ at a lat/lon (nearest cell), NaN off-grid or no coverage. */
export function sampleMrms(f: MrmsField, lat: number, lon: number): number {
  const i = Math.round((lon - f.lo1) / f.di);
  const j = Math.round((f.northFirst ? f.la1 - lat : lat - f.la1) / f.dj);
  if (i < 0 || i >= f.ni || j < 0 || j >= f.nj) return NaN;
  const v = f.values[j * f.ni + i];
  return v < -30 ? NaN : v;
}

const TILE = 256;

/** One web-mercator tile, max-pooling the sub-pixel cells at low zoom so
 *  small storms don't vanish. Null when the tile has no echo. */
export function renderMrmsTile(f: MrmsField, z: number, x: number, y: number): Uint8Array | null {
  const world = TILE * 2 ** z;
  const rgba = new Uint8Array(TILE * TILE * 4);
  const degPerPx = 360 / world;
  const sub = Math.max(1, Math.min(4, Math.round(degPerPx / f.di)));
  let any = false;
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      let best = NaN;
      for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
        const wx = x * TILE + px + (sx + 0.5) / sub, wy = y * TILE + py + (sy + 0.5) / sub;
        const lon = wx / world * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / world))) * 180 / Math.PI;
        const v = sampleMrms(f, lat, lon);
        if (!(v <= best)) best = Number.isNaN(best) ? v : Math.max(best, v);
      }
      const [r, g, b, a] = dbzColor(best);
      if (a === 0) continue;
      const o = (py * TILE + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a; any = true;
    }
  }
  return any ? encodePng({ width: TILE, height: TILE, data: rgba, channels: 4, depth: 8 }) : null;
}
