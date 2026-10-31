"""kit-lofi: Karoryfer "Gogodze Phu Vol II" retro mic (CC0) + Virtuosity Drums "lofi" mic cymbals (CC0)
+ VCSL hand clap (CC0, low-passed to match).

python scripts/samples/kit_lofi.py

Articulation abbreviations (Programs/Hat.sfz, Programs/mappings/*_retro_mic.sfz):
  ks kick, sc snare center, se snare edge, ss side stick, tl/tm/th toms low/mid/high,
  hc closed hat, ht tight hat, hl loosely closed, hh half open, ho open, hf foot chick.
Only the kick retro mic has a static offset (Programs/Kit.sfz: offset=66 frames); the
other offset_cc110 values are modulation for the "Fi" knob and are ignored.
"""
from __future__ import annotations

from kit_common import CYMBAL_SECONDS, KitSpec, Piece, Source, build_kit, lowpass, read_text

GP = ("sfzinstruments/karoryfer.gogodze-phu-vol-ii", "master")
VD = ("sfzinstruments/virtuosity_drums", "master")
VCSL = ("sgossner/VCSL", "master")
KICK_OFFSET = 66


def gp(abbr: str, vls: list[int], offset: int = 0) -> list[Source]:
    return [Source(*GP, f"Samples/retro_mic/{abbr}_vl{v}_rr1.wav", offset=offset) for v in vls]


# Clap and cymbals come from other libraries, so their level relative to the Gogodze set is arbitrary;
# zone gainDb seats them (clap -0.4 dBFS -> ~-7, crash -15 -> ~-8, ride -28 -> ~-14 dBFS peak).
PIECES = [
    Piece("kick", [(36, None)], gp("ks", [2, 4, 6], offset=KICK_OFFSET)),
    Piece("sidestick", [(37, None)], gp("ss", [2, 4])),
    Piece("snare", [(38, None)], gp("sc", [2, 4, 6])),
    Piece("clap", [(39, None)], [Source(*VCSL, "Idiophones/Struck Idiophones/Claps/Clap_rr1.wav")],
          process=lowpass(6000), gainDb=-6),
    Piece("snareedge", [(40, None)], gp("se", [3, 5])),
    Piece("tomlow", [(41, 0), (43, 300)], gp("tl", [2, 4])),
    Piece("tommid", [(45, 0), (47, 300)], gp("tm", [2, 4])),
    Piece("tomhigh", [(48, 0), (50, 300)], gp("th", [2, 4])),
    Piece("hhclosed", [(42, None)], gp("hc", [2, 4]), choke=1),
    Piece("hhpedal", [(44, None)], gp("hf", [2]), choke=1),
    Piece("hhopen", [(46, None)], gp("ho", [3, 5]), choke=1, max_seconds=CYMBAL_SECONDS),
    Piece("crash", [(49, None)], [Source(*VD, "Samples/lofi/crash/lofi_crash_crash_vl2_rr1.flac")],
          max_seconds=CYMBAL_SECONDS, gainDb=7),
    Piece("ride", [(51, None)], [Source(*VD, "Samples/lofi/ride/lofi_ride_ride_vl2_rr1.flac")],
          max_seconds=CYMBAL_SECONDS, gainDb=14),
]

ATTRIBUTION = {
    "title": "Gogodze Phu Vol II",
    "author": "Karoryfer Samples",
    "url": "https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "changes": "retro_mic subset, trimmed, normalized, Opus/AAC; cymbals from Virtuosity Drums 'lofi' mic (CC0); "
               "clap from VCSL (Versilian Studios, CC0), low-passed at 6 kHz",
}


def license_text() -> str:
    cc0 = read_text(*GP, "LICENSE")
    readme = read_text(*GP, "readme.txt").strip()
    return (
        "kit-lofi\n"
        "========\n\n"
        "Kick, snare, side stick, toms, hi-hat: Gogodze Phu Vol II (\"retro_mic\" position)\n"
        "  Karoryfer Samples (Karoryfer Lecolds)\n"
        "  https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii\n"
        "  License: CC0 1.0 Universal\n\n"
        "Crash and ride (notes 49, 51): Virtuosity Drums (\"lofi\" mic position)\n"
        "  Versilian Studios LLC & Karoryfer Samples, performed by Austin McMahon\n"
        "  https://github.com/sfzinstruments/virtuosity_drums\n"
        "  License: CC0 1.0 Universal\n\n"
        "Hand clap (note 39): Versilian Community Sample Library (VCSL)\n"
        "  Versilian Studios LLC, Idiophones/Struck Idiophones/Claps/Clap_rr1.wav\n"
        "  https://github.com/sgossner/VCSL\n"
        "  License: CC0 1.0 Universal\n\n"
        "Changes: subset selected, trimmed, normalized, clap low-passed at 6 kHz,\n"
        "re-encoded to Opus (webm) and AAC (m4a).\n\n"
        "Original readme.txt (Gogodze Phu Vol II):\n"
        + "\n".join("  " + line for line in readme.splitlines())
        + "\n\n"
        "----------------------------------------------------------------------\n\n"
        + cc0
    )


if __name__ == "__main__":
    build_kit(KitSpec(id="kit-lofi", name="Lo-fi Drums", nameKo="로파이 드럼",
                      attribution=ATTRIBUTION, pieces=PIECES, license_text=license_text()))
