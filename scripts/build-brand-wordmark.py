#!/usr/bin/env python3
"""Typeset the fixed 가락이음 wordmark without modifying or distributing a font.

Requires fonttools 4.61.1. Supply the unmodified horizontal DeogonPrincess.ttf
from the National Hangeul Museum's original ZIP. This produces an SVG graphic,
not a subset font. Only the fixed four precomposed Hangul syllables are used;
their original outlines and horizontal advance widths are preserved. The
original font's horizontal GPOS and kern tables have no pair adjustments for
these three adjacent pairs; vertical and discretionary alternates are unused.
"""

import argparse
import hashlib
from pathlib import Path
from xml.sax.saxutils import escape

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

TEXT = '가락이음'
SOURCE_SHA256 = '35ae40e50d3223253a95095de2b5a0340308b9fa18f8b609b608678741610119'


def build(font_path: Path, output: Path) -> None:
    if hashlib.sha256(font_path.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Use the verified, unmodified DeogonPrincess.ttf original.')

    with TTFont(font_path) as font:
        glyphs = font.getGlyphSet()
        cmap = font.getBestCmap()
        paths = []
        bounds = []
        advance = 0

        for character in TEXT:
            name = cmap[ord(character)]
            glyph = glyphs[name]
            pen = SVGPathPen(glyphs)
            glyph.draw(pen)
            bounds_pen = BoundsPen(glyphs)
            glyph.draw(bounds_pen)
            left, bottom, right, top = bounds_pen.bounds
            bounds.append((advance + left, bottom, advance + right, top))
            paths.append(f'    <path transform="translate({advance} 0)" d="{pen.getCommands()}"/>')
            advance += font['hmtx'][name][0]

    left = min(b[0] for b in bounds)
    bottom = min(b[1] for b in bounds)
    right = max(b[2] for b in bounds)
    top = max(b[3] for b in bounds)
    padding = 24
    width = right - left + 2 * padding
    height = top - bottom + 2 * padding
    svg = '\n'.join([
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.6f}" height="{height:.6f}" viewBox="0 0 {width:.6f} {height:.6f}" role="img" aria-labelledby="title">',
        f'  <title id="title">{escape(TEXT)}</title>',
        '  <desc>덕온공주체로 조판한 가락이음. 글꼴 출처: 국립한글박물관 · ㈜윤디자인그룹. https://hanfont.hangeul.go.kr/relaxfont/font/deokon.do</desc>',
        f'  <g fill="#f0e2be" transform="translate({padding-left:.6f} {padding+top:.6f}) scale(1 -1)">',
        *paths,
        '  </g>',
        '</svg>',
        '',
    ])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(svg, encoding='utf-8')
    print(f'{output}: {output.stat().st_size:,} bytes, fixed four-letter SVG wordmark')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=Path('public/brand/garak-ieum-wordmark.svg'))
    args = parser.parse_args()
    build(args.font, args.output)
