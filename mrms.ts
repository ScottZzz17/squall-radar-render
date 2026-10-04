// Squall radar — observed MRMS reflectivity, every ~10 min.
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
const KEEP_MIN = 60;
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

async function latestKey(): Promise<string | null> {
  for (const back of [0, 1]) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    const r = await fetch(`${BASE}/?list-type=2&prefix=${PRODUCT}/${day}/`
      + `&start-after=${PRODUCT}/${day}/MRMS_MergedReflectivityQCComposite_00.50_${stamp(new Date(Date.now() - 20 * 60_000))}`);
    const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
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

async function main() {
  const key = await latestKey();
  if (!key) { console.error("no recent MRMS file"); process.exit(1); }
  const m = key.match(/_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/)!;
  const token = `${m[1]}${m[2]}${m[3]}`;
  const valid = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2]}:${m[3]}:${m[4]}Z`;
  const frames = await oldFrames();
  if (frames.some((f) => f.token === token)) { console.log(`${token} already rendered`); return; }

  console.log(`MRMS ${valid}`);
  const gz = new Uint8Array(await (await fetch(`${BASE}/${key}`)).arrayBuffer());
  const field = decodeMrms(new Uint8Array(gunzipSync(gz)));

  const tiles: { key: string; png: Uint8Array }[] = [];
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    for (let x = lon2x(CONUS.west, z); x <= lon2x(CONUS.east, z); x++) {
      for (let y = lat2y(CONUS.north, z); y <= lat2y(CONUS.south, z); y++) {
        const png = renderMrmsTile(field, z, x, y);
        if (png) tiles.push({ key: `mrms/${token}/${z}/${x}/${y}.png`, png });
      }
    }
  }
  let i = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (i < tiles.length) { const t = tiles[i++]; await put(t.key, t.png, "image/png", "public, max-age=86400"); }
  }));
  console.log(`${tiles.length} tiles`);

  const cutoff = Date.now() - KEEP_MIN * 60_000;
  const kept = [...frames, { token, valid }]
    .filter((f) => Date.parse(f.valid) >= cutoff)
    .sort((a, b) => Date.parse(a.valid) - Date.parse(b.valid));
  const manifest = { updated: new Date().toISOString(), zoomMax: ZOOM_MAX, frames: kept };
  await put("mrms/manifest.json", new TextEncoder().encode(JSON.stringify(manifest)), "application/json", "no-cache");
  console.log(`manifest: ${kept.length} frames`);
}

main().catch((e) => { console.error(e); process.exit(1); });
