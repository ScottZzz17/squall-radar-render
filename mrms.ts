// Squall radar — observed MRMS reflectivity, every ~15 min (R2 free-tier writes).
//
// Takes the newest NOAA MRMS MergedReflectivityQCComposite (CONUS, 0.01°,
// ~2 min cadence, public domain) from the AWS Open Data bucket, renders
// Squall-palette tiles to R2 `mrms/{YYYYMMDDHHmm}/{z}/{x}/{y}.png`, and keeps
// a rolling `mrms/manifest.json` of the last ~60 min. The Worker prefers it
// over IEM whenever the manifest is under 15 min old. Old frames expire via
// an R2 lifecycle rule on the `mrms/` prefix.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";
import { decodeMrms, renderMrmsTile } from "./lib/mrms.ts";

const BASE = "https://noaa-mrms-pds.s3.amazonaws.com";
const PRODUCT = "CONUS/MergedReflectivityQCComposite_00.50";
const ZOOM_MIN = 3;
// z6 keeps ~4.3k runs/month × non-empty tiles inside R2's free writes next to
// HRRR; the app over-zooms. Raise once this runs on our own server.
const ZOOM_MAX = Number(process.env.MRMS_ZOOM_MAX ?? 6);
const KEEP_MIN = 65;
const CONUS = { west: -126, east: -66, south: 22, north: 51 };

const DRY_RUN = !!process.env.DRY_RUN;
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const bucket = DRY_RUN ? "" : env("R2_BUCKET");
const s3 = DRY_RUN ? null : new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});

interface Frame { token: string; valid: string }

/** MRMS files from the last ~70 min, oldest first. */
async function recentKeys(): Promise<string[]> {
  const since = new Date(Date.now() - 70 * 60_000);
  const days = [...new Set([since, new Date()].map((d) => d.toISOString().slice(0, 10).replace(/-/g, "")))];
  const keys: string[] = [];
  for (const day of days) {
    const r = await fetch(`${BASE}/?list-type=2&prefix=${PRODUCT}/${day}/`
      + `&start-after=${PRODUCT}/${day}/MRMS_MergedReflectivityQCComposite_00.50_${stamp(since)}`);
    keys.push(...[...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
  }
  return keys.sort();
}

/** The newest file, then one per ~15 min back through the hour. */
function loopKeys(keys: string[]): string[] {
  const picked: string[] = [];
  let last = Infinity;
  for (const k of [...keys].reverse()) {
    const t = Date.parse(frameOf(k).valid);
    if (last - t >= 14 * 60_000) { picked.push(k); last = t; }
  }
  return picked.reverse();
}

function frameOf(key: string): Frame {
  const m = key.match(/_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/)!;
  return { token: `${m[1]}${m[2]}${m[3]}`,
           valid: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2]}:${m[3]}:${m[4]}Z` };
}

function stamp(d: Date) { return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); }

function lon2x(lon: number, z: number) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function lat2y(lat: number, z: number) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

async function put(key: string, body: Uint8Array, type: string, cache: string) {
  if (!s3) return;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type, CacheControl: cache }));
}

async function oldFrames(): Promise<Frame[]> {
  if (!s3) return [];
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "mrms/manifest.json" }));
    return (JSON.parse(await r.Body!.transformToString()).frames ?? []) as Frame[];
  } catch { return []; }
}

async function renderFrame(key: string, f: Frame) {
  const gz = new Uint8Array(await (await fetch(`${BASE}/${key}`)).arrayBuffer());
  const field = decodeMrms(new Uint8Array(gunzipSync(gz)));
  const tiles: { key: string; png: Uint8Array }[] = [];
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    for (let x = lon2x(CONUS.west, z); x <= lon2x(CONUS.east, z); x++) {
      for (let y = lat2y(CONUS.north, z); y <= lat2y(CONUS.south, z); y++) {
        const png = renderMrmsTile(field, z, x, y);
        if (png) tiles.push({ key: `mrms/${f.token}/${z}/${x}/${y}.png`, png });
      }
    }
  }
  let i = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (i < tiles.length) { const t = tiles[i++]; await put(t.key, t.png, "image/png", "public, max-age=86400"); }
  }));
  console.log(`${f.valid}: ${tiles.length} tiles`);
}

async function main() {
  const keys = loopKeys(await recentKeys());
  if (!keys.length) { console.error("no recent MRMS files"); process.exit(1); }
  const frames = await oldFrames();
  const have = new Set(frames.map((f) => f.token));
  // Fill the whole past hour (first run, or after missed schedules), not just now.
  for (const k of keys) {
    const f = frameOf(k);
    if (have.has(f.token)) continue;
    await renderFrame(k, f);
    frames.push(f); have.add(f.token);
  }
  const cutoff = Date.now() - KEEP_MIN * 60_000;
  const kept = frames.filter((f) => Date.parse(f.valid) >= cutoff)
    .sort((a, b) => Date.parse(a.valid) - Date.parse(b.valid));
  const manifest = { updated: new Date().toISOString(), zoomMax: ZOOM_MAX, frames: kept };
  await put("mrms/manifest.json", new TextEncoder().encode(JSON.stringify(manifest)), "application/json", "no-cache");
  console.log(`manifest: ${kept.length} frames`);
}

main().catch((e) => { console.error(e); process.exit(1); });
