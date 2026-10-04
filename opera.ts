// Squall radar — observed EUMETNET OPERA reflectivity (Ireland + UK), every
// ~15 min. Newest composite GeoTIFF from the public OPERA 24 h cache (CC BY
// 4.0, credit "EUMETNET OPERA"), drawn in Squall's radar ramp to R2
// `opera/{YYYYMMDDHHmm}/{z}/{x}/{y}.png` with a rolling `opera/manifest.json`.
// The Worker serves it as the observed radar for coordinates in this box.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { decodeOpera, renderOperaTile } from "./lib/opera.ts";

const BASE = "https://s3.waw3-1.cloudferro.com/openradar-24h";
const ZOOM_MIN = 3;
const ZOOM_MAX = Number(process.env.OPERA_ZOOM_MAX ?? 6);
const KEEP_MIN = 65;
// Ireland + Great Britain, generous.
const BOX = { west: -11.5, east: 2.5, south: 49.5, north: 61 };

const DRY_RUN = !!process.env.DRY_RUN;
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const bucket = DRY_RUN ? "" : env("R2_BUCKET");
const s3 = DRY_RUN ? null : new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});

interface Frame { token: string; valid: string }

function frameOf(key: string): Frame {
  const m = key.match(/OPERA@(\d{8})T(\d{2})(\d{2})@0@DBZH\.tiff$/)!;
  return { token: `${m[1]}${m[2]}${m[3]}`,
           valid: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2]}:${m[3]}:00Z` };
}

async function recentKeys(): Promise<string[]> {
  const since = Date.now() - 70 * 60_000;
  const days = [...new Set([new Date(since), new Date()].map((d) => d.toISOString().slice(0, 10).replace(/-/g, "/")))];
  const keys: string[] = [];
  for (const day of days) {
    const r = await fetch(`${BASE}/?list-type=2&prefix=${day}/OPERA/COMP/&max-keys=1000`);
    keys.push(...[...(await r.text()).matchAll(/<Key>([^<]+@DBZH\.tiff)<\/Key>/g)].map((m) => m[1])
      .filter((k) => Date.parse(frameOf(k).valid) >= since));
  }
  return keys.sort();
}

function loopKeys(keys: string[]): string[] {
  const picked: string[] = [];
  let last = Infinity;
  for (const k of [...keys].reverse()) {
    const t = Date.parse(frameOf(k).valid);
    if (last - t >= 14 * 60_000) { picked.push(k); last = t; }
  }
  return picked.reverse();
}

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
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "opera/manifest.json" }));
    return (JSON.parse(await r.Body!.transformToString()).frames ?? []) as Frame[];
  } catch { return []; }
}

async function renderFrame(key: string, f: Frame) {
  const buf = await (await fetch(`${BASE}/${key.split("/").map(encodeURIComponent).join("/")}`)).arrayBuffer();
  const field = await decodeOpera(buf);
  const tiles: { key: string; png: Uint8Array }[] = [];
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
    for (let x = lon2x(BOX.west, z); x <= lon2x(BOX.east, z); x++) {
      for (let y = lat2y(BOX.north, z); y <= lat2y(BOX.south, z); y++) {
        const png = renderOperaTile(field, z, x, y);
        if (png) tiles.push({ key: `opera/${f.token}/${z}/${x}/${y}.png`, png });
      }
    }
  }
  let i = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (i < tiles.length) { const t = tiles[i++]; await put(t.key, t.png, "image/png", "public, max-age=86400"); }
  }));
  console.log(`${f.valid}: ${tiles.length} tiles`);
}

async function main() {
  const keys = loopKeys(await recentKeys());
  if (!keys.length) { console.error("no recent OPERA composites"); process.exit(1); }
  const frames = await oldFrames();
  const have = new Set(frames.map((f) => f.token));
  for (const k of keys) {
    const f = frameOf(k);
    if (have.has(f.token)) continue;
    await renderFrame(k, f);
    frames.push(f); have.add(f.token);
  }
  const cutoff = Date.now() - KEEP_MIN * 60_000;
  const kept = frames.filter((f) => Date.parse(f.valid) >= cutoff)
    .sort((a, b) => Date.parse(a.valid) - Date.parse(b.valid));
  const manifest = { updated: new Date().toISOString(), zoomMax: ZOOM_MAX, bbox: BOX, frames: kept };
  await put("opera/manifest.json", new TextEncoder().encode(JSON.stringify(manifest)), "application/json", "no-cache");
  console.log(`manifest: ${kept.length} frames`);
}

main().catch((e) => { console.error(e); process.exit(1); });
