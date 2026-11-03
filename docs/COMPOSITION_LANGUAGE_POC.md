# 코드 작곡 언어 비교 실험

2026-11-02 · 가락이음 0.1.0 · 기준 소스 `5fb8f73`

**라이선스 기록 안내 (2026-11-03):** 이 실험 당시 앱 코드는 MIT였으며, 아래 MIT 관련 판단과 의존성 비교는 당시 기록으로 보존합니다. 현재 앱은 0.1.1에서 **GPL-3.0-only**로 전환했습니다. 이 전환은 Strudel의 앱 통합이나 AGPL 채택을 뜻하지 않습니다. [현재 라이선스·대응 소스 안내](LICENSING.md)

**상태: 비교 실험 완료, 앱의 작곡 언어 채택은 미확정.** 앱의 `package.json`, 잠금 파일, `node_modules`, 재생 엔진에 두 라이브러리를 추가하지 않았습니다. 실험 의존성은 임시 디렉터리에만 설치했고, 저장소에는 직접 작성한 재현 스크립트·입력 fixture·결과만 남깁니다. 라이브러리 구현이나 생성된 번들은 저장소에 포함하지 않습니다.

## 판단

정확한 셋잇단 시간, 유한 구간 생성, seed로 재현되는 변주까지 처음부터 요구한다면 **Strudel의 패턴 계층을 우선 후보로 삼는 것이 이번 실험 결과에 맞습니다.** 다만 AGPL 통합 정책을 정하고, 패키징·실제 브라우저 검증을 통과하기 전에는 주 앱에 넣지 않습니다.

**Scribbletune도 간단한 작곡 프로파일에는 유효한 후보입니다.** 순수 `clip`을 브라우저용으로 묶는 데 라이브러리 포크는 필요하지 않았습니다. 사용하지 않는 `fs` import를 제거한다는 빌드 설정과, 출력 단위를 변환하는 어댑터로 실행할 수 있었습니다. 그러나 마디 표기, 정확한 셋잇단, 기본 랜덤의 재현성에는 제약이 실제로 확인됐습니다. 4/4의 이진 분할 패턴 중심으로 제한하거나 이 제약을 보정해야 합니다.

공통 편곡 API·프로젝트 명령 계층은 어느 후보를 선택해도 사용할 수 있게 유지합니다. 새 범용 음악 언어를 만드는 일은 이번 범위에 포함하지 않습니다. Scribbletune의 익숙한 JS 객체 API를 사용하는 것과, 그 패턴 엔진 전체를 장기간 포크하는 것은 구분해서 판단합니다.

## 실험 환경과 방법

| 항목 | 실행값 |
|---|---|
| Node.js | 24.22.1 |
| pnpm | 11.25.0 |
| Scribbletune | 5.5.5, MIT |
| `@strudel/core` / `@strudel/mini` | 1.2.6 / 1.2.6, AGPL-3.0-or-later |
| esbuild | 0.28.2 |
| 박자 | 4/4 |
| Strudel 시간 정책 | 이 실험에서 1 cycle = 4 quarter beats로 매핑 |
| Scribbletune 시간 정책 | 실제 core 반환값의 quarter `4n` = 128 단위를 1 beat로 변환 |
| 음높이 | 언어 입력의 과학적 표기 C4 → MIDI 60 → 가락이음 표시 C3 |
| 세기 | Scribbletune `amp / 127`, Strudel `velocity`에 같은 정규화 값을 지정 |
| 비교 기준 | 음높이·음표 수 일치, 시작·길이·세기의 차이 ≤ `1e-12` |

문법이 다른 입력으로 같은 음악을 표현하고, 결과를 `{ pitch, start, duration, velocity }`의 공통 이벤트로 바꿔 직접 작성한 예상값과 비교했습니다. 음표 위치와 길이는 quarter beat 단위입니다. 음높이 변환은 이 실험의 명시적인 어댑터이며, 두 라이브러리가 가락이음의 C3 표기를 원래 지원한다는 뜻은 아닙니다.

브라우저 검사는 esbuild의 `platform: browser` 번들을 **Worker와 비슷한 전역 환경의 `node:vm` 컨텍스트**에서 실행했습니다. AudioContext·AudioWorkletNode 생성, 타이머 예약, fetch 호출을 세어 불필요한 실행을 확인했습니다. 실제 브라우저 화면·오디오 재생 검증은 아니며, `node:vm`을 신뢰할 수 없는 AI 코드의 보안 샌드박스로 제안하는 것도 아닙니다. 입력은 이 저장소의 신뢰된 고정 fixture뿐입니다.

## 공통 음악 fixture 결과

