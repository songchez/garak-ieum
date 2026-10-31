"""Build a looped pitched set from 국립국악원 단음 scale recordings (used by haegeum.py, daegeum.py)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from analysis import ScaleNote, cut_scale
from common import (PUBLIC, RATE, Manifest, Zone, clear_set, decode, encode_many, key_ranges, log, normalize_set,
                    set_size_mb, velocity_ranges)
from gugak_download import Session, attribution, ensure, monotone_items, seq_of, write_license

NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def note_name(m: int) -> str:
    return f"{NAMES[m % 12]}{m // 12 - 1}"


@dataclass
class Layer:
    instr: str  # download key in gugak_download.INSTR
    seq: int  # mntnSeq
    tag: str  # file suffix, e.g. "p", "mf", "f"


def build(set_id: str, name: str, name_ko: str, layers: list[Layer], *, release: float, main: int = 0,
          below: int = 7, above: int = 5, fmax: float = 2000) -> None:
    """layers are ordered softest first; `main` picks the layer whose detected notes define the roots."""
    session = Session()
    found: list[dict[int, ScaleNote]] = []
    sources: list[str] = []
    all_dropped: list[str] = []
    for layer in layers:
        item = monotone_items(layer.instr, [layer.seq], session)[0]
        path = ensure("monotone", [item], session)[seq_of(item)]
        sources.append(f"{item['wavFileName']} (단음 mntnSeq {layer.seq})")
        notes, dropped = cut_scale(decode(path), fmax=fmax, label=item["wavFileName"])
        all_dropped += dropped
        found.append({n.root: n for n in notes})
        log(f"{item['wavFileName']}: " + ", ".join(f"{note_name(n.root)}{n.cents:+.0f}c" for n in notes))

    roots = sorted(found[main])
    for i, f in enumerate(found):
        extra = sorted(set(f) - set(roots))
        if extra:
            all_dropped.append(f"layer {layers[i].tag}: notes {[note_name(r) for r in extra]} not in main layer, ignored")

    clips = {}
    zones: list[Zone] = []
    for root, (lo, hi) in zip(roots, key_ranges(roots, roots[0] - below, roots[-1] + above)):
        have = [(layers[i], f[root]) for i, f in enumerate(found) if root in f]
        for (layer, note), (vlo, vhi) in zip(have, velocity_ranges(len(have))):
            file = f"{note_name(root)}_{layer.tag}" if len(layers) > 1 else note_name(root)
            clips[file] = note.clip
            zones.append(Zone(file=file, root=root, lo=lo, hi=hi, vlo=round(vlo, 4), vhi=round(vhi, 4),
                              tune=round(-note.cents, 1),
                              loop=[round(note.loop[0], 5), round(note.loop[1], 5)] if note.loop else None))

    clear_set(set_id)
    encode_many(normalize_set(clips), PUBLIC / set_id, pitched=True)
    write_license(set_id, sources)
    Manifest(id=set_id, name=name, nameKo=name_ko, kind="pitched", category="gugak",
             attribution=attribution(), release=release, zones=zones).write()
    for d in all_dropped:
        log("DROP", d)
    log(f"{set_id}: roots {[note_name(r) for r in roots]}")
    log(f"{set_id}: {len(zones)} zones, {sum(len(c) for c in clips.values()) / RATE:.1f} s audio, "
        f"{set_size_mb(set_id):.2f} MB")


__all__ = ["Layer", "build", "note_name", "Path"]
