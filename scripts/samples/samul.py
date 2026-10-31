"""사물놀이 kit from 국립국악원 단음 recordings. See docs/SAMPLES.md (kit note table) and gugak_download.py.

Each 강/중/약 trio becomes three velocity layers (약 lowest). Run: python scripts/samples/samul.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis import envelope_db  # noqa: E402
from common import (PUBLIC, Manifest, Zone, clear_set, decode, encode_many, log, normalize_set, set_size_mb,  # noqa: E402
                    trim, velocity_ranges)
from gugak_download import Session, attribution, ensure, monotone_items, seq_of, write_license  # noqa: E402

SET = "samul"
LONG = {"jing", "bara"}  # ring long: allow 8 s

# note, file stem, instrument (download key), [(seq, dynamic)] strongest first
KIT = [
    (36, "yonggo", "용고", [(2276, "강"), (2277, "중"), (2278, "약")]),
    (37, "bak", "박", [(2258, "1회")]),
    (38, "janggu_deong", "장구", [(2282, "강"), (2283, "중"), (2284, "약")]),
    (39, "janggu_gideok", "장구", [(2285, "강"), (2286, "중"), (2287, "약")]),
    (40, "janggu_deok", "장구", [(2294, "강"), (2295, "중"), (2296, "약")]),
    (41, "janggu_kung", "장구", [(2288, "강"), (2289, "중"), (2290, "약")]),
    (42, "kkwaenggwari_gaeng", "꽹과리", [(2213, "강"), (2214, "중"), (2215, "약")]),
    (43, "janggu_deo", "장구", [(2297, "강"), (2298, "중"), (2299, "약")]),
    (44, "kkwaenggwari_ji", "꽹과리", [(2216, "강"), (2217, "중"), (2218, "약")]),
    (45, "jwago", "좌고", [(2305, "강"), (2306, "중"), (2307, "약")]),
    (46, "kkwaenggwari_gaek", "꽹과리", [(2222, "강"), (2223, "중"), (2224, "약")]),
    (47, "bara", "바라", [(2254, "강"), (2255, "중"), (2256, "약")]),
    (48, "kkwaenggwari_gaet", "꽹과리", [(2225, "강"), (2226, "중"), (2227, "약")]),
    (49, "jing_gang", "징", [(2334, "강")]),
    (50, "kkwaenggwari_gaes", "꽹과리", [(2219, "강"), (2220, "중"), (2221, "약")]),
    (51, "jing_yak", "징", [(2335, "약")]),
]


def main() -> None:
    session = Session()
    paths: dict[int, Path] = {}
    names: dict[int, str] = {}
    for _, _, instr, layers in KIT:
        items = monotone_items(instr, [s for s, _ in layers], session)
        names.update({seq_of(x): x["wavFileName"] for x in items})
        paths.update(ensure("monotone", items, session))

    clips: dict[str, object] = {}
    zones: list[Zone] = []
    for note, stem, _, layers in KIT:
        layers = list(reversed(layers))  # 약 → 강 so the softest gets the lowest velocity range
        ranges = velocity_ranges(len(layers))
        for i, ((seq, dyn), (vlo, vhi)) in enumerate(zip(layers, ranges)):
            audio = decode(paths[seq])
            long = stem.split("_")[0] in LONG
            # 16-bit sources sit at about -62 dBFS; keep the end threshold clear of noise spikes.
            # The floor is measured on the silent pre-roll (a 징 rings for most of its file).
            env = envelope_db(audio)
            pre = env[:max(1, int(np.argmax(env > -40)) - 2)]
            end_db = max(-60.0, float(np.median(pre)) + 8)
            # 징/바라 can still ring at the 8 s cap, so give them a long fade instead of a click
            clip = trim(audio, start_db=-40, end_db=end_db, end_hold=0.05, max_seconds=8 if long else 2.5,
                        fade_out=1.0 if long else 0.02)
            file = f"{stem}_v{i + 1}" if len(layers) > 1 else stem
            clips[file] = clip
            zones.append(Zone(file=file, root=note, lo=note, hi=note, vlo=round(vlo, 4), vhi=round(vhi, 4)))
            log(f"{file:28s} {names[seq]:22s} {dyn} {len(clip) / 48000:5.2f}s")

    clear_set(SET)
    encode_many(normalize_set(clips), PUBLIC / SET, pitched=False)

    sources = [f"{names[s]} (단음 mntnSeq {s})" for s in sorted(names)]
    write_license(SET, sources)
    Manifest(id=SET, name="Samulnori", nameKo="사물놀이", kind="kit", category="gugak",
             attribution=attribution(), release=0.25, zones=zones).write()
    log(f"{SET}: {len(zones)} zones, {set_size_mb(SET):.2f} MB")


if __name__ == "__main__":
    main()
