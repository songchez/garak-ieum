# 제3자 자산 안내

애플리케이션 코드는 MIT로 제공합니다. 아래 아이콘, 글꼴과 샘플 음원은 각각의 라이선스를 따르며 애플리케이션의 MIT 라이선스로 다시 허가하지 않습니다.

## Lucide 아이콘

- 패키지: `lucide-react` 1.66.0
- 저작권자: Lucide Icons and Contributors · Feather 유래 아이콘은 Cole Bemis
- 공식 출처: <https://lucide.dev/> · <https://github.com/lucide-icons/lucide>
- 이용 조건: ISC License, Feather 유래 아이콘은 MIT License — <https://lucide.dev/license>
- 사용: `src/components/Icon.tsx`에서 필요한 아이콘만 정적으로 가져옵니다. 크기·색상·선 두께만 UI에 맞춰 지정합니다.
- 배포용 고지: [lucide-LICENSE.txt](public/licenses/lucide-LICENSE.txt). 앱의 소개 창에서도 이 파일에 접근할 수 있습니다.
- 아래는 설치한 패키지의 `LICENSE` 전문입니다.

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 덕온공주체

- 저작권자: 문화체육관광부 국립한글박물관 · ㈜윤디자인그룹
- 공식 출처: <https://hanfont.hangeul.go.kr/relaxfont/font/deokon.do>
- 원본 배포: <https://hanfont.hangeul.go.kr/fonts/DeogonPrincess_TTF.zip>
- 이용 조건: 공공누리 제3유형 — 출처표시·변경금지. 공식 페이지의 추가 사용 조건을 함께 따릅니다.
- 사용 결과물: `public/brand/garak-ieum-wordmark.svg`
- 안내 파일: [DeogonPrincess-LICENSE.txt](public/fonts/DeogonPrincess-LICENSE.txt)

이름은 2026-10-30에 공식 ZIP에서 받은 가로쓰기용 `DeogonPrincess.ttf`로 조판했습니다. 글꼴 파일은 수정하거나 서브셋하지 않았고, 저장소와 웹 배포물에도 포함하지 않습니다. 고정된 네 글자의 원래 획과 가로 배치 폭을 사용해 만든 SVG 워드마크만 제공합니다. 일반 편집 UI는 기존 본문 글꼴을 사용합니다.

재생성 도구는 `scripts/build-brand-wordmark.py`입니다. 공식 원본 TTF와 fonttools 4.61.1을 준비한 뒤 `python3 scripts/build-brand-wordmark.py --font /path/to/DeogonPrincess.ttf`로 실행합니다. 앱 실행과 일반 빌드에는 이 도구나 전체 폰트가 필요하지 않습니다.

상업적 이용 허용과 수정 가능한 오픈소스 글꼴이라는 뜻은 서로 다릅니다. 자세한 허용 범위는 공식 안내를 확인합니다.

## 샘플 음원

`public/samples/<세트>/` 아래의 음원은 아래 원 저작물을 잘라내고 음량을 맞춘 뒤 Opus(webm)·AAC(m4a)로 변환한 것입니다. 각 폴더의 `LICENSE.txt`와 `manifest.json`의 `attribution`에 같은 내용을 적었습니다. 재생성 스크립트는 `scripts/samples/`에 있고, 규격은 [docs/SAMPLES.md](docs/SAMPLES.md)입니다. 원 저작자들은 가락이음을 후원하거나 보증하지 않습니다.

### 국악기 디지털 음원 — `samul`, `gayageum`, `haegeum`, `daegeum`

본 저작물은 '국립국악원'에서 작성하여 공공누리 제1유형으로 개방한 '국악기 디지털 음원(단음·확장)'을 이용하였으며, 해당 저작물은 '국립국악원, <https://www.gugak.go.kr/digitaleum>'에서 무료로 내려받으실 수 있습니다.

- 이용 조건: 공공누리 제1유형(출처표시) <https://www.kogl.or.kr/info/licenseType1.do> — 상업적 이용과 변경 허용
- 확장 음원 연주: 윤다영(가야금)
- 변경 사항: 음 단위 분할, 트리밍, 페이드, 음량 정규화, Opus/AAC 변환, 일부 음정 보정
- 곡을 공개하거나 판매할 때는 '국립국악원 국악기 디지털 음원(공공누리 제1유형)' 출처 표기를 권장합니다.

### Salamander Grand Piano V3 — `salamander`

- 저작자: Alexander Holm (Yamaha C5, 48 kHz/24-bit 녹음)
- 출처: <https://archive.org/details/SalamanderGrandPianoV3>
- 라이선스: CC BY 3.0 <https://creativecommons.org/licenses/by/3.0/>
- 변경 사항: 30음 × 3 벨로시티 레이어와 88개 키 릴리즈 샘플을 골라 9초로 자르고 정규화한 뒤 Opus/AAC로 변환. 인코딩 원본은 @tonejs/piano(<https://github.com/tambien/Piano>, © Yotam Mann)의 MP3입니다.

### Wurlitzer EP200 (E-Pianos) — `wurlitzer`

- 저작자: Greg Sullivan (SFZ 매핑: kinwie)
- 출처: <https://github.com/sfzinstruments/GregSullivan.E-Pianos>
- 라이선스: CC BY 3.0 <https://creativecommons.org/licenses/by/3.0/> (저작자 사이트는 CC BY 4.0으로 안내)
- 변경 사항: FLAC → Opus/AAC 변환, 트리밍, 정규화

### Virtuosity Drums — `kit-acoustic`, `kit-lofi`(심벌)

- 저작자: Versilian Studios LLC · Karoryfer Samples (연주: Austin McMahon)
- 출처: <https://github.com/sfzinstruments/virtuosity_drums>
- 라이선스: CC0 1.0 <https://creativecommons.org/publicdomain/zero/1.0/>
- 변경 사항: 'mid'·'lofi' 마이크 일부 발췌, 트리밍, 정규화, Opus/AAC 변환

### Versilian Community Sample Library (VCSL) — 클랩(`kit-acoustic`, `kit-lofi`)

- 저작자: Versilian Studios LLC
- 출처: <https://github.com/sgossner/VCSL>
- 라이선스: CC0 1.0

### Gogodze Phu Vol II — `kit-lofi`

- 저작자: Karoryfer Samples
- 출처: <https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii>
- 라이선스: CC0 1.0
- 변경 사항: retro_mic 일부 발췌, 트리밍, 정규화, Opus/AAC 변환

### TR808EmulationKit — `kit-808`

- 저작자: ArtemioLabs (Artemiy Pavlov), Hydrogen 드럼 머신과 함께 배포. 기본 파형만으로 직접 합성한 16개 소리입니다.
- 출처: <https://github.com/hydrogen-music/hydrogen/tree/main/data/drumkits/TR808EmulationKit>
- 라이선스: GPL-3.0-or-later <https://www.gnu.org/licenses/gpl-3.0.html> — 전문은 `public/samples/kit-808/LICENSE.txt`
- 변경 사항: 트리밍, Opus/AAC 변환
- 이 샘플 파일은 MIT 코드와 별개로 함께 배포하는 GPL 데이터입니다. 코드가 GPL이 되는 것은 아닙니다.
