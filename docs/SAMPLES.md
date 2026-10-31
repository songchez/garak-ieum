# 샘플 악기 규격

가락이음은 합성 악기 외에 샘플 기반 악기를 제공합니다. 샘플은 `public/samples/<set>/` 아래에 두고, 각 세트는 `manifest.json` 하나로 설명합니다. 앱은 이 매니페스트만 읽습니다.

## 폴더 구조

```
public/samples/
  <set-id>/
    manifest.json
    LICENSE.txt          # 원 저작물 라이선스 전문 또는 링크와 출처
    *.webm               # Opus 96 kbps (one-shot) / 64 kbps (pitched), 48 kHz
    *.m4a                # 같은 내용의 AAC 128 kbps (Safari 17 이하 대비)
scripts/samples/
  <set-id>.py            # 원본 다운로드 → 트리밍 → 인코딩 재현 스크립트
  common.py              # 공통 인코딩 함수
```

원본 WAV/FLAC은 저장소에 넣지 않습니다. 처리된 webm/m4a만 커밋합니다. 세트 하나당 20 MB를 넘지 않도록 합니다.

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
- 끝: one-shot은 `-60 dBFS` 아래로 떨어진 뒤 50 ms에서 자르고 20 ms 페이드 아웃. pitched는 길이 상한 8 s(피아노 12 s), 마지막 300 ms 페이드 아웃.
- 정규화: 세트 안에서 상대 음량을 유지. 세트 전체의 최대 피크를 `-1 dBFS`로 맞추는 한 번의 공통 게인만 적용. 레이어 간 음량 차이는 보존.
- 리샘플: 48 kHz. 스테레오 원본은 스테레오 유지, 모노는 모노 유지.
- Opus: `ffmpeg -c:a libopus -b:a 96k -application audio -frame_duration 20` (pitched는 64k). 컨테이너 webm.
- AAC: `ffmpeg -c:a aac -b:a 128k` 컨테이너 m4a. AAC 인코더 지연(약 2112 샘플)을 매니페스트가 아닌 로더에서 보정할 수 없으므로, 인코딩 전에 트리밍을 끝내고 `-movflags +faststart`를 씁니다. 앱은 m4a를 쓸 때 첫 44 ms를 건너뜁니다.

## 출처 표기

각 세트의 `attribution`을 `THIRD_PARTY_NOTICES.md`에 그대로 옮기고, 앱의 정보 창에서도 보여 줍니다. 이 저장소의 MIT 라이선스는 코드에만 적용되고 샘플에는 적용되지 않습니다.
