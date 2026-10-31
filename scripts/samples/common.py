"""Shared helpers for building sample sets. See docs/SAMPLES.md.

Requires ffmpeg on PATH and numpy (pip install numpy). Audio is decoded through
ffmpeg to float32 PCM, trimmed/faded in numpy, then encoded to Opus (webm) and AAC (m4a).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public" / "samples"
CACHE = ROOT / ".samples-cache"  # gitignored raw downloads
RATE = 48000


def log(*parts: object) -> None:
    print(*parts, file=sys.stderr, flush=True)


def download(url: str, dest: Path, headers: dict[str, str] | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    log("download", url)
    req = urllib.request.Request(url, headers={"User-Agent": "garak-ieum-samples/1.0", **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def download_many(items: list[tuple[str, Path]], workers: int = 8) -> list[Path]:
    """download() several (url, dest) pairs concurrently; returns dests in input order."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda it: download(it[0], it[1]), items))


def decode(path: Path) -> np.ndarray:
    """Returns float32 array shaped (frames, channels) at RATE."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
         "-of", "json", str(path)], capture_output=True, text=True, check=True)
    channels = int(json.loads(probe.stdout)["streams"][0]["channels"])
    channels = 2 if channels >= 2 else 1
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le",
         "-ac", str(channels), "-ar", str(RATE), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).copy()


def db(x: float) -> float:
    return 10 ** (x / 20)


def trim(audio: np.ndarray, *, start_db: float = -40, end_db: float = -60, end_hold: float = 0.05,
         max_seconds: float | None = None, fade_out: float = 0.02, lead: float = 0.002) -> np.ndarray:
    mono = np.abs(audio).max(axis=1)
    above = np.nonzero(mono > db(start_db))[0]
    if len(above) == 0:
        return audio[:1]
    start = max(0, int(above[0] - lead * RATE))
    tail = np.nonzero(mono > db(end_db))[0]
    end = min(len(audio), int(tail[-1] + end_hold * RATE))
    if max_seconds is not None:
        end = min(end, start + int(max_seconds * RATE))
    out = audio[start:end].copy()
    n = min(len(out), int(fade_out * RATE))
    if n > 0:
        out[-n:] *= np.linspace(1, 0, n, dtype=np.float32)[:, None]
    return out


def normalize_set(clips: dict[str, np.ndarray], peak_db: float = -1) -> dict[str, np.ndarray]:
    """One common gain for the whole set, preserving relative levels between layers."""
    peak = max((np.abs(c).max() for c in clips.values()), default=0)
    if peak <= 0:
        return clips
    g = db(peak_db) / peak
    return {k: (v * g).astype(np.float32) for k, v in clips.items()}


def peak_db(audio: np.ndarray) -> float:
    peak = float(np.abs(audio).max()) if len(audio) else 0.0
    return 20 * np.log10(peak) if peak > 0 else float("-inf")


def encode(audio: np.ndarray, out_base: Path, *, pitched: bool = False) -> None:
    out_base.parent.mkdir(parents=True, exist_ok=True)
    ch = audio.shape[1]
    pcm = audio.astype(np.float32).tobytes()
    base = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", str(ch), "-i", "-"]
    subprocess.run(base + ["-c:a", "libopus", "-b:a", "64k" if pitched else "96k", "-application", "audio",
                           "-frame_duration", "20", str(out_base.with_suffix(".webm"))], input=pcm, check=True)
    subprocess.run(base + ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                           str(out_base.with_suffix(".m4a"))], input=pcm, check=True)


@dataclass
class Zone:
    file: str
    root: int
    lo: int
    hi: int
    vlo: float = 0.0
    vhi: float = 1.0
    gainDb: float | None = None
    tune: float | None = None
    loop: list[float] | None = None
    choke: int | None = None

    def json(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Manifest:
    id: str
    name: str
    nameKo: str
    kind: str  # pitched | kit
    category: str  # piano | keys | drums | gugak
    attribution: dict
    gainDb: float = 0
    release: float = 0.25
    zones: list[Zone] = field(default_factory=list)
    releaseZones: list[Zone] = field(default_factory=list)

    def write(self) -> Path:
        out = PUBLIC / self.id / "manifest.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "id": self.id, "name": self.name, "nameKo": self.nameKo, "kind": self.kind,
            "category": self.category, "formats": ["webm", "m4a"], "gainDb": self.gainDb,
            "release": self.release, "zones": [z.json() for z in self.zones],
            "releaseZones": [z.json() for z in self.releaseZones], "attribution": self.attribution,
        }
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return out


def velocity_ranges(n: int) -> list[tuple[float, float]]:
    """Split 0..1 into n contiguous layers, lowest layer first."""
    return [(i / n, (i + 1) / n) for i in range(n)]


def key_ranges(roots: list[int], lo: int = 0, hi: int = 127) -> list[tuple[int, int]]:
    """Give each sampled root the keys nearest to it."""
    roots = sorted(roots)
    out = []
    for i, r in enumerate(roots):
        a = lo if i == 0 else (roots[i - 1] + r) // 2 + 1
        b = hi if i == len(roots) - 1 else (r + roots[i + 1]) // 2
        out.append((a, b))
    return out


def encode_many(clips: dict[str, np.ndarray], out_dir: Path, *, pitched: bool = False, workers: int = 4) -> None:
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(lambda kv: encode(kv[1], out_dir / kv[0], pitched=pitched), clips.items()))


def write_license(set_id: str, attribution: dict, extra: str = "") -> Path:
    """LICENSE.txt from a manifest attribution block (title/author/url/license/licenseUrl/changes)."""
    a = attribution
    text = (f"{a['title']}\n"
            f"by {a['author']}\n"
            f"Source: {a['url']}\n\n"
            f"Licensed under {a['license']} ({a['licenseUrl']}).\n\n"
            f"Changes made for this project: {a['changes']}\n")
    if extra:
        text += "\n" + extra.rstrip() + "\n"
    out = PUBLIC / set_id / "LICENSE.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    return out


def clear_set(set_id: str) -> None:
    """Remove previously generated media so stale files never linger in the set."""
    d = PUBLIC / set_id
    if d.exists():
        for p in d.glob("*"):
            if p.suffix in (".webm", ".m4a", ".json", ".txt"):
                p.unlink()


def set_size_mb(set_id: str) -> float:
    return sum(p.stat().st_size for p in (PUBLIC / set_id).glob("*") if p.is_file()) / 1e6
