"""Squall forecast maps for Ireland + the UK, from DWD ICON-EU (CC BY 4.0).

The European counterpart of render.ts's HRRR job: for the newest complete
ICON-EU run it renders, hourly to +24 h, Squall-palette tiles for
  euhrrr/  forecast radar — hourly rain rate (Δ TOT_PREC) → dBZ (Marshall–Palmer)
  eutemp/  2 m temperature
  euwind/  10 m wind speed
into R2 as {prefix}/{run}/e{H}/{z}/{x}/{y}.png with a {prefix}/manifest.json,
the same shape the Worker already serves for the US.

ICON-EU GRIB2 uses CCSDS packing, which eccodes decodes (the TS renderer can't).
Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET; DRY_RUN=1.
"""
import bz2, io, json, math, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import eccodes
import numpy as np
from PIL import Image

BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
BOX = dict(west=-11.5, east=2.5, south=49.5, north=61.0)   # Ireland + Great Britain
ZOOM_MIN, ZOOM_MAX = 3, 6
HOURS = list(range(1, 25))
DRY = bool(os.environ.get("DRY_RUN"))
UA = {"User-Agent": "Squall/1.0 (https://squall-push.scottzaragoza.workers.dev/contact)"}

# The exact ramps the US tiles use (lib/hrrr.ts).
DBZ = [(5, 0x88, 0xDD, 0xEE), (10, 0x51, 0xC5, 0xE8), (15, 0x1B, 0xAE, 0xE2), (20, 0x00, 0x91, 0xCA),
       (25, 0x00, 0x77, 0xAA), (30, 0x00, 0x55, 0x88), (35, 0xFF, 0xEE, 0x00), (40, 0xFF, 0xB7, 0x00),
       (45, 0xFF, 0x8B, 0x00), (50, 0xF2, 0x36, 0x00), (55, 0xC1, 0x00, 0x00), (60, 0x8F, 0x00, 0x00),
       (65, 0xFF, 0x81, 0xFF), (70, 0xFF, 0xFF, 0xFF)]
TEMP_F = [(-20, 0x7b, 0x3f, 0xf2), (0, 0x3b, 0x4c, 0xc0), (20, 0x4c, 0x8f, 0xe2), (32, 0x6c, 0xd1, 0xeb),
          (45, 0x3f, 0xc4, 0x8f), (55, 0x7a, 0xcb, 0x4f), (65, 0xc6, 0xd6, 0x00), (72, 0xf2, 0xe8, 0x4d),
          (80, 0xf7, 0xb7, 0x33), (88, 0xf4, 0x7a, 0x22), (95, 0xef, 0x36, 0x36), (105, 0xb9, 0x1f, 0x24),
          (115, 0x8a, 0x2b, 0xe2)]
WIND_MPH = [(0, 0xc4, 0xe3, 0xfa), (8, 0x78, 0xbf, 0xf5), (16, 0x36, 0x99, 0xe8), (25, 0x17, 0x6e, 0xc9),
            (35, 0x0d, 0x47, 0x99)]


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def latest_run():
    """Newest run (YYYYMMDDHH, dir) whose +24 h TOT_PREC exists."""
    now = datetime.now(timezone.utc)
    for back in range(0, 24, 3):
        t = now - timedelta(hours=back)
        t = t.replace(hour=t.hour - t.hour % 3, minute=0, second=0, microsecond=0)
        run = t.strftime("%Y%m%d%H")
        hh = t.strftime("%H")
        listing = fetch(f"{BASE}/{hh}/tot_prec/").decode()
        if f"_{run}_024_TOT_PREC" in listing:
            return run, hh
    return None, None


class Field:
    def __init__(self, raw):
        g = eccodes.codes_grib_new_from_file(io.BytesIO(raw)) if False else eccodes.codes_new_from_message(raw)
        self.ni = eccodes.codes_get(g, "Ni"); self.nj = eccodes.codes_get(g, "Nj")
        self.lat0 = eccodes.codes_get(g, "latitudeOfFirstGridPointInDegrees")
        lon0 = eccodes.codes_get(g, "longitudeOfFirstGridPointInDegrees")
        self.lon0 = lon0 - 360 if lon0 > 180 else lon0
        self.d = eccodes.codes_get(g, "iDirectionIncrementInDegrees")
        self.v = eccodes.codes_get_values(g).reshape(self.nj, self.ni)   # rows south → north
        eccodes.codes_release(g)

    def sample(self, lat, lon):
        i = np.rint((lon - self.lon0) / self.d).astype(int)
        j = np.rint((lat - self.lat0) / self.d).astype(int)
        ok = (i >= 0) & (i < self.ni) & (j >= 0) & (j < self.nj)
        out = np.full(lat.shape, np.nan)
        out[ok] = self.v[j[ok], i[ok]]
        return out


