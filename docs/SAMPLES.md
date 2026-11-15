# 샘플 악기 규격

가락이음은 합성 악기 외에 샘플 기반 악기를 제공합니다. 샘플은 `public/samples/<set>/` 아래에 두고, 각 세트는 `manifest.json` 하나로 설명합니다. 앱은 이 매니페스트만 읽습니다.

## 폴더 구조

```
public/samples/
  <set-id>/
    manifest.json
    LICENSE.txt          # 원 저작물 라이선스 전문 또는 링크와 출처
    *.webm               # Opus 96 kbps (one-shot, 피아노) / 64 kbps (그 밖의 pitched), 48 kHz
    *.m4a                # 같은 내용의 AAC 128 kbps (Safari 17 이하 대비)
scripts/samples/
  <set-id>.py            # 원본 다운로드 → 트리밍 → 인코딩 재현 스크립트
  common.py              # 공통 인코딩 함수
  piano.py               # 어쿠스틱 피아노 세트(salamander, bitklavier) 공통 빌드
```

원본 WAV/FLAC은 저장소에 넣지 않습니다. 처리된 webm/m4a만 커밋합니다. 세트 하나의 **형식별** 크기(webm 합계, m4a 합계 각각)가 20 MB를 넘지 않도록 합니다. 앱은 실행 환경에 맞는 형식 하나만 내려받으므로, 사용자가 받는 크기 기준입니다(2026-11-15 변경, 이전에는 두 형식 합계 20 MB).

## manifest.json

```jsonc
{
  "id": "salamander",              // 폴더 이름과 같음
  "name": "Grand Piano",           // 화면 표시 이름
  "nameKo": "그랜드 피아노",
  "kind": "pitched",               // "pitched" | "kit"
  "category": "piano",             // piano | keys | drums | gugak
  "formats": ["webm", "m4a"],      // 제공 포맷. 앱은 지원되는 첫 포맷을 고름
  "gainDb": 0,                     // 세트 전체 보정
  "release": 0.25,                 // 노트 오프 후 페이드 아웃(초). kit은 무시
  "zones": [
    {
      "file": "A4v3",              // 확장자 없이. file + "." + format
      "root": 69,                  // 샘플이 녹음된 MIDI 번호 (kit은 매핑 대상 노트)
      "lo": 68, "hi": 70,          // 이 존이 담당하는 키 범위 (kit은 root 하나)
      "vlo": 0.34, "vhi": 0.67,    // 벨로시티 범위 0..1 (단일 레이어면 0..1)
      "gainDb": 0,                 // 존별 보정(선택)
      "tune": 0,                   // 센트 보정(선택)
      "loop": [1.234, 2.345],      // 루프 구간 초(선택, pitched 지속음용)
      "choke": 1                   // 같은 choke 그룹이 울리면 끊음(선택, 하이햇)
    }
  ],
  "releaseZones": [],              // 피아노 키 릴리즈 노이즈 등(선택, zones와 같은 형식)
  "attribution": {
    "title": "Salamander Grand Piano V3",
    "author": "Alexander Holm",
    "url": "https://archive.org/details/SalamanderGrandPianoV3",
    "license": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "changes": "30 notes × 3 velocity layers selected, trimmed, encoded to Opus/AAC"
  }
}
```

### kit 세트의 노트 배치 (General MIDI 기준)

| 노트 | 역할 | 국악 사물 키트 |
|---|---|---|
| 36 | 킥 | 북(용고) |
| 37 | 사이드 스틱 | 박 |
| 38 | 스네어 | 장구 덩 |
| 39 | 클랩 | 장구 기덕 |
| 40 | 스네어 2 / 림 | 장구 덕 |
| 41 | 로우 플로어 탐 | 장구 쿵 |
| 42 | 클로즈드 하이햇 | 꽹과리 갱 |
| 43 | 플로어 탐 | 장구 더 |
| 44 | 페달 하이햇 | 꽹과리 지 |
| 45 | 로우 탐 | 좌고 |
| 46 | 오픈 하이햇 | 꽹과리 객 |
| 47 | 미드 탐 | 바라 |
| 48 | 하이 미드 탐 | 꽹과리 갯 |
| 49 | 크래시 | 징 강 |
| 50 | 하이 탐 | 꽹과리 개-ㅅ |
| 51 | 라이드 | 징 약 |
| 53 | 라이드 벨 | |

## 인코딩 규칙

