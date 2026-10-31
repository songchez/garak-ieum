"""대금 from 국립국악원 단음 정악대금 기본음 scale (jungak_deageum_scale_sus_25.wav).

The 정악 recording was picked over 산조 `sanjo_deageum_scale_sus_04`: both have cleanly separated
notes, but 정악 covers more of the range (18 notes, B♭3–E6 vs 13) with longer, steadier sustains for
looping. The 대금 is not tuned to A440 equal temperament; offsets of up to ±50 cents are corrected
per note through `tune`. Pass --sanjo to build from the 산조 file instead.
Run: python scripts/samples/daegeum.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gugak_scale import Layer, build  # noqa: E402

if __name__ == "__main__":
    layer = Layer("산조대금", 2550, "") if "--sanjo" in sys.argv else Layer("정악대금", 2557, "")
    build("daegeum", "Daegeum", "대금", [layer], release=0.35, fmax=1500)
