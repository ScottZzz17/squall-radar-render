import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import { encode as encodePng } from "fast-png";
import { dbzColor } from "./hrrr.ts";

// EUMETNET OPERA maximum-reflectivity composite (CC BY 4.0): 1 km, 5 min,
// pan-European, as cloud-optimized GeoTIFF. Band 1 = dBZ. Grid is Lambert
// azimuthal equal-area (lat_0 55, lon_0 10, false E/N 1 950 000 / −2 100 000).

export interface OperaField {
  width: number; height: number;
  x0: number; y0: number; res: number; // top-left corner (m) and pixel size
  values: Float32Array;
  /** OPERA quality index 0…1 per pixel (0 = not assessed). */
  quality: Float32Array | null;
  /** Ground-clutter persistence map (see ClutterMap); masked pixels → no echo. */
  clutter?: ClutterMap;
  toXY: (lon: number, lat: number) => [number, number];
}

export async function decodeOpera(buf: ArrayBuffer): Promise<OperaField> {
  const tiff = await fromArrayBuffer(buf);
  const im = await tiff.getImage();
  const g = im.getGeoKeys() as Record<string, number>;
  const def = `+proj=laea +lat_0=${g.ProjCenterLatGeoKey} +lon_0=${g.ProjCenterLongGeoKey} ` +
    `+x_0=${g.ProjFalseEastingGeoKey} +y_0=${g.ProjFalseNorthingGeoKey} +ellps=WGS84 +units=m +no_defs`;
  const fwd = proj4("EPSG:4326", def);
  const [minX, , , maxY] = im.getBoundingBox();
  const [res] = im.getResolution();
  const bands = await im.readRasters();
  const band = bands[0];
  const quality = bands.length > 1 ? (bands[1] as unknown as Float32Array) : null;
  return {
    width: im.getWidth(), height: im.getHeight(), x0: minX, y0: maxY, res,
    values: band as unknown as Float32Array, quality,
    toXY: (lon, lat) => fwd.forward([lon, lat]) as [number, number],
  };
}

export function sampleOpera(f: OperaField, lat: number, lon: number): number {
  const [x, y] = f.toXY(lon, lat);
  const i = Math.floor((x - f.x0) / f.res), j = Math.floor((f.y0 - y) / f.res);
  if (i < 0 || i >= f.width || j < 0 || j >= f.height) return NaN;
  const k = j * f.width + i;
  const v = f.values[k];
  // Pixels OPERA itself flags as low quality (clutter round a radar site,
  // sea clutter, anaprop): 0 < QI < 0.3. QI 0 = not assessed — kept.
  const q = f.quality ? f.quality[k] : 0;
  if (q > 0 && q < 0.3) return NaN;
  if (f.clutter && f.clutter.isClutter(i, j)) return NaN;
  return Number.isFinite(v) && v > -50 ? v : NaN;
}

const TILE = 256;

/** One web-mercator tile in the Squall ramp (max-pooled at low zoom). */
export function renderOperaTile(f: OperaField, z: number, x: number, y: number): Uint8Array | null {
  const world = TILE * 2 ** z;
  const kmPerPx = 40_075 * Math.cos(55 * Math.PI / 180) / world;
  const sub = Math.max(1, Math.min(3, Math.round(kmPerPx)));
  const rgba = new Uint8Array(TILE * TILE * 4);
  let any = false;
  for (let py = 0; py < TILE; py++) {
    for (let px = 0; px < TILE; px++) {
      let best = NaN;
      for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
        const wx = x * TILE + px + (sx + 0.5) / sub, wy = y * TILE + py + (sy + 0.5) / sub;
        const lon = wx / world * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / world))) * 180 / Math.PI;
        const v = sampleOpera(f, lat, lon);
        if (Number.isFinite(v) && !(v <= best)) best = v;
      }
      const [r, g, b, a] = dbzColor(best);
      if (a === 0) continue;
      const o = (py * TILE + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a; any = true;
    }
  }
  return any ? encodePng({ width: TILE, height: TILE, data: rgba, channels: 4, depth: 8 }) : null;
}


/** Echo persistence per pixel over a region: an exponential average of
 *  "had ≥ 20 dBZ" across frames. Rain moves; ground clutter (round radar
 *  sites, hills, wind farms) stays lit in the same pixels nearly every frame,
 *  so pixels lit for hours on end (a run of ~4 h at the seed rate, ~2–3 h at the per-frame rate) are masked. Stored as Uint8 (0–255). */
export class ClutterMap {
  constructor(public i0: number, public j0: number, public w: number, public h: number, public data: Uint8Array) {}

  static forBox(f: OperaField, box: { west: number; east: number; south: number; north: number }): ClutterMap {
    let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
    for (let a = 0; a <= 20; a++) for (const [lat, lon] of [
      [box.south + (box.north - box.south) * a / 20, box.west], [box.south + (box.north - box.south) * a / 20, box.east],
      [box.south, box.west + (box.east - box.west) * a / 20], [box.north, box.west + (box.east - box.west) * a / 20],
    ]) {
      const [x, y] = f.toXY(lon, lat);
      const i = Math.floor((x - f.x0) / f.res), j = Math.floor((f.y0 - y) / f.res);
      i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j);
    }
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    return new ClutterMap(i0, j0, w, h, new Uint8Array(w * h));
  }

  static decode(buf: Uint8Array): ClutterMap {
    const v = new DataView(buf.buffer, buf.byteOffset, 16);
    return new ClutterMap(v.getInt32(0), v.getInt32(4), v.getInt32(8), v.getInt32(12), buf.slice(16));
  }

  encode(): Uint8Array {
    const out = new Uint8Array(16 + this.data.length);
    const v = new DataView(out.buffer);
    v.setInt32(0, this.i0); v.setInt32(4, this.j0); v.setInt32(8, this.w); v.setInt32(12, this.h);
    out.set(this.data, 16);
    return out;
  }

  /** Fold one frame in (alpha = weight of the new frame). */
  update(f: OperaField, alpha: number) {
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const gi = this.i0 + i, gj = this.j0 + j;
      if (gi < 0 || gj < 0 || gi >= f.width || gj >= f.height) continue;
      const v = f.values[gj * f.width + gi];
      const lit = Number.isFinite(v) && v >= 20 ? 255 : 0;
      const k = j * this.w + i;
      this.data[k] = Math.round(this.data[k] * (1 - alpha) + lit * alpha);
    }
  }

  isClutter(gi: number, gj: number): boolean {
    const i = gi - this.i0, j = gj - this.j0;
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    return this.data[j * this.w + i] >= 110;
  }
}
