# 제자리 바운스 · 트랙 얼리기 · 스템 내보내기

세 기능 모두 **WAV 내보내기와 같은 오프라인 렌더 경로**를 씁니다. `src/core/renderPlan.ts`가 파생 프로젝트(렌더 계획)를 만들고, 각 엔진의 `renderAudio(project, options)`가 그것을 내보내기와 같은 그래프로 렌더합니다. 그래서 결과는 일반 내보내기와 샘플 단위로 정렬됩니다.

| 렌더 옵션 (`RenderOptions`) | 의미 | Web Audio | 네이티브 (`render.wav`) |
| --- | --- | --- | --- |
| `bitDepth` 16 / 24 / 32 | 32 = IEEE float(클리핑 없음) | `encodeWav` | 호스트가 직접 기록 |
| `preMaster` | 마스터 볼륨·마스터 프로세서 생략 | `createGraph(..., { preMaster })` | `RenderEngine::setMasterBypass` |
| `tailSeconds` | 렌더 꼬리 길이를 고정(0–30초) | `renderTailSeconds` 대신 사용 | 그래프 꼬리 대신 사용 |
| `startFrame` | PDC 보정 뒤 앞부분을 잘라냄 | 렌더 결과를 자름 | 쓰기 전에 건너뜀 |

트랙 단위 렌더 탭(`Track.render`, 저장되지 않음 — 파생 프로젝트에만 존재)은 두 엔진에 같은 뜻으로 전달됩니다.

- `preFader`: 인서트(시김새·VST3)와 PDC 보정을 거친 신호를 팬·페이더·뮤트 없이 출력합니다. **모노 소스는 오른쪽 채널을 비웁니다**(Web Audio는 discrete 업믹스, 네이티브는 `stereoSource||stereoEffects`가 아닐 때 R=0). 렌더 결과의 오른쪽이 완전히 무음이면 모노 에셋으로 저장해, 재생 시 팬이 원래와 같은 모노 법칙을 따릅니다.
- `directOut: false`: 트랙 자신의 출력은 마스터 합에서 빠지고 센드는 그대로 리턴을 먹입니다(리턴 스템).
- `frozen`: 얼린 트랙의 캐시를 재생합니다(아래).

## 트랙 얼리기 (Freeze)

- 렌더: `freezeRenderProject` — 그 트랙만, `preFader`, 센드·믹싱 오토메이션 없이, 프로젝트 전체 + 트랙 자신의 꼬리. `bitDepth: 32`, `preMaster`.
- 저장(스키마 19 — 18은 박자 맵): `Track.freeze = { assetId, signature, tailSeconds, sampleRate }`. 에셋은 `freeze-` 접두사의 일반 프로젝트 에셋(float WAV, 모노 소스는 모노)이라 기존 저장 경로를 그대로 탑니다 — 웹은 IndexedDB, 데스크톱은 앱 데이터 폴더(Electron IndexedDB, 디스크)이며 `.garak` 묶음에도 들어갑니다.
- 재생: `playbackProject(project, assets)`가 서명이 맞고 캐시가 있는 트랙을 `kind: 'audio'`, 리전·시김새·플러그인 없이 `render.frozen`만 가진 트랙으로 바꿉니다. 볼륨·팬·뮤트·솔로·센드와 그 오토메이션은 그대로 살아 있습니다. 두 엔진은 `setProject`/타임라인 컴파일과 오프라인 렌더에서 이 변환을 적용합니다. 얼린 트랙의 VST3는 로드되지 않습니다.
- 서명: 정규화(검증 왕복)한 트랙 내용(리전, 악기·파라미터, 시김새·VST3 상태, 장치/악기 오토메이션, 트랜스포즈 등)과 프로젝트 타이밍(샘플레이트, 템포 맵, 길이, 박자표)의 해시. 타이밍이 바뀌면 **만료(stale)** — 잠긴 채로 원래 소리로 재생하며 "다시 얼리기"를 제안합니다.
- 잠금: `ProjectSession`이 얼린 트랙의 내용을 바꾸는 편집을 거부하고 알립니다(MCP는 `TRACK_FROZEN`). 믹싱·이름·삭제·얼림/해제는 허용됩니다.
- 해제: 기록을 지우고 캐시 에셋을 즉시 제거합니다. 실행 취소로 되돌리면 캐시가 없으므로 만료 상태가 됩니다. 현재·실행 취소·다시 실행 어디에서도 쓰지 않는 `freeze-` 에셋은 자동으로 정리됩니다.
- 꼬리: 얼린 창은 프로젝트 끝 뒤로 이어지고(오프라인 렌더는 꼬리 구간에서도 읽음), 창의 `tailSeconds`(렌더의 `trackTailSeconds`)가 트랙 꼬리를 대신하므로 내보내기 길이와 리턴 꼬리가 얼리기 전과 같습니다.