25개 fixture 중 Scribbletune은 **16개**, Strudel은 **25개**가 위의 정확도 기준을 만족했습니다. 이 개수는 임의의 곡 생성 정확도나 음악성 점수가 아닙니다. 같은 제약을 여러 길이에서 반복 확인하는 항목도 포함합니다.

| 사례 | 개수 | Scribbletune | Strudel |
|---|---:|---|---|
| 4분·8분음표, 쉼, 연장, 코드, 중첩 이진 분할 | 6 | 일치 | 일치 |
| 8·16·32마디의 4분음표 패턴 | 3 | 일치 | 일치 |
| 유한 구간, 마디를 넘는 장음, 장음 중간에서 시작하는 구간 | 3 | 공통 어댑터 정책으로 일치 | fragment 처리 후 일치 |
| MIDI 세기 0·1·64·127 | 4 | 일치 | 일치 |
| 셋잇단·중첩 셋잇단 | 2 | 정수 양자화 차이, 중첩 사례의 전체 길이 감소 | 일치 |
| 8·16·32마디의 일반·중첩 셋잇단 패턴 | 6 | 일반 사례의 양자화 차이, 중첩 사례의 누적 길이 감소 | 일치 |
| 네이티브 한 마디 표기 | 1 | `1m`이 실제 16 beat로 생성됨. 기대값은 4 beat | 1 cycle을 4 beat로 매핑해 일치 |

원시 입력·각 실패의 예상/실제 이벤트는 [results.json](../scripts/composition-poc/results.json)에 있습니다. [fixtures.mjs](../scripts/composition-poc/fixtures.mjs)는 음악의 예상값을 명시하고, [run.mjs](../scripts/composition-poc/run.mjs)는 정규화와 비교를 실행합니다.

### Scribbletune의 시간 제약

`subdiv: '4n'`, `pattern: '[xxx]xxx'`의 첫 박을 나누면 실제 반환 길이는 **43, 43, 42**입니다. 128로 나눈 길이는 각각 `43/128`, `43/128`, `42/128`로, 정확한 `1/3`과 다릅니다. 이 일반 셋잇단 사례의 최대 시작/길이 차이는 약 **0.005208333 beat**였습니다. 120 BPM으로 환산하면 약 2.60ms이며, 들리는 정도나 음악성은 이 실험에서 평가하지 않았습니다.

일반 셋잇단의 8·16·32마디에서는 같은 양자화 차이가 있었지만 마디 길이는 정확했습니다. 반면 **중첩 셋잇단 `x[x[xxx]]xx`는 한 마디가 4가 아닌 3.984375 beat**로 생성됐습니다. 이는 단순히 각 음의 분수가 반올림되는 것과 구분해야 합니다. 이 위험을 확인하기 위해 중첩 사례의 8·16·32마디 반복을 추가했습니다.

| 중첩 패턴 반복 | 기대 길이 | 실제 길이 | 부족한 길이 |
|---|---:|---:|---:|
| 1마디 | 4 | 3.984375 | 0.015625 beat |
| 8마디 | 32 | 31.875 | 0.125 beat |
| 16마디 | 64 | 63.75 | 0.25 beat |
| 32마디 | 128 | 127.5 | 0.5 beat |

따라서 기본 양자화를 허용하더라도 **이 중첩 경로는 보정하거나 지원 대상에서 제외해야 합니다.** 전체 라이브러리의 모든 리듬에서 드리프트가 난다는 주장은 하지 않습니다. 실패 입력과 실제 길이를 고정해 재현할 수 있게 남깁니다.

`subdiv: '1m'`, `pattern: 'x'`는 실제 길이 **2048**을 반환했습니다. 같은 라이브러리에서 `4n=128`이므로 이 경로의 결과는 16 quarter beats입니다. 공식 문서는 `1m`을 한 마디로 설명합니다. 4/4에서 이를 그대로 사용하는 것은 부적합합니다. 첫 프로파일은 가락이음이 마디 길이를 계산해 `1n` 또는 명시적인 beat 길이로 정규화할 수 있으나, 이 보정을 라이브러리의 원래 동작과 구분해야 합니다.

### Strudel의 장음·유한 구간 처리

`queryArc`는 마디를 넘는 하나의 장음을 cycle 경계에서 여러 fragment로 반환할 수 있습니다. 각 fragment의 `whole`을 모두 별도 MIDI 음표로 변환하면 같은 음이 중복됩니다. 이 실험은 다음 정책을 적용했습니다.

1. 실제 onset이 있는 fragment를 받습니다.
2. 질의 구간이 장음 중간에서 시작하면, 질의 왼쪽 경계의 첫 carry-in fragment도 받습니다.
3. 음 전체 구간을 요청 범위 `[startBeat, endBeat)`와 교차해 자릅니다.
4. 뒤 cycle에 이어지는 동일 장음 fragment를 다시 발음할 음표로 만들지 않습니다.

