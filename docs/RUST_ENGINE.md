# Rust 렌더 엔진 (4단계)

> **상태 (2026-11-16, 첫 마일스톤):** `rust/garak-engine`이 오디오 트랙(PCM 클립·게인·페이드·크로스페이드), 트랙 볼륨/팬/뮤트/솔로, 내장 이펙트 체인(garak-dsp), 센드/리턴, 마스터, 볼륨/팬/뮤트/센드/인서트 파라미터 오토메이션, 템포 맵을 C++ `RenderEngine`과 같은 의미로 렌더합니다. 같은 엔진이 **네이티브(C++ 호스트, `garak-ffi`)와 브라우저(WASM, `garak-engine-wasm`)에서 처음부터 똑같이** 돕니다. 패리티: C++ 엔진 대비 **비트 동일**(MinGW·MSVC, 오프라인 내보내기 4종 + 재생 중 diff, C++·Rust 이펙트 모두. macOS arm64는 Rust 이펙트 기준 비트 동일, C++ 이펙트 기준 ≤ -138 dBFS), WASM 대비 네이티브 Rust **-144.5 dBFS**. 웹 앱은 **플래그(`garak.rustEngine`, 기본 꺼짐)로 이 엔진을 AudioWorklet에서 씁니다**([5장](#5-wasm-호스트-audioworklet--5단계-웹-호스트)); 기본 동작 변화 없음. 악기·VST3·입력 모니터링·녹음은 다음 마일스톤입니다([9장](#9-이번-마일스톤의-범위와-다음-단계)).

관련 문서: [RUST.md](RUST.md)(1~3단계, DSP 커널), [RENDER_DIFF_PROTOCOL.md](RENDER_DIFF_PROTOCOL.md)(엔진 입력 계약), [SENDS_RETURNS.md](SENDS_RETURNS.md), [AUTOMATION.md](AUTOMATION.md), [TEMPO_MAP.md](TEMPO_MAP.md), [REGION_GAIN_FADES.md](REGION_GAIN_FADES.md).

## 1. 왜, 어디까지

1~3단계로 **이펙트 커널**은 한 벌(Rust)이 됐지만, 그 커널을 엮는 **그래프**는 아직 두 벌입니다. 웹은 TS Web Audio 그래프(`src/audio/graph.ts`, `WebAudioEngine.ts`), 데스크톱은 C++ `RenderEngine`(`native/src/engine.cpp`)이 타임라인 → 트랙 소스 → 인서트 → 센드/리턴 → 마스터를 따로 구현합니다. 4~6단계 계획:

| 단계 | 내용 | 끝나는 조건 |
|---|---|---|
| **4** | Rust 렌더 엔진: 타임라인 → 트랙별 악기/클립 → 이펙트 → 센드/리턴 → 마스터, 오토메이션, 템포 맵. C++ 엔진과 패리티 | C++ 엔진 회귀 테스트(`engine_test.cpp`) 전부를 Rust 엔진으로 옮겨 통과, 패리티 ≤ -90 dBFS, CPU 동등 이상 |
| 5 | 웹이 WASM으로 같은 엔진을 사용 (AudioWorklet) | 웹 기본값 전환 |
| 6 | TS 그래프와 C++ 렌더 삭제 | 두 엔진 코드 제거 |

장치·플러그인 I/O(miniaudio, ASIO, CoreAudio, VST3 호스팅)는 C++에 남습니다. Rust 엔진은 "프로젝트를 소리로 만드는 부분"만 맡습니다.

## 2. 구조

```
rust/garak-engine/            #![no_std] + alloc (이유: 3장). 의존성: garak-dsp, libm
  src/plan.rs                 데이터 모델: Plan / TrackPlan / AudioWindow / AutomationLane … (C++ ProjectTimeline 필드 그대로)
  src/json.rs                 의존성 없는 JSON 리더(정확히 반올림되는 core f64 파서, 마지막 중복 키 우선 = nlohmann)
  src/protocol.rs             protocol.hpp의 줄 단위 포팅: project.set 타임라인, project.patch 병합, 바이너리 음표/컨트롤러 레코드
  src/engine.rs               Controller(제어 스레드) / Renderer(오디오 스레드), 그래프 준비(prepare), diff 분류(update), 명령 적용(consume), 블록 렌더
  src/track.rs                TrackRuntime: 윈도 → (리턴 입력) → 인서트(32프레임 오토메이션 청크) → PDC → 페이더/팬/뮤트 → 출력 지연, 탭
  src/clip.rs                 오디오 윈도: 게인, 페이드 5종, 4 ms 클릭 가드, 선형 보간 리샘플, 4/6채널 다운믹스
  src/insert.rs               garak-dsp Fx + 소유 저장 공간, 리버브 커널 캐시(공유 Arc), 라이브 파라미터 판정
  src/automation.rs tempo.rs  automationShape/evaluate/value, TempoMap (C++과 같은 식)
  src/master.rs delay.rs      dsp::Master(마스터 컴프/세이프티), CompensationDelay
  src/queue.rs                고정 용량 SPSC 큐(명령 1024칸, 반환 2056칸)
  src/offline.rs              host.cpp renderStopped와 같은 오프라인 내보내기
  src/testkit.rs              패리티용 결정적 테스트 프로젝트(JSON + PCM)
  tests/engine.rs             오프라인 렌더, diff == 새 그래프, 트랙 교체, 전송, 거부, patch 병합
  tests/realtime.rs           카운팅 전역 할당기: Renderer::render가 힙을 전혀 건드리지 않음
rust/garak-ffi/src/engine.rs  C ABI(garak_rs_engine_*, garak_rs_testkit_*) + include/garak_engine.h
rust/garak-ffi/src/heap.rs    staticlib 전역 할당기 = CRT malloc (Rust 런타임 라이브러리 불필요 유지)
rust/garak-engine-wasm/       워크릿용 cdylib: 원시 extern "C" (wasm-bindgen 없음), 모듈 인스턴스당 엔진 1개
src/audio/rust/garakEngineWasm.ts  워크릿·워커·Node 공용 로더
src/audio/rust/RustWebAudioEngine.ts, engine.worklet.ts, engineHost.ts, engineChannel.ts, engineOffline.ts
                              웹 호스트 (5장, 플래그 `garak.rustEngine`)
src/audio/rust/engine.test.ts      WASM 렌더 ↔ 네이티브 Rust 렌더
src/audio/rust/engineAB.test.ts    웹 경로 A/B (Project → 컴파일러 → WASM ↔ Web Audio 의미), CPU 보고
scripts/rust-engine-smoke.mjs      Chromium: 재생·내보내기·대체·A/B·CPU (pnpm rust:engine-smoke)
native/tests/rust_engine_parity_test.cpp  C++ RenderEngine ↔ Rust 엔진 (GARAK_RUST=ON)
native/tests/rust_engine_bench.cpp        16/32트랙 CPU 비교
```

## 3. 데이터 모델과 실시간 규칙

### 3.1 입력: 렌더-diff 프로토콜 그대로

엔진의 입력은 [RENDER_DIFF_PROTOCOL.md](RENDER_DIFF_PROTOCOL.md)의 계약을 바꾸지 않습니다. 렌더러(TS)의 `NativeTimelineCompiler`가 만든 `timeline` JSON과 바이너리 프레임이 C++ 호스트에 가듯 Rust 엔진에도 갑니다.

| 메시지 | Rust API | C ABI | WASM |
|---|---|---|---|
| `project.set` (전체 계획 + 바이너리) | `Controller::set_json(text, blob)` / `update(Plan)` | `garak_rs_engine_set` | `garak_engine_set` |
| `project.patch` (헤더 + 순서 + 바뀐 트랙) | `Controller::patch_json` (호스트의 `patchTimeline` 병합과 같은 규칙) | `garak_rs_engine_patch` | `garak_engine_patch` |
| `asset.put` (PCM, 프로토콜 밖) | `Controller::put_asset(id, PcmAsset)` | `garak_rs_engine_put_asset` | `garak_engine_put_asset` |
| 전송(play/pause/stop/seek) | `play`/`pause`/`stop`/`seek` | `garak_rs_engine_transport` | `garak_engine_transport` |
| 응답의 `applied` | `Applied::{None, Diff, Tracks, Full}` | 0/1/2/3 | 같음 |

- 파서(`protocol.rs`)는 `protocol.hpp`와 같은 필드·범위·기본값·거부 조건을 씁니다. 바이너리 레코드(음표 24 B, 컨트롤러 12 B, 리틀 엔디언, 4바이트 정렬)도 같습니다. 패리티 테스트에서 C++은 호스트의 `protocol.hpp`로, Rust는 자기 파서로 **같은 JSON 텍스트**를 읽어 결과가 비트 단위로 같으므로 두 파서가 함께 검증됩니다.
- diff 분류(`Controller::update`)는 `RenderEngine::update`의 표(프로토콜 4장)를 그대로 따릅니다: 타이밍 헤더·트랙 순서·라우트·센드 구조 → 새 그래프(트랙은 id로 상태 승계), 이벤트·체인·소스·비라이브 파라미터·재등록된 PCM → 그 트랙만 재준비(Replace, 상태 이전), 라이브 인서트 파라미터 → Param, 페이더/팬/뮤트/솔로 플래그 → Mix, 센드 레벨 → Send, 마스터 게인 → Master, 나머지 → Revision. PDC 지연이 바뀌는 재준비는 새 그래프로 넘어갑니다. 라이브 파라미터 예외(리버브 `size`/`type`/`predelay`, 딜레이 `mode`)도 같습니다.
- 상태 이전(`Track::adopt`)은 C++ `TrackRuntime::adopt`와 같습니다: 페이더·팬·뮤트 스무딩, id와 종류가 같은 인서트끼리 이펙트 상태(꼬리·딜레이 버퍼·필터 기록; garak-dsp `take_state_from`, O(1) 저장 공간 교환), PDC·출력 지연선, 센드 피드 게인, 마스터 엔벨로프.

### 3.2 두 반쪽과 큐

```
제어 스레드 (할당 자유)                          오디오 스레드 (할당·해제·잠금·패닉 없음)
Controller ── Command(SPSC 1024) ──────────────▶ Renderer::render(out)
  parse / prepare(Graph) / build(Track)            블록 시작에서 명령 전부 적용(consume)
  ◀── Retired(SPSC 2056): 교체된 Graph·Track ──    교체된 객체는 반환 큐로만 내보냄
  collect(): 여기서 drop
```

- 그래프 교체·트랙 교체는 `Box` 포인터 교환입니다. 트랙은 `Vec<Box<Track>>`에 있어 교체 때 구조체가 이동하지 않습니다.
- 반환 큐가 가득 차면(제어 스레드가 `collect()`를 안 부름) 오디오 스레드는 해제하지 않고 누수시키며 `Snapshot::leaked`로 셉니다. 명령 큐가 가득 차면 `update()`가 오류를 내고 recipe를 버려 다음 업데이트가 새 그래프가 됩니다(C++과 같음).
- 오디오 스레드가 만지는 모든 버퍼(트랙 버퍼, 탭, 리턴 입력, 지연선, 이펙트 저장 공간)는 제어 스레드가 `max_block` 기준으로 미리 잡습니다.
- **강제 방법:** `tests/realtime.rs`가 전역 할당기를 바꿔 `Renderer::render` 호출 중의 할당·해제·재할당을 셉니다. 그래프 교체, 트랙 교체, Mix/Send/Param/Master diff, seek, stop을 적용하는 호출을 포함해 0이어야 통과합니다. 워크스페이스 린트(패닉·인덱싱 금지)도 그대로 적용됩니다.

### 3.3 왜 `no_std + alloc`인가

- 프로젝트는 크기가 정해지지 않은 데이터(트랙 256개, 음표 10만, 윈도 8192, PCM 수백 MB, 오토메이션 점 10만)입니다. 이것을 담는 그래프는 제어 스레드에서 만들어야 하고, 그래서 `alloc`이 필요합니다. `garak-dsp`는 계속 `alloc` 없이 남습니다(커널은 호출자 저장 공간을 빌림).
- `std`가 아니라 `no_std + alloc`인 이유: `garak-ffi` staticlib이 Rust 표준 런타임(스레드, I/O, `ws2_32`/`userenv` 등)을 끌고 오지 않아 MinGW·MSVC·Apple 링크가 지금처럼 단순합니다. 전역 할당기는 `garak-ffi`가 C 런타임 `malloc`으로 제공합니다(`heap.rs`, 16바이트 초과 정렬은 앞에 원래 포인터를 두는 방식). 링크에 필요한 것은 CRT 수학 함수, `abort`, `malloc` 계열뿐이고 모두 C++ 호스트가 이미 링크합니다. 미리 빌드된 `alloc` 크레이트의 언와인드 테이블이 참조하는 `rust_eh_personality`는 빈 함수로 둡니다(모든 프로필이 `panic = "abort"`라 호출되지 않음).
- 오디오 스레드의 무할당은 타입이 아니라 테스트(3.2)와 구조(사전 할당, 반환 큐)로 지킵니다. 할당이 필요한 API는 `Controller`에만 있어서 오디오 쪽 `Renderer`에서는 호출할 수 없습니다.

## 4. C++ 호스트가 엔진을 쓰는 방법 (FFI)

C++은 장치 콜백과 VST3 처리를 계속 갖고, 나머지를 Rust 엔진에 맡깁니다.

```
garak-audio-host (C++)
  JSON 줄 + 바이너리 프레임 ─▶ project.set / patch ─▶ garak_rs_engine_set / _patch   (제어 스레드)
  asset.put ──────────────────────────────────────▶ garak_rs_engine_put_asset
  장치 콜백 (miniaudio/ASIO/CoreAudio) ────────────▶ garak_rs_engine_render(out, frames)   (오디오 스레드)
  주기적으로 ──────────────────────────────────────▶ garak_rs_engine_collect / _snapshot
```

- 스레드 규칙: `garak_rs_engine_render`만 오디오 반쪽이고, 나머지 `garak_rs_engine_*`는 제어 반쪽(한 번에 한 제어 스레드)입니다. 두 반쪽은 서로 다른 스레드에서 동시에 돌 수 있습니다(핸들 안의 `Controller`와 `Renderer`가 원자적 큐로만 통신). 오류는 예외가 아니라 -1 반환 + `garak_rs_engine_last_error`.
- **VST3 트랙의 끼워 넣기 (다음 마일스톤 설계):** VST3 인스턴스는 C++ 소유로 둡니다. 엔진은 트랙 처리 순서 안에 **외부 처리 지점(hook)**을 둡니다.
  - 플랜의 `"type":"vst3"` 인서트와 `"kind":"vst3"` 소스는 엔진에서 `External { slot }` 노드가 됩니다. 준비 시 C++ resolver가 슬롯마다 지연(PDC)과 꼬리를 알려 주고(`latencyFrames`, `tailSeconds`), 엔진이 PDC·꼬리 계산에 넣습니다.
  - 렌더 중 엔진은 그 노드에서 호스트 콜백 `process_external(user, slot, stereo*, frames, events*, count, context*)`을 부릅니다. 이벤트(음표·컨트롤러·파라미터 오토메이션 점)는 엔진이 지금의 `PluginEvent` 규칙(같은 샘플 순서, 블록당 32점 격자)대로 만들어 넘깁니다. `ProcessContext`(템포 맵, 위치, 사이클)도 엔진이 채웁니다.
  - 그래서 C++ 쪽 VST3 코드(`vst3.cpp`의 프로세서, 에디터, 상태 저장)는 그대로이고, `RenderEngine`의 트랙 루프만 사라집니다. 콜백은 오디오 스레드에서 동기 호출이므로 추가 지연이 없습니다.
  - 멀티코어/렌더-어헤드(`setProcessing`)는 엔진 안의 트랙 병렬화로 옮깁니다(VST3 트랙은 C++처럼 콜백에 남김). 이번 마일스톤은 단일 스레드입니다.
- 입력 모니터링·녹음 탭(`TrackRoute`, `planRecording`)은 입력 버퍼를 `render`에 함께 넘기는 형태로 옮깁니다(파서는 이미 `input`/`route`를 읽고 diff 비교에 씁니다).

## 5. WASM 호스트 (AudioWorklet) — 5단계 웹 호스트

> **상태 (2026-11-17):** 웹 앱이 플래그로 이 엔진을 씁니다. **기본값은 꺼짐**입니다(`garak.rustEngine`). 켜면 엔진이 받아들이는 프로젝트(지금은 오디오 트랙·내장 이펙트·센드/리턴·오토메이션·템포 맵)는 재생과 내보내기 모두 Rust 엔진으로, 받아들이지 않는 프로젝트(악기 트랙, 얼린 트랙, 기타 랙, pre-master 렌더 등)는 지금의 Web Audio 엔진으로 돌고 콘솔에 이유를 남깁니다. 판정은 **엔진 자신의 거부 메시지**라서, 악기 포팅(G2)이 엔진에 들어오면 그 프로젝트들은 코드 변경 없이 저절로 Rust 엔진으로 넘어갑니다.

### 5.1 켜는 법

```js
localStorage.setItem('garak.rustEngine', '1')   // 새로 고침. '0'은 빌드 기본값을 끔
```

또는 `VITE_GARAK_RUST_ENGINE=1 pnpm dev` / `pnpm build`. `pnpm build`(`scripts/rust.mjs web-build`)는 두 모듈(`garak-dsp.wasm`, `garak-engine.wasm`)을 모두 빌드해 함께 배포합니다. 엔진 모듈은 플래그가 켜진 페이지만 내려받습니다.

### 5.2 구조

```
RustWebAudioEngine (src/audio/rust/RustWebAudioEngine.ts)  ← createAudioEngine(), 플래그가 켜졌을 때
  extends WebAudioEngine: 장치 설정, 디코딩, 샘플, 녹음, 미리 듣기, 라이브 MIDI는 그대로
  setProject/setAssets ─▶ NativeTimelineCompiler + planNativeSync (데스크톱과 같은 렌더러 쪽 계획)
                         └▶ RustEngineNode.update(project.set | project.patch) ─┐
  play/pause/stop/seek ─▶ RustEngineNode.transport ──────────────────────────┤
  renderAudio ─▶ renderInEngineWorker (Worker, garak-engine.wasm 새 인스턴스) │
                                                                             ▼
engine.worklet.ts (AudioWorkletProcessor 'garak-engine', 노드 1개 = 엔진 1개, 출력 스테레오)
  port.onmessage: asset / set / patch / remove-asset / transport  (렌더 퀀텀 사이에서 실행)
  process(): 링의 전송 명령 → garak_engine_render_planar → 출력 채널 복사 → 상태 게시
```

| 파일 | 역할 |
|---|---|
| `rust/garak-engine-wasm/src/lib.rs` | ABI 2: 기존 내보내기 + `alloc_f32`/`put_asset_owned`(PCM 사본 없이 넘김), `remove_asset`, `render_planar`/`planar_ptr`, `playing`, `master_peak` (새 함수만 추가) |
| `src/audio/rust/garakEngineWasm.ts` | 로더(워크릿·워커·Node 공용). TextEncoder 없는 워크릿 대비 UTF-8 직접 처리, 출력 뷰 캐시(메모리가 커졌을 때만 다시 만듦), 엔진 거부는 `GarakEngineError` |
| `src/audio/rust/engine.worklet.ts` | 워크릿 프로세서. 렌더 퀀텀이 엔진 블록보다 크면(`renderSizeHint`) 나눠 렌더, `collect()`는 편집 8퀀텀 뒤 |
| `src/audio/rust/engineChannel.ts` | 명령/상태 채널: SharedArrayBuffer 링(SPSC 64칸)과 seqlock 상태 블록, 메시지 형식 |
| `src/audio/rust/engineHost.ts` | 모듈 로드(인스턴스 없이 ABI 확인), `RustEngineNode` 브리지, 내보내기 워커 실행 |
| `src/audio/rust/engineOffline.ts`, `engineRender.worker.ts` | 오프라인 렌더(offline.rs / host.cpp `renderStopped`와 같은 루프: 길이 + 꼬리 ≤ 30 s, PDC 앞쪽 제거, `startFrame`, `tailSeconds`) |
| `src/audio/rust/flag.ts` | `rustEngineRequested()` |
| `src/audio/WebAudioEngine.ts` | 하위 클래스 훅만 추가: `prepareContext`, `graphEnabled`, `refreshGraph`, `readIdleMeters`, 몇몇 필드 `protected` |

### 5.3 규칙

- **입력은 데스크톱과 같습니다.** `NativeTimelineCompiler`가 만든 timeline과 바이너리 프레임, `planNativeSync`의 `project.set`/`project.patch`를 그대로 보냅니다. 편집은 16 ms로 묶어 patch 한 번(페이더 드래그 = `Diff`)이 됩니다. 거부된 patch 뒤에는 다음 동기화가 `project.set`입니다.
- **PCM 전달:** 메인 스레드는 `AudioBuffer`를 한 번 인터리브해 그 사본을 **transfer**합니다(메인 스레드에 남는 사본 없음). 워크릿은 `alloc_f32` 버퍼에 한 번 복사하고 `put_asset_owned`가 그 버퍼를 그대로 소유합니다(이전 로더는 모듈 안에서 한 번 더 `to_vec()`). 같은 `AudioBuffer`는 다시 보내지 않고(WeakRef), 더 이상 참조되지 않는 PCM은 `remove_asset`.
- **채널:** 페이지가 cross-origin isolated면 전송 명령은 SharedArrayBuffer 링으로 다음 퀀텀에 바로 적용되고, 상태(프레임, 재생 여부, 마스터 피크, 렌더 시간 통계, 적용된 순번)는 매 퀀텀 seqlock 블록에 씁니다. 아니면 같은 명령을 postMessage로 보내고 상태는 약 37 ms마다 게시합니다. 링 명령은 "앞 메시지의 순번"을 갖고 있어 그 메시지(예: `project.set`)가 적용될 때까지 기다립니다.
- **전송:** 재생은 `seek(frame)` + `play`. 비트 위치는 엔진이 게시한 프레임을 템포 맵으로 바꾼 값입니다(명령이 적용되기 전에는 시작 비트). 사이클은 엔진이 돌고, 사이클이 없으면 엔진이 프로젝트 끝에서 멈추고 꼬리는 울립니다. 메트로놈 클릭은 기존 `WebMetronome`을 같은 오디오 클럭에 예약합니다. 카운트인은 아직 Web Audio로 재생합니다(엔진에 예약 시작이 없음).
- **Web Audio 그래프:** 엔진이 재생하는 동안에는 Web Audio 그래프(와 이펙트 워크릿들)를 두지 않고, 멈추면 다시 만듭니다(미리 듣기, 입력 모니터링, 대체 재생용). 입력/트랙 라우트 모니터링과 라우트 녹음은 그 그래프가 필요하므로 켜져 있는 동안 프로젝트를 Web Audio에 둡니다. 재생 중에 편집으로 엔진이 거부하게 되면 들리던 비트부터 Web Audio로 이어서 재생합니다.
- **내보내기/바운스/프리즈/스템:** `renderAudio`는 Worker에서 엔진을 오프라인으로 렌더합니다(UI 스레드 무부담). 엔진이 거부하거나 `preMaster`(엔진에 마스터 바이패스가 아직 없음)면 Web Audio 렌더로 대체합니다.
- **미터:** 엔진은 마스터 피크만 게시합니다. 트랙 미터는 엔진의 트랙 탭(호스트 쪽 작업)이 들어오면 `garak_engine_*` 내보내기를 하나 더해 연결합니다. 그 전까지 Rust 엔진 재생 중 트랙 미터는 0입니다.

### 5.4 A/B와 CPU (이 PC, Chrome, Windows x64)

**Node A/B** (`src/audio/rust/engineAB.test.ts`, `pnpm test`): Project → 타임라인 컴파일러 → `garak-engine.wasm`을, Web Audio 엔진의 믹스 의미를 그대로 옮긴 TS 기준(템포 맵 위 클립 위치, `clipEnvelope` 페이드, 리전 게인, StereoPannerNode 팬 법칙, 페이더, 뮤트/솔로)과 비교:

| 프로젝트 | 결과 |
|---|---|
| 클립·리전 게인/오프셋·볼륨·팬(모노/스테레오)·뮤트 | **-150.5 dBFS** |
| 페이드 5종·솔로 | **-156.5 dBFS** |
| 이펙트 체인 + 리턴 2개, 볼륨/팬 오토메이션 + 템포 램프 | 유한·가청, 지연 8프레임(드라이브 PDC) |
| patch(볼륨/팬) ↔ 같은 편집의 `project.set` | 스무딩 뒤 < 1e-6, 분류 `diff` |
| 악기 트랙 | 엔진 거부(`GarakEngineError`) → 대체. 악기가 들어오면 이 테스트는 "렌더됨"을 확인하도록 이미 양쪽을 받습니다 |

**브라우저 A/B** (`pnpm rust:engine-smoke`, Web Audio 엔진의 내보내기 ↔ Rust 엔진 내보내기). Web Audio의 마스터는 `DynamicsCompressorNode`(6 ms 선행 지연 = 48 kHz에서 288프레임, 자동 메이크업 게인)이고 엔진의 마스터는 데스크톱의 인과적 프로세서라서 둘은 원래 다릅니다(플래그를 켜면 웹 출력이 6 ms 빨라지고 데스크톱과 같은 마스터가 됩니다). 그래서 Web Audio 쪽은 pre-master로 렌더해 그래프만 비교합니다(이 프로젝트들은 엔진 마스터의 무릎 아래):

| 프로젝트 | 최대 차이 | 오차 에너지 | 레벨 차 |
|---|---|---|---|
| 드라이 믹스 | **-150.5 dBFS** | -145.6 dB | 0.000 dB |
| 페이드 | -79.1 dBFS | -74.3 dB | 0.001 dB |
| 오토메이션 + 템포 램프 | -41.6 dBFS | -35.5 dB | 0.006 dB (Web Audio는 오토메이션을 `setTargetAtTime`으로 근사) |
| 이펙트 체인 + 리턴 | -17.9 dBFS | -9.9 dB | 0.000 dB (커널은 같은 Rust 코드, 그래프가 다름: PDC 보정, 블록 단위 변조 위상) |

**CPU**: 16/32트랙 + 리턴 2개(트랙마다 위상기/코러스, 2배 오버샘플 드라이브, 3트랙마다 딜레이; 리턴에 리버브·딜레이 — 네이티브 벤치와 같은 모양).

| 측정 | 16트랙 | 32트랙 |
|---|---|---|
| 워크릿 `process()` 평균, 128프레임 퀀텀(예산 2667 µs) | 0.8~0.9 ms (실시간 3.0~3.4×) | 1.3~1.7 ms (1.6~2.1×) |
| Node, 같은 엔진 오프라인 128프레임 블록 | 586 µs (4.6×) | 1484 µs (1.8×) |
| 오프라인 내보내기 13.7 s: Web Audio 엔진 ↔ Rust 엔진(Worker) | 4.3 s ↔ 3.1 s | 11.8 s ↔ 9.3 s |
| 참고: 네이티브 Rust 엔진(7.3) | 269 µs (9.9×) | 485 µs (5.5×) |

워크릿에는 `performance.now()`가 없어 `Date.now()`(1 ms 단위)로 재므로 평균만 의미가 있습니다. Chrome에 `AudioContext.renderCapacity`가 아직 없어 Web Audio 엔진의 실시간 부하는 같은 방식으로 잴 수 없습니다(스모크는 API가 생기면 두 엔진 모두 그 값을 보고). 이 PC는 측정 중 다른 빌드가 돌아 값의 폭이 큽니다. WASM은 네이티브보다 약 2.5~3배 느립니다: 32트랙은 한 코어의 절반 이상이라 G2 이후 기본값 전환 전에 워크릿 렌더 경로 최적화(SIMD, 수학 import 호출 수)가 필요합니다.

### 5.5 크기

`garak-engine.wasm`: **258 KiB raw / 105 KB gzip** (예산 272 KiB / 110 KB, `scripts/rust.mjs`가 강제, `pnpm build`·`checks.yml`·`rust.yml` 모두 이 경로). 측정:

| 시도 | raw | gzip | CPU |
|---|---|---|---|
| 기존(`wasm` 프로필, opt 3) | 282 KiB | 113 KB | 기준 |
| `wasm-engine` 프로필: opt "s", garak-dsp만 3 (채택) | 258 KiB | 105 KB | 같음 |
| 전부 "s" | 240 KiB | 98 KB | -20 % |
| 전부 "z" (garak-dsp 3) | 252 KiB | 102 KB | -20 % |
| `no_std` + dlmalloc 명시 | +3.7 KiB | | — |

LTO fat, `panic = "abort"`, strip, codegen-units 1은 이미 켜져 있습니다. 포맷팅 코드는 4~5 KB뿐이고 크기의 대부분은 엔진(파서·준비·diff, 약 130 KB 코드)과 garak-dsp 이펙트(약 64 KB)입니다. `garak-dsp.wasm`과 합치는 것은 이득이 없습니다: 엔진 모듈이 이미 모든 이펙트를 담고 있고, 플래그가 켜진 페이지에서 엔진이 받아들인 프로젝트는 재생 중 이펙트 워크릿을 만들지 않습니다. 6단계에서 Web Audio 그래프를 지우면 `garak-dsp.wasm`의 이펙트 부분이 통째로 빠집니다.

### 5.6 남은 일 (기본값 전환 전)

- 큰 `project.set`의 파싱·그래프 준비(리버브 커널 생성 포함)가 워크릿 스레드에서 돕니다(아직 따로 재지 않음). 수백 트랙/긴 오디오에서는 렌더 퀀텀을 놓칠 수 있어, 준비를 트랙 단위로 나누거나 Worker에서 준비하는 방식이 필요합니다.
- PCM이 메인 스레드(`AudioBuffer`, 파형·편집용)와 워크릿 모듈에 두 벌 있습니다.
- 트랙 미터, 다이내믹스 미터(엔진 탭), 마스터 바이패스(pre-master 스템/프리즈), 카운트인 예약 시작, 입력 모니터링·녹음(G3).
- 엔진 재생 중에는 Web Audio 그래프가 없어 미리 듣기·라이브 MIDI 노트가 소리 나지 않습니다(악기가 엔진에 들어올 때 엔진의 라이브 노트 API로 옮길 일).

## 6. 악기·보이스 계획 (인벤토리)

이번 마일스톤은 오디오 트랙만 렌더하고, 악기 소스가 켜진 트랙은 거부합니다(`Track::build`: "renders audio tracks only"). 옮길 악기:

| 소스 | C++ (데스크톱) | TS (웹) | Rust 계획 |
|---|---|---|---|
| 내장 신스 `keys`·`bass`·`pad`·`pluck`·`rhodes` | `engine.cpp` `Synth`/`Voice`/`oscillator`(polyBLEP·삼각 급수), ADSR, 톤 필터, 피치벤드·비브라토·CC7/11 스무딩 | `graph.ts`의 OscillatorNode/BiquadFilter 조합 | `garak-dsp`에 `voice` 모듈(no_std, 보이스 풀 128 사전 할당), 엔진에 음표 커서·컨트롤러 추적. 첫 단계는 C++ 보이스와 비트 패리티 |
| 내장 드럼 `drums` | `Synth::Kind::Drums`(스윕 사인, LCG 노이즈 + 필터) | `graph.ts` 버퍼 소스/노이즈 | 위와 같은 모듈 |
| 샘플 악기 / 킷 (`builtin-sampled`) | `SampleSet` 존 선택(`pickZone`), 루프, 릴리스 샘플, 초크, 댐퍼 노이즈 | `samples.ts` + AudioBufferSourceNode | 샘플 세트 등록 API(`sample.set` 대응), PCM은 `put_asset`과 같은 저장소 공유 |
| IEUM WAVE (`native-wavetable`) | `native/devices/wavetable-synth`(C++ 라이브러리, 테이블 크로스페이드) | 합성 없음(편집만) | 별도 포팅(규모 큼). 그 전까지는 VST3처럼 외부 hook으로 C++ 인스턴스 사용 가능 |
| VST3 악기 | `vst3.cpp` | 없음 | C++ 유지, 4장의 외부 hook |
| 기타 랙 인서트 (`guitar-rig`) | `dsp.cpp` | worklet | 2단계 포팅이 garak-dsp에 들어오면 인서트 목록에 추가(지금은 거부) |

음표 상태 이전 규칙(음표 id 재부여, 지운 음표 릴리스, 재생 위치에 걸친 음표 다음 반복부터)은 프로토콜 4.2에 있고, 악기 마일스톤에서 `renumberNotes`/`removedNotes`와 함께 옮깁니다.

## 7. 패리티 전략과 결과

### 7.1 하네스

| 테스트 | 비교 | 기준 |
|---|---|---|
| `native/tests/rust_engine_parity_test.cpp` (`ctest -R native-rust-engine-parity`) | C++ `RenderEngine` ↔ Rust 엔진, 같은 JSON·PCM(`testkit`을 C ABI로 받아 양쪽에 투입) | residual ≤ -90 dBFS, 지연·길이 동일 |
| `src/audio/rust/engine.test.ts` | WASM 엔진 ↔ 네이티브 Rust 엔진(`cargo test`가 `rust/target/engine-parity/`에 쓴 렌더) | ≤ -90 dBFS |
| `rust/garak-engine/tests/engine.rs` | diff 경로 ↔ 같은 편집을 새 그래프로(`Controller::rebuild`) | ≤ 1e-6 (프로토콜 8.5) |
| `rust/garak-engine/tests/realtime.rs` | 렌더 중 힙 사용 | 0회 |

테스트 프로젝트(`testkit.rs`): 오디오 트랙 N개 + 리턴 2개. 겹치는 윈도(크로스페이드)와 페이드 5종, 클립 오프셋·게인, 모노/스테레오/44.1 kHz PCM(48 kHz 엔진에서 리샘플), 기타 랙을 뺀 내장 이펙트 15종 전부(드라이브가 PDC 8프레임: 트랙 쪽 8 + 리턴 쪽 8로 센드/리턴 지연 보정까지 거침), 꺼진 인서트, 프리/포스트 센드, 볼륨·팬·뮤트·센드·인서트(컷오프 로그 범위, 컴프 임계값) 오토메이션, 템포 램프(싱크 딜레이·트레몰로), `audible:false` 트랙의 프리 센드 무음. PCM은 사칙연산만으로 만들어 플랫폼마다 같습니다.

C++ 쪽은 두 번 돌립니다: C++ 이펙트로(완전히 독립된 두 구현) 그리고 `GARAK_RUST_EFFECTS=all`처럼 Rust 이펙트로(엔진 구조만 비교). 오프라인 경우는 host.cpp `renderStopped`와 같은 루프(길이 + 꼬리 ≤ 30 s, PDC 앞쪽 제거)이고, 라이브 경우는 재생 중 0.5 s에 Mix+Send+Param+Master diff, 1.5 s에 트랙 재준비를 두 엔진에 같은 JSON으로 보냅니다(분류 결과 `Diff`/`Tracks`도 같아야 통과).

### 7.2 결과 (이 PC, MinGW-w64 GCC 16 Release, x86-64)

| 경우 | 트랙 | 블록 | 이펙트 | 지연 C++/Rust | residual |
|---|---|---|---|---|---|
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 128 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 44.1 kHz, 3 s | 6+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 1 s | 1+2 | 512 | C++ / Rust | 0 / 0 | **비트 동일** |
| 재생 중 diff(믹스·센드·파라미터·마스터) + 트랙 재준비 | 8+2 | 128 | C++ / Rust | — | **비트 동일** |
| WASM ↔ 네이티브 Rust, 오프라인 3 s | 8+2 | 4096 | — | 16 / 16 | **-144.5 dBFS** |

**CI (PR #50):** Windows MSVC x64는 위 표와 똑같이 전부 비트 동일입니다. macOS arm64(AppleClang)는 Rust 이펙트를 쓴 C++ 엔진과 비교하면 전부 비트 동일이고(엔진 구조·식이 FMA 축약까지 같다는 뜻), C++ 이펙트와 비교하면 -138.5 ~ -156.5 dBFS입니다. 이 차이는 1단계 커널 표에서 이미 macOS에서만 비트 동일이 아닌 커널 몇 개에서 옵니다.

엔진 자체의 식(페이더·팬 법칙·페이드·오토메이션 곡선·마스터)은 garak-dsp처럼 같은 연산 순서와 플랫폼 libm을 쓰고, AppleClang이 FMA로 합치는 `a*b + c` 자리에는 `math::mul_add`/`mul_add_f32`를 둬서 macOS arm64에서도 같은 반올림을 따르게 했습니다. CI 요약(`rust.yml`)에도 같은 표가 나옵니다.

### 7.3 CPU (단일 스레드, 128프레임 블록, 10 s × 최고 3회, `garak-rust-engine-bench`)

| 트랙(+리턴 2) | C++ 엔진 + C++ 이펙트 | C++ 엔진 + Rust 이펙트 | Rust 엔진 | 블록당 µs (C++ / Rust) |
|---|---|---|---|---|
| 16 | 4.7× 실시간 | 5.3× | **9.9×** (2.10배 빠름) | 565 / 269 |
| 32 | 2.7× | 3.0× | **5.5×** (2.02배 빠름) | 981 / 485 |

CI 러너(같은 벤치, 공유 머신이라 절대값은 들쭉날쭉):

| 플랫폼 | 트랙 | C++ 엔진 + C++ 이펙트 | C++ 엔진 + Rust 이펙트 | Rust 엔진 | 블록당 µs (C++ / Rust) |
|---|---|---|---|---|---|
| Windows MSVC x64 | 16 | 2.6× | 2.9× | **6.2×** (2.34배) | 1015 / 433 |
| Windows MSVC x64 | 32 | 1.5× | 1.6× | **3.6×** (2.44배) | 1818 / 745 |
| macOS arm64 | 16 | 4.4× | 4.3× | **7.9×** (1.80배) | 610 / 338 |
| macOS arm64 | 32 | 2.2× | 2.2× | **4.4×** (1.97배) | 1198 / 608 |

(트랙마다 이펙트 2~3개, 위상기·코러스·2배 오버샘플 드라이브·딜레이 포함, 리턴에 리버브·딜레이. 128프레임 블록 예산은 2.67 ms.) 이펙트만 Rust로 바꾼 C++ 엔진은 1.1배 정도이므로 차이의 대부분은 엔진 루프(윈도·페이더·센드 경로) 쪽입니다. 세 툴체인 모두 Rust 엔진이 1.8~2.4배 빠릅니다.

### 7.4 단계 게이트

| 게이트 | 조건 | 상태 |
|---|---|---|
| G1 (이번) | 오디오 트랙·이펙트·센드·오토메이션·템포 맵 오프라인/라이브 패리티 ≤ -90 dBFS, 렌더 무할당, WASM ↔ 네이티브 ≤ -90 dBFS, CI(MSVC·macOS) | 통과 (MinGW·MSVC·macOS) |
| G2 | 내장 신스·드럼·샘플 악기 + 컨트롤러, 음표 상태 이전 | 다음 |
| G3 | VST3·IEUM WAVE 외부 hook, 입력 모니터링·녹음 탭, 멀티코어 | |
| G4 | `engine_test.cpp`의 모든 항목을 Rust 엔진 하네스로 옮겨 통과, 장시간 재생 소크 테스트, CPU ≥ C++ (MSVC·macOS) | |
| G5 | 데스크톱 호스트에서 기능 플래그(`GARAK_RUST_ENGINE=1`)로 전환 가능, 이후 기본값 | |

## 8. 5단계(웹 전환) 중 지금 병렬로 할 수 있는 일

**지금 바로 (엔진 패리티를 기다리지 않음):**

- ~~워크릿 호스트 뼈대~~, ~~PCM 전달~~, ~~기능 플래그와 대체 동작~~, ~~오디오 트랙 프로젝트의 A/B~~, ~~WASM 크기 예산~~, ~~계측(`process()` 시간, 예산 초과 퀀텀, 위치·피크 게시)~~: [5장](#5-wasm-호스트-audioworklet--5단계-웹-호스트)에서 끝남.
- 남음: **워크릿 준비 비용 분리**(큰 `project.set` 파싱·그래프 준비를 트랙 단위 또는 Worker로), 워크릿 렌더 경로 CPU(5.4).

**패리티를 기다리는 일:**

- **웹 기본값 전환:** G2(내장 악기·샘플)까지 끝나야 합니다(웹 프로젝트 대부분이 악기 트랙). 데스크톱 기본값 전환은 G4~G5.
- **TS 그래프(`graph.ts`, `WebAudioEngine` 렌더 부분)와 C++ `RenderEngine` 트랙 루프 삭제(6단계):** 양쪽 기본값 전환 후 한 릴리스 이상 지나서.
- 웹 녹음·입력 모니터링을 엔진 경유로 바꾸는 일(G3의 입력 탭 이후).

## 9. 이번 마일스톤의 범위와 다음 단계

**포함:** 오디오 클립(PCM, 게인, 페이드 5종, 크로스페이드, 클릭 가드, 리샘플, 다운믹스), 트랙 볼륨/팬(모노 등전력·스테레오 밸런스)/뮤트/솔로(`audible`/`unmutedAudible`), 내장 이펙트 15종 체인과 PDC, 프리/포스트 센드와 리턴(리턴 지연 보정 포함), 마스터 게인·마스터 프로세서, 볼륨·팬·뮤트·센드·인서트 파라미터 오토메이션(샘플 단위 / 32프레임 청크), 템포 맵(싱크 이펙트), 사이클·정지·탐색, project.set/patch 파싱과 diff 분류·상태 이전, 오프라인 렌더 API, C ABI, WASM 빌드.

**아직 아님:** 얼린 트랙·바운스·스템(`AudioWindow.freeze`, `TrackTimeline.preFader`/`directOut` — 파서가 거부, 옮길 항목은 [BOUNCE_FREEZE_STEMS.md](BOUNCE_FREEZE_STEMS.md#rust-렌더-엔진stage-4이-지원해야-할-것)), 박자 맵(`meterMap` — 메트로놈 전용이라 파싱 없이 무시, 메트로놈을 옮길 때 `native/include/garak/meter.hpp`와 같은 마디 계산 필요; [METER_MAP.md](METER_MAP.md)), 악기 소스(거부), VST3 인서트/소스(거부; 4장 설계), 기타 랙(거부), 입력 모니터링·녹음·트랙 라우트 탭(파싱만), 메트로놈·카운트인, 라이브 MIDI·미리 듣기, 멀티코어·렌더-어헤드, 다이내믹스 미터·트랙 피크 게시(마스터 피크만), 음표 id 재부여.

**다음 마일스톤 제안:**

1. **G2 악기:** garak-dsp `voice` 모듈(내장 신스 5종 + 드럼 + 샘플 존), 엔진의 음표/컨트롤러 커서, `renumberNotes`·상태 이전, `engine_test.cpp`의 악기 항목을 Rust 하네스로 이전.
2. ~~**웹 워크릿 호스트(병렬):**~~ 5장(플래그, 기본 꺼짐). 남은 일은 5.6.
3. **G3 외부 hook:** VST3·IEUM WAVE를 C++ 인스턴스로 끼우는 콜백, 입력 탭·녹음, 그리고 엔진 내부 트랙 병렬화.
4. **G4~G5:** 회귀 테스트 전부 이전, 데스크톱 `GARAK_RUST_ENGINE` 플래그, 소크 테스트, 기본값 전환.
