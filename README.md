# squall-radar-render

Pre-renders NOAA **HRRR** composite-reflectivity **forecast** tiles and uploads
them to **Cloudflare R2**, where the Squall Worker serves them with zero decode.
This moves the CPU-heavy GRIB work off the Worker's 10 ms budget onto a free
GitHub Actions runner.

**Keep this repo public** — public repos get *unlimited* GitHub Actions minutes.
Nothing here is secret: it's just a GRIB decoder + tile renderer. All
credentials live in encrypted repo *secrets*, never in the code.

---

## How it works

1. A cron-scheduled Action (`.github/workflows/render.yml`) runs `render.ts`.
2. It finds the latest HRRR run, decodes REFC for each forecast step
   (sub-hourly `m15…m120` + hourly `f1…f18`), and renders web-mercator PNG
   tiles for zooms `ZOOM_MIN…ZOOM_MAX` over CONUS, **skipping empty tiles**.
3. Tiles upload to `r2://<bucket>/hrrr/{run}/{step}/{z}/{x}/{y}.png`, plus a
   `hrrr/manifest.json` index.
4. Squall's Worker reads that manifest for its `/radar/manifest` forecast frames
   and serves the tiles from R2.

---

## One-time setup

### 1. Create an R2 API token (S3 credentials)
Cloudflare dashboard → **R2** → **Manage R2 API Tokens** → **Create API Token**:
- Permissions: **Object Read & Write**
- Scope: the **`squall-radar`** bucket
- Copy the **Access Key ID** and **Secret Access Key** (shown once).

Also grab your **Account ID** (R2 overview page, or `npx wrangler whoami`).

### 2. Push this repo to a **public** GitHub repo
```bash
cd squall-radar-render
git init && git add -A && git commit -m "HRRR → R2 render pipeline"
gh repo create squall-radar-render --public --source=. --push
```

### 3. Add the repo secrets
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | from step 1 |
| `R2_SECRET_ACCESS_KEY` | from step 1 |
| `R2_BUCKET` | `squall-radar` |

### 4. Set an R2 lifecycle rule (auto-cleanup)
Dashboard → R2 → `squall-radar` bucket → **Settings → Object lifecycle rules** →
add a rule to **delete objects after 2 days**. Each HRRR run writes a new
`hrrr/{run}/…` prefix; this expires stale runs so storage stays flat.

### 5. Run it
Actions tab → **render-hrrr** → **Run workflow** (or wait for the cron). The
Worker picks up the new forecast within ~2 minutes.

---

## Write budget (staying inside R2's free tier)

R2 free tier: **1,000,000 Class-A (write) ops/month**. Each tile upload is one
write. A stormy CONUS render is ~2,500 tiles at `z3–z6`.

- **Default: every 2 h, `z3–z6`** → ~2.5k × 12/day ≈ **0.9M/month** — under the cap.
- Want **hourly**? Drop `ZOOM_MAX` to **5** (~600 tiles/run) via a workflow env
  var, → ~600 × 24/day ≈ 0.43M/month.
- Watch usage in the R2 dashboard; tune `ZOOM_MAX` / cron if you approach 1M.

Reads (Class B, 10M/mo free) are absorbed by the Worker's edge cache, so serving
is effectively free.

---

## Local dry run (no credentials needed)

```bash
npm install
DRY_RUN=1 ZOOM_MIN=3 ZOOM_MAX=4 npm run render
```
Renders and counts tiles without uploading — validates the decode pipeline.
