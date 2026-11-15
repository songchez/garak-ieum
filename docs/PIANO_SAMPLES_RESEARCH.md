# 피아노 샘플 조사

2026-11-15 · 조사 문서이며 코드나 샘플은 바꾸지 않았습니다.

현재 `salamander` 세트("그랜드 피아노")의 소리가 아쉽다는 의견이 있어, GPL-3.0-only 앱에 변환·트리밍한 형태로 함께 배포해도 되는 피아노 샘플을 다시 찾았습니다. 라이선스는 가능한 한 공식 페이지에서 직접 확인했습니다. 확인하지 못한 항목은 **미확인**으로 적었습니다.

## 1. 결론 요약

1. 소리가 아쉬운 원인은 원본보다 **우리 변환 과정**의 영향이 큽니다. 지금은 이미 손실 압축된 MP3를 다시 Opus 64 kbps로 인코딩합니다. 벨로시티 레이어는 16개 중 3개만 쓰고, 모든 음을 9초에서 자르며, 페달·공명 처리가 없습니다. 원본을 바꾸지 않고 변환 과정만 고쳐도 차이의 상당 부분이 줄어듭니다(4장).
2. 원본을 바꾼다면 1순위는 **bitKlavier Grand**(Princeton, Steinway D, CC BY 4.0)입니다. 30음 × 16레이어라는 구성이 Salamander와 똑같아 현재 매니페스트·빌드 스크립트 구조를 거의 그대로 쓸 수 있습니다.
3. 2순위는 **Accurate-Salamander**(Salamander 리마스터, CC BY 3.0, 2026-11 갱신)입니다. 지금 악기를 유지한 채 조율·잡음·레이어 간 음량을 정리한 판본이라 위험이 가장 적습니다.
4. 3순위는 별도 악기로 넣는 **Upright Piano KW**(FreePats, CC0)입니다. 그랜드와 성격이 다른 업라이트가 하나 생기고, 작아서 웹에도 부담이 없습니다.
5. 반드시 함께 해결할 제약은 **디코딩 메모리**입니다. 웹과 네이티브 모두 세트 전체를 float32 PCM으로 메모리에 올립니다. 레이어와 샘플 길이를 늘리면 다운로드 크기보다 RAM이 먼저 한계에 닿습니다(5장).

## 2. 현재 구현과 제약

| 항목 | 현재 상태 | 근거 |
|---|---|---|
| 원본 | @tonejs/piano가 배포하는 Salamander V3 **MP3** | `scripts/samples/salamander.py` |
| 음 배치 | 단3도 간격 30음(A0–C8). 한 존이 ±1반음을 재생 속도로 맞춤 | 같은 파일 |
| 벨로시티 | 원본 16레이어 중 v3·v8·v13의 3개. 0–1을 3등분해 **경계에서 바로 전환**(크로스페이드 없음) | `pickZone` (`src/audio/samples.ts`, `native/src/engine.cpp`) |
| 음량 곡선 | 레이어 선택과 별도로 `0.25 + 0.75 × velocity` 게인을 곱함 | `src/audio/graph.ts`, `engine.cpp` |
| 길이 | 12 → 10 → 9초 순으로 줄여 20 MB 안에 들어가는 첫 값을 사용. 지금은 **9초**, 끝 300 ms 페이드 | `CAPS`, `BUDGET_MB` |
| 인코딩 | 48 kHz 스테레오, Opus **64 kbps**(pitched) + AAC 128 kbps | `scripts/samples/common.py` |
| 릴리즈 | 세트 전체에 0.3초 엔벨로프 하나를 씀. 88개 해머 릴리즈 노이즈를 0.35배로 재생 | `graph.ts` |
| 페달 | 엔진에 CC64가 없음. MIDI 가져오기에서 서스테인을 노트 길이 연장으로 바꿈. 페달 공명·페달 노이즈 없음 | `src/core/midiImport.ts` |
| 라운드 로빈 | 없음 | 매니페스트 형식 |
| 루프 | 형식은 지원(`loop`). 피아노는 쓰지 않음 | `SampleZone.loop` |
| 로딩 | 매니페스트의 모든 파일을 동시 6개씩 받아 **전부 디코딩**한 뒤 준비 완료 | `SampleLibrary.fetchSet` |
| 네이티브 | 같은 매니페스트를 float32 인터리브 PCM으로 보관. 최대 128보이스 | `native/include/garak/engine.hpp` |
| 크기 규칙 | 세트 하나당 20 MB(**webm과 m4a 합계**). 현재 webm 7.3 MB + m4a 12 MB = 19 MB | `docs/SAMPLES.md` |