def grib(run, hh, var, step):
    name = f"icon-eu_europe_regular-lat-lon_single-level_{run}_{step:03d}_{var.upper()}.grib2.bz2"
    return Field(bz2.decompress(fetch(f"{BASE}/{hh}/{var}/{name}")))


def colorize(values, ramp, transparent_below=None):
    """Step ramp: each value takes the colour of the highest anchor ≤ it."""
    anchors = np.array([a[0] for a in ramp], dtype=float)
    cols = np.array([a[1:] for a in ramp], dtype=np.uint8)
    idx = np.clip(np.searchsorted(anchors, values, side="right") - 1, 0, len(ramp) - 1)
    rgba = np.zeros(values.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = cols[idx]
    rgba[..., 3] = 255
    bad = ~np.isfinite(values)
    if transparent_below is not None:
        bad |= values < transparent_below
    rgba[bad] = 0
    return rgba


def tile_latlon(z, x, y):
    n = 256 * 2 ** z
    px = (np.arange(256) + 0.5 + x * 256) / n
    py = (np.arange(256) + 0.5 + y * 256) / n
    lon = px * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py))))
    return np.meshgrid(lat, lon, indexing="ij")


def tiles():
    def lon2x(lon, z): return int((lon + 180) / 360 * 2 ** z)
    def lat2y(lat, z):
        r = math.radians(lat); return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    for z in range(ZOOM_MIN, ZOOM_MAX + 1):
        for x in range(lon2x(BOX["west"], z), lon2x(BOX["east"], z) + 1):
            for y in range(lat2y(BOX["north"], z), lat2y(BOX["south"], z) + 1):
                yield z, x, y


def png(rgba):
    if not rgba[..., 3].any():
        return None
    buf = io.BytesIO(); Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True); return buf.getvalue()


s3 = None
if not DRY:
    import boto3
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
BUCKET = os.environ.get("R2_BUCKET", "")


def put(key, body, ctype, cache="public, max-age=86400"):
    if s3: s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=ctype, CacheControl=cache)


def render(prefix, run, step, values_fn, ramp, transparent_below=None):
    jobs = []
    for z, x, y in tiles():
        lat, lon = tile_latlon(z, x, y)
        data = png(colorize(values_fn(lat, lon), ramp, transparent_below))
        if data: jobs.append((f"{prefix}/{run}/e{step}/{z}/{x}/{y}.png", data))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda j: put(j[0], j[1], "image/png"), jobs))
    return len(jobs)


def main():
    run, hh = latest_run()
    if not run:
        print("no complete ICON-EU run"); sys.exit(1)
    print("ICON-EU run", run)
    # Already rendered this run? (the Worker and GitHub may both trigger) — skip.
    try:
        req = urllib.request.Request("https://squall-push.scottzaragoza.workers.dev/hrrr/manifest?lat=52.5&lon=-8.5", headers=UA)
        if json.loads(urllib.request.urlopen(req, timeout=20).read()).get("run") == run:
            print("already rendered", run); return
    except Exception:
        pass
    t0 = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    frames = {"euhrrr": [], "eutemp": [], "euwind": []}
    prev = grib(run, hh, "tot_prec", 0)
    for h in HOURS:
        valid = (t0 + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
        cur = grib(run, hh, "tot_prec", h)
        def dbz(lat, lon, cur=cur, prev=prev):
            rate = np.maximum(0, cur.sample(lat, lon) - prev.sample(lat, lon))   # mm in the hour = mm/h
            with np.errstate(divide="ignore", invalid="ignore"):
                return np.where(rate >= 0.1, 10 * np.log10(200 * rate ** 1.6), np.nan)
        n = render("euhrrr", run, h, dbz, DBZ, transparent_below=10)
        frames["euhrrr"].append({"token": f"{run}/e{h}", "valid": valid, "zoomMax": ZOOM_MAX})
        prev = cur
        if h % 3 == 0 or h == 1:
            t = grib(run, hh, "t_2m", h)
            render("eutemp", run, h, lambda la, lo: (t.sample(la, lo) - 273.15) * 9 / 5 + 32, TEMP_F)
            frames["eutemp"].append({"token": f"{run}/e{h}", "valid": valid, "zoomMax": ZOOM_MAX})
            u, v = grib(run, hh, "u_10m", h), grib(run, hh, "v_10m", h)
            render("euwind", run, h, lambda la, lo: np.hypot(u.sample(la, lo), v.sample(la, lo)) * 2.236936, WIND_MPH)
            frames["euwind"].append({"token": f"{run}/e{h}", "valid": valid, "zoomMax": ZOOM_MAX})
        print(f"+{h}h: {n} radar tiles")
    for prefix, fr in frames.items():
        m = {"run": run, "updated": datetime.now(timezone.utc).isoformat(), "zoomMax": ZOOM_MAX,
             "source": "DWD ICON-EU (CC BY 4.0)", "frames": fr}
        put(f"{prefix}/manifest.json", json.dumps(m).encode(), "application/json", "no-cache")
    print("done")


if __name__ == "__main__":
    main()