## 제자리 바운스

트랙 전체(뮤트되지 않은 리전 전체) 또는 한 트랙의 선택 리전을 `preFader`로 렌더해(`planBounce`) 새 오디오 트랙의 리전으로 놓습니다(`applyBounce`). 옵션: 시김새 포함(끄면 원음을 굽고 체인을 새 트랙에 복사), 꼬리 길이, 노멀라이즈(기본 끔, 리전 게인으로 피크 −0.3 dBFS). 새 트랙은 볼륨·팬·센드와 볼륨/팬/센드 오토메이션을 이어받고, 원본 트랙(또는 바운스한 리전)은 뮤트된 채 남습니다. 리전은 프로젝트 끝을 넘지 않습니다.

## 스템 내보내기 (파일 → 스템 내보내기…)

`planStems`: 믹스에서 들리는 트랙마다(센드 제외, 혼자) 한 파일, 들리는 리턴마다(들리는 모든 송신 트랙을 `directOut: false`로, 다른 리턴 없이) 한 파일. 뮤트·솔로 제외·꺼진 트랙은 건너뜁니다(솔로는 전체 프로젝트에서 한 번 판정). 모든 스템은 믹스의 렌더 꼬리(`renderTail`, 네이티브 `render.tail`)와 같은 시작 프레임을 공유하므로 길이가 같습니다. **마스터 처리 전**을 고르면 스템의 합이 마스터 처리 전 믹스와 같습니다(`native/tests/engine_test.cpp` `stemsSumToMix`). 샘플레이트·비트 깊이·파일 이름 패턴(`{n} {track} {project} {type}`)을 고를 수 있습니다. 데스크톱은 고른 폴더 안에 새 하위 폴더를 만들어 파일을 쓰고(`garak:choose-export-folder` / `garak:write-export-file`, 경로는 렌더러로 넘어오지 않음), 브라우저는 ZIP(`src/core/zip.ts`, 무압축) 하나를 내려받습니다.

## 검증

- `native/tests/engine_test.cpp`: `freezeMatchesLive`(모노·스테레오·지연 VST3, 마스터 전/후 — 얼린 트랙의 렌더가 원래와 2e-5 안에서 같고 내보내기 길이도 같음), `stemsSumToMix`.
- `src/core/freeze.test.ts`, `src/core/renderPlan.test.ts`: 서명·무효화·잠금·재생 변환·계획·이름·ZIP/WAV.

## Rust 렌더 엔진(stage 4)이 지원해야 할 것

이전 C++ `RenderEngine`과 같은 의미로 (1~3 모두 `rust/garak-engine`에 구현, 0.3.2 C++ 경로의 골든 레퍼런스와 비트 동일 — [RUST_ENGINE.md 10장](RUST_ENGINE.md#10-데스크톱-호스트-경로-셸--rust-그래프)):

1. `AudioWindow.freeze`/`tailSeconds`: 클릭 가드 없음, `endFrame > lengthFrames` 허용(꼬리 31초까지), 오프라인 렌더에서 프로젝트 끝 뒤에도 재생, 트랙 꼬리 = `max(기존, tailSeconds)`.
2. `TrackTimeline.preFader`: 팬·페이더·뮤트 생략, 비스테레오 소스는 R=0. `TrackTimeline.directOut=false`: 마스터 합에서 제외(센드는 유지).
3. 오프라인 마스터 바이패스(`setMasterBypass`), `PreparedProject::trackTailSeconds()`(리턴 제외 트랙 자신의 꼬리 최댓값, 바닥값·+0.15 없이).
4. `render.wav`의 `bitDepth`·`preMaster`·`tailSeconds`·`startFrame`과 응답의 `tailSeconds`·`trackTailSeconds`, 그리고 `render.tail`.
