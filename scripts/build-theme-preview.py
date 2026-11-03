#!/usr/bin/env python3
"""Draw the theme color-placement reference from the live theme registry.

Requires Node 24, Python fontTools and PyMuPDF, plus a local Noto Sans KR font.
The font is used to outline only the text in this document; it is not bundled.
This drawing is deliberately labelled as a design reference, not a screenshot.
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import subprocess
from xml.etree import ElementTree as ET

import fitz
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font', required=True, type=Path, help='Local NotoSansKR[wght].ttf or compatible Korean font')
parser.add_argument('--node', default='node', help='Node 24 executable')
args = parser.parse_args()
themes = json.loads(subprocess.check_output([
    args.node, '--input-type=module', '-e',
    "import { THEMES } from './src/core/theme.ts'; process.stdout.write(JSON.stringify(THEMES));",
], cwd=ROOT, text=True))

font = TTFont(args.font)
cmap = font.getBestCmap()
glyph_set = font.getGlyphSet(location={'wght': 500} if 'fvar' in font else None)
units = font['head'].unitsPerEm
glyphs: dict[str, str] = {}
elements: list[str] = []


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def add(value: str) -> None:
    elements.append(value)


def rect(x: float, y: float, w: float, h: float, fill: str, radius: float = 0,
         stroke: str | None = None, width: float = 1, opacity: float = 1) -> None:
    add(f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{radius:g}" fill="{fill}" opacity="{opacity:g}"'
        + (f' stroke="{stroke}" stroke-width="{width:g}"' if stroke else '') + '/>')


def line(x1: float, y1: float, x2: float, y2: float, color: str, width: float = 1, opacity: float = 1) -> None:
    add(f'<path d="M{x1:g},{y1:g} L{x2:g},{y2:g}" fill="none" stroke="{color}" stroke-width="{width:g}" opacity="{opacity:g}"/>')


def circle(x: float, y: float, radius: float, fill: str) -> None:
    add(f'<circle cx="{x:g}" cy="{y:g}" r="{radius:g}" fill="{fill}"/>')


def text(value: str, x: float, baseline: float, size: float, color: str, anchor: str = 'start') -> None:
    advances: list[tuple[str, float]] = []
    advance = 0.0
    for character in value:
        name = cmap.get(ord(character))
        if name is None:
            raise ValueError(f'Font lacks {character!r} U+{ord(character):04X}')
        glyph = glyph_set[name]
        key = f'g{ord(character):x}'
        if key not in glyphs:
            pen = SVGPathPen(glyph_set)
            glyph.draw(pen)
            glyphs[key] = pen.getCommands()
        advances.append((key, advance))
        advance += glyph.width
    scale = size / units
    if anchor == 'middle':
        x -= advance * scale / 2
    elif anchor == 'end':
        x -= advance * scale
    uses = ''.join(f'<use href="#{key}" transform="translate({offset:g},0)"/>' for key, offset in advances)
    add(f'<g fill="{color}" transform="translate({x:g},{baseline:g}) scale({scale:g},-{scale:g})" aria-label="{esc(value)}"><title>{esc(value)}</title>{uses}</g>')


def mix(a: str, b: str, ratio: float) -> str:
    left = [int(a[i:i+2], 16) for i in (1, 3, 5)]
    right = [int(b[i:i+2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{int(x+(y-x)*ratio+.5):02x}' for x, y in zip(left, right))


def luminance(color: str) -> float:
    components = [int(color[i:i+2], 16)/255 for i in (1, 3, 5)]
    components = [c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4 for c in components]
    return sum(a*b for a, b in zip(components, (.2126, .7152, .0722)))


def contrast(a: str, b: str) -> float:
    x, y = luminance(a), luminance(b)
    return (max(x, y)+.05)/(min(x, y)+.05)


def ink_for(fill: str) -> str:
    return '#000000' if contrast(fill, '#000000') >= contrast(fill, '#ffffff') else '#ffffff'


def daw(theme: dict, x: float, y: float, w: float, h: float) -> None:
    c = theme['colors']
    rect(x, y, w, h, c['base'], 7, c['border'])
    rect(x+1, y+1, w-2, 32, c['panel'], 6)
    brand_scale = 16/906.333333
    add(f'<use href="#wordmark" transform="translate({x+13:g},{y+9:g}) scale({brand_scale:g})" fill="{c["text"] if theme["mode"] == "light" else c["playhead"]}"/>')
    text('Hanok session', x+82, y+21, 10, c['secondary'])
    circle(x+168, y+17, 2.2, c['success'])
    # Familiar transport shapes without suggesting a working interactive screenshot.
    add(f'<path d="M{x+260},{y+12} v10 M{x+270},{y+12} l-8,5 8,5 z" stroke="{c["muted"]}" fill="{c["muted"]}"/>')
    rect(x+285, y+12, 10, 10, c['muted'], 1)
    rect(x+307, y+7, 27, 20, c['play'], 4)
    add(f'<path d="M{x+317},{y+12} l8,5 -8,5 z" fill="{c["onPlay"]}"/>')
    circle(x+351, y+17, 5, c['record'])
    text('01.1', x+389, y+21, 11, c['text'])
    text('96 BPM', x+439, y+21, 10, c['muted'])
    rect(x+w-78, y+8, 63, 19, c['brand'], 4)
    text('내보내기', x+w-46, y+21, 9, c['inverse'], 'middle')
    rect(x+1, y+33, w-2, 6, c['giwa'])
    for roof_x in range(int(x+2), int(x+w-10), 14):
        add(f'<path d="M{roof_x}, {y+38} q7,-6 14,0" fill="none" stroke="{c["giwaEdge"]}" stroke-width="1"/>')
    rect(x+1, y+39, w-2, 21, c['raised'])
    text('트랙   편집   보기', x+12, y+53, 9, c['secondary'])
    text('스마트 스냅', x+w-17, y+53, 9, c['muted'], 'end')
    sidebar = 123
    arrangement_x = x+sidebar
    arrangement_w = w-sidebar-27
    for bar in range(1, 9):
        text(str(bar), arrangement_x+10+(bar-1)*arrangement_w/8, y+53, 9, c['muted'])
    track_colors = ['#6f9fd0', '#7fb59a', '#d9b45a']
    track_names = ['가야금', '베이스', '장구']
    for row in range(3):
        row_y = y+60+row*39
        rect(x+1, row_y, sidebar-1, 39, c['selected'] if row == 0 else c['panel'])
        rect(x+1, row_y, 4, 39, track_colors[row])
        text(f'{row+1:02d}', x+12, row_y+15, 8, c['muted'])
        text(track_names[row], x+34, row_y+15, 11, c['text'])
        text('M   S', x+34, row_y+31, 8, c['muted'])
        line(x+80, row_y+27, x+109, row_y+27, c['borderStrong'], 3)
        circle(x+99-row*4, row_y+27, 3, c['accent'])
        rect(arrangement_x, row_y, arrangement_w, 39, c['canvasAlt'] if row%2 == 0 else c['canvas'])
        for column in range(17):
            grid_x=arrangement_x+column*arrangement_w/16
            line(grid_x, row_y, grid_x, row_y+39, c['borderSubtle'], opacity=.7 if column%2 == 0 else .3)
        clip_x=arrangement_x+12+(52 if row == 1 else 0)
        clip_w=[205,267,148][row]
        fill=mix(track_colors[row], '#ffffff', .2) if row == 0 else mix(c['panel'],track_colors[row],.24)
        foreground=ink_for(fill) if row == 0 else c['text']
        rect(clip_x,row_y+5,clip_w,29,fill,3,theme['tokens']['--control-border'] if theme['mode']=='light' else track_colors[row],1.5 if row == 0 else 1)
        text(['주제 · 8마디','저음 패턴','장단'][row],clip_x+7,row_y+16,8,foreground)
        for note in range(8):
            rect(clip_x+7+note*(clip_w-18)/8,row_y+22-(note%3),max(6,(clip_w-28)/10),2,foreground,1,opacity=.72)
        line(x+1,row_y+39,x+w-1,row_y+39,c['borderSubtle'])
    rect(arrangement_x+12,y+60,205,3,c['loopFill'])
    line(arrangement_x+141,y+60,arrangement_x+141,y+177,c['playhead'],1.5)
    # A compact editor and mixer strip uses the same role tokens.
    editor_y=y+177
    rect(x+1,editor_y,w-2,49,c['panelSoft'])
    text('피아노롤',x+13,editor_y+14,9,c['accent'])
    text('C3',x+14,editor_y+35,8,c['muted'])
    for index in range(11):
        key_x=x+49+index*12
        rect(key_x,editor_y+21,11,20,c['raised'],1,c['border'])
        if index%7 in [0,1,3,4,5]:rect(key_x+7,editor_y+21,5,12,c['text'],1)
    for index in range(7):
        rect(x+211+index*42,editor_y+24-(index%3)*3,29,4,c['accent'],1)
    meter_x=x+w-21
    rect(meter_x,y+61,10,115,c['meterEmpty'],1)
    for segment in range(13):
        color=c['meterLow'] if segment<9 else c['meterMid'] if segment<12 else c['meterHigh']
        rect(meter_x+1,y+170-segment*7,8,5,color,opacity=1 if segment<10 else .25)
    rect(x+1,y+h-23,w-2,22,c['panel'],5)
    circle(x+13,y+h-11,2.3,c['success'])
    text('이 브라우저에 저장됨',x+22,y+h-8,8,c['muted'])
    text('48 kHz  ·  WEB AUDIO',x+w-12,y+h-8,8,c['muted'],'end')


W,H=1520,1740
rect(0,0,W,H,'#eae6dc')
text('가락이음 · 한국의 빛, 여섯 작업실',48,69,40,'#26322b')
text('로고 > 설정 > 화면 테마에서 선택 · 기존 새벽 한옥과 다섯 가지 전통색 팔레트',49,106,18,'#586459')
text('실제 앱 스크린샷이 아닌 색 배치 설계 자료',49,138,17,'#6b695e')
text('2026.11.03',1472,67,15,'#586459','end')

for index,theme in enumerate(themes):
    x=48+(index%2)*726
    y=180+(index//2)*500
    c=theme['colors']
    rect(x,y,698,472,'#fcfaf5',12,'#d3cfc2')
    text(theme['name'],x+23,y+42,28,'#26322b')
    text(theme['subtitle'],x+24,y+68,13,'#646b61')
    rect(x+584,y+22,90,28,'#e7e6dc' if theme['mode']=='light' else '#354238',14)
    text('밝은 테마' if theme['mode']=='light' else '어두운 테마',x+629,y+41,12,'#354238' if theme['mode']=='light' else '#f3efe4','middle')
    daw(theme,x+22,y+91,654,258)
    text('원색 팔레트',x+24,y+378,12,'#646b61')
    cell_width=650/len(theme['palette'])
    for swatch_index,swatch in enumerate(theme['palette']):
        swatch_x=x+24+swatch_index*cell_width
        rect(swatch_x,y+392,cell_width-12,12,swatch['color'],3,'#00000014')
        text(swatch['name'],swatch_x,y+427,16,'#26322b')
        text(swatch['color'].upper(),swatch_x,y+449,11,'#6b7066')

text('원색을 배경·선택·녹음·루프로 나누고, 작은 글자는 명도를 조정해 읽기 쉽게 구성했습니다.',48,1698,16,'#586459')
text('실제 테마 토큰으로 생성 · 트랙 색상은 테마와 별도로 유지',1472,1723,13,'#6b695e','end')

wordmark=ET.fromstring((ROOT/'public/brand/garak-ieum-wordmark.svg').read_text())
for child in wordmark.iter():
    child.tag=child.tag.rsplit('}',1)[-1]
    child.attrib.pop('fill',None)
word_paths=[ET.tostring(child,encoding='unicode') for child in wordmark if child.tag not in ('title','desc')]
definitions=''.join(f'<path id="{key}" d="{esc(path)}"/>' for key,path in glyphs.items())
definitions+='<g id="wordmark">'+''.join(word_paths)+'</g>'
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="preview-title preview-desc">
<title id="preview-title">가락이음의 여섯 화면 테마</title>
<desc id="preview-desc">실제 앱 스크린샷이 아닌 색 배치 설계 자료입니다. src/core/theme.ts의 실제 토큰으로 생성했습니다. 문자 윤곽은 Noto Sans KR로 제작했으며 글꼴 파일은 포함하지 않습니다.</desc>
<defs>{definitions}</defs>{''.join(elements)}</svg>'''
assets=ROOT/'docs/assets'
assets.mkdir(parents=True,exist_ok=True)
svg_path=assets/'korean-theme-presets.svg'
png_path=assets/'korean-theme-presets.png'
svg_path.write_text(svg,encoding='utf-8')
document=fitz.open(stream=svg.encode(),filetype='svg')
document[0].get_pixmap(alpha=False).save(png_path)
print(f'SVG: {svg_path} ({svg_path.stat().st_size:,} bytes)')
print(f'PNG: {png_path} ({png_path.stat().st_size:,} bytes)')
print(f'Outlined glyphs: {len(glyphs)}; missing glyphs: 0')
