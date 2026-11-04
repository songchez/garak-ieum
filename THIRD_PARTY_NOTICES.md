# 제3자 자산 안내

애플리케이션 코드의 배포 라이선스는 [GPL-3.0-only](LICENSE)입니다. 이전에 MIT로 제공한 앱 코드의 [저작권·허가 고지](public/licenses/garak-ieum-MIT-notice.txt)를 보존하며, 이미 MIT 조건으로 받은 복사본의 권리는 소급해 취소하지 않습니다. [라이선스와 대응 소스 안내](docs/LICENSING.md)

아래 아이콘, 글꼴, 샘플 음원과 외부 라이브러리는 각각의 원래 라이선스와 저작권 고지를 유지합니다. 앱의 라이선스 변경으로 이 제3자 자료의 라이선스 원문을 바꾸지 않습니다.

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
- 이 샘플 파일의 GPL-3.0-or-later 조건은 앱 코드의 GPL-3.0-only와 구분해 유지합니다. 샘플의 출처·변경 내역·라이선스 원문은 그대로 보존합니다.

## Signalsmith Stretch — 피치 편집 오프라인 DSP

- 원본: [Signalsmith-Audio/signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch), 고정 커밋 `88061fd4eda56a2353c5d65c74aa3f4ccf76f9da`.
- 공식 배포 웹 번들의 WASM factory를 별도 Worker/Node용으로 분리했습니다. 상위 AudioWorklet 래퍼는 실행하지 않습니다.
- 라이선스: MIT. [원문](src/devices/pitch-editor/vendor/LICENSE.signalsmith.txt)을 함께 포함합니다.
- 추출 방법·원본 출처·변경 범위는 [vendor 안내](src/devices/pitch-editor/vendor/README.md)에 기록합니다.
- 이 모듈은 피치 편집 렌더에 사용하며 네이티브 플러그인 호스트나 실시간 마이크 피치 보정기를 제공하지 않습니다.

## 네이티브 오디오 엔진 의존성

C++ 엔진은 아래 고정 소스를 사용합니다. 다운로드 URL, 정확한 SHA-256과 archive 이름, 하위 소스 commit, 고지 파일 경로는 [native/dependencies.lock.json](native/dependencies.lock.json)이 기준입니다. JUCE는 사용하지 않습니다.

| 패키지 | 고정 버전 / commit | 적용 라이선스와 저작권 고지 |
| --- | --- | --- |
| Steinberg ASIO SDK | 2.3.4, 공식 `ASIO-SDK_2.3.4_2025-10-15.zip` | Steinberg Media Technologies GmbH. 제공된 이중 라이선스 중 GPLv3 경로 선택. 원본 `LICENSE.txt` 및 `common/LICENSE.txt` 보존 |
| miniaudio | 0.11.26 · `877ea4a7c2601c7b0f2a44e83dfac42e6470fea6` | David Reid 및 기여자. Public Domain/MIT No Attribution 선택지 중 MIT-0. 원본 `LICENSE` 보존 |
| nlohmann/json | 3.11.3 · `9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03` | Niels Lohmann 및 기여자, MIT. 원본 `LICENSE.MIT` 보존 |
| VST3 SDK | 3.8.1 · `3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96` | Steinberg Media Technologies GmbH, MIT. root 및 각 하위 소스 `LICENSE.txt` 보존 |
| VST3 base | `fcf9da0bd27a16f7f03773a3a39822f28f5c8477` | MIT |
| VST3 pluginterfaces | `4f547e8e102b47de4a8b8aaf343c73b700786372` | MIT |
| VST3 public.sdk | `586dc5e6c8012c3e4b01c79389375cbe96bdb1da` | MIT |
| VST3 cmake | `054c9143cbb8d47fc4694e473f2ee3b4d951a8f5` | MIT |

원본 출처: [ASIO 공식 SDK](https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip), [miniaudio](https://github.com/mackron/miniaudio/tree/877ea4a7c2601c7b0f2a44e83dfac42e6470fea6), [nlohmann/json](https://github.com/nlohmann/json/tree/9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03), [VST3 SDK](https://github.com/steinbergmedia/vst3sdk/tree/3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96). 하위 저장소의 고정 URL은 manifest에 모두 기록합니다.

이 의존성의 원본 archive는 수정하지 않고 SHA-256을 확인해 빌드합니다. 자체 어댑터·호스트·DSP와 테스트 코드는 `native/`에 있습니다. 설치물에는 `resources/native/licenses/<패키지>/`와 동일 manifest를 넣습니다. 대응 소스 ZIP에는 8개 archive를 모두 `native/dependency-sources/`에 넣고 Windows/macOS에서 같은 소스 묶음을 제공합니다. macOS에서 ASIO를 컴파일하지 않더라도 대응 소스 묶음에는 ASIO 원본이 포함됩니다. [빌드/배포 상세](docs/NATIVE_AUDIO.md)

사용자가 설치한 제3자 VST3 플러그인은 각 제작자의 별도 제품입니다. 그 바이너리는 가락이음의 설치물이나 대응 소스 ZIP에 포함하지 않습니다. ASIO/VST 명칭은 Steinberg의 상표이며, SDK 사용을 Steinberg나 개별 플러그인 제작자의 보증으로 표시하지 않습니다.