이 정책으로 2마디 장음과 그 중간의 유한 구간이 예상값과 일치했습니다. 단순한 pitch/time 해시로 중복 제거하는 방식은 같은 음높이를 겹쳐 연주하는 별도 음표까지 합칠 수 있어 사용하지 않았습니다. 이 결과는 유한 클립 생성 규칙이며, 실시간 엔진의 legato·서스테인 상태 전체를 검증한 것은 아닙니다.

## 랜덤과 seed

| 확인 | Scribbletune | Strudel |
|---|---|---|
| 동일 seed의 반복 결과 | core `clip`의 native seed는 이 프로파일에서 지원되지 않음 | `.seed(42)` + `useRNG('precise')`로 일치 |
| seed 변경 | 같은 `seed` 입력만으로 Math.random 의존성을 제거하지 못함 | 42 → 43에서 결과 변경 |
| 긴 구간 중 일부만 재생성 | 별도 seed/변주 어댑터 필요 | 32마디 전체의 9~16마디와 해당 구간 직접 질의 결과 일치 |

Scribbletune에는 같은 `seed: 42`를 전달하면서 격리된 실험 VM의 `Math.random`을 각각 0.1과 0.9로 제어했습니다. `R` 패턴과 `randomNotes`의 결과가 MIDI `[60,60,60,60]`과 `[67,67,67,67]`로 달라졌습니다. 이 변경은 **실험용 증명 방법**이고 앱에서 전역 Math.random을 교체하자는 설계가 아닙니다. 초기 제품에서는 `R`/shuffle을 제한하거나, 명시적인 PRNG를 가진 후처리·변주 계층을 사용해야 합니다.

Strudel은 precise RNG 모드를 명시하고 32마디의 256개 이벤트를 비교했습니다. 같은 seed의 전체 결과, 다른 seed의 변화, 부분 질의 재현성이 통과했습니다. compiler 버전·RNG 모드·seed·절대적인 패턴 시간 기준을 함께 저장해야 이 성질을 유지할 수 있습니다.

## 브라우저 번들과 불필요한 엔진

아래 크기는 이 실험의 작은 진입점을 esbuild로 minify한 IIFE의 바이트 수입니다. 앱 전체의 최종 증가량이나 gzip 크기가 아닙니다.

| 경로 | 번들 결과 | 실행·관찰 |
|---|---|---|
| Scribbletune 기본 `clip` import | 실패: `Could not resolve "fs"` | 브라우저 대상 기본 설정으로는 해석되지 않음 |
| 같은 경로에서 fs를 external로만 지정 | 17,707B, 외부 fs require가 남음 | 브라우저용 독립 번들이 아니므로 실행 성공으로 처리하지 않음 |
| `scribbletune/browser` | 19,196B | 번들은 실행되지만 `clip()` 호출이 `Tone is not defined`로 실패. 별도 Tone 런타임 경로임 |
| Scribbletune 순수 clip만 export하고 미사용 fs import의 side effect를 제거 | **17,285B**, 외부 import 없음 | fixture 실행 성공, AudioContext·타이머·fetch 호출 0 |
| Strudel core + mini | **138,736B**, 외부 import 없음 | fixture 실행 성공, AudioContext·타이머·fetch 호출 0 |

Scribbletune의 core 진입점은 MIDI 파일 출력 코드도 import합니다. 실험의 esbuild resolve 설정은 `fs`를 external로 표시하면서 `sideEffects: false`로 선언하고, 사용하지 않는 MIDI 출력 경로가 제거되는지 확인합니다. **fs를 흉내 내는 가짜 구현은 추가하지 않았습니다.** 최종 번들에 외부 import가 없다는 검사를 통과한 경우만 Worker와 비슷한 컨텍스트에서 실행합니다. 이 설정의 사용 범위는 순수 clip export이며, 파일 입출력까지 지원한다는 뜻이 아닙니다.

Strudel core 번들에는 **Kabelsalat 코드 34,158B**가 포함됐습니다. “core만 사용하므로 오디오 관련 코드가 전혀 없다”고 설명하면 틀립니다. 반면 이번 패턴 질의 경로에서 두 번째 오디오 엔진이 실제로 생성되지는 않았습니다. 포함된 코드와 실행된 엔진을 구분해야 합니다. 향후 패키지 분리나 로딩 지연을 검토할 수 있으나, 이번 실험에서는 라이브러리 소스를 수정하지 않았습니다.

