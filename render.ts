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
import { prepareHrrr, renderTile, dbzColor, tempColor, type HrrrField } from "./lib/hrrr.ts";

const HRRR_BASE = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";
const ZOOM_MIN = Number(process.env.ZOOM_MIN ?? 3);
const ZOOM_MAX = Number(process.env.ZOOM_MAX ?? 6);
// The 18→24h synoptic tail is coarse/far-out, so render it at a lower zoom to
// keep R2 writes inside the free tier (the app over-zoom-upscales it anyway).
const SYNOPTIC_ZOOM_MAX = Number(process.env.SYNOPTIC_ZOOM_MAX ?? 4);
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

/** Hourly HRRR runs only reach f18. The 00/06/12/18z *synoptic* runs reach f48,
 *  so they extend the timeline 18→24h+. Find the freshest whose f24 is published. */
async function latestSynopticRun(): Promise<string | null> {
  const now = Date.now();
  for (let back = 0; back <= 30; back++) {
    const t = new Date(now - back * 3600_000);
    if (![0, 6, 12, 18].includes(t.getUTCHours())) continue;
    const ymd = t.toISOString().slice(0, 10).replace(/-/g, "");
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const url = `${HRRR_BASE}/hrrr.${ymd}/conus/hrrr.t${hh}z.wrfsfcf24.grib2.idx`;
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

interface Job { run: string; step: Step; zoomMax: number; }
type ColorFn = (value: number) => [number, number, number, number];

/** Render a product's jobs (skipping empty tiles), upload to `{prefix}/…`, and
 *  return its manifest frames. Reused for every HRRR-field map layer. */
async function renderProduct(prefix: string, jobs: Job[], color: ColorFn): Promise<{ token: string; valid: string; zoomMax: number }[]> {
  const frames: { token: string; valid: string; zoomMax: number }[] = [];
  let total = 0;
  for (const job of jobs) {
    const field = await fetchField(job.run, job.step);
    if (!field) { console.log(`  ${prefix}/${job.step.token}: no data, skipped`); continue; }
    const tiles: { key: string; png: Uint8Array }[] = [];
    for (let z = ZOOM_MIN; z <= job.zoomMax; z++) {
      for (const [x, y] of conusTiles(z)) {
        const png = renderTile(field, z, x, y, color);
        if (png) tiles.push({ key: `${prefix}/${job.run}/${job.step.token}/${z}/${x}/${y}.png`, png });
      }
    }
    await pMapLimit(tiles, 24, (t) => put(t.key, t.png, "image/png"));
    total += tiles.length;
    frames.push({ token: `${job.run}/${job.step.token}`, valid: validTime(job.run, job.step.minute), zoomMax: job.zoomMax });
    console.log(`  ${prefix}/${job.step.token} (z≤${job.zoomMax}): ${tiles.length} tiles`);
  }
  frames.sort((a, b) => Date.parse(a.valid) - Date.parse(b.valid));
  console.log(`${prefix}: ${total} tiles, ${frames.length} frames`);
  return frames;
}

async function writeManifest(prefix: string, run: string, zoomMax: number, frames: unknown) {
  const m = { run, updated: new Date().toISOString(), zoomMax, frames };
  await put(`${prefix}/manifest.json`, new TextEncoder().encode(JSON.stringify(m)), "application/json");
}

// Temperature layer: 2 m temp, coarse zoom, a few forecast hours (it's a smooth,
// slowly-changing field, so it needs neither high zoom nor a dense timeline).
const TEMP_ZOOM_MAX = Number(process.env.TEMP_ZOOM_MAX ?? 5);
const TEMP_LEADS = [1, 3, 6, 9, 12, 18];
function tempStep(fh: number): Step {
  return { token: `f${fh}`, minute: fh * 60, file: `wrfsfcf${String(fh).padStart(2, "0")}`,
           matches: (p) => p[3] === "TMP" && p[4] === "2 m above ground" };
}

async function main() {
  const runH = await latestRun();
  if (!runH) { console.error("No HRRR run available"); process.exit(1); }

  // ── Radar (REFC): near-term + hourly (0–18h) at full zoom + synoptic 18→24h.
  const radarJobs: Job[] = [
    ...SUBHOURLY_MIN.map((m) => ({ run: runH, step: subhourlyStep(m), zoomMax: ZOOM_MAX })),
    ...Array.from({ length: 18 }, (_, i) => ({ run: runH, step: hourlyStep(i + 1), zoomMax: ZOOM_MAX })),
  ];
  const runS = await latestSynopticRun();
  const hourlyLastValid = Date.parse(validTime(runH, 18 * 60));
  if (runS) {
    for (let h = 19; h <= 30; h++) {
      if (Date.parse(validTime(runS, h * 60)) <= hourlyLastValid) continue;
      radarJobs.push({ run: runS, step: hourlyStep(h), zoomMax: SYNOPTIC_ZOOM_MAX });
    }
  }
  console.log(`HRRR run ${runH} (synoptic ${runS ?? "none"})`);

  const radarFrames = await renderProduct("hrrr", radarJobs, dbzColor);
  await writeManifest("hrrr", runH, ZOOM_MAX, radarFrames);

  // ── Temperature map.
  const tempJobs: Job[] = TEMP_LEADS.map((fh) => ({ run: runH, step: tempStep(fh), zoomMax: TEMP_ZOOM_MAX }));
  const tempFrames = await renderProduct("temp", tempJobs, tempColor);
  await writeManifest("temp", runH, TEMP_ZOOM_MAX, tempFrames);

  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
