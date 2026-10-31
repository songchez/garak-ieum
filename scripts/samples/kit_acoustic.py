"""kit-acoustic: Virtuosity Drums (CC0) "mid" stereo mic + VCSL hand clap (CC0).

python scripts/samples/kit_acoustic.py
"""
from __future__ import annotations

from kit_common import CYMBAL_SECONDS, KitSpec, Piece, Source, build_kit, read_text

VD = ("sfzinstruments/virtuosity_drums", "master")
VCSL = ("sgossner/VCSL", "master")


def vd(folder: str, stem: str) -> Source:
    return Source(*VD, f"Samples/mid/{folder}/mid_{stem}.flac")


def vd_layers(folder: str, pattern: str, vls: list[int]) -> list[Source]:
    return [vd(folder, pattern.format(vl=v)) for v in vls]


# kick vl1 and hh_closed vl1 peak at -43 dBFS (below the -40 dB trim threshold), so layers start at vl2.
PIECES = [
    Piece("kick", [(36, None), (35, None)], vd_layers("kick", "kick_snon_vl{vl}_rr1", [2, 3, 4])),
    Piece("sidestick", [(37, None)], vd_layers("snare", "snare_crossstick_vl{vl}", [4, 10, 16])),
    Piece("snare", [(38, None)], vd_layers("snare", "snare_center_vl{vl}", [6, 14, 22, 30, 36])),
    # VCSL clap is a separately normalized recording (-0.4 dBFS); gainDb seats it under the snare.
    Piece("clap", [(39, None)],
          [Source(*VCSL, f"Idiophones/Struck Idiophones/Claps/Clap_rr{i}.wav") for i in (1, 2, 3)], gainDb=-6),
    Piece("rimshot", [(40, None)], vd_layers("snare", "snare_rimshot_vl{vl}", [6, 12])),
    Piece("tomlow", [(41, 0), (43, 200), (45, 400)], vd_layers("ltom", "ltom_center_vl{vl}", [5, 11, 16])),
    Piece("tomhigh", [(47, -300), (48, 0), (50, 300)], vd_layers("htom", "htom_center_vl{vl}", [5, 11, 16])),
    Piece("hhclosed", [(42, None)], vd_layers("hh", "hh_closed_vl{vl}_rr1", [2, 3, 4]), choke=1),
    Piece("hhpedal", [(44, None)], vd_layers("hh", "hh_pedal_vl{vl}_rr1", [2, 3]), choke=1),
    Piece("hhopen", [(46, None)], vd_layers("hh", "hh_open_vl{vl}_rr1", [2, 4]), choke=1,
          max_seconds=CYMBAL_SECONDS),
    Piece("crash", [(49, None), (57, None)], vd_layers("crash", "crash_crash_vl{vl}_rr1", [2, 3]),
          max_seconds=CYMBAL_SECONDS),
    Piece("ride", [(51, None), (59, None)], vd_layers("ride", "ride_ride_vl{vl}_rr1", [2, 3]),
          max_seconds=CYMBAL_SECONDS),
    Piece("ridebell", [(53, None)], [vd("ride", "ride_bell_vl2_rr1")], max_seconds=CYMBAL_SECONDS),
]

ATTRIBUTION = {
    "title": "Virtuosity Drums",
    "author": "Versilian Studios LLC & Karoryfer Samples (drummer Austin McMahon)",
    "url": "https://github.com/sfzinstruments/virtuosity_drums",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "changes": "subset of the 'mid' mic, trimmed, normalized, Opus/AAC; clap from VCSL "
               "(Versilian Studios, CC0, https://github.com/sgossner/VCSL)",
}


def license_text() -> str:
    cc0 = read_text(*VD, "LICENSE")
    return (
        "kit-acoustic\n"
        "============\n\n"
        "Drum samples: Virtuosity Drums (\"mid\" stereo mic position)\n"
        "  Versilian Studios LLC & Karoryfer Samples, performed by Austin McMahon\n"
        "  https://github.com/sfzinstruments/virtuosity_drums\n"
        "  License: CC0 1.0 Universal\n\n"
        "Hand clap (note 39): Versilian Community Sample Library (VCSL)\n"
        "  Versilian Studios LLC, Idiophones/Struck Idiophones/Claps/Clap_rr1-3.wav\n"
        "  https://github.com/sgossner/VCSL\n"
        "  License: CC0 1.0 Universal\n\n"
        "Changes: subset selected, trimmed, normalized, re-encoded to Opus (webm) and AAC (m4a).\n\n"
        "----------------------------------------------------------------------\n\n"
        + cc0
    )


if __name__ == "__main__":
    build_kit(KitSpec(id="kit-acoustic", name="Acoustic Drums", nameKo="어쿠스틱 드럼",
                      attribution=ATTRIBUTION, pieces=PIECES, license_text=license_text()))
