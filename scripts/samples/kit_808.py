"""kit-808: Hydrogen TR808EmulationKit (ArtemioLabs, GPL-3.0-or-later per drumkit.xml).

python scripts/samples/kit_808.py
"""
from __future__ import annotations

import re

from kit_common import CYMBAL_SECONDS, KitSpec, Piece, Source, build_kit, fetch_text, read_text

HY = ("hydrogen-music/hydrogen", "main")
DIR = "data/drumkits/TR808EmulationKit"


def hy(stem: str) -> list[Source]:
    return [Source(*HY, f"{DIR}/808_{stem}.flac")]


PIECES = [
    Piece("kicklong", [(36, None)], hy("Kick_Long")),
    Piece("kickshort", [(35, None)], hy("Kick_Short")),
    Piece("snare1", [(38, None)], hy("Snare_1")),
    Piece("snare2", [(40, None)], hy("Snare_2")),
    Piece("clap", [(39, None)], hy("Clap")),
    Piece("tomlow", [(41, 0), (43, 300)], hy("Tom_Low")),
    Piece("tommid", [(45, 0), (47, 300)], hy("Tom_Mid")),
    Piece("tomhi", [(48, 0), (50, 300)], hy("Tom_Hi")),
    Piece("hhclosed", [(42, None)], hy("Hat_Closed"), choke=1),
    Piece("hhpedal", [(44, None)], hy("Hat_Pedal"), choke=1),
    Piece("hhopen", [(46, None)], hy("Hat_Open"), choke=1, max_seconds=CYMBAL_SECONDS),
    Piece("cymbal", [(49, 0), (51, -200)], hy("Cymbal"), max_seconds=CYMBAL_SECONDS),
    Piece("cowbell", [(56, None)], hy("Cowbell")),
    Piece("conga", [(63, None)], hy("Conga")),
    Piece("shaker", [(70, None)], hy("Shaker")),
    Piece("clave", [(75, None)], hy("Clave")),
]

ATTRIBUTION = {
    "title": "TR808EmulationKit",
    "author": "ArtemioLabs (Artemiy Pavlov), distributed with Hydrogen",
    "url": "https://github.com/hydrogen-music/hydrogen/tree/main/data/drumkits/TR808EmulationKit",
    "license": "GPL-3.0-or-later",
    "licenseUrl": "https://www.gnu.org/licenses/gpl-3.0.html",
    "changes": "re-encoded to Opus/AAC, trimmed; these sample files are separate GPL-licensed data, "
               "not part of the MIT-licensed source",
}


def license_text() -> str:
    xml = read_text(*HY, f"{DIR}/drumkit.xml")
    header = re.search(r"<!--(.*?)-->", xml, re.S).group(1).strip()
    info = re.search(r"<info>(.*?)</info>", xml, re.S).group(1)
    info = re.sub(r"&lt;style.*?&lt;/style>", "", info, flags=re.S)
    info = re.sub(r"&lt;[^>]*>", "", info).strip()
    info = re.sub(r"\s+", " ", info)
    author = re.search(r"<author>(.*?)</author>", xml).group(1)
    tag = re.search(r"<license>(.*?)</license>", xml).group(1)
    gpl = fetch_text("https://www.gnu.org/licenses/gpl-3.0.txt", "gpl-3.0.txt")
    return (
        "kit-808\n"
        "=======\n\n"
        "Samples: TR808EmulationKit, distributed with Hydrogen (drum machine)\n"
        f"  Author: {author}\n"
        f"  Source: https://github.com/hydrogen-music/hydrogen/tree/main/{DIR}\n"
        f"  License tag in drumkit.xml: {tag}\n\n"
        "Provenance note from drumkit.xml:\n"
        f"  {info}\n\n"
        "License header from drumkit.xml:\n"
        + "\n".join("  " + line.strip() for line in header.splitlines())
        + "\n\n"
        "Changes: trimmed, normalized, re-encoded to Opus (webm) and AAC (m4a).\n"
        "These sample files are separate GPL-licensed data and are not part of the\n"
        "MIT-licensed application source.\n\n"
        "----------------------------------------------------------------------\n\n"
        + gpl
    )


if __name__ == "__main__":
    build_kit(KitSpec(id="kit-808", name="808 Drum Machine", nameKo="808 드럼머신",
                      attribution=ATTRIBUTION, pieces=PIECES, license_text=license_text()))
