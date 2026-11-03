#!/usr/bin/env python3
"""Render a labelled light-theme design mock from the shipped theme and roof.

Requires Node 24, installed project dependencies, Python fontTools, Inkscape and
a local Noto Sans KR variable TTF. The font is outlined, never bundled. This
illustration is a design comparison, not an app or browser screenshot.
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import re
import subprocess
from xml.etree import ElementTree as ET

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font', required=True, type=Path, help='Local NotoSansKR[wght].ttf')
parser.add_argument('--node', default='node')
args = parser.parse_args()
themes = json.loads(subprocess.check_output([
    args.node, '--input-type=module', '-e',
    "import {THEMES} from './src/core/theme.ts'; process.stdout.write(JSON.stringify(THEMES.filter(t=>t.mode==='light')));",
], cwd=ROOT, text=True))

# Render the actual reusable ornament in memory. No browser/server is opened.
component_art = json.loads(subprocess.check_output([
    args.node, '--input-type=module', '-e',
    "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';"
    "import {createServer} from 'vite';"
    "const server=await createServer({configFile:false,server:{middlewareMode:true},logLevel:'silent'});"
    "try {const {GiwaEave}=await server.ssrLoadModule('/src/components/GiwaEave.tsx');"
    "const {Icon}=await server.ssrLoadModule('/src/components/Icon.tsx');"
    "const icons={}; for(const name of ['undo','redo','loop','chevron']) icons[name]=renderToStaticMarkup(React.createElement(Icon,{name,size:18}));"
    "process.stdout.write(JSON.stringify({roof:renderToStaticMarkup(React.createElement(GiwaEave)),icons}));}"
    "finally {await server.close();}",
], cwd=ROOT, text=True))
roof_svg = component_art['roof']
roof_css = (ROOT/'src/components/GiwaEave.css').read_text()

font = TTFont(args.font)
cmap = font.getBestCmap()
glyph_sets = {weight: font.getGlyphSet(location={'wght': weight}) for weight in (500, 700)}
units = font['head'].unitsPerEm
glyphs: dict[tuple[int, str], tuple[str, float]] = {}
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


def circle(x: float, y: float, radius: float, fill: str, stroke: str | None = None) -> None:
    add(f'<circle cx="{x:g}" cy="{y:g}" r="{radius:g}" fill="{fill}"' + (f' stroke="{stroke}"' if stroke else '') + '/>')


def text(value: str, x: float, baseline: float, size: float, color: str,
         weight: int = 500, anchor: str = 'start') -> None:
    paths: list[tuple[str, float]] = []
    advance = 0.0
    for character in value:
        name = cmap.get(ord(character))
        if name is None:
            raise ValueError(f'Font lacks {character!r} U+{ord(character):04X}')
        key = (weight, character)
        if key not in glyphs:
            glyph = glyph_sets[weight][name]
            pen = SVGPathPen(glyph_sets[weight], ntos=lambda value: f'{value:.2f}'.rstrip('0').rstrip('.') if value else '0')
            glyph.draw(pen)
            glyphs[key] = (pen.getCommands(), glyph.width)
        path, width = glyphs[key]
        if path:
            paths.append((path, advance))
        advance += width
    scale = size / units
    if anchor == 'middle':
        x -= advance * scale / 2
    elif anchor == 'end':
        x -= advance * scale
    # Inline paths also render correctly in SVG viewers lacking SVG2 <use href>.
    markup = ''.join(f'<path d="{esc(path)}" transform="translate({offset:g},0)"/>' for path, offset in paths)
    add(f'<g fill="{color}" transform="translate({x:g},{baseline:g}) scale({scale:g},-{scale:g})" aria-label="{esc(value)}"><title>{esc(value)}</title>{markup}</g>')


def mix(a: str, b: str, amount: float) -> str:
    def rgb(color: str) -> list[int]:
        if color == 'white': color = '#ffffff'
        if color == 'black': color = '#000000'
        if len(color) == 4: color = '#' + ''.join(ch*2 for ch in color[1:])
        return [int(color[i:i+2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(x+(y-x)*amount):02x}' for x,y in zip(rgb(a),rgb(b)))


def resolve_css(value: str, variables: dict[str, str]) -> str:
    for _ in range(20):
        previous = value
        value = re.sub(r'var\((--[\w-]+)(?:,\s*([^()]+))?\)',
                       lambda m: variables.get(m[1], m[2] or m[0]), value)
        def color_mix(match: re.Match) -> str:
            parts = [p.strip() for p in match[1].split(',')]
            if len(parts) != 3 or parts[0] != 'in srgb':
                raise ValueError(f'Unsupported paint: {match[0]}')
            left, right = parts[1].split(), parts[2].split()
            left_amount = float(left[1].rstrip('%'))/100 if len(left)>1 else None
            right_amount = float(right[1].rstrip('%'))/100 if len(right)>1 else None
            if left_amount is None and right_amount is None: left_amount=right_amount=.5
            elif left_amount is None: left_amount=1-right_amount
            elif right_amount is None: right_amount=1-left_amount
            return mix(left[0],right[0],right_amount/(left_amount+right_amount))
        value = re.sub(r'color-mix\(([^()]+)\)', color_mix, value)
        if value == previous: break
    return value


def roof(theme: dict, x: float, y: float, width: float, prefix: str, scale: float = 1) -> None:
    variables = dict(theme['tokens'])
    variables['--header-roof-height'] = '12px'
    for name,value in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', roof_css):
        variables[name] = value.strip()
    for _ in range(6):
        variables = {key:resolve_css(value,variables) for key,value in variables.items()}
    markup = resolve_css(roof_svg,variables)
    if 'var(' in markup or 'color-mix(' in markup:
        raise ValueError('The roof contains unresolved paint; update the SVG color resolver.')
    node = ET.fromstring(markup)
    node.set('width', f'{width/scale:g}')
    node.set('height', '12')
    node.set('x','0'); node.set('y','0')
    node.set('overflow','hidden')
    # Isolate CSS classes and fragment IDs across all six roof instances.
    ids = {child.get('id') for child in node.iter() if child.get('id')}
    for child in node.iter():
        for name,value in list(child.attrib.items()):
            for old in ids:
                value = value.replace(f'#{old}',f'#{prefix}-{old}')
            if name == 'id': value = f'{prefix}-{value}'
            if name == 'class': value = ' '.join(f'{prefix}-{cls}' for cls in value.split())
            child.set(name,value)
    # Paint is already resolved into the component's presentation attributes.
    # Browser layout/custom-property declarations are unnecessary in this SVG.
    for child in node.iter(): child.tag = child.tag.rsplit('}',1)[-1]
    add(f'<g transform="translate({x:g},{y:g}) scale({scale:g})">'+ET.tostring(node,encoding='unicode')+'</g>')


def brand(x: float, y: float, color: str) -> None:
    logo = ET.parse(ROOT/'public/brand/favicon.svg').getroot()
    logo.set('x',str(x)); logo.set('y',str(y-1))
    logo.set('width','20'); logo.set('height','20')
    for child in logo.iter():
        child.tag = child.tag.rsplit('}',1)[-1]
        child.attrib.pop('id',None)
    add(ET.tostring(logo,encoding='unicode'))
    mark = ET.parse(ROOT/'public/brand/garak-ieum-wordmark.svg').getroot()
    for child in mark.iter():
        child.tag = child.tag.rsplit('}',1)[-1]
        child.attrib.pop('fill',None)
    body = ''.join(ET.tostring(child,encoding='unicode') for child in mark if child.tag not in ('title','desc'))
    add(f'<g transform="translate({x+27:g},{y:g}) scale({18/906.333333:g})" fill="{color}">{body}</g>')


def icon(name: str, x: float, y: float, color: str, size: float=18) -> None:
    node=ET.fromstring(component_art['icons'][name])
    node.set('x',str(x)); node.set('y',str(y))
    node.set('width',str(size)); node.set('height',str(size))
    node.set('stroke',color)
    for child in node.iter(): child.tag=child.tag.rsplit('}',1)[-1]
    add(ET.tostring(node,encoding='unicode'))


def triangle(x: float, y: float, color: str, size: float=8) -> None:
    add(f'<path d="M{x:g},{y:g} l{size:g},{abs(size)*.62:g} {-size:g},{abs(size)*.62:g} z" fill="{color}"/>')


def control(x: float,y: float,w: float,label: str,c: dict,active: bool=False) -> None:
    rect(x,y,w,19,c['accent'] if active else c['input'],3,c['accent'] if active else c['borderStrong'])
    text(label,x+w/2,y+13,9,c['onAccent'] if active else c['text'],700 if active else 500,'middle')


def studio(theme: dict,x: float,y: float,w: float,h: float) -> None:
    c,t = theme['colors'],theme['tokens']
    frame = t.get('--hanok-frame',c['borderStrong'])
    paper_edge = t.get('--paper-edge',c['raised'])
    rect(x,y,w,h,c['canvas'],6,frame)
    # The header uses the shipped 48 px total height: 36 px controls + 12 px roof.
    rect(x+1,y+1,w-2,35,c['panel'],5)
    brand(x+14,y+9,c['text'])
    line(x+111,y+7,x+111,y+29,c['border'])
    text('마당의 결',x+123,y+16,11,c['text'],700)
    circle(x+125,y+26,2,c['success'])
    text('이 브라우저에 저장됨',x+132,y+29,8,c['muted'])
    tx=x+w/2-171
    icon('undo',tx,y+10,c['muted'])
    icon('redo',tx+28,y+10,c['muted'])
    line(tx+60,y+8,tx+60,y+29,c['border'])
    add(f'<path d="M{tx+79},{y+13} v12" stroke="{c["secondary"]}" stroke-width="2"/>')
    triangle(tx+89,y+13,c['secondary'],-9)
    rect(tx+108,y+14,10,10,c['secondary'],1)
    rect(tx+132,y+5,36,27,c['play'],4)
    triangle(tx+146,y+12,c['onPlay'],10)
    circle(tx+187,y+18,5.5,c['record'])
    icon('loop',tx+209,y+10,c['brass'])
    text('009.1.1',tx+253,y+20,18,c['text'])
    text('00:20.870',tx+254,y+30,8,c['muted'])
    line(tx+345,y+7,tx+345,y+30,c['border'])
    text('92',tx+370,y+21,17,c['text'],500,'middle')
    text('BPM',tx+370,y+30,7,c['muted'],500,'middle')
    rect(x+w-95,y+7,79,22,c['brand'],4,c['brand'])
    text('내보내기',x+w-55.5,y+22,9,c['inverse'],700,'middle')
    roof(theme,x+1,y+36,w-2,theme['id']+'-main')
    # Inspector and track header emulate real grouping without claiming capture.
    inspector=168; headers=196; track_x=x+inspector; lane_x=track_x+headers
    lane_w=w-inspector-headers-1
    rect(x+1,y+48,inspector-1,h-70,c['panel'])
    rect(x+1,y+48,inspector-1,28,c['panelSoft'])
    icon('chevron',x+9,y+55,c['muted'],11)
    text('리전: 가야금',x+26,y+66,10,c['text'],700)
    line(x+1,y+76,x+inspector,y+76,frame)
    for i,(label,value) in enumerate([('퀀타이즈','1/16'),('트랜스포즈','0'),('벨로시티','+ 0')]):
        cy=y+87+i*25
        text(label,x+13,cy+13,9,c['muted'])
        control(x+91,cy,63,value,c)
    line(x+1,y+169,x+inspector,y+169,c['border'])
    icon('chevron',x+9,y+177,c['muted'],11)
    text('트랙',x+26,y+187,10,c['text'],700)
    text('가야금',x+13,y+209,11,c['text'],700)
    text('악기',x+13,y+232,9,c['muted'])
    control(x+60,y+219,94,'가야금',c)
    line(x+inspector,y+48,x+inspector,y+h-22,frame)
    line(x+inspector-2,y+48,x+inspector-2,y+h-22,paper_edge)
    rect(track_x,y+48,w-inspector-1,28,c['panelSoft'])
    text('＋   트랙     편집     기능     보기',track_x+13,y+66,10,c['secondary'])
    text('스냅: 스마트      드래그: 겹침',x+w-18,y+66,9,c['secondary'],500,'end')
    line(track_x,y+76,x+w-1,y+76,frame)
    rect(track_x,y+77,headers,20,c['panel'])
    rect(lane_x,y+77,lane_w,20,c['panel'])
    text('트랙',track_x+13,y+91,8,c['muted'])
    for bar in range(8):
        gx=lane_x+bar*lane_w/8
        text(str(bar*4+1),gx+6,y+92,8,c['muted'])
    rect(lane_x+lane_w/4,y+78,lane_w/4,5,c['loopFill'])
    track_colors=['#6f9fd0','#7fb59a','#d9b45a']
    names=['가야금','모노 베이스','장구']
    rowheight=44
    for row in range(3):
        yy=y+97+row*rowheight
        tc=track_colors[row]
        rect(track_x,yy,headers,rowheight,c['selected'] if row==0 else c['panel'])
        rect(track_x+2,yy+2,3,rowheight-4,tc,1)
        text(str(row+1),track_x+13,yy+16,8,c['muted'])
        text(names[row],track_x+33,yy+16,11,c['text'],700 if row==0 else 500)
        for b,label in enumerate(['M','S','R','I']):
            control(track_x+33+b*22,yy+22,18,label,c)
        line(track_x+134,yy+31,track_x+179,yy+31,c['borderStrong'],3)
        rect(track_x+155-row*5,yy+27,5,8,c['text'],1)
        lane_fill=c['canvasAlt'] if row%2==0 else c['canvas']
        rect(lane_x,yy,lane_w,rowheight,lane_fill)
        for col in range(33):
            gx=lane_x+col*lane_w/32
            color=t.get('--grid-major',c['border']) if col%4==0 else t.get('--grid-minor',c['borderSubtle'])
            line(gx,yy,gx,yy+rowheight,color)
        clips=[[(12,235,'주제 · 8마디'),(268,235,'주제 변주')],[(124,383,'저음 패턴')],[(12,111,'장단'),(134,111,'장단'),(268,111,'장단'),(390,111,'장단')]][row]
        for n,(dx,cw,label) in enumerate(clips):
            cx=lane_x+dx
            selected=row==0 and n==0
            fill=mix(tc,'#ffffff',.2) if selected else mix(c['canvas'],tc,.26)
            edge=c['accent'] if selected else mix(tc,c['text'],.65)
            rect(cx,yy+5,cw,34,fill,3,edge,1.5 if selected else 1)
            text(label,cx+7,yy+17,8,c['text'],700 if selected else 500)
            line(cx+1,yy+21,cx+cw-1,yy+21,mix(fill,c['text'],.16))
            for note in range(9):
                rect(cx+7+note*(cw-20)/9,yy+28-note%3,max(5,(cw-38)/12),2,mix(tc,c['text'],.75),.7)
        line(track_x,yy+rowheight,x+w-1,yy+rowheight,c['borderSubtle'])
    line(lane_x,y+77,lane_x,y+229,frame)
    playhead=lane_x+lane_w*.37
    line(playhead,y+78,playhead,y+229,c['playhead'],1.5)
    add(f'<path d="M{playhead-4},{y+79} l8,0 -4,6 z" fill="{c["playhead"]}"/>')
    # A small pitch pane demonstrates the now-visible dual-stroke curve.
    rect(track_x,y+229,w-inspector-1,26,c['panelSoft'])
    line(track_x,y+229,x+w-1,y+229,frame)
    text('피아노롤     믹서     디바이스',track_x+13,y+246,9,c['muted'])
    text('피치 편집',track_x+215,y+246,9,c['accent'],700)
    line(track_x+215,y+253,track_x+255,y+253,c['accent'],2)
    rect(track_x,y+255,w-inspector-1,33,c['canvas'])
    text('C3',track_x+15,y+274,8,c['muted'])
    for n in range(9):
        xx=track_x+62+n*103
        yy=y+263+(n%3-1)*3
        selected=n==3
        rect(xx,yy,82,15,c['accent'] if selected else c['selected'],3,c['accentBorder'])
        path=f'M{xx+4},{yy+8} q10,-3 20,0 t21,0 t18,-1 l15,1'
        if selected:
            add(f'<path d="{path}" fill="none" stroke="{c["canvas"]}" stroke-width="3.5"/>')
        add(f'<path d="{path}" fill="none" stroke="{c["brand"]}" stroke-width="1.3"/>')
    rect(x+1,y+288,w-2,21,c['panelSoft'],4)
    line(x+1,y+288,x+w-1,y+288,frame)
    circle(x+13,y+299,2,c['success'])
    text('프로젝트가 저장되었습니다',x+22,y+303,8,c['muted'])
    text('48 kHz     92 BPM     4/4',x+w-16,y+303,8,c['secondary'],500,'end')


W,H=1440,1544
rect(0,0,W,H,'#eee9de')
text('GARAK IEUM  /  LIGHT THEME STUDY',48,43,11,'#6a6d64',700)
text('한지 위에, 또렷한 음악 작업실.',48,93,35,'#28342f',700)
text('색 배치 목업 · 실제 앱 스크린샷 아님',49,126,16,'#5d645a')
text('48 px 헤더 유지 · 밝은 기와 · 선명한 경계',1390,126,13,'#5d645a',500,'end')

descriptions=[
    ('A', '백자 · 한지', '먹색 글자와 청화색 선택, 따뜻한 목재선으로 가장 또렷한 화이트 작업실.', True),
    ('B', '비색 · 상감', '백상감 바탕에 차분한 옥빛 기와와 진한 상감선을 더한 밝은 작업실.', False),
    ('C', '염색 · 한복', '따뜻한 비단빛 바탕, 쪽빛 선택과 소목색 강조를 담은 작업실.', False),
]

for index,theme in enumerate(themes):
    c,t=theme['colors'],theme['tokens']
    letter,title,description,recommended=descriptions[index]
    y=154+index*446
    rect(40,y,1360,426,'#fffdf7',11,'#d2c8b7')
    rect(60,y+16,27,27,c['accent'],5)
    text(letter,73.5,y+35,16,c['onAccent'],700,'middle')
    text(title,99,y+38,23,'#28342f',700)
    if recommended:
        rect(257,y+17,45,24,'#e1eadd',4,'#9cae95')
        text('추천',279.5,y+33,12,'#334d37',700,'middle')
    text(description,320,y+35,13,'#5a6258')
    studio(theme,60,y+54,1320,310)
    # A 2× crop of the exact same shipped roof makes its small tile geometry clear.
    text('기와 디테일 ×2',62,y+386,11,'#5a6258',700)
    roof(theme,62,y+393,286,theme['id']+'-detail',2)
    swatches=[('한지 바탕',c['canvas']),('목재·상감 경계',t.get('--hanok-frame',c['borderStrong'])),('선택·포커스',c['accent']),('본문 글자',c['text'])]
    for s,(label,color) in enumerate(swatches):
        sx=378+s*247
        rect(sx,y+383,30,25,color,3,c['border'])
        text(label,sx+40,y+389,10,'#5a6258')
        text(color.upper(),sx+40,y+407,13,'#28342f',700)

text('기와·테마 색은 실제 코드에서 가져왔습니다. 화면 배치는 색감과 경계의 비교를 위한 목업입니다.',48,1510,13,'#5d645a')
text('2026.11.03',1392,1510,12,'#6a6d64',500,'end')

svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="light-theme-title light-theme-desc">
<title id="light-theme-title">가락이음의 밝은 테마 개선안 세 가지</title>
<desc id="light-theme-desc">색 배치 목업이며 실제 앱 스크린샷이 아닙니다. 실제 테마 토큰과 GiwaEave SVG를 사용합니다. 백자·한지, 비색·상감, 염색·한복의 밝은 작업면과 기와를 비교합니다.</desc>
{''.join(elements)}</svg>'''
output=ROOT/'docs/assets'
output.mkdir(exist_ok=True,parents=True)
svg_path=output/'light-theme-refinement.svg'
png_path=output/'light-theme-refinement.png'
svg_path.write_text(svg,encoding='utf-8')
subprocess.run(['inkscape',str(svg_path),'--export-type=png',f'--export-filename={png_path}'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'svg':str(svg_path),'svg_bytes':svg_path.stat().st_size,'png':str(png_path),'png_bytes':png_path.stat().st_size,'outlined_glyphs':len(glyphs),'themes':[t['id'] for t in themes]},ensure_ascii=False))
