"""Irish tide predictions → R2 tides/ie.json (daily).

The Marine Institute's high/low tide summary (CC BY 4.0) for the next 7 days,
all stations. Predictions are computed years ahead, so a copy stays good for
days: when the institute's ERDDAP server is down, the last copy is kept.
Columns are matched by name so a renamed field doesn't silently break it.
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timedelta, timezone

DATASETS = ["IMI_TidePrediction_HighLow"]
BASE = "https://erddap.marine.ie/erddap/tabledap"
UA = {"User-Agent": "Squall/1.0 (https://squall-push.scottzaragoza.workers.dev/contact)"}


def fetch(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception as e:
            print("attempt", i + 1, "failed:", e)
            time.sleep(20 * (i + 1))
    return None


def col(names, *want):
    low = [n.lower() for n in names]
    for w in want:
        for i, n in enumerate(low):
            if w in n:
                return i
    return None


def main():
    now = datetime.now(timezone.utc)
    start, end = now.strftime("%Y-%m-%dT%H:%M:%SZ"), (now + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = None
    for ds in DATASETS:
        raw = fetch(f"{BASE}/{ds}.json?&time%3E={start}&time%3C={end}")
        if raw:
            break
    if not raw:
        print("Marine Institute ERDDAP unreachable; keeping the last copy"); return
    table = json.loads(raw)["table"]
    names, rows = table["columnNames"], table["rows"]
    it, ist = col(names, "time"), col(names, "stationid", "station_id", "station")
    ila, ilo = col(names, "latitude"), col(names, "longitude")
    ity = col(names, "tide_time_category", "category", "type")
    ilv = col(names, "water_level", "level", "height")
    if None in (it, ist, ila, ilo, ity, ilv):
        print("unexpected columns:", names); sys.exit(1)
    stations = {}
    for r in rows:
        sid = str(r[ist])
        s = stations.setdefault(sid, {"id": sid, "name": sid.replace("_", " "), "lat": r[ila], "lon": r[ilo], "events": []})
        kind = str(r[ity]).lower()
        s["events"].append({"t": r[it], "type": "H" if kind.startswith("h") else "L", "m": r[ilv]})
    out = {"updated": now.isoformat(), "source": "Marine Institute (CC BY 4.0)", "stations": list(stations.values())}
    print(len(out["stations"]), "stations")
    if os.environ.get("DRY_RUN"):
        return
    import boto3
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    s3.put_object(Bucket=os.environ["R2_BUCKET"], Key="tides/ie.json", Body=json.dumps(out).encode(),
                  ContentType="application/json", CacheControl="public, max-age=3600")


if __name__ == "__main__":
    main()
