"""Shared build pipeline for drum kit sets (kind "kit"). See docs/SAMPLES.md.

Sources are fetched from GitHub repos. Paths are verified against the git trees API
before download, and Git LFS pointer files are resolved through media.githubusercontent.com.
"""
from __future__ import annotations

import json
import subprocess
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from common import (CACHE, PUBLIC, RATE, Manifest, Zone, decode, download, encode_many, log, normalize_set, set_size_mb,
                    trim, velocity_ranges)

CYMBAL_SECONDS = 6
DRUM_SECONDS = 3
CAP_FADE = 0.5
_TREES: dict[tuple[str, str], set[str]] = {}


def gh_tree(repo: str, branch: str) -> set[str]:
    key = (repo, branch)
    if key not in _TREES:
        cache = CACHE / "trees" / f"{repo.replace('/', '_')}_{branch}.json"
        if not cache.exists():
            download(f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1", cache,
                     headers={"Accept": "application/vnd.github+json"})
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("truncated"):
            raise RuntimeError(f"tree listing truncated for {repo}@{branch}")
        _TREES[key] = {t["path"] for t in data["tree"] if t["type"] == "blob"}
    return _TREES[key]


def fetch(repo: str, branch: str, path: str) -> Path:
    """Download one file from a GitHub repo into the cache, verifying the path exists."""
    if path not in gh_tree(repo, branch):
        raise FileNotFoundError(f"{repo}@{branch}: {path}")
    dest = CACHE / repo.replace("/", "_") / path
    quoted = urllib.parse.quote(path)
    download(f"https://raw.githubusercontent.com/{repo}/{branch}/{quoted}", dest)
    if dest.stat().st_size < 200 and dest.read_bytes().startswith(b"version https://git-lfs"):
        log("lfs pointer, fetching media", path)
        dest.unlink()
        download(f"https://media.githubusercontent.com/media/{repo}/{branch}/{quoted}", dest)
    return dest


def source_rate(path: Path) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=sample_rate", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return int(json.loads(out.stdout)["streams"][0]["sample_rate"])


@dataclass
class Source:
    repo: str
    branch: str
    path: str
    offset: int = 0  # frames to drop at the start, in the source file's sample rate (sfz offset=)

    def load(self) -> np.ndarray:
        p = fetch(self.repo, self.branch, self.path)
        audio = decode(p)
        if self.offset:
            audio = audio[int(round(self.offset * RATE / source_rate(p))):]
        return audio


@dataclass
class Piece:
    """One kit piece: a list of velocity layers (lowest first) shared by one or more notes."""
    name: str  # output file base; layers get a v1..vN suffix when there is more than one
    notes: list[tuple[int, float | None]]  # (midi note, tune in cents or None)
    layers: list[Source]
    choke: int | None = None
    max_seconds: float = DRUM_SECONDS
    process: Callable[[np.ndarray], np.ndarray] | None = None  # applied before trimming
    gainDb: float | None = None  # manifest-level correction, for pieces borrowed from another library

    def file(self, i: int) -> str:
        return self.name if len(self.layers) == 1 else f"{self.name}v{i + 1}"


def trim_oneshot(audio: np.ndarray, max_seconds: float, gain_db: float = 0) -> np.ndarray:
    """docs/SAMPLES.md one-shot trim, with thresholds relative to the level the zone will play at.
    Clips that are still ringing at max_seconds get a longer fade."""
    out = trim(audio, start_db=-40 - gain_db, lead=0.002, end_db=-60 - gain_db, end_hold=0.05, fade_out=0.02)
    cap = int(max_seconds * RATE)
    if len(out) > cap:
        out = out[:cap].copy()
        n = int(CAP_FADE * RATE)
        out[-n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
    return out


@dataclass
class KitSpec:
    id: str
    name: str
    nameKo: str
    attribution: dict
    pieces: list[Piece]
    license_text: str
    gainDb: float = 0
    extra_files: dict[str, str] = field(default_factory=dict)


def build_kit(spec: KitSpec) -> None:
    out_dir = PUBLIC / spec.id
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in list(out_dir.glob("*.webm")) + list(out_dir.glob("*.m4a")):
        stale.unlink()

    clips: dict[str, np.ndarray] = {}
    zones: list[Zone] = []
    for piece in spec.pieces:
        ranges = velocity_ranges(len(piece.layers))
        for i, (src, (vlo, vhi)) in enumerate(zip(piece.layers, ranges)):
            fname = piece.file(i)
            if fname not in clips:
                audio = src.load()
                if piece.process is not None:
                    audio = piece.process(audio)
                audio = trim_oneshot(audio, piece.max_seconds, piece.gainDb or 0)
                if len(audio) < RATE * 0.01:
                    raise RuntimeError(f"{fname}: trimmed to {len(audio)} frames from {src.path}")
                clips[fname] = audio
            for note, tune in piece.notes:
                zones.append(Zone(file=fname, root=note, lo=note, hi=note, vlo=round(vlo, 4), vhi=round(vhi, 4),
                                  gainDb=piece.gainDb, tune=tune, choke=piece.choke))

    clips = normalize_set(clips, peak_db=-1)
    for fname, audio in clips.items():
        log(f"encode {spec.id}/{fname}  {len(audio) / RATE:.2f}s  {audio.shape[1]}ch")
    encode_many(clips, out_dir)

    zones.sort(key=lambda z: (z.root, z.vlo))
    manifest = Manifest(id=spec.id, name=spec.name, nameKo=spec.nameKo, kind="kit", category="drums",
                        attribution=spec.attribution, gainDb=spec.gainDb, release=0, zones=zones)
    manifest.write()
    (out_dir / "LICENSE.txt").write_text(spec.license_text, encoding="utf-8")
    for name, text in spec.extra_files.items():
        (out_dir / name).write_text(text, encoding="utf-8")

    log(f"{spec.id}: {len(clips)} clips, {len(zones)} zones, {set_size_mb(spec.id):.2f} MB")


def fetch_text(url: str, name: str) -> str:
    dest = CACHE / "licenses" / name
    download(url, dest)
    return dest.read_text(encoding="utf-8")


def read_text(repo: str, branch: str, path: str) -> str:
    return fetch(repo, branch, path).read_text(encoding="utf-8")


def lowpass(hz: float, gain_db: float = 0) -> Callable[[np.ndarray], np.ndarray]:
    """Return a process() that runs the clip through ffmpeg's lowpass filter."""
    def run(audio: np.ndarray) -> np.ndarray:
        ch = audio.shape[1]
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(RATE), "-ac", str(ch), "-i", "-",
             "-af", f"lowpass=f={hz}:p=2,volume={gain_db}dB", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
            input=audio.astype(np.float32).tobytes(), capture_output=True, check=True).stdout
        return np.frombuffer(out, dtype=np.float32).reshape(-1, ch).copy()
    return run
