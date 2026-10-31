"""가야금 from 국립국악원 확장 음원 `Gayageum_SingleNote1_*` (연주 윤다영). See gugak_download.py.

Each source file plays one note three times, 약 → 중 → 강, ~8 s apart. We take every 2nd semitone
from E2 to Ab5, split each file at its three onsets and map the strokes to three velocity layers.
If a file does not show exactly three onsets, only the middle-loudness stroke is used as a single layer.
Run: python scripts/samples/gayageum.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analysis import detect_pitch, envelope_db, find_onsets, hz_to_midi  # noqa: E402
from common import (PUBLIC, RATE, Manifest, Zone, clear_set, decode, encode_many, key_ranges, log,  # noqa: E402
                    normalize_set, set_size_mb, trim, velocity_ranges)
from gugak_download import Session, attribution, ensure, gayageum_single_notes, seq_of, write_license  # noqa: E402

SET = "gayageum"
PERFORMER = "윤다영"
LO_NOTE, HI_NOTE = 40, 80  # E2 .. Ab5, every 2nd semitone
KEY_LO, KEY_HI = 36, 84
MAX_SECONDS = 5.5  # 6 s puts the set just over its 8 MB budget
FADE = 0.3
NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def note_name(m: int) -> str:
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def stroke_pitch(clip: np.ndarray) -> float | None:
    """Pitch over the first second after the attack (high strings decay fast)."""
    body = clip[int(0.05 * RATE):int(1.05 * RATE)]
    r = detect_pitch(body, fmin=60, fmax=1500, frame=4096, region=(0.0, 1.0))
    return r[0] if r and r[1] > 0.8 else None


def main() -> None:
    session = Session()
    items = {Path(x["wavFilePath"]).stem.split("_")[-1]: x for x in gayageum_single_notes(session)}
    wanted = {m: items[note_name(m)] for m in range(LO_NOTE, HI_NOTE + 1, 2)}
    paths = ensure("extend", list(wanted.values()), session)

    clips: dict[str, np.ndarray] = {}
    layers: dict[int, list[tuple[str, float | None]]] = {}
    sources: list[str] = []
    skipped: list[str] = []
    for root, item in wanted.items():
        audio = decode(paths[seq_of(item)])
        env = envelope_db(audio)
        end_db = max(-60.0, float(np.median(env[:max(1, int(np.argmax(env > -40)) - 2)])) + 8)
        onsets = find_onsets(audio, on_db=-30, quiet_db=-45, quiet_for=0.3)
        bounds = [int(o * RATE) for o in onsets] + [len(audio)]
        strokes = []
        for a, b in zip(bounds[:-1], bounds[1:]):
            strokes.append(trim(audio[max(0, a - int(0.01 * RATE)):b], start_db=-40, end_db=end_db,
                                max_seconds=MAX_SECONDS, fade_out=FADE))
        name = Path(item["wavFilePath"]).name
        sources.append(f"{name} (확장 extendSeq {seq_of(item)})")
        if len(strokes) != 3:
            msg = f"{name}: {len(onsets)} onsets at {[round(o, 2) for o in onsets]}, using one stroke"
            log("WARN", msg)
            skipped.append(msg)
            peaks = [float(np.abs(s).max()) for s in strokes]
            strokes = [strokes[int(np.argsort(peaks)[len(peaks) // 2])]] if strokes else []
        if not strokes:
            continue
        peaks = [float(20 * np.log10(np.abs(s).max())) for s in strokes]
        if len(strokes) == 3 and not peaks[0] < peaks[1] < peaks[2]:
            log("WARN", f"{name}: strokes not 약<중<강 ({[round(p, 1) for p in peaks]} dB), sorting by peak")
            strokes = [strokes[i] for i in np.argsort(peaks)]
        layers[root] = []
        cents = []
        for i, s in enumerate(strokes):
            file = f"{note_name(root)}_v{i + 1}"
            clips[file] = s
            f = stroke_pitch(s)
            if f is not None:
                m, c = hz_to_midi(f)
                if m == root:
                    cents.append(c)
                else:
                    log("WARN", f"{file}: detected {note_name(m)} {c:+.0f}c, file says {note_name(root)}")
            layers[root].append((file, None))
        tune = round(-float(np.median(cents)), 1) if cents else None
        layers[root] = [(f, tune) for f, _ in layers[root]]
        log(f"{note_name(root):4s} onsets {[round(o, 2) for o in onsets]} peaks {[round(p, 1) for p in peaks]} dB "
            f"len {[round(len(s) / RATE, 2) for s in strokes]} s tune {tune}")

    zones: list[Zone] = []
    roots = sorted(layers)
    for root, (lo, hi) in zip(roots, key_ranges(roots, KEY_LO, KEY_HI)):
        for (file, tune), (vlo, vhi) in zip(layers[root], velocity_ranges(len(layers[root]))):
            zones.append(Zone(file=file, root=root, lo=lo, hi=hi, vlo=round(vlo, 4), vhi=round(vhi, 4),
                              tune=tune if tune else None))

    clear_set(SET)
    encode_many(normalize_set(clips), PUBLIC / SET, pitched=True)
    write_license(SET, sources, PERFORMER)
    Manifest(id=SET, name="Gayageum", nameKo="가야금", kind="pitched", category="gugak",
             attribution=attribution(PERFORMER), release=0.4, zones=zones).write()
    log(f"{SET}: roots {[note_name(r) for r in roots]}")
    log(f"{SET}: {len(zones)} zones, {set_size_mb(SET):.2f} MB; skipped: {skipped or 'none'}")


if __name__ == "__main__":
    main()