- 시작 무음 제거: `-40 dBFS` 기준으로 첫 신호 직전 2 ms까지 자름. 드럼은 어택이 밀리지 않도록 반드시 자름.
- 끝: one-shot은 `-60 dBFS` 아래로 떨어진 뒤 50 ms에서 자르고 20 ms 페이드 아웃. pitched는 길이 상한 8 s, 마지막 300 ms 페이드 아웃. 피아노는 아래 [피아노 세트](#피아노-세트)의 음역별 상한을 씁니다.
- 정규화: 세트 안에서 상대 음량을 유지. 세트 전체의 최대 피크를 `-1 dBFS`로 맞추는 한 번의 공통 게인만 적용. 레이어 간 음량 차이는 보존.
- 리샘플: 48 kHz. 스테레오 원본은 스테레오 유지, 모노는 모노 유지.
- Opus: `ffmpeg -c:a libopus -b:a 96k -application audio -frame_duration 20` (피아노가 아닌 pitched는 64k). 컨테이너 webm.
- AAC: `ffmpeg -c:a aac -b:a 128k` 컨테이너 m4a. AAC 인코더 지연(약 2112 샘플)을 매니페스트가 아닌 로더에서 보정할 수 없으므로, 인코딩 전에 트리밍을 끝내고 `-movflags +faststart`를 씁니다. 앱은 m4a를 쓸 때 첫 44 ms를 건너뜁니다.

## 피아노 세트

| 세트 | 악기 이름 | 원본 | 라이선스 |
|---|---|---|---|
| `salamander` | Grand Piano · 그랜드 피아노 | Accurate-Salamander Grand Piano V6.2e(Salamander Grand Piano V3 리마스터, Yamaha C5) 48 kHz/24-bit FLAC | CC BY 3.0 |
| `bitklavier` | Concert Grand · 콘서트 그랜드 | The bitKlavier Grand(Steinway D), Stage Lid ORTF 마이크 44.1 kHz/16-bit WAV | CC BY 4.0 |

두 세트는 `scripts/samples/piano.py` 한 파이프라인으로 만듭니다. `salamander` ID는 기존 프로젝트 호환을 위해 그대로 두고 음원만 바꿨습니다(0.1.6까지는 @tonejs/piano의 MP3를 다시 인코딩한 30음 × 3레이어, 9초 고정, Opus 64k).

- 원본: archive.org의 공식 아카이브를 받아 공개된 MD5로 확인한 뒤, 압축을 풀지 않고 필요한 파일만 읽어 ffmpeg로 디코딩합니다. `python -I scripts/samples/salamander.py --archive <zip>`처럼 직접 받은 파일을 넘기거나, 생략하면 `.samples-cache/`에 받습니다.
- 구성: 단3도 간격 30음(A0–C8) × 16레이어 중 v3·v7·v11·v15의 4개. 0–1 벨로시티를 4등분합니다. 키 릴리즈 노이즈 88개(`rel1`–`rel88`).
- 길이: 음마다 실제 감쇠가 `-66 dBFS` 아래로 떨어지는 곳과 음역별 상한 중 짧은 쪽에서 자릅니다. 상한은 A0 14 s → A2 11 s → C4 7.5 s → C5 5 s → C6 3.5 s → C7 2.6 s → C8 2 s를 직선 보간한 값에 세트별 배율을 곱합니다. 배율은 세트 전체의 디코딩 크기(float32 스테레오 48 kHz)가 275 MiB를 넘지 않도록 정합니다(0.1.6 세트 약 270 MiB와 같은 수준). 상한에서 자른 음은 상한의 35 %(0.5–3 s)에 걸친 코사인 페이드로 끝나 자연스럽게 사라집니다.
- 음량: 피치 샘플 전체의 최대 피크를 `-1 dBFS`로 맞추는 공통 게인 하나만 적용해 레이어 사이의 실제 세기 차이를 보존합니다. 키 릴리즈 노이즈는 같은 게인에 세트별 감쇠(`release_gain_db`)를 더해, 중간 세기 음보다 충분히 작게 저장합니다.
- 인코딩: Opus 96 kbps, AAC 128 kbps. 형식별 20 MB 이하를 빌드에서 확인합니다.

| 세트 | 배율 | 피치 샘플 평균/최대 길이 | webm | m4a | 디코딩 크기 |
|---|---|---|---|---|---|
| `salamander` | 0.804 | 5.8 s / 11.3 s | 10.3 MB | 11.8 MB | 270 MiB |
| `bitklavier` | 0.777 | 5.6 s / 10.9 s | 10.6 MB | 12.1 MB | 274 MiB |

세트별 보정:

- `salamander`: Accurate-Salamander는 16레이어의 음량을 모두 같게 맞추고 세기 표현을 SFZ의 `amp_veltrack=98.5`에 맡깁니다. 우리 샘플러는 `0.25 + 0.75 × 벨로시티`만 곱하므로, 각 레이어 벨로시티 구간의 가운데에서 SFZ 곡선(`1 − 0.985 + 0.985 × v²`)과 같아지도록 레이어 게인을 굽습니다(v3 −19.7 dB, v7 −9.4 dB, v11 −3.7 dB, v15 0 dB). 키 릴리즈는 −25 dB.
- `bitklavier`: 녹음된 레이어 세기 차이(C4 기준 v3→v15 약 21 dB)를 그대로 씁니다. 키 릴리즈 녹음이 큰 음보다 13–18 dB밖에 작지 않아 −12 dB 낮춥니다.

### 키 릴리즈 소리

`releaseZones`가 있는 세트는 노트 오프 때 키 릴리즈(댐퍼) 소리를 섞습니다. 웹(`src/audio/samples.ts` `releaseNoiseGain`)과 네이티브(`native/include/garak/dsp.hpp` `dsp::releaseNoiseGain`)가 같은 규칙을 씁니다.

- 크기 = `릴리즈 소리`(피아노 악기 조절기 `releaseNoise`, 0–1, 기본 0.5, 0이면 끔) × 노트 온 벨로시티 × `exp(-누른 시간 / 2 s)`.
- 건너뜀: 음이 이미 다 울려 사라진 뒤(누른 시간 ≥ 샘플 길이), 벨로시티 0.02 이하, 리전 끝·루프 경계·프로젝트 끝에서 잘린 노트(노트 끝이 해당 구간 끝과 같음).
- 트랜스포트 정지, 탐색, 보이스 스틸링은 보이스를 바로 끊으므로 릴리즈 소리를 내지 않습니다. 실시간 MIDI 입력의 노트 오프는 항상 실제 키 떼기로 봅니다.

## 출처 표기

각 세트의 `attribution`을 `THIRD_PARTY_NOTICES.md`에 그대로 옮기고, 앱의 정보 창에서도 보여 줍니다. 앱 코드의 GPL-3.0-only는 샘플 자산의 라이선스를 대체하지 않습니다. 샘플마다 [제3자 자산 안내](../THIRD_PARTY_NOTICES.md)에 기록한 원래 이용 조건과 고지를 유지합니다.
