# 빈티지 악기 복각 오픈소스 조사

2026-11-15 · 조사 문서 (코드·자산 변경 없음)

롤랜드 신디·드럼머신, 로즈 전기 피아노, 해먼드 오르간, DX7 등 고전 악기를 재현한 **오픈소스 DSP 코드**와 **재배포 가능한 샘플**을 조사했습니다. 가락이음의 GPL-3.0-only 배포물에 포함할 수 있는 항목만 추천 대상으로 남겼습니다. NC(비상업), ND(변경금지), 재배포 금지 조건이 있거나 라이선스가 명시되지 않은 자료는 제외했습니다. 라이선스는 2026-11-15에 각 저장소의 LICENSE 파일과 소스 헤더를 직접 확인했습니다. "확인 필요"로 표시한 항목은 도입 전에 다시 확인해야 합니다.

관련 문서: [샘플 악기 규격](SAMPLES.md) · [IEUM WAVE](IEUM_WAVE.md) · [라이선스](LICENSING.md) · [제3자 고지](../THIRD_PARTY_NOTICES.md)

## 요약: 추천 순위

| 순위 | 가칭(오마주 이름) | 재현 대상 | 출처 | 라이선스 | 경로 | 예상 공수 |
|---|---|---|---|---|---|---|
| 1 | **Rose Keys 73** · 로즈 키 73 | 로즈 Mk I 계열 EP | mda ePiano (Paul Kellett) | MIT 또는 GPL-2.0-or-later (원본) | 내장 샘플 → 샘플러 매니페스트 + 트레몰로·드라이브 DSP | S–M (3–7일) |
| 2 | **Juniper 60** · 주니퍼 60 | 주노-6/60/106 | Ultramaster KR-106 | GPL-3.0 | C++17 헤더 DSP 포팅 | M–L (2–3주) |
| 3 | **새콤 303** (영문 Silverline Acid) | TB-303 베이스 | Open303 (Robin Schmidt) | MIT | C++ 포팅 | S–M (1주, 시퀀서 제외) |
| 4 | **Octo 88 / Nine-O 드럼** · 뚝배기 킥 | TR-808 / 909풍 합성 드럼 | Mutable Instruments Plaits·Peaks 드럼 | MIT | C++ 헤더 포팅 | S–M (1주) |
| 5 | **자개 FM 7** (영문 Septet FM) | DX7 6-오퍼레이터 FM | MSFA (Dexed 엔진) | Apache-2.0 | C++ 포팅 + 사용자 SysEx 가져오기 | M–L (2–4주) |
| 6 | **풍금 B3** + **회전목마 로터리** | 해먼드 B3 + 레슬리 | setBfree | GPL-2.0-or-later | C 포팅 | L (3–4주) |
| 7 | **Planet T** · **Stage Grand 80** | 호너 피아넷 T · 야마하 CP80 | Greg Sullivan E-Pianos | CC BY 3.0 | 기존 `wurlitzer.py` 파이프라인 재사용 | S (1–2일) |
| 8 | **Oberon X** · 오베론 X (참고용) | 오버하임 OB-X 계열 폴리 VA | OB-Xf (Surge 팀) | GPL-3.0 | 필터·보이스 구조 참고 또는 부분 포팅 | L (참고만 하면 S) |

**보조 후보:** FreePats "FM Synthesized Piano"(CC0, DX7 E.Piano 1을 Hexter로 녹음) — 5순위 FM 엔진보다 먼저 샘플러용 "FM EP"를 1일 안에 제공할 수 있습니다.

**결론:** 로즈 계열 EP는 **재배포 가능한 고품질 멀티샘플이 사실상 없습니다**(아래 '제외 목록' 참고). mda ePiano의 내장 샘플(MIT로 함께 공개된 33개 루프 샘플)이 현실적인 유일한 샘플 경로입니다. 나머지 악기(주노, 303, 808/909, DX7, 해먼드)는 **샘플보다 DSP 포팅이 더 깨끗한 경로**입니다. 808·909 원본 녹음 팩은 대부분 라이선스가 명시되지 않았습니다.

