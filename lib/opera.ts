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
