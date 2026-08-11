// Squall radar — HRRR forecast pre-render.
//
// Runs on a schedule (GitHub Actions cron). For the latest HRRR run it decodes
// composite reflectivity (REFC) for each forecast step, renders web-mercator
// PNG tiles (skipping empty ones), and uploads them to Cloudflare R2 — where
// Squall's Worker serves them with zero decode. This moves the CPU-heavy GRIB
// work off the Worker's 10 ms budget onto a free runner.
//
// Env (set as GitHub Actions secrets):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional tuning:
//   ZOOM_MIN (default 3), ZOOM_MAX (default 6)

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prepareHrrr, renderTile, type HrrrField } from "./lib/hrrr.ts";

const HRRR_BASE = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";
const ZOOM_MIN = Number(process.env.ZOOM_MIN ?? 3);
const ZOOM_MAX = Number(process.env.ZOOM_MAX ?? 6);
// CONUS bounding box (a little generous) for tile enumeration.
const CONUS = { west: -125, east: -66, south: 23, north: 51 };
const SUBHOURLY_MIN = [15, 30, 45, 60, 75, 90, 105, 120];

// DRY_RUN=1 renders + counts tiles but uploads nothing (no R2 creds needed) —
// handy for validating the decode/tile pipeline locally before wiring R2.
const DRY_RUN = !!process.env.DRY_RUN;
const bucket = DRY_RUN ? "(dry-run)" : requireEnv("R2_BUCKET");
const s3 = DRY_RUN ? null : new S3Client({
  region: "auto",
  endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  },
});

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
  return v;
}

// ── forecast step model (mirrors the Worker) ─────────────────────────────────

interface Step { token: string; minute: number; file: string; matches(parts: string[]): boolean; }

function hourlyStep(fh: number): Step {
  return { token: `f${fh}`, minute: fh * 60, file: `wrfsfcf${String(fh).padStart(2, "0")}`,
           matches: (p) => p[3] === "REFC" };
}
function subhourlyStep(min: number): Step {
  return { token: `m${min}`, minute: min, file: `wrfsubhf${String(Math.ceil(min / 60)).padStart(2, "0")}`,
           matches: (p) => p[3] === "REFC" && p[5] === `${min} min fcst` };
}

function validTime(run: string, minute: number): string {
  const y = +run.slice(0, 4), mo = +run.slice(4, 6), d = +run.slice(6, 8), h = +run.slice(8, 10);
  return new Date(Date.UTC(y, mo - 1, d, h, minute)).toISOString();
}

async function latestRun(): Promise<string | null> {
  const now = Date.now();
  for (let back = 1; back <= 6; back++) {
    const t = new Date(now - back * 3600_000);
    const ymd = t.toISOString().slice(0, 10).replace(/-/g, "");
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const url = `${HRRR_BASE}/hrrr.${ymd}/conus/hrrr.t${hh}z.wrfsfcf01.grib2.idx`;
    const r = await fetch(url, { headers: { Range: "bytes=0-16" } });
    if (r.ok || r.status === 206) return `${ymd}${hh}`;
  }
  return null;
}

/** Range-fetch + decode one step's REFC field; null if the file/record is absent. */
async function fetchField(run: string, step: Step): Promise<HrrrField | null> {
  const ymd = run.slice(0, 8), hh = run.slice(8, 10);
  const base = `${HRRR_BASE}/hrrr.${ymd}/conus/hrrr.t${hh}z.${step.file}.grib2`;
  const idxRes = await fetch(base + ".idx");
  if (!idxRes.ok) return null;
  const lines = (await idxRes.text()).split("\n").filter(Boolean);
  const i = lines.findIndex((l) => step.matches(l.split(":")));
  if (i < 0) return null;
  const start = parseInt(lines[i].split(":")[1], 10);
  const end = i + 1 < lines.length ? parseInt(lines[i + 1].split(":")[1], 10) : 0;
  const range = end > start ? `bytes=${start}-${end - 1}` : `bytes=${start}-`;
  const res = await fetch(base, { headers: { Range: range } });
  if (!res.ok && res.status !== 206) return null;
  return prepareHrrr(new Uint8Array(await res.arrayBuffer()));
}

// ── tile enumeration ─────────────────────────────────────────────────────────

function lon2x(lon: number, z: number): number { return Math.floor((lon + 180) / 360 * 2 ** z); }
function lat2y(lat: number, z: number): number {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

function* conusTiles(z: number): Generator<[number, number]> {
  const x0 = lon2x(CONUS.west, z), x1 = lon2x(CONUS.east, z);
  const y0 = lat2y(CONUS.north, z), y1 = lat2y(CONUS.south, z);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield [x, y];
}

// ── R2 upload (bounded concurrency) ──────────────────────────────────────────

async function pMapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

async function put(key: string, body: Uint8Array, contentType: string): Promise<void> {
  if (DRY_RUN || !s3) return;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: "public, max-age=3600",
  }));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const run = await latestRun();
  if (!run) { console.error("No HRRR run available"); process.exit(1); }
  console.log(`HRRR run ${run}, zoom ${ZOOM_MIN}..${ZOOM_MAX}`);

  const steps: Step[] = [
    ...SUBHOURLY_MIN.map(subhourlyStep),
    ...Array.from({ length: 18 }, (_, i) => hourlyStep(i + 1)),
  ];

  const manifestFrames: { token: string; valid: string }[] = [];
  let totalTiles = 0;

  for (const step of steps) {
    const field = await fetchField(run, step);
    if (!field) { console.log(`  ${step.token}: no data, skipped`); continue; }

    // Render every CONUS tile across the zoom range; keep only non-empty ones.
    const tiles: { key: string; png: Uint8Array }[] = [];
    for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
      for (const [x, y] of conusTiles(z)) {
        const png = renderTile(field, z, x, y);
        if (png) tiles.push({ key: `hrrr/${run}/${step.token}/${z}/${x}/${y}.png`, png });
      }
    }
    await pMapLimit(tiles, 24, (t) => put(t.key, t.png, "image/png"));
    totalTiles += tiles.length;
    manifestFrames.push({ token: `${run}/${step.token}`, valid: validTime(run, step.minute) });
    console.log(`  ${step.token}: ${tiles.length} tiles`);
  }

  // Manifest the Worker reads to build the forecast timeline.
  const manifest = { run, updated: new Date().toISOString(), zoomMax: ZOOM_MAX, frames: manifestFrames };
  await put("hrrr/manifest.json", new TextEncoder().encode(JSON.stringify(manifest)), "application/json");
  console.log(`Done: ${totalTiles} tiles across ${manifestFrames.length} frames → r2://${bucket}/hrrr/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