## 엔진 통합 방침

가락이음에는 두 엔진이 있습니다. 브라우저의 `WebAudioEngine`(AudioWorklet, TypeScript)과 데스크톱의 C++20 `RenderEngine`입니다. 조사한 DSP는 대부분 C/C++입니다.

- **권장:** `native/devices/<악기>/`에 C++ DSP를 하나 둡니다. 데스크톱은 직접 링크하고 웹은 Emscripten WASM으로 빌드해 AudioWorklet에서 실행합니다. 기존 Signalsmith WASM 사례(`src/devices/pitch-editor/vendor/`)와 같은 방식입니다. TS와 C++로 두 번 포팅하지 않아도 되고 두 엔진의 소리가 같습니다. 단, IEUM WAVE는 현재 웹에서 합성하지 않습니다. 웹 WASM 경로는 이 조사 범위를 넘는 별도 작업입니다.
- **악기 정의:** `src/core/instruments.ts`의 `kind: 'native'`(WAVE와 같은 방식) 또는 `'sampled'`로 등록합니다. 샘플 기반은 [SAMPLES.md](SAMPLES.md) 규격(Opus/AAC, 세트당 20 MB 이하, `scripts/samples/<set>.py` 재현 스크립트)을 따릅니다.
- **라이선스 고지:** MIT·Apache·BSD 코드는 원 저작권 고지와 라이선스 전문을 `native/devices/<악기>/LICENSE.*`와 `THIRD_PARTY_NOTICES.md`에 보존합니다. Apache-2.0은 NOTICE 파일이 있으면 함께 보존합니다. GPL 코드는 "or later" 여부를 기록합니다. GPL-2.0-only 코드는 GPL-3.0-only와 결합할 수 없으므로 사용하지 않습니다.
- **프리셋:** 원본 기기의 공장 프리셋(롤랜드 패치, 야마하 ROM 카트리지)을 옮겨 적은 데이터는 번들하지 않습니다. 직접 만든 프리셋만 포함하고 사용자가 자신의 SysEx·패치를 가져오도록 합니다.

## 1. Rose Keys 73 — 로즈 계열 전기 피아노

### mda ePiano (권장)