엔진은 레이어 수에 제한이 없습니다. `vlo/vhi`로 몇 개든 나눌 수 있고, `releaseZones`로 키별 릴리즈 샘플도 받습니다. 따라서 **레이어를 늘리거나 샘플을 길게 하는 데는 코드 변경이 필요 없습니다.** 반면 페달 다운 샘플, 공명 릴리즈, 벨로시티 크로스페이드, 고음 무댐퍼 처리, 라운드 로빈은 매니페스트 형식과 엔진 양쪽을 바꿔야 합니다.

크기 규칙에 대한 참고: 앱은 `chooseFormat`으로 **한 가지 포맷만** 받습니다. 사용자가 실제로 내려받는 양은 webm 하나(7.3 MB)입니다. 20 MB 규칙이 저장소 용량을 위한 것인지 다운로드 크기를 위한 것인지 정하면 선택할 수 있는 범위가 달라집니다. 아래 계획은 "포맷 하나당 다운로드"를 기준으로 하고, 두 포맷의 합계도 함께 적었습니다.

## 3. 후보별 조사

### 3.1 재배포 가능한 후보

#### A. bitKlavier Grand — 추천 1순위

- 공식: <https://bitklavier.com/the-bitklavier-grand/> · 파일: `https://archive.org/details/bitKlavierGrand_<Mic>_<포맷>` (예: [Piano Bar 44k16b](https://archive.org/details/bitKlavierGrand_PianoBar_44k16b), [Stage Lid ORTF 48k24b](https://archive.org/details/bitKlavierGrand_StageLidORTF_48k24b))
- 라이선스: **CC BY 4.0**. 공식 페이지 원문은 "The bitKlavier Grand sample library is covered by the CC BY 4.0 license"이고, archive.org 항목에도 CC BY 4.0이 표시됩니다. 변환·트리밍·믹스한 결과물의 재배포와 상업적 이용이 가능합니다. 저작자 표시와 변경 사항 표시가 조건입니다.
- 표기 예: "The bitKlavier Grand" — Dan Trueman (producer), recorded by Andrés Villalta, played by Matt Wang, edited/denoised by Jeff Gordon, Katie Chou, Christien Ayers, Matt Wang, Dan Trueman; Princeton University Department of Music. CC BY 4.0. 변경: 레이어 선택, 마이크 믹스, 트리밍, 정규화, Opus/AAC 변환
- 악기: 새 **Steinway D** 콘서트 그랜드. Princeton Taplin Auditorium에서 뚜껑을 완전히 열고 2021년 1월에 녹음했습니다.
- 샘플: 단3도 간격 **30음 × 16레이어 = 480개**, 해머 릴리즈 88개(rel1–rel88), **릴리즈 공명** 90개, 페달 4개. 마이크 이미지 하나에 약 662파일입니다. 라운드 로빈은 없습니다.
- 마이크: 9개 스테레오 이미지(House ORTF, House Wide Cardioid, Decca Tail, Lip Cardioid, Harp Omni, Piano Bar, Stage Lid ORTF, Stage Lid Omni, Binaural KU100)를 각각 따로 배포합니다.
- 포맷: WAV. 96k/24, 88.2k/24, 48k/24, 44.1k/16 네 가지입니다. 한 마이크당 크기는 44k16b가 약 0.93 GB(Piano Bar), 48k24b가 약 2.6 GB(Stage Lid ORTF)입니다.
- 품질: iZotope RX8로 잡음을 줄였고, 레이어 간 음량을 키보드 전체에서 고르게 다시 맞췄습니다. A440 평균율로 조율했습니다. 녹음 시기가 가장 최근이고 녹음 환경도 가장 좋습니다. 다만 Salamander만큼 커뮤니티 비교 청취 자료가 많지는 않습니다(검색으로 리뷰를 찾지 못함). 웹용으로 변환한 선례로 [DoReGo](https://github.com/ldayton/DoReGo)가 있습니다. 16레이어를 유지하고 CC BY 4.0 NOTICE를 함께 배포합니다.
- 통합 난이도: **낮음~중간**. 음 배치가 Salamander와 같아 `salamander.py`의 NOTES와 존 계산을 그대로 쓸 수 있습니다. 파일명 규칙만 새로 매핑하면 됩니다. 마이크 선택이 필요합니다. 제안은 Stage Lid ORTF(자연스러운 거리감)와 Lip Cardioid(가까운 팝 톤) 중 하나를 고르거나, 둘을 빌드 단계에서 미리 섞어 스테레오 하나로 만드는 방법입니다. 릴리즈 공명과 페달 샘플을 쓰려면 엔진 확장(6장)이 필요합니다.

#### B. Accurate-Salamander — 추천 2순위

- 공식: <https://www.ir.isas.jaxa.jp/~cyamauch/AccurateSalamander/> (archive.org·InfiniCLOUD에서 배포)
- 라이선스: **CC BY 3.0**. 페이지 원문은 "CC-by (same licence as the original version)"입니다. 재배포와 변형이 가능하며 저작자 표시와 변경 표시가 조건입니다.
- 표기 예: Salamander Grand Piano V3 by Alexander Holm; Accurate-Salamander remaster by Chisato Yamauchi (retuning by Hiroharu Narikawa). CC BY 3.0. 변경: …
- 악기: Yamaha C5(Salamander와 같은 녹음). AKG C414 두 대를 AB로 현 위 약 12 cm에 두었습니다.
- 개선 내용: 88음 개별 음량 보정, 16레이어 사이 음량 단차를 약 2벨로시티 수준으로 축소(V6.0), 2025-07 조율사가 88음 전체 재조율, 녹음 잡음·진동 잡음·C4v15의 발소리 제거, 릴리즈 샘플 리마스터, 해머 노이즈 타이밍과 노트 온 지연 정리가 들어 있습니다. 음색 변형으로 Accurate, Twilight, Moonlight, Noct 네 가지가 있고, 뒤로 갈수록 부드럽습니다. 최신판은 **V6.2e(2026-11-12)**이며, 17–20레이어(더 강한 포르테)를 넣은 V7.0alpha가 개발 중입니다.
- 샘플: 뱅크당 641샘플, 16레이어, 48 kHz/24-bit WAV. 뱅크당 WAV 약 1.6 GB, FLAC 약 0.8 GB입니다. 의사 댐퍼 공명(디튠으로 생성)과 하프 페달은 SFZ 쪽 기능이라 우리가 그대로 가져오지는 못합니다.
- 품질: 원본 Salamander는 KVR 등의 블라인드 비교에서 좋은 평을 받아 왔습니다. 맑고 밝으며 콘서트 그랜드보다 작은 소리라는 평이 많습니다. 원본의 약점(잡음, 음마다 고르지 않은 음량·조율)을 이 판본이 정리했습니다.
- 통합 난이도: **가장 낮음**. 지금 스크립트에서 원본 경로와 파일명만 바꾸면 됩니다. MP3 대신 24-bit WAV를 원본으로 쓰므로 이중 손실 압축도 사라집니다. 변형 뱅크 하나(예: Moonlight)를 "부드러운 피아노"로 따로 내는 것도 같은 비용으로 가능합니다.

#### C. Upright Piano KW (FreePats) — 추천 3순위(별도 악기)

- 공식: <https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html>
- 라이선스: **CC0 1.0**(퍼블릭 도메인 헌정). 표기 의무는 없지만 출처를 적는 것을 권장합니다.
- 악기: Kawai 업라이트. 2017년 1월 거실에서 Zoom H1 한 대를 연주자 머리 위치에 두고 녹음했습니다. 2022-02-21판입니다.
- 샘플: 최고 품질판은 스테레오 **2레이어**이며 저음에 루프가 있습니다. 음 수와 샘플레이트는 페이지에 적혀 있지 않습니다(미확인. 디렉터리 목록 접근이 403).
- 크기: 최고 품질 SFZ+FLAC 32 MiB, WAV 69 MiB입니다. 작은 판은 FLAC 2.9 MiB입니다.
- 품질: 가정용 녹음기라 방 소리와 잡음이 있지만 따뜻한 "방 안 업라이트" 성격이 뚜렷합니다. 그랜드를 대체하지는 못하고, 로파이·발라드용 두 번째 피아노로 알맞습니다.
- 통합 난이도: **낮음**. 2레이어라 웹 예산 안에 쉽게 들어갑니다. 저음 루프는 매니페스트의 `loop`로 옮길 수 있습니다.

#### D. 그 밖에 재배포가 가능한 후보

| 이름 | 라이선스(확인 위치) | 악기 | 구성 | 크기·포맷 | 평가 |
|---|---|---|---|---|---|
| [Headroom Piano](https://github.com/sfzinstruments/BengtNilsson.HeadroomPiano) | CC BY 4.0 (저장소 README. 원작자 Bengt Nilsson의 허락으로 kinwie가 매핑. 원래 악기 이름 유지와 "이 저장소에서 파생" 표기 요청) | Yamaha C3 그랜드 | 30음(MIDI 21–108, 3반음 간격) × 5레이어 × 마이크 2(Close, Decca Tree), 300샘플. 릴리즈 샘플은 파일명에서 찾지 못함 | FLAC 156 MB(WAV 875 MB) | 구성이 Salamander와 같아 바로 쓸 수 있음. CC BY 4.0을 원작자가 직접 부여했는지는 저장소 설명에만 근거하므로 후보 4위 |
| [University of Iowa MIS Piano](https://theremin.music.uiowa.edu/MISpiano.html) | [MIS 소개](https://theremin.music.uiowa.edu/MIS.html): "freely available … may be downloaded and used for any projects, without restrictions." 정식 라이선스 문서는 없음 | Steinway B | **반음마다 88음** × 3다이내믹(pp, mf, ff), 전체 감쇠까지 녹음. 라운드 로빈·릴리즈 없음. mf Gb7 링크가 깨져 있음 | AIFF 44.1k/16 스테레오, 파일당 1.1–12.9 MB | Neumann KM84 2대, DAT 녹음(2001). 비무향실 환경이고 히스 잡음이 있음. 제약 없는 대체 소스로는 쓸 만하지만 소리는 A·B보다 아래 |
| [Osiris Piano](https://github.com/sfzinstruments/Osiris_Piano) | CC0 1.0 (저장소 LICENSE. beta_notes 0.923에서 CC0 추가) | Yamaha C2 소형 그랜드(KVR 기준) | 2레이어, 스테레오 마이크 3개, 서스테인 페달 업/다운 샘플, 잡음 제거판과 원본판 | FLAC 16-bit 약 460 MB, 1,200+ 샘플 | Versilian·Karoryfer 베타(0.925). 레이어가 적음 |
| [VCSL Keys](https://versilian-studios.com/vcsl-keys/) / [VCSL](https://github.com/sgossner/VCSL) | CC0 ("No royalties, attribution, or credit are required") | Steinway B("Joachim's"), Kawai 그랜드, Yamaha·Knight 업라이트 | 예: Steinway B는 34음 × 3레이어, rr1, Sus/NoSus/Rel 폴더. Kawai는 약 4레이어 | 전체 680 MB FLAC | 공식 설명대로 빈티지 악기를 "in the wild"에서 녹음. 캐릭터 피아노 용도 |
| [YDP Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) | CC BY 3.0 (FreePats) | Yamaha Disklavier Pro(OLPC용 Zenph 샘플) | 레이어 수 미확인 | SF2 36 MiB만 있음 | SF2를 풀어야 함. 품질은 평범 |

### 3.2 제외한 후보

| 이름 | 제외 이유 |
|---|---|
| Piano in 162 (Ivy Audio, Steinway B, 5다이내믹 × 2RR, 페달 on/off, 마이크 2, 4.9 GB) | 공식 페이지([ivyaudio.com](https://www.ivyaudio.com/Piano-in-162))에 라이선스나 이용 조건이 없음. 제3자 페이지는 "무료지만 공개 재배포 금지"라고 전함. 재배포를 허락하는 문구를 확인하지 못함 |
| Maestro Concert Grand (Mats Helgesson, Yamaha CF-3, 5레이어 반음 단위) | `mcgreadme.txt`에 "You may not modify and spread this soundfont without the author's written permission"이라고 명시 |
| Splendid Grand Piano (AKAI, "Steinway") | sfzinstruments README의 "2000년 초 Akai가 퍼블릭 도메인으로 공개"라는 한 줄 외에 1차 근거가 없고 저장소에 LICENSE 파일도 없음. 출처를 확인할 수 없음 |
| LivingRoom Upright Micro (KeyPleezer) | sfzinstruments는 CC BY-SA 4.0으로 표기하지만 제작사 페이지는 별도 EULA로 연결됨. 조건이 일치하는지 미확인 |
| Estate Grand LE, CFX Lite 등 | 상용 또는 라이선스 미표기 |
| Pianobook 팩(Church Steinway, The Steinway Experiment 등) | Pianobook 고유 약관이 적용되고 CC 라이선스가 아님. The Steinway Experiment는 Iowa 샘플에서 파생되었고 권리 논란이 있음 |
| Freesound CC0 | 반음 단위·다중 벨로시티를 모두 갖춘 CC0 피아노 세트를 찾지 못함 |
| Polyphone "127 velocity grand piano" 등 | 출처가 "Unknown"이고 9개 모노 샘플 수준 |
| Sonatina Symphonic Orchestra | 은퇴한 CC Sampling Plus 1.0 라이선스. 이번에는 조건을 확인하지 않음 |

## 4. Salamander 파생본을 고치면 얼마나 좋아지나

결론부터: **대부분 좋아집니다.** 원본 Salamander는 무료 피아노 중 평이 좋은 편이고, 지금 들리는 문제 대부분은 변환 과정에서 생겼습니다. 영향이 큰 순서로 정리했습니다.

1. **이중 손실 압축 제거**: MP3 → Opus 64k 경로를 버리고 48k/24 WAV(또는 Accurate-Salamander)에서 바로 인코딩합니다. 피아노 고음 배음과 어택에서 생기는 흐려짐·프리에코가 줄어듭니다. 코드 변경 없이 스크립트만 고치면 됩니다.
2. **비트레이트 64k → 80–96k**: 64k 스테레오 Opus는 피아노처럼 감쇠가 긴 소리에서 꼬리가 거칠어집니다. 크기는 1.25–1.5배가 됩니다.
3. **레이어 3 → 5–8개**: 3레이어에서는 벨로시티 경계를 넘을 때 음색이 갑자기 바뀝니다. 지금은 레이어 안에서 `0.25 + 0.75v`로 음량만 바뀝니다. 레이어를 늘리고 레이어별 음량 보정을 더하면 다이내믹이 자연스러워집니다.
4. **음역별 길이 상한**: 모든 음을 9초에서 자르므로 저음과 페달로 길게 끄는 화음이 부자연스럽게 끊깁니다. 저음 16–20초, 중음 10–12초, 고음 4–6초처럼 감쇠에 맞춘 상한(또는 -60 dB 지점 절단)을 쓰면 같은 용량으로 더 길게 울립니다.
5. **릴리즈 처리**: 세트 전체에 0.3초 하나만 쓰고 있습니다. 실제 피아노는 F#6 정도 위로 댐퍼가 없습니다(Osiris 노트에도 같은 언급). 존별 릴리즈 시간과 "고음 무댐퍼" 처리를 넣고, 해머 노이즈 음량을 벨로시티에 연동하면 끝소리가 덜 전자적으로 들립니다.
6. **서스테인 페달과 공명**: 지금은 페달을 노트 연장으로만 표현합니다. 그래서 페달 공명(현 공진)과 페달 소리가 없고, 같은 음을 반복하면 보이스가 쌓입니다. Salamander 원본과 bitKlavier에는 **공명 릴리즈 샘플**과 페달 노이즈가 있습니다. CC64를 엔진 이벤트로 받고 페달을 밟은 동안 공명 레이어를 섞는 기능을 넣으면 "샘플 피아노 같은" 인상이 가장 크게 줄어듭니다. 작업량은 가장 큽니다(6장).

1–4는 빌드 스크립트와 매니페스트 값만 바꾸면 됩니다. 5–6은 엔진 작업입니다. 1–4만 해도 체감 차이의 대부분이 해결될 것으로 판단합니다. 다만 원본을 bitKlavier로 바꾸는 작업도 1–4와 같은 수준의 비용으로 할 수 있습니다. 같은 작업량으로 더 좋은 녹음(Steinway D, 2021, 잡음 제거, 마이크 선택)을 얻을 수 있으므로, **스크립트를 다시 짜는 김에 원본을 함께 바꾸는 것**을 권합니다.

## 5. 크기·메모리 예산

### 계산 기준

- Opus 스테레오 비트레이트별 초당 크기: 64k ≈ 8 KB/s, 80k ≈ 10 KB/s, 96k ≈ 12 KB/s, 128k ≈ 16 KB/s. AAC 96k ≈ 12 KB/s, 128k ≈ 16 KB/s.
- 디코딩 메모리: 48 kHz 스테레오 float32는 **초당 375 KiB**입니다. 웹(`AudioBuffer`)과 네이티브(`PcmAsset.samples`) 모두 같은 크기를 씁니다.
- 현재 세트의 디코딩 메모리는 실측 약 **270 MB**입니다(webm 길이 합계: 피치 샘플 90개 692초 + 릴리즈 88개 40초. 고음은 9초보다 짧음). 이미 작지 않은 크기이므로 레이어와 길이를 늘리기 전에 이 값을 기준선으로 삼아야 합니다.
- 평균 길이는 음역별 상한(저음 16 s / 중음 10 s / 고음 5 s)과 여린 레이어가 빨리 감쇠하는 점을 반영해 **약 8초**로 잡았습니다.

### 웹 계획

| 안 | 구성 | webm 다운로드 | m4a(대체) | 디코딩 메모리 |
|---|---|---|---|---|
| 현재 | 30 × 3, 9 s 고정, Opus 64k, MP3 원본 | 7.3 MB | 12 MB | ≈ 270 MB(실측) |
| **W1(권장)** | 30 × 4레이어, 음역별 상한(평균 8 s), Opus 80k, 릴리즈 88개 | 120 × 8 s × 10 KB ≈ **9.6 MB** + 릴리즈 ≈ 0.7 MB → **≈ 10 MB** | AAC 96k ≈ 12 MB | 960 s + 릴리즈 40 s → **≈ 370 MB** |
| W2 | 30 × 5레이어, 평균 8 s, Opus 80k | ≈ 12.7 MB | AAC 96k ≈ 15 MB | ≈ 455 MB |
| W3 | 30 × 4, Opus 96k | ≈ 12 MB | AAC 128k ≈ 16 MB | ≈ 370 MB |

- W1은 현재보다 약 100 MB 많은 메모리로 원본 품질, 비트레이트, 저음 길이, 레이어 수를 모두 개선합니다. 레이어는 16개 중 고르게 v2, v6, v10, v14 정도를 고르고, 레이어별 음량은 원본 비율을 유지합니다.
- 20 MB 규칙을 지금처럼 "webm + m4a 합계"로 두면 W1(약 22 MB)은 조금 넘습니다. "포맷 하나당 다운로드 20 MB"로 바꾸거나, AAC를 96k로 낮추고 m4a를 Safari 구버전 대체용으로만 두는 방법이 있습니다.
- W2 이상은 메모리를 줄이는 작업과 함께 해야 합니다. 예: mf 레이어를 먼저 받아 바로 연주 가능하게 하고 나머지 레이어를 뒤에서 디코딩하기, 처음 쓰일 때 디코딩하기, AudioWorklet 샘플러에서 Int16으로 보관해 메모리를 절반으로 줄이기.

### 데스크톱 계획

| 안 | 구성 | 다운로드 | 메모리 |
|---|---|---|---|
| D1(설치 파일 기본) | 웹 W1과 같은 세트 | 0(앱에 포함) | ≈ 370 MB |
| **D2(선택 다운로드 "고품질 피아노 팩")** | 30 × 8레이어, 상한 저음 30 s / 중음 15 s / 고음 6 s(평균 약 12 s), Opus 128k 또는 FLAC 16-bit, 공명 릴리즈 90개 + 페달 4개 포함 | Opus ≈ 240 × 12 s × 16 KB ≈ **46 MB**(+공명 ≈ 5 MB). FLAC이면 약 250–350 MB | float32 그대로면 ≈ 1.05 GB. **Int16 보관 시 ≈ 530 MB** |
| D3(16레이어 전체) | 30 × 16 전체 길이 | Opus ≈ 100 MB, FLAC ≈ 0.5–0.8 GB | float32 ≈ 2–2.7 GB. **디스크 스트리밍 없이는 비현실적** |

- 데스크톱 팩은 GitHub Release 자산이나 별도 CDN에 두고 처음 쓸 때 내려받습니다. 소스 묶음에는 재현 스크립트(`scripts/samples/<set>.py`)와 출처를 넣습니다. 처리 결과 자산은 GPL 대응 소스가 아니라 CC BY 자산이므로 LICENSE·NOTICE를 함께 배포하면 됩니다.
- D2부터는 네이티브 `PcmAsset`의 Int16 보관(또는 앞부분만 미리 올리고 나머지를 디스크에서 읽는 스트리밍)이 필요합니다.

## 6. 엔진에 필요한 작업(우선순위)

| 순위 | 작업 | 효과 | 범위 |
|---|---|---|---|
| 1 | 빌드 스크립트: WAV/FLAC 원본, 레이어 선택, 음역별 상한, 비트레이트 | 4장 1–4번 | `scripts/samples/*.py`만 |
| 2 | 존별 `release` 값과 고음 무댐퍼(예: `release: null` 또는 `damper: false`) | 끝소리 개선 | 매니페스트 형식, `graph.ts`, `engine.cpp` |
| 3 | 같은 음 재타건 시 이전 보이스를 짧게 감쇠 | 보이스 쌓임과 탁해짐 방지 | 두 엔진 |
| 4 | 인접 레이어 크로스페이드(선택) | 레이어 경계의 음색 단차 제거 | 보이스 2개 사용, `pickZone` 확장 |
| 5 | CC64 이벤트와 페달 상태. 페달을 밟은 동안 릴리즈 지연, 공명 릴리즈 샘플, 페달 노이즈 | 페달 공명, "진짜 피아노" 인상 | 타임라인 모델, MIDI 가져오기, 두 엔진, 매니페스트(`resonanceZones`, `pedalZones`) |
| 6 | 지연 디코딩 또는 Int16 보관 | W2·D2 메모리 확보 | `SampleLibrary`, 네이티브 자산 저장 |

## 7. 최종 추천

1. **bitKlavier Grand(CC BY 4.0, Steinway D)**로 원본을 교체하고 W1 구성(30 × 4레이어, Opus 80k, 음역별 상한, 해머 릴리즈 88개)으로 웹 기본 세트를 만듭니다. 웹 다운로드 약 10 MB, 디코딩 메모리 약 370 MB(현재 270 MB)입니다. 마이크는 Stage Lid ORTF와 Lip Cardioid를 실제로 들어 보고 정합니다(두 마이크를 섞는 것도 가능). 데스크톱에는 D2 "고품질 피아노 팩"을 선택 다운로드로 제공하고, 엔진 작업 5번(페달·공명)이 끝나면 공명 릴리즈 90개와 페달 샘플을 켭니다.
2. 교체 전에 들어 보는 단계에서 bitKlavier가 너무 멀거나 어둡게 들리면 **Accurate-Salamander V6.2e(CC BY 3.0)**를 같은 W1/D2 구성으로 씁니다. 지금 악기와 같은 C5라 사용자 프로젝트의 소리가 크게 달라지지 않는다는 장점도 있습니다. Twilight 또는 Moonlight 뱅크를 "소프트 피아노"로 추가하는 것도 같은 스크립트로 할 수 있습니다.
3. **Upright Piano KW(CC0)**를 두 번째 피아노("업라이트 피아노")로 추가합니다. 최고 품질판 FLAC이 32 MiB이므로 Opus 변환 시 웹에서도 수 MB 수준이 예상됩니다(음 수 미확인).

어느 안이든 첫 작업은 6장의 1번(빌드 스크립트)입니다. 이 단계만 끝내도 현재 피아노와 바로 A/B 비교할 수 있습니다. 출처 표기는 `docs/SAMPLES.md` 규칙대로 각 세트의 `attribution`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, 앱 정보 창에 반영합니다. CC BY 4.0과 3.0 모두 변경 사항 표시가 필요합니다.

## 출처

- bitKlavier Grand: <https://bitklavier.com/the-bitklavier-grand/>, <https://archive.org/details/bitKlavierGrand_PianoBar_44k16b>, <https://archive.org/details/bitKlavierGrand_StageLidORTF_48k24b>
- Accurate-Salamander: <https://www.ir.isas.jaxa.jp/~cyamauch/AccurateSalamander/>
- Salamander Grand Piano V3: <https://archive.org/details/SalamanderGrandPianoV3>, <https://sfzinstruments.github.io/pianos/salamander>
- FreePats(Upright Piano KW, YDP, Salamander): <https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html>
- University of Iowa MIS: <https://theremin.music.uiowa.edu/MIS.html>, <https://theremin.music.uiowa.edu/MISpiano.html>
- SFZ Instruments 피아노 목록: <https://sfzinstruments.github.io/pianos>
- Headroom Piano: <https://github.com/sfzinstruments/BengtNilsson.HeadroomPiano>
- Osiris Piano: <https://github.com/sfzinstruments/Osiris_Piano>, <https://www.kvraudio.com/product/osiris-piano-by-karoryfer/details>
- VCSL: <https://versilian-studios.com/vcsl-keys/>, <https://github.com/sgossner/VCSL>
- Maestro Concert Grand 약관: <https://github.com/sfzinstruments/MatsHelgesson.MaestroConcertGrandPiano>
- Splendid Grand Piano: <https://github.com/sfzinstruments/SplendidGrandPiano>
- Piano in 162: <https://www.ivyaudio.com/Piano-in-162>, <https://sfzinstruments.github.io/pianos/in_162>
- DoReGo(bitKlavier 웹 변환 선례): <https://github.com/ldayton/DoReGo>
