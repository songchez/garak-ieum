"""Build public/samples/salamander — Accurate-Salamander Grand Piano V6.2e (CC BY 3.0).

Lossless 48 kHz/24-bit FLAC remaster of Alexander Holm's Salamander Grand Piano V3 (Yamaha C5)
by the Accurate-Salamander Project (Chisato Yamauchi). Earlier builds of this set used the MP3
encodings from @tonejs/piano; this one reads the official FLAC archive directly. The shared
pipeline (layers, register length caps, fades, encoding) is in piano.py.

    python -I scripts/samples/salamander.py --archive /path/to/AccurateSalamanderGrandPianoV6.2e_48khz24bit_flac.zip
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from piano import NOTES, PianoSpec, build, veltrack_layer_gains  # noqa: E402

ITEM = "https://archive.org/download/httpswww.ir.isas.jaxa.jpcyamauchaccuratesalamander/"
ARCHIVE = "AccurateSalamanderGrandPianoV6.2e_48khz24bit_flac.zip"
LAYERS = [3, 7, 11, 15]  # of 16, soft → loud
ROOTS = dict(NOTES)

ATTRIBUTION = {
    "title": "Accurate-Salamander Grand Piano V6.2e (remaster of Salamander Grand Piano V3)",
    "author": "Alexander Holm (Salamander Grand Piano V3); remaster by Chisato Yamauchi, Accurate-Salamander Project",
    "url": "https://www.ir.isas.jaxa.jp/~cyamauch/AccurateSalamander/",
    "license": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "changes": (f"30 notes × {len(LAYERS)} of 16 velocity layers (v{', v'.join(map(str, LAYERS))}) and 88 key-release "
                "samples selected from the 48 kHz/24-bit FLAC bank; trimmed with per-register length caps and "
                "fade-outs, one common gain for the whole set, encoded to Opus 96 kbps (webm) and AAC 128 kbps (m4a)"),
}

LICENSE_EXTRA = """Original soundbank: Salamander Grand Piano V3 by Alexander Holm
(https://archive.org/details/SalamanderGrandPianoV3), CC BY 3.0.
Remaster: Accurate-Salamander Grand Piano V6.2e, Accurate-Salamander Project, Chisato Yamauchi
(https://www.ir.isas.jaxa.jp/~cyamauch/AccurateSalamander/), "CC-by (same licence as the original
version)" — CC BY 3.0. Downloaded from
https://archive.org/details/httpswww.ir.isas.jaxa.jpcyamauchaccuratesalamander
(AccurateSalamanderGrandPianoV6.2e_48khz24bit_flac.zip, MD5 c2803eaa235a28af5c11e4a504ad337e).
The archive.org item page shows CC BY 4.0; we follow the project page (CC BY 3.0, same as the original).
Neither the original author nor the Accurate-Salamander Project endorses this project."""

SPEC = PianoSpec(
    set_id="salamander", name="Grand Piano", name_ko="그랜드 피아노",
    archive_url=ITEM + ARCHIVE, archive_md5="c2803eaa235a28af5c11e4a504ad337e",
    layers=LAYERS,
    pitched_member=lambda note, v: f"48khz24bit/{ROOTS[note]:03d}_{note}v{v:02d}.flac",
    release_member=lambda key: f"48khz24bit/rel{key}.flac",
    attribution=ATTRIBUTION, license_extra=LICENSE_EXTRA,
    # The remaster matches the loudness of all 16 layers and leaves dynamics to the SFZ
    # amp_veltrack=98.5 (its sfz_*/ *.Recommended.sfz); restore that curve per layer.
    layer_gain_db=veltrack_layer_gains(LAYERS, 0.985),
    # The key-release files are normalized near 0 dBFS (its SFZ plays them at volume=-37 dB).
    # Bring them to about the same distance below the notes as the bitklavier set (~30 dB).
    release_gain_db=-25,
)

if __name__ == "__main__":
    build(SPEC)