- **원본:** Paul Kellett(Maxim Digital Audio)의 mda VST 플러그인. 2008-06 SourceForge에 소스 공개. <https://sourceforge.net/p/mda-vst/>
- **라이선스:** 원본 소스는 **MIT 또는 GPL-2.0-or-later** 선택. Kellett은 상용 제품에도 쓸 수 있도록 MIT를 택했다고 밝혔습니다([KVR 공지](https://www.kvraudio.com/forum/viewtopic.php?p=3109032), [LAD 공지](https://lists.linuxaudio.org/archives/linux-audio-dev/2008-June/020316.html)). LV2 포트(David Robillard, <https://gitlab.com/drobilla/mda-lv2>)는 **GPL-3.0-or-later**입니다. 어느 쪽이든 GPL-3.0-only와 호환됩니다. 출처가 깔끔한 **SourceForge 원본(MIT)** 을 기준으로 삼는 것을 권장합니다.
- **출처 표기 예:** `mda ePiano — Copyright (c) 1999-2000 Paul Kellett (Maxim Digital Audio), MIT License`
- **구성:** `mdaEPiano.cpp`(약 17 KB)와 `mdaEPianoData.h`(텍스트 약 2.3 MB). 데이터는 로즈 피아노를 녹음한 **11개 건반 그룹 × 3 벨로시티 = 33개 샘플**입니다. 44.1 kHz 모노 16비트이고 루프 지점이 코드에 있습니다(예: `kgrp[0].root = 36`, `pos/end/loop`). 원시 PCM은 1 MB 미만으로 추정되며 [SAMPLES.md](SAMPLES.md)의 20 MB 예산에 여유 있게 들어갑니다.
- **DSP:** 벨로시티별 샘플 재생, 트레블 셸빙 보정, 오버드라이브, 오토팬/트레몰로, 벨로시티 감도. 수백 줄 분량입니다.
- **평판:** 1990년대 말부터 무료 EP의 표준으로 쓰였습니다. 지금도 Zynthian, MOD, SuperCollider(MdaUGens)에 포함됩니다. 최신 상용 EP보다 해상도가 낮고 벨로시티 레이어가 3개뿐이지만, 재배포 가능한 로즈 계열 소리 중에서는 가장 확실합니다.
- **통합 경로:**
  1. `scripts/samples/rose-keys.py`: 헤더 배열을 추출해 33개 WAV로 분리하고 `zones`(root/lo/hi/vlo/vhi/`loop`)를 생성한 뒤 Opus/AAC로 인코딩합니다. 우리 샘플러가 `loop`를 이미 지원하므로 **양쪽 엔진에서 바로 동작**합니다(S, 2–3일).
  2. 선택: 트레몰로·드라이브를 샘플러 뒤의 인서트(기존 이펙트 체인)나 네이티브 장치로 추가합니다(M).
- **주의:** 샘플의 녹음 출처는 Kellett 본인 녹음으로 알려졌을 뿐 문서화되어 있지 않습니다. 저작권자가 소스와 함께 MIT로 공개한 자료로 취급하되, LICENSE.txt에 "원본 소스 배포물에 포함된 데이터"임을 기록합니다.

### 보조: 합성 타인 모델 (선택, 장기)

- 기존 `rhodes`("Tine EP", FM 타인)를 개선하는 방향입니다. **Mutable Instruments Elements/Rings/Plaits의 모달 공진기**(STM32 코드, **MIT**, <https://github.com/pichenettes/eurorack>)로 타인·톤바 모드를 만들고, 전자기 픽업의 비선형 특성(비대칭 포화)을 더하는 방식입니다. Copyright 2014–2016 Emilie Gillet.
- 참고 문헌: Pfeifle, "Real-time Physical Model of a Wurlitzer and Rhodes Electronic Piano"(DAFx 2017), Aalborg 대학 석사 논문(2024, FDTD 로즈 모델). 논문은 알고리즘 참고용이며 코드를 포함하지 않습니다.
- 공수: L(3주+). 음색 튜닝 비용이 큽니다.

## 2. Juniper 60 — 주노 계열 폴리 신디

### Ultramaster KR-106

- **URL:** <https://github.com/kayrockscreenprinting/ultramaster_kr106> (2026-03 공개, 스타 약 200, 커밋 284)
- **라이선스:** GPL-3.0(LICENSE 전문). 버전 "only/or later"는 헤더로 확인이 필요합니다. 둘 다 GPL-3.0-only와 호환됩니다. JUCE는 AGPLv3로 사용하고 있으나 **우리는 JUCE를 가져오지 않고 `Source/DSP/` 헤더만** 사용합니다.
- **재현 대상:** Juno-6/60(아날로그)·Juno-106(펌웨어) 듀얼 모드.
- **DSP 구성(헤더 전용 C++17, JUCE 비의존 확인):** `KR106OscillatorsWT.h`(대역 제한 톱니·펄스·서브), `KR106VCF.h`(TPT 래더 + OTA 포화), `KR106Chorus.h`(MN3009 BBD 코러스, 에르미트 보간), `BBDFilter.h`, `KR106Voice.h`, `KR106Arpeggiator.h`, ADSR·LFO, 모델별 파라미터 곡선. ngspice로 회로를 검증했다고 밝힙니다.
- **통합:** `native/devices/juniper/`로 DSP 헤더를 옮기고 `RenderEngine` 악기 인터페이스에 연결합니다. 편집기는 WAVE 편집기 구조를 재사용합니다(슬라이더 패널). 코러스는 단독 이펙트("은하수 코러스")로도 분리할 수 있습니다.
- **주의:** `KR106_Presets_JUCE.h`의 240개 공장 프리셋은 원본 기기 패치에서 생성되었습니다. **번들하지 말고** 자체 프리셋을 만듭니다. GUI 비트맵도 가져오지 않습니다.
- **공수:** M–L (DSP 연결 1주, 편집기·프리셋·검증 1–2주)

### 대안·참고

- **TAL-U-NO-62 / TAL-U-NO-LX:** 비공개 소스입니다. 제외합니다.
- **Surge XT** (<https://github.com/surge-synthesizer/surge>, GPL-3.0): 거대한 하이브리드 신디입니다. 그대로 포팅하기에는 크지만 `sst-filters`·`sst-basic-blocks`·`sst-effects`(모두 GPL-3.0)의 필터·코러스를 부품으로 쓸 수 있습니다.

## 3. 새콤 303 (Silverline Acid) — 303 애시드 베이스

### Open303 (권장 엔진)

- **URL:** <https://github.com/RobinSchmidt/Open303> · 확장 포크 JC-303 <https://github.com/midilab/jc303> (GPL-3.0, 활발히 유지)
- **라이선스:** Open303 엔진 파일(`rosic_*`)은 **MIT, Copyright (c) 2009 Robin Schmidt (www.rs-met.com)**. JC-303 README도 같은 내용을 파일별로 명시합니다.
- **구성:** 블렌드 톱니/사각 오실레이터, TB-303 특유의 다이오드 래더 근사 필터(TeeBee), 액센트·슬라이드, 데케이 엔벌로프. C++이며 저장소가 작습니다(수천 줄 이하).
- **통합:** 모노 신디로 `native/devices/acid/`에 포팅합니다. 슬라이드는 노트 겹침(레가토)으로, 액센트는 벨로시티 임계값으로 매핑합니다. 웹은 WASM입니다. 선택적으로 JC-303이 포팅한 **Aciduino V2 시퀀서(MIT, (c) 2022 Romulo Silva)** 를 참고해 16스텝 애시드 패턴 편집기를 만들 수 있습니다.
- **주의(JC-303):** `dfl_DiodeLadderFilter.*`, `dfl_TB303OutputNetwork.h`, `dfl_LFO.*`는 **AGPL-3.0-or-later**입니다(Copyright (C) 2026 David Lowenfels). GPLv3 제13조로 결합 자체는 가능하지만 네트워크 제공 의무가 추가되므로 **가져오지 않습니다.** GuitarML 오버드라이브(GPL-3.0)는 이미 기타 리그가 있으므로 불필요합니다.
- **공수:** S–M (엔진 3–5일, 스텝 시퀀서 별도 1–2주)

## 4. Octo 88 / Nine-O — 808·909풍 합성 드럼

### Mutable Instruments Plaits·Peaks 드럼 모델 (권장)

- **URL:** <https://github.com/pichenettes/eurorack> — `plaits/dsp/drums/`, `peaks/drums/`
- **라이선스:** STM32 프로젝트 코드는 **MIT** (README: "Code (STM32F projects): MIT license", 파일 헤더 "Copyright 2016 Emilie Gillet"). AVR 프로젝트는 GPL-3.0이며 대상이 아닙니다. 하드웨어 도면은 CC BY-SA 3.0이며 사용하지 않습니다.
- **파일과 소스 주석:**
  - `analog_bass_drum.h` — "808 bass drum model, revisited"
  - `analog_snare_drum.h` — "808 snare drum model, revisited"
  - `hi_hat.h` — "808 HH, with a few extra parameters…"
  - `synthetic_bass_drum.h` — "Inadvertently 909-ish" (909풍 킥)
  - `synthetic_snare_drum.h`, Peaks `bass_drum.h`·`snare_drum.h`·`high_hat.h`·`fm_drum.h`
- **평판:** Plaits는 유로랙에서 가장 널리 쓰인 디지털 음원 중 하나입니다. VCV Rack "Audible Instruments"로도 이식되었습니다. 각 모델은 헤더 하나, 100–200줄 규모이고 `stmlib` 일부(필터·유틸)에 의존합니다(같은 저장소, MIT).
- **통합:** 신규 `kind: 'native'` 드럼 키트로 등록합니다. GM 노트 배치(36 킥, 38 스네어, 42/46 하이햇, 39 클랩)는 [SAMPLES.md](SAMPLES.md)의 kit 표를 따릅니다. 패드마다 Tune·Decay·Tone·Accent 노브를 둡니다. 클랩·탐·카우벨은 모델이 없으므로 같은 원리(노이즈 버스트 + 밴드패스, 브리지드-T 공진)로 직접 작성합니다.
- **기존 자산과의 관계:** `kit-808`(Hydrogen TR808EmulationKit, GPL-3.0-or-later 샘플)은 그대로 두고, 이 엔진은 "파라미터를 돌릴 수 있는" 합성 키트로 제공합니다.
- **공수:** S–M (1주)

### 808/909 원본 샘플 팩

[제외 목록](#제외-목록)을 참고합니다. 명시적 라이선스가 있는 원본 기기 녹음 팩은 찾지 못했습니다.

## 5. 자개 FM 7 (Septet FM) — DX7 계열 FM

### MSFA (Music Synthesizer for Android) — Dexed의 엔진

- **URL:** <https://github.com/google/music-synthesizer-for-android> (Apache-2.0) · Dexed <https://github.com/asb2m10/dexed> (GPL-3.0, 스타 3.6k, 2026-11 활동)
- **라이선스:** Dexed README: "Dexed is licensed on the GPL v3. The msfa component … stays on the Apache 2.0 license." Apache-2.0은 GPL-3.0과 호환됩니다(GPL-2.0과는 비호환이지만 우리는 GPL-3.0). Copyright 2012 Google Inc. 고지와 Apache-2.0 전문을 보존하고 변경 사실을 표시합니다.
- **구성:** `fm_core`, `fm_op_kernel`, `dx7note`, `env`, `pitchenv`, `lfo`, `exp2`/`sin` 테이블. 32비트 고정소수점 C++이며 수천 줄 규모입니다. DX7의 32개 알고리즘, 엔벌로프, 키 스케일링을 재현합니다. Dexed 쪽 MSFA에는 이후 수정 사항(엔진 모드 등)이 추가되어 있습니다. **Dexed의 msfa 폴더(Apache-2.0)를 기준으로** 가져오는 것이 좋습니다.
- **통합:** `native/devices/fm7/`. 155개 보이스 파라미터 편집기는 큰 작업입니다. 1차로 "알고리즘 선택 + 오퍼레이터 6개 비율·레벨·엔벌로프"의 축약 편집기와 **사용자 SysEx(.syx) 가져오기**를 제공하는 것이 좋습니다. 기존 `rhodes`(FM Tine EP) 소리를 이 엔진의 프리셋으로 통합할 수도 있습니다.
- **주의:** 야마하 ROM 카트리지(ROM1A 등)는 번들하지 않습니다. 자체 프리셋만 제공합니다.
- **공수:** M–L (엔진 1주, 편집기·프리셋 2–3주)

### FreePats "FM Synthesized Piano" (빠른 대안)

- **URL:** <https://freepats.zenvoid.org/ElectricPiano/synthesized-piano.html>
- **라이선스:** **CC0 1.0**. Hexter(DX7 에뮬레이터)로 "E. Piano 1" 계열 패치를 녹음한 것입니다. Piano #1 SFZ FLAC 24 MiB, Piano #2 8.7 MiB.
- **통합:** 샘플러 세트(`fm-ep`)로 변환합니다. 존을 줄이고 8초로 자르면 3–5 MB에 들어갑니다. **S (1일)**
- 주의: 패치 자체가 야마하 공장 음색을 흉내 낸 것이지만 녹음물은 FreePats가 CC0로 공개했습니다. 이름에는 "DX"를 쓰지 않습니다.

## 6. 풍금 B3 + 회전목마 로터리 — 톤휠 오르간과 회전 스피커

### setBfree

- **URL:** <https://github.com/pantherb/setBfree> · <https://setbfree.org/> · 바이너리 <https://x42-plugins.com/x42/setBfree>
- **라이선스:** 소스 헤더 "GNU General Public License … either version 2, or (at your option) any later version" → **GPL-2.0-or-later**. GPL-3.0-only와 호환됩니다.
- **출처 표기:** Copyright (C) 2003-2004 Fredrik Kilander · (C) 2008-2018 Robin Gareus · (C) 2012 Will Panther · (C) 2010 Ken Restivo (whirl)
- **구성(C):** `src/tonegen.c`(91개 톤휠, 크로스토크·누설·키 클릭, 드로바, 퍼커션, 비브라토/코러스 스캐너), `b_whirl/`(레슬리 혼·드럼 회전 모델), `b_overdrive/`(진공관 프리앰프), `b_reverb/`. 오디오 샘플을 쓰지 않는 순수 DSP입니다.
- **평판:** 리눅스 오디오에서 가장 완성도 높은 톤휠 오르간이며 Ardour·Zynthian·MOD에서 쓰입니다. 오랫동안 안정적으로 유지되었습니다.
- **통합:** 엔진은 전역 상태와 설정 파서에 얽혀 있어 정리가 필요합니다. `native/devices/organ/`로 가져와 인스턴스 구조체로 감쌉니다. **`b_whirl`은 단독 이펙트("회전목마 로터리")** 로 분리하면 EP·신디에도 쓸 수 있어 가치가 큽니다. 편집기는 9개 드로바 + 퍼커션 + V/C 스캐너 + 로터리 슬로/패스트입니다.
- **공수:** L (3–4주). 로터리 이펙트만 먼저 하면 M(1–2주)입니다.

## 7. Planet T · Stage Grand 80 — 피아넷 T와 CP80

### Greg Sullivan E-Pianos (이미 쓰는 패키지의 나머지 두 악기)

- **URL:** <https://github.com/sfzinstruments/GregSullivan.E-Pianos>
- **라이선스:** **CC BY 3.0 Unported** ("This work is licensed under a Creative Commons Attribution 3.0 Unported License"). Greg Sullivan의 출처 표기 요청, SFZ 매핑은 kinwie입니다. 현재 `wurlitzer` 세트와 같은 패키지입니다.
- **포함 악기:** Yamaha CP80 Electric Grand v1.3(2004), Hohner Pianet T(type 2) v1.3(2004), Wurlitzer EP200(사용 중). FLAC, SFZ v2.
- **통합:** `scripts/samples/wurlitzer.py`의 SFZ 파서·인코딩 흐름을 그대로 재사용합니다(`FOLDER`, `SFZ`, `BUDGET_MB`만 변경). 기존 wurlitzer 세트가 2.8 MB이므로 각각 3–6 MB가 예상됩니다. 출처 표기는 기존 wurlitzer 항목 형식을 따릅니다.
- **공수:** S (세트당 반나절–1일)
- 로즈 EP는 이 패키지에 없습니다(조사 시 확인).

## 8. Oberon X — 오버하임 계열 폴리 VA (참고용)

### OB-Xf

- **URL:** <https://github.com/surge-synthesizer/OB-Xf> (스타 약 530, 베타, 2026-11 활동)
- **라이선스:** GPL-3.0 ("This repository and the source code is under GPL3 license"). OB-Xd(2DaT, discoDSP)의 마지막 오픈소스 판을 Surge 팀이 이어받았습니다. 원래 `reales/OB-Xd` 저장소는 비워졌으므로 OB-Xf를 기준으로 합니다.
- **용도:** 2-폴 SEM풍 / 4-폴 필터, 보이스 변동(슬롭) 처리 같은 "아날로그 폴리" 기법을 참고합니다. 주노(2순위) 다음에 두 번째 VA가 필요할 때 부분 포팅을 검토합니다.
- 프로페트-5·미니무그 계열은 별도 전용 오픈소스 복각 중 GPL3 호환이면서 성숙한 것을 찾지 못했습니다. Surge XT·Odin 2·OB-Xf의 래더 필터와 톱니 오실레이터로 "Model Mood D"·"Oracle 5" 같은 오마주 프리셋을 IEUM WAVE나 Juniper 엔진 위에 만드는 편이 현실적입니다.

## 기타 확인한 후보

| 이름 | URL | 라이선스 | 판단 |
|---|---|---|---|
| openwurli | <https://github.com/hal0zer0/openwurli> | GPL-3.0 | 월리처 200A 물리 모델(Rust, 리드 7모드 모달 + 정전 픽업 + 프리앰프 MNA + 트레몰로). 샘플 월리처가 이미 있으므로 참고·장기 후보. 포팅하려면 Rust→C++ 재작성 필요(L). |
| Odin 2 | <https://github.com/TheWaveWarden/odin2> | GPL-3.0 (글꼴만 OFL 1.1) | 아날로그 모델링 필터 다수(래더, SEM, Korg35, 다이오드). 필터 부품 참고용. |
| Helm | <https://github.com/mtytel/helm> | GPL-3.0 | 2022 이후 정체. 참고만. |
| Vital | <https://github.com/mtytel/vital> | GPL-3.0 (+ "Vital" 상표 제한) | IEUM WAVE와 영역이 겹침. 참고만. |
| ZynAddSubFX | <https://github.com/zynaddsubfx/zynaddsubfx> | GPL-2.0-or-later (헤더 확인) | 가산·PAD 합성. 빈티지 복각 목적에는 부적합. |
| amsynth | <https://github.com/amsynth/amsynth> | GPL-2.0 계열 (or-later 여부 헤더 확인 필요) | 단순 2-OSC 아날로그. 우선순위 낮음. |
| Surge XT | <https://github.com/surge-synthesizer/surge> | GPL-3.0 | 부품(sst-filters, sst-effects)으로 활용 가능. |
| VCV Fundamental | <https://github.com/VCVRack/Fundamental> | 코드 GPL-3.0-or-later / **패널 디자인 CC BY-NC-ND 4.0** | 코드만 가능, 그래픽은 금지. |
| Faust 라이브러리 | <https://github.com/grame-cncm/faustlibraries> | LGPL + 생성 코드 라이선스 선택 예외 | `pm.` 물리 모델링 부품이 있으나 EP·오르간 완성품은 없음. 프로토타이핑 도구로 유용. |
| VCSL | <https://github.com/sgossner/VCSL> | CC0 | `Electrophones/TX81Z` 등 일부 전자 악기만 있음. EP·오르간 없음. |
| pytheory Rhodes 합성 | <https://github.com/kennethreitz/pytheory> | 확인 필요 | 타인·톤바·픽업 모델 아이디어 수준. |

## 제외 목록

| 항목 | 이유 |
|---|---|
| **jRhodes3d** (Jeff Learman, 1977 Rhodes Mk I Stage 73) | 샘플이 **CC BY-NC 4.0**(나머지만 CC0). 일부 미러가 CC0로 잘못 표기함. <https://sfzinstruments.github.io/pianos/jrhodes3d> |
| **jRhodes3c** | **CC BY-NC-SA 4.0** |
| 808/909 원본 녹음 팩 (hyperreal의 Michael Fischer 808, fluid-music `@fluid-music/tr-808`·`tr-909`, 각종 무료 팩) | 정식 라이선스가 없거나 "제한 없음"이라는 메모뿐임. GPL 배포물에 넣기에는 근거가 약함. 합성 모델(4순위)로 대체 |
| 멜로트론·챔벌린 테이프 샘플 | 원 테이프 녹음 저작권이 살아 있고 현 권리자가 상용 판매 중. 무료 재배포 가능한 세트 없음 |
| 해먼드·클라비넷 샘플 (HamOrg Lite 등 프리웨어) | 재배포 조건 미기재. 해먼드는 setBfree, 클라비넷은 향후 Rings/Plaits 현 모델(MIT) + 픽업 합성으로 대체 검토 |
| TAL-U-NO-62/LX, Roland Cloud, Arturia 등 | 비공개 소스 |
| JC-303의 `dfl_*` 파일 | AGPL-3.0-or-later. 엔진(MIT)만 사용 |
| KR-106 공장 프리셋, Dexed 동봉 DX7 ROM 카트리지 | 원 제조사 패치 데이터. 자체 프리셋으로 대체 |
| Production Voices, Garritan 등 sfzinstruments 목록의 상용 항목 | 상용 |

## 상표와 이름 규칙

다음은 각 회사의 상표이거나 상표일 가능성이 큰 이름입니다. **제품·악기 이름, 아이콘, 프리셋 이름으로 쓰지 않습니다.** Roland, Juno, Jupiter, TB-303, TR-808, TR-909, SH-101, D-50, Rhodes, Fender, Wurlitzer, Hohner, Clavinet, Pianet, Hammond, Leslie, Mellotron, Yamaha, DX7, CP80, Moog, Minimoog, Sequential, Prophet, Oberheim, OB-X. 출처 고지와 설명 문장에서 "Wurlitzer EP200을 녹음한 샘플"처럼 사실을 적는 것은 지명 사용으로 허용됩니다.

> **참고:** 현재 `src/core/instruments.ts`의 `wurlitzer` 악기 표시 이름이 `'Wurlitzer EP'`·`'월리처'`입니다. 이 규칙에 맞추려면 오마주 이름(예: "Whirly 200" · "월리 200")으로 바꾸고 출처 고지에만 원래 이름을 남기는 것을 검토할 만합니다(ID `wurlitzer`는 저장된 프로젝트 호환을 위해 유지).

기타 리그 장비와 같은 방식으로, 한국적 이름 2–3개와 원형을 떠올리게 하는 영어식 말장난 이름을 섞었습니다.

| 원형 | 영어식 오마주 | 한국적 이름 |
|---|---|---|
| 로즈 Mk I | Rose Keys 73, Tine Garden | 옥구슬 EP |
| 주노-60/106 | Juniper 60, Junebell 106 | 은하수 60 (코러스: 은하수 코러스) |
| 주피터-8 | Jovian 8 | — |
| TB-303 | Silverline Acid, Acid 3o3 | 새콤 303 |
| TR-808 | Octo 88, Boom Eighty | 뚝배기 킥(808 킥 단독) |
| TR-909 | Nine-O, Club Niner | — |
| DX7 | Septet FM, FM Seven | 자개 FM 7 |
| 해먼드 B3 | Hammerwheel B, Tonewheel Bee | 풍금 B3 |
| 레슬리 | Whirlwind Rotary | 회전목마 로터리 |
| 피아넷 T | Planet T | — |
| CP80 | Stage Grand 80 | — |
| 월리처 | Whirly 200 | 월리 200 |
| OB-X | Oberon X | — |
| 프로페트-5 | Oracle 5 | — |
| 미니무그 | Model Mood D | — |
| 멜로트론 | (재배포 가능 자료 없음) | 테이프 대신 "녹음테이프 패드" 같은 자체 합성 음색 |

이름에 숫자 "303", "808", "909"만 쓰는 사례는 업계에서 흔하지만, 정확한 모델명("TB-303", "TR-808")이나 로고 서체를 흉내 내지 않습니다.

## 권장 진행 순서

1. **빠른 성과(1주 안):** 7순위 Planet T·Stage Grand 80(CC BY 3.0), FreePats FM EP(CC0), 1순위 Rose Keys 73 샘플 세트. 모두 기존 샘플러와 `scripts/samples/` 파이프라인을 사용하며 새 DSP가 필요 없습니다.
2. **네이티브 DSP 1차:** 3순위 새콤 303(Open303), 4순위 Octo 88 드럼(Plaits/Peaks). 둘 다 MIT이고 코드가 작아 네이티브 장치 구조(`native/devices/<악기>/`, 프로토콜, 편집기)의 틀을 잡기에 좋습니다.
3. **네이티브 DSP 2차:** 2순위 Juniper 60(KR-106), 6순위 회전목마 로터리 → 풍금 B3(setBfree), 5순위 자개 FM 7(MSFA).
4. 웹 엔진 지원이 필요하면 2단계부터 같은 C++ DSP를 WASM으로 빌드하는 경로를 함께 설계합니다.

각 도입 작업에서는 원본 커밋을 `native/dependencies.lock.json` 방식으로 고정하고, 라이선스 전문과 변경 내역을 `THIRD_PARTY_NOTICES.md`와 앱 정보 창에 추가합니다.
