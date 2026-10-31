"""Build public/samples/salamander — Salamander Grand Piano V3 (Alexander Holm, CC BY 3.0).

Source files are the MP3 encodings shipped with https://github.com/tambien/Piano
(served from https://tambien.github.io/Piano/audio/). 16 velocity layers exist
upstream; we keep LAYERS of them plus the 88 key-release noises.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from common import (CACHE, PUBLIC, Manifest, Zone, clear_set, decode, download_many, encode_many,
                    key_ranges, log, normalize_set, peak_db, set_size_mb, trim, velocity_ranges,
                    write_license)

SET = "salamander"
BASE = "https://tambien.github.io/Piano/audio/"
NOTES = ("A0 C1 Ds1 Fs1 A1 C2 Ds2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6 Ds6 Fs6 A6 "
         "C7 Ds7 Fs7 A7 C8").split()  # 'Ds' = D#
LAYERS = [3, 8, 13]  # upstream velocity layers (1..16), soft → loud
BUDGET_MB = 20
CAPS = [12.0, 10.0, 9.0]  # pitched length cap candidates; the first that fits BUDGET_MB wins
RELEASE = 0.3
KEY_LO, KEY_HI = 21, 108

SEMITONE = {"C": 0, "Cs": 1, "D": 2, "Ds": 3, "E": 4, "F": 5, "Fs": 6, "G": 7, "Gs": 8, "A": 9, "As": 10, "B": 11}

ATTRIBUTION = {
    "title": "Salamander Grand Piano V3",
    "author": "Alexander Holm",
    "url": "https://archive.org/details/SalamanderGrandPianoV3",
    "license": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "changes": (f"30 notes × {len(LAYERS)} velocity layers and 88 key-release samples selected, trimmed, "
                "normalized, encoded to Opus/AAC (via MP3 encodings from https://github.com/tambien/Piano)"),
}


def midi(note: str) -> int:
    name, octave = note[:-1], int(note[-1])
    return 12 * (octave + 1) + SEMITONE[name]


def main() -> None:
    cache = CACHE / SET
    pitched_names = [f"{n}v{v}" for n in NOTES for v in LAYERS]
    release_names = [f"rel{i}" for i in range(1, 89)]
    download_many([(BASE + f"{name}.mp3", cache / f"{name}.mp3") for name in pitched_names + release_names])

    log("decode", len(pitched_names) + len(release_names), "files")
    raw = {name: decode(cache / f"{name}.mp3") for name in pitched_names + release_names}
    # MP3 has ~50 ms encoder delay and a soft pre-roll: trim at -50 dB so the attack is not cut.
    releases = {name: trim(raw[name], start_db=-50) for name in release_names}

    roots = [midi(n) for n in NOTES]
    ranges = dict(zip(roots, key_ranges(roots, KEY_LO, KEY_HI)))
    vel = velocity_ranges(len(LAYERS))

    for cap in CAPS:
        log(f"trim pitched @ max {cap:g} s")
        pitched = {name: trim(raw[name], start_db=-50, max_seconds=cap, fade_out=RELEASE) for name in pitched_names}
        clips = normalize_set({**pitched, **releases})

        clear_set(SET)
        out = PUBLIC / SET
        encode_many(clips, out, pitched=True)
        size = set_size_mb(SET)
        log(f"cap {cap:g} s → {size:.2f} MB")
        if size <= BUDGET_MB:
            break
    else:
        raise SystemExit(f"{SET}: {size:.2f} MB exceeds {BUDGET_MB} MB even at {CAPS[-1]:g} s")

    zones = []
    for n in NOTES:
        r = midi(n)
        lo, hi = ranges[r]
        for v, (vlo, vhi) in zip(LAYERS, vel):
            zones.append(Zone(file=f"{n}v{v}", root=r, lo=lo, hi=hi, vlo=round(vlo, 4), vhi=round(vhi, 4)))
    release_zones = [Zone(file=f"rel{i}", root=20 + i, lo=20 + i, hi=20 + i) for i in range(1, 89)]

    Manifest(id=SET, name="Grand Piano", nameKo="그랜드 피아노", kind="pitched", category="piano",
             attribution=ATTRIBUTION, release=RELEASE, zones=zones, releaseZones=release_zones).write()
    write_license(SET, ATTRIBUTION,
                  "Original samples: Alexander Holm, Salamander Grand Piano V3 "
                  "(https://archive.org/details/SalamanderGrandPianoV3), CC BY 3.0.\n"
                  "MP3 intermediates: https://github.com/tambien/Piano (same license).")

    for name in (f"{NOTES[13]}v{LAYERS[0]}", f"{NOTES[13]}v{LAYERS[-1]}", "rel40"):
        c = clips[name]
        log(f"{name}: {len(c) / 48000:.2f} s, peak {peak_db(c):.1f} dBFS")
    log(f"{SET}: {len(list(out.glob('*.webm')))} clips, {set_size_mb(SET):.2f} MB")


if __name__ == "__main__":
    main()
