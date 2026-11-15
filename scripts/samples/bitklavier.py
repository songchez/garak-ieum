"""Build public/samples/bitklavier — The bitKlavier Grand, Stage Lid ORTF mic image (CC BY 4.0).

Steinway D concert grand recorded in Taplin Auditorium, Princeton University (January 2021).
We use the official 44.1 kHz/16-bit package of one stereo mic image (Stage Lid ORTF, Sanken CU41
cardioids about 1.5 m from the strings) and resample it to 48 kHz with soxr. The shared pipeline
(layers, register length caps, fades, encoding) is in piano.py.

    python -I scripts/samples/bitklavier.py --archive /path/to/bitKlavierGrand_StageLidORTF_44k16b.zip
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from piano import PianoSpec, build  # noqa: E402

ITEM = "https://archive.org/download/bitKlavierGrand_StageLidORTF_44k16b/"
ARCHIVE = "bitKlavierGrand_StageLidORTF_44k16b.zip"
FOLDER = "bitKlavierGrand_StageLidORTF_44k16b/"
LAYERS = [3, 7, 11, 15]  # of 16, soft → loud

ATTRIBUTION = {
    "title": "The bitKlavier Grand (Stage Lid ORTF mic image)",
    "author": ("Dan Trueman (producer); recorded by Andrés Villalta; played by Matt Wang; edited and denoised by "
               "Jeff Gordon, Katie Chou, Christien Ayers, Matt Wang, Dan Trueman; Princeton University Department of Music"),
    "url": "https://bitklavier.com/the-bitklavier-grand/",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "changes": (f"Stage Lid ORTF 44.1 kHz/16-bit package; 30 notes × {len(LAYERS)} of 16 velocity layers "
                f"(v{', v'.join(map(str, LAYERS))}) and 88 key-release samples selected, resampled to 48 kHz, trimmed with "
                "per-register length caps and fade-outs, one common gain for the whole set, encoded to Opus 96 kbps "
                "(webm) and AAC 128 kbps (m4a)"),
}

LICENSE_EXTRA = """Original work: "The bitKlavier Grand" sample library, Stage Lid ORTF mic image.
Producer: Dan Trueman. Recorded by: Andrés Villalta. Piano played by: Matt Wang.
Edited and denoised by: Jeff Gordon, Katie Chou, Christien Ayers, Matt Wang, Dan Trueman.
With support from Princeton University's Department of Music and Council for the Humanities.
"The bitKlavier Grand sample library is covered by the CC BY 4.0 license" — https://bitklavier.com/the-bitklavier-grand/
Downloaded from https://archive.org/details/bitKlavierGrand_StageLidORTF_44k16b
(bitKlavierGrand_StageLidORTF_44k16b.zip, MD5 cecc6ffb04d8a965d5183b63a7ab5a12).
The creators do not endorse this project. No warranties are given."""

SPEC = PianoSpec(
    set_id="bitklavier", name="Concert Grand", name_ko="콘서트 그랜드",
    archive_url=ITEM + ARCHIVE, archive_md5="cecc6ffb04d8a965d5183b63a7ab5a12",
    layers=LAYERS,
    pitched_member=lambda note, v: f"{FOLDER}{note}v{v}.wav",
    release_member=lambda key: f"{FOLDER}rel{key}.wav",
    attribution=ATTRIBUTION, license_extra=LICENSE_EXTRA,
    # Layers keep their recorded dynamics (about 21 dB from v3 to v15 at C4), so no layer trim.
    # The key-release recordings sit only ~13-18 dB below the loudest notes; lower them so they
    # end up about as far below the notes as in the salamander set (~30 dB).
    release_gain_db=-12,
)

if __name__ == "__main__":
    build(SPEC)
