"""Shared builder for the multi-layer acoustic piano sets (salamander, bitklavier). See docs/SAMPLES.md.

Both sources sample every minor third from A0 to C8 (30 notes) with 16 velocity layers and
88 key-release ("rel") noises. We keep LAYERS of the 16, give each note a length cap that
follows how long that register really rings (long bass, short treble) and end capped notes
with a long raised-cosine fade so the tail dies away instead of stopping. One common gain is
applied to the whole set so the loudness steps between layers are preserved.

The official archive is read in place (zipfile) and every member is piped through ffmpeg;
nothing from the archive is extracted to disk or executed. Pass --archive to use a copy you
downloaded yourself; otherwise it is downloaded into .samples-cache/. The archive's MD5
(published in the archive.org item metadata) is verified either way.
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from common import (CACHE, PUBLIC, RATE, Manifest, Zone, clear_set, db, download, encode_many, key_ranges,
                    log, peak_db, set_size_mb, velocity_ranges, write_license)

# (source note name, MIDI root). Output files use 's' for sharps ("Ds1") so names stay [\w.-].
NOTES = [(f"{n}{o}", 12 * (o + 1) + {"C": 0, "D#": 3, "F#": 6, "A": 9}[n])
         for o in range(0, 9) for n in ("C", "D#", "F#", "A") if 21 <= 12 * (o + 1) + {"C": 0, "D#": 3, "F#": 6, "A": 9}[n] <= 108]
KEY_LO, KEY_HI = 21, 108

# Length cap (seconds) by MIDI note, linearly interpolated. Scaled down together if the set
# would decode to more than DECODED_BUDGET_MIB (web AudioBuffer and native PcmAsset are float32).
CAP_POINTS = [(21, 14.0), (45, 11.0), (60, 7.5), (72, 5.0), (84, 3.5), (96, 2.6), (108, 2.0)]
DECODED_BUDGET_MIB = 275
END_DB = -66            # natural end: smoothed level falls below this (after set normalization)
START_REL_DB = -36      # attack starts where the clip first reaches its peak minus this
LEAD = 0.003            # keep this much before the attack
RELEASE_MAX = 1.2       # key-release noises are short; cap them anyway
OPUS_KBPS = 96
AAC_KBPS = 128
FORMAT_BUDGET_MB = 20   # per format (docs/SAMPLES.md)


@dataclass
class PianoSpec:
    set_id: str
    name: str
    name_ko: str
    archive_url: str
    archive_md5: str
    layers: list[int]
    pitched_member: Callable[[str, int], str]  # (source note "D#1", layer 1..16) -> zip member
    release_member: Callable[[int], str]       # key 1..88 -> zip member
    attribution: dict
    license_extra: str
    release_gain_db: float = 0.0               # extra trim baked into the key-release noises
    layer_gain_db: dict[int, float] = field(default_factory=dict)  # per-layer trim baked in


def veltrack_layer_gains(layers: list[int], veltrack: float = 0.985) -> dict[int, float]:
    """Per-layer gain (dB, loudest layer 0) for banks whose layers are loudness-matched.

    Such banks (Accurate-Salamander) rely on the player's SFZ velocity tracking
    (amplitude = 1 - veltrack + veltrack * (vel/127)^2). Our sampler only multiplies by
    0.25 + 0.75 * velocity, so we bake the rest into each layer: at the centre x of the
    layer's velocity range, layer gain * (0.25 + 0.75 x) matches the SFZ amplitude.
    """
    gains = []
    for vlo, vhi in velocity_ranges(len(layers)):
        x = (vlo + vhi) / 2
        gains.append((1 - veltrack + veltrack * x * x) / (0.25 + 0.75 * x))
    top = gains[-1]
    return {layer: round(20 * float(np.log10(g / top)), 2) for layer, g in zip(layers, gains)}


def out_name(note: str, layer: int) -> str:
    return f"{note.replace('#', 's')}v{layer}"


def md5sum(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def decode_bytes(data: bytes, max_seconds: float | None = None) -> np.ndarray:
    """WAV/FLAC bytes -> float32 (frames, 2) at RATE; soxr resampling when the source is 44.1 kHz."""
    cmd = ["ffmpeg", "-v", "error", "-i", "pipe:0"]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-af", "aresample=resampler=soxr:precision=28", "-f", "f32le", "-acodec", "pcm_f32le",
            "-ac", "2", "-ar", str(RATE), "pipe:1"]
    raw = subprocess.run(cmd, input=data, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def cap_seconds(midi: int, scale: float) -> float:
    xs, ys = zip(*CAP_POINTS)
    return float(np.interp(midi, xs, ys)) * scale


def envelope_db(audio: np.ndarray, block: int = 960) -> np.ndarray:
    """Peak level per 20 ms block in dBFS."""
    mono = np.abs(audio).max(axis=1)
    n = len(mono) // block
    blocks = mono[: n * block].reshape(n, block).max(axis=1) if n else np.array([mono.max(initial=0)])
    return 20 * np.log10(np.maximum(blocks, 1e-9))


def shape_pitched(audio: np.ndarray, cap: float) -> np.ndarray:
    peak = float(np.abs(audio).max())
    mono = np.abs(audio).max(axis=1)
    above = np.nonzero(mono >= peak * db(START_REL_DB))[0]
    start = max(0, int(above[0] - LEAD * RATE)) if len(above) else 0
    audio = audio[start:]
    env = envelope_db(audio)
    alive = np.nonzero(env > END_DB)[0]
    natural = (int(alive[-1]) + 1) * 960 + int(0.05 * RATE) if len(alive) else len(audio)
    end = min(len(audio), natural, int(cap * RATE))
    out = audio[:end].copy()
    capped = end < natural
    # Capped notes get a long raised-cosine fade (a faster but smooth decay); natural ends a short one.
    fade = int((min(3.0, max(0.5, 0.35 * cap)) if capped else 0.05) * RATE)
    fade = min(fade, len(out))
    if fade > 0:
        out[-fade:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade, dtype=np.float32)))[:, None]
    return out


def shape_release(audio: np.ndarray) -> np.ndarray:
    peak = float(np.abs(audio).max())
    if peak <= 0:
        return audio[:1]
    mono = np.abs(audio).max(axis=1)
    above = np.nonzero(mono >= peak * db(-30))[0]
    start = max(0, int(above[0] - LEAD * RATE))
    audio = audio[start:]
    env = envelope_db(audio)
    alive = np.nonzero(env > peak_db(audio) - 45)[0]
    end = min(len(audio), (int(alive[-1]) + 1) * 960 + int(0.03 * RATE), int(RELEASE_MAX * RATE))
    out = audio[:end].copy()
    n = min(len(out), int(0.03 * RATE))
    out[-n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
    return out


def decoded_mib(clips: dict[str, np.ndarray]) -> float:
    return sum(len(c) for c in clips.values()) * 2 * 4 / 2**20


def read_members(archive: Path, names: list[str], max_seconds: float | None) -> list[np.ndarray]:
    with zipfile.ZipFile(archive) as z:
        blobs = [z.read(n) for n in names]
    with ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(lambda b: decode_bytes(b, max_seconds), blobs))


def get_archive(spec: PianoSpec, given: str | None) -> Path:
    path = Path(given) if given else download(spec.archive_url, CACHE / spec.set_id / spec.archive_url.rsplit("/", 1)[-1])
    log("verify md5", path.name)
    got = md5sum(path)
    if got != spec.archive_md5:
        raise SystemExit(f"{path}: md5 {got} != published {spec.archive_md5}")
    return path


def analyze(spec: PianoSpec, archive: Path) -> None:
    """Print the level of the first 0.5 s of every layer for a few notes (to choose LAYERS)."""
    for note in ("A1", "C4", "A5"):
        names = [spec.pitched_member(note, v) for v in range(1, 17)]
        clips = read_members(archive, names, 1.0)
        row = []
        for v, c in zip(range(1, 17), clips):
            seg = c[: RATE // 2]
            row.append(f"v{v}:{peak_db(seg):.1f}/{10 * np.log10(np.mean(seg ** 2) + 1e-12):.1f}")
        log(note, " ".join(row))
    rel = read_members(archive, [spec.release_member(k) for k in (20, 40, 60)], 2.0)
    log("rel peaks", [f"{peak_db(c):.1f}" for c in rel])


def build(spec: PianoSpec) -> None:
    ap = argparse.ArgumentParser(description=f"Build public/samples/{spec.set_id}")
    ap.add_argument("--archive", help="official archive already downloaded (verified against the published MD5)")
    ap.add_argument("--analyze", action="store_true", help="only print per-layer levels")
    args = ap.parse_args()
    archive = get_archive(spec, args.archive)
    if args.analyze:
        analyze(spec, archive)
        return

    pitched_keys = [(note, root, v) for note, root in NOTES for v in spec.layers]
    log("decode", len(pitched_keys), "notes +", 88, "releases")
    longest = CAP_POINTS[0][1] + 1
    raw = read_members(archive, [spec.pitched_member(n, v) for n, _, v in pitched_keys], longest)
    pitched_raw = {out_name(n, v): a * db(spec.layer_gain_db.get(v, 0.0)) for (n, _, v), a in zip(pitched_keys, raw)}
    rel_raw = read_members(archive, [spec.release_member(k) for k in range(1, 89)], 4.0)

    # One gain for the whole set: loudest pitched sample -> -1 dBFS. Release noises share it.
    gain = db(-1) / max(float(np.abs(a).max()) for a in pitched_raw.values())
    pitched_raw = {k: (a * gain).astype(np.float32) for k, a in pitched_raw.items()}
    releases = {f"rel{k}": shape_release((a * gain * db(spec.release_gain_db)).astype(np.float32))
                for k, a in zip(range(1, 89), rel_raw)}

    roots = {out_name(n, v): r for n, r, v in pitched_keys}
    scale = 1.0
    for _ in range(12):
        pitched = {k: shape_pitched(a, cap_seconds(roots[k], scale)) for k, a in pitched_raw.items()}
        total = decoded_mib({**pitched, **releases})
        log(f"cap scale {scale:.3f}: decoded {total:.1f} MiB")
        if total <= DECODED_BUDGET_MIB:
            break
        scale *= 0.97 * DECODED_BUDGET_MIB / total
    else:
        raise SystemExit("could not meet the decoded-memory budget")

    clear_set(spec.set_id)
    out = PUBLIC / spec.set_id
    encode_many({**pitched, **releases}, out, pitched=True, workers=8, opus_kbps=OPUS_KBPS, aac_kbps=AAC_KBPS)
    sizes = {fmt: set_size_mb(spec.set_id, f".{fmt}") for fmt in ("webm", "m4a")}
    for fmt, size in sizes.items():
        if size > FORMAT_BUDGET_MB:
            raise SystemExit(f"{spec.set_id}: {fmt} {size:.2f} MB exceeds {FORMAT_BUDGET_MB} MB")

    ranges = dict(zip([r for _, r in NOTES], key_ranges([r for _, r in NOTES], KEY_LO, KEY_HI)))
    vel = velocity_ranges(len(spec.layers))
    zones = [Zone(file=out_name(n, v), root=r, lo=ranges[r][0], hi=ranges[r][1], vlo=round(vlo, 4), vhi=round(vhi, 4))
             for n, r in NOTES for v, (vlo, vhi) in zip(spec.layers, vel)]
    release_zones = [Zone(file=f"rel{k}", root=20 + k, lo=20 + k, hi=20 + k) for k in range(1, 89)]
    Manifest(id=spec.set_id, name=spec.name, nameKo=spec.name_ko, kind="pitched", category="piano",
             attribution=spec.attribution, release=0.3, zones=zones, releaseZones=release_zones).write()
    write_license(spec.set_id, spec.attribution, spec.license_extra)

    lengths = [len(c) / RATE for c in pitched.values()]
    log(f"{spec.set_id}: {len(pitched)} notes + {len(releases)} releases, cap scale {scale:.3f}, "
        f"pitched avg {np.mean(lengths):.2f} s (max {max(lengths):.2f}), decoded {total:.1f} MiB, "
        f"webm {sizes['webm']:.2f} MB, m4a {sizes['m4a']:.2f} MB")
    for k in (out_name("C4", spec.layers[0]), out_name("C4", spec.layers[-1]), out_name("A0", spec.layers[-1]), "rel40"):
        c = {**pitched, **releases}[k]
        log(f"  {k}: {len(c) / RATE:.2f} s, peak {peak_db(c):.1f} dBFS")