추가로 Node에서 `@strudel/mini`를 직접 ESM import하는 경로는 `@kabelsalat/web`의 `SalatRepl` named export 오류로 실패했습니다. 브라우저용 bundler 경로는 통과했습니다. MCP 서버에서 컴파일할 경우에도 검증한 번들 경로 또는 별도 Node 패키징 검증이 필요합니다. 이 차이를 Strudel 패턴 계산 자체의 실패로 취급하지는 않습니다.

## 실험 당시 채택 전에 남은 결정

1. **라이선스:** 실험에 사용한 Strudel 패키지는 AGPL-3.0-or-later입니다. 공식 통합 안내와 실제 배포 구조를 확인해 정책을 정한 뒤 앱에 통합합니다. 이번 변경은 MIT 앱에 Strudel 코드를 포함하거나 앱 라이선스를 바꾸지 않습니다.
2. **언어 프로파일:** 처음에는 유한한 음표·코드·리듬·seed 변주를 지원합니다. 선택한 언어의 임의 파일·네트워크 접근, 자체 오디오 엔진, 모든 효과 API까지 자동으로 허용하지 않습니다.
3. **악기·편곡 어댑터:** 생성 이벤트를 기존 악기 ID·트랙·리전에 넣고, Undo 한 번·부분 교체·프로젝트 저장과 연결해야 합니다. 이 실험은 그 앱 통합을 수행하지 않았습니다.
4. **코드와 수동 편집:** 생성 후 피아노롤에서 수정한 리전을 덮어쓰는 정책, 원본 코드·seed·compiler 버전·생성된 ID의 보존이 필요합니다. 임의의 MIDI 수정을 원래 코드로 완전히 역변환하는 기능은 약속하지 않습니다.
5. **실제 브라우저와 음악성:** Vite 앱 통합, 실제 Worker, 재생·내보내기의 타이밍, 동일 모델의 프롬프트별 생성·수정 성공률, 사람의 청음 평가는 남아 있습니다. 25개 데이터 fixture 통과를 이 검증들의 대체 결과로 사용하지 않습니다.

**다음 기술 선택 제안:** 공통 명령 계층을 먼저 연결하고, 작곡 프런트엔드는 Strudel의 유한 패턴 컴파일을 우선 검토합니다. 라이선스 정책상 MIT 의존성만 허용하기로 한다면, Scribbletune의 제한된 프로파일과 정확한 시간·seed 어댑터의 유지 비용을 검토합니다. 단순한 패키징 문제 때문에 새 범용 언어를 만들거나, 두 재생 엔진을 동시에 올리는 방향으로 범위를 늘리지 않습니다.

## 재현

저장소 루트에서 다음을 실행합니다. Node 24.22.1과 pnpm 11.25.0에서 확인했습니다.

```bash
bash scripts/composition-poc/run-isolated.sh
```

스크립트는 새 임시 디렉터리를 만들고 fixture manifest·잠금 파일·테스트 코드를 복사한 뒤 그 안에 의존성을 설치합니다. 앱의 의존성 설치를 요구하지 않습니다. 첫 실행에는 npm registry 접근이 필요할 수 있습니다. 실행 후 전체 `results.json` 경로가 표시됩니다. 원본 저장소의 결과 snapshot을 자동으로 덮어쓰지 않습니다.

종료 코드 0은 **알려진 통과·실패 관찰을 재현했다는 뜻**입니다. Scribbletune이 25개 채택 기준을 모두 통과했다는 뜻이 아닙니다. 패키지 버전이 고정돼 있고 예상 실패 집합까지 검사하므로, 결과가 바뀌면 원인을 검토해야 합니다.

## 공식 근거

- [Scribbletune clip 문법과 음가](https://scribbletune.com/documentation/core/clip)
- [Scribbletune 공식 저장소](https://github.com/scribbletune/scribbletune) · [MIT 고지](https://github.com/scribbletune/scribbletune/blob/master/LICENSE.txt)
- [Scribbletune core clip](https://github.com/scribbletune/scribbletune/blob/master/src/clip.ts) · [browser 진입점](https://github.com/scribbletune/scribbletune/blob/master/src/browser-index.ts) · [MIDI 출력 경로](https://github.com/scribbletune/scribbletune/blob/master/src/midi.ts)
- [Strudel 패턴과 queryArc](https://strudel.cc/technical-manual/patterns/) · [Mini-notation](https://strudel.cc/learn/mini-notation/)
- [Strudel 패키지 구분](https://strudel.cc/technical-manual/packages/) · [공식 통합·라이선스 안내](https://strudel.cc/technical-manual/project-start/)

실제 판정은 문서 설명만이 아니라 고정한 npm 패키지를 실행한 결과를 사용합니다. 위 소스 링크의 현재 브랜치 내용과 향후 버전이 실험 snapshot과 같다고 가정하지 않습니다.
