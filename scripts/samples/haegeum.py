"""해금 from 국립국악원 단음 기본음계 recordings: Haegeum_2 (약), Haegeum_1 (중), Haegeum_10 (강).

Each scale recording is cut into sustained notes (see analysis.cut_scale); the detected pitch sets the
root and `tune` (the scale is tuned 황종 ≈ E♭, offsets are corrected per note); loops sit in the sustain.
Run: python scripts/samples/haegeum.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gugak_scale import Layer, build  # noqa: E402

if __name__ == "__main__":
    build("haegeum", "Haegeum", "해금",
          [Layer("해금", 2474, "p"), Layer("해금", 2406, "mf"), Layer("해금", 2482, "f")],
          release=0.5, main=1, fmax=1500)
