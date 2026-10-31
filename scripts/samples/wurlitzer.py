"""Build public/samples/wurlitzer — Wurlitzer EP200 from Greg Sullivan's E-Pianos (CC BY 3.0).

Zones come straight from the SFZ mapping by kinwie in
https://github.com/sfzinstruments/GregSullivan.E-Pianos ("Wurlitzer EP200/Wurlitzer EP200.sfz").
"""
from __future__ import annotations

import re
import subprocess
import urllib.parse

import numpy as np

from common import (CACHE, PUBLIC, RATE, Manifest, Zone, clear_set, db, decode, download, download_many,
                    encode_many, log, normalize_set, peak_db, set_size_mb, write_license)

SET = "wurlitzer"
RAW = "https://raw.githubusercontent.com/sfzinstruments/GregSullivan.E-Pianos/master/"
FOLDER = "Wurlitzer EP200/"
SFZ = "Wurlitzer EP200.sfz"
BUDGET_MB = 3
CAPS = [None, 6.0, 5.0, 4.0]  # length cap candidates (s); None = keep full length
RELEASE = 0.2

ATTRIBUTION = {
    "title": "Wurlitzer EP200 (E-Pianos)",
    "author": "Greg Sullivan (SFZ mapping by kinwie)",
    "url": "https://github.com/sfzinstruments/GregSullivan.E-Pianos",
    "license": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "changes": "converted FLAC → Opus/AAC, trimmed, normalized",
}


def url(path: str) -> str:
    return RAW + urllib.parse.quote(path)


def parse_sfz(text: str) -> list[dict[str, str]]:
    """Flatten <global>/<group>/<region> opcodes into one dict per region (no <master>/#include support)."""
    defines = dict(re.findall(r"^#define\s+(\$\w+)\s+(\S+)", text, re.M))
    text = re.sub(r"//.*", "", text)
    for k in sorted(defines, key=len, reverse=True):
        text = text.replace(k, defines[k])
    regions: list[dict[str, str]] = []
    scopes: dict[str, dict[str, str]] = {"control": {}, "global": {}, "group": {}}
    current: dict[str, str] | None = None
    for header, body in re.findall(r"<(\w+)>([^<]*)", text):
        ops = dict(re.findall(r"(\w+)=(\S+)", body))
        if header == "region":
            current = {**scopes["global"], **scopes["group"], **ops}
            regions.append(current)
        elif header in scopes:
            if header == "global":
                scopes["group"] = {}
            scopes[header] = ops
    default_path = scopes["control"].get("default_path", "")
    for r in regions:
        r["sample"] = default_path + r["sample"].replace("\\", "/")
    return regions


def source_rate(path) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    return int(out.strip())


def main() -> None:
    cache = CACHE / SET
    sfz_path = download(url(FOLDER + SFZ), cache / SFZ)
    regions = parse_sfz(sfz_path.read_text(encoding="utf-8"))
    samples = sorted({r["sample"] for r in regions})
    log(len(regions), "regions,", len(samples), "samples")
    paths = dict(zip(samples, download_many([(url(FOLDER + s), cache / s.split("/")[-1]) for s in samples])))

    # A sample shared by several regions gets the loudest region volume baked in; the rest becomes zone gainDb.
    baked = {s: max(float(r.get("volume", 0)) for r in regions if r["sample"] == s) for s in samples}
    name = {s: s.split("/")[-1].rsplit(".", 1)[0] for s in samples}

    full: dict[str, np.ndarray] = {}
    offset: dict[str, float] = {}
    for s in samples:
        a = decode(paths[s]) * db(baked[s])
        above = np.nonzero(np.abs(a).max(axis=1) > db(-50))[0]
        start = max(0, int(above[0] - 0.002 * RATE)) if len(above) else 0
        full[name[s]] = a[start:].astype(np.float32)
        offset[s] = start / RATE

    zones: list[Zone] = []
    min_loop_end: dict[str, float] = {}
    for r in regions:
        s = r["sample"]
        lovel, hivel = int(r.get("lovel", 0)), int(r.get("hivel", 127))
        loop = None
        if r.get("loop_mode") == "loop_continuous" and "loop_start" in r and "loop_end" in r:
            sr = source_rate(paths[s])
            loop = [round(int(r["loop_start"]) / sr - offset[s], 4), round(int(r["loop_end"]) / sr - offset[s], 4)]
            min_loop_end[name[s]] = max(min_loop_end.get(name[s], 0), loop[1])
        gain = round(float(r.get("volume", 0)) - baked[s], 2)
        tune = float(r.get("tune", 0))
        zones.append(Zone(
            file=name[s], root=int(r["pitch_keycenter"]), lo=int(r["lokey"]), hi=int(r["hikey"]),
            vlo=0.0 if lovel <= 1 else round(lovel / 127, 4), vhi=min(1.0, round((hivel + 1) / 127, 4)),
            gainDb=gain or None, tune=(int(tune) if tune.is_integer() else tune) or None, loop=loop))

    for cap in CAPS:
        clips = {}
        for k, a in full.items():
            end = len(a)
            if cap is not None:
                end = min(end, max(int(cap * RATE), int((min_loop_end.get(k, 0) + 0.05) * RATE)))
            c = a[:end].copy()
            n = min(len(c), int((0.01 if end == len(a) else RELEASE) * RATE))
            c[-n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
            clips[k] = c
        clips = normalize_set(clips)
        clear_set(SET)
        encode_many(clips, PUBLIC / SET, pitched=True)
        size = set_size_mb(SET)
        log(f"cap {cap} → {size:.2f} MB")
        if size <= BUDGET_MB:
            break
    else:
        raise SystemExit(f"{SET}: {size:.2f} MB exceeds {BUDGET_MB} MB")

    Manifest(id=SET, name="Wurlitzer EP", nameKo="월리처 전기 피아노", kind="pitched", category="keys",
             attribution=ATTRIBUTION, release=RELEASE, zones=zones).write()
    write_license(SET, ATTRIBUTION,
                  "Samples: Greg Sullivan, Wurlitzer EP200 Electric Piano v1.1 (http://www.sullivang.net/).\n"
                  "SFZ mapping: kinwie. Released under Creative Commons Attribution 3.0 Unported\n"
                  "per https://github.com/sfzinstruments/GregSullivan.E-Pianos/blob/master/LICENSE")

    for k in ("a1ff", "a1pp", "db5pp", "ab6f"):
        if k in clips:
            log(f"{k}: {len(clips[k]) / RATE:.2f} s, peak {peak_db(clips[k]):.1f} dBFS")
    log(f"{SET}: {len(clips)} clips, {len(zones)} zones, {set_size_mb(SET):.2f} MB")


if __name__ == "__main__":
    main()
