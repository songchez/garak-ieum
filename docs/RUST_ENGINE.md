# Rust 렌더 엔진 (4단계)

> **상태 (2026-11-16, 첫 마일스톤):** `rust/garak-engine`이 오디오 트랙(PCM 클립·게인·페이드·크로스페이드), 트랙 볼륨/팬/뮤트/솔로, 내장 이펙트 체인(garak-dsp), 센드/리턴, 마스터, 볼륨/팬/뮤트/센드/인서트 파라미터 오토메이션, 템포 맵을 C++ `RenderEngine`과 같은 의미로 렌더합니다. 같은 엔진이 **네이티브(C++ 호스트, `garak-ffi`)와 브라우저(WASM, `garak-engine-wasm`)에서 처음부터 똑같이** 돕니다. 패리티: C++ 엔진 대비 **비트 동일**(MinGW·MSVC, 오프라인 내보내기 4종 + 재생 중 diff, C++·Rust 이펙트 모두. macOS arm64는 Rust 이펙트 기준 비트 동일, C++ 이펙트 기준 ≤ -138 dBFS), WASM 대비 네이티브 Rust **-144.5 dBFS**. 웹 앱은 **플래그(`garak.rustEngine`, 기본 꺼짐)로 이 엔진을 AudioWorklet에서 씁니다**([5장](#5-wasm-호스트-audioworklet--5단계-웹-호스트)); 기본 동작 변화 없음. 데스크톱은 `GARAK_RUST_ENGINE=1`로 켤 수 있습니다([10장](#10-데스크톱-호스트-경로-garak_rust_engine-g5-첫-단계)). 악기·VST3·입력 모니터링·녹음은 다음 마일스톤입니다([9장](#9-이번-마일스톤의-범위와-다음-단계)).

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
- **전송:** 재생은 `seek(frame)` + `play`(카운트인이 있으면 `countIn(frames)`). 비트 위치는 엔진이 게시한 프레임을 템포 맵으로 바꾼 값입니다(명령이 적용되기 전에는 시작 비트). 사이클은 엔진이 돌고, 사이클이 없으면 엔진이 프로젝트 끝에서 멈추고 꼬리는 울립니다. 메트로놈과 카운트인은 엔진이 마스터 뒤에 섞습니다([5.7](#57-웹-호스트-2차-엔진-안에서-끝나는-일)).
- **Web Audio 그래프:** 엔진이 들리는 동안(재생 중이거나, 멈춰 있어도 트랙을 모니터링 중) Web Audio 그래프(와 이펙트 워크릿들)를 두지 않고, 그 밖에는 다시 만듭니다(멈춘 프로젝트의 미리 듣기, 대체 재생용). 재생 중에 편집으로 엔진이 거부하게 되면 들리던 비트부터 Web Audio로 이어서 재생합니다.
- **내보내기/바운스/프리즈/스템:** `renderAudio`는 Worker에서 엔진을 오프라인으로 렌더합니다(UI 스레드 무부담). pre-master(스템·프리즈)도 엔진의 마스터 바이패스로 렌더합니다. 엔진이 거부하는 프로젝트만 Web Audio 렌더로 대체합니다.
- **미터:** 마스터 피크는 상태 블록, 트랙 피크와 다이내믹스 미터는 미터 블록([5.7](#57-웹-호스트-2차-엔진-안에서-끝나는-일))으로 게시합니다.

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

- PCM이 메인 스레드(`AudioBuffer`)와 워크릿 모듈에 두 벌 있습니다. 앱 전체가 `AudioAsset.buffer`를 동기적으로 읽습니다(파형 상세 그리기, 리전 길이, 정규화, 피치/워프 편집, 녹음 채널 고르기 등 20여 곳). 엔진 쪽 경로에는 남는 사본이 없습니다([5.7](#57-웹-호스트-2차-엔진-안에서-끝나는-일)). 메인 스레드 사본을 없애려면 `AudioAsset`을 "메타데이터 + 파형 피라미드 + 필요할 때 blob 디코드"로 바꾸는 앱 단위 작업이 필요합니다.
- 악기(G2, `rust/engine-instruments`): 들어오면 `Track::live_event`가 라이브 노트를 받고, 미리 듣기·라이브 MIDI가 같은 경로로 엔진에서 소리 납니다(웹 쪽 배선은 끝남).
- PCM 업로드(`asset`)는 아직 한 번에 복사합니다(긴 오디오는 업로드 퀀텀에서 수 ms).

### 5.7 웹 호스트 2차: 엔진 안에서 끝나는 일

엔진이 프로젝트를 받아들이면 아래는 모두 **Web Audio 그래프로 넘기지 않고** 엔진에서 처리합니다(`rust/engine-web-w2`). 엔진 쪽은 `engine.cpp`의 같은 코드를 옮긴 것이고(`rust/garak-engine/tests/web.rs`), 웹 쪽은 `src/audio/rust/webHost.test.ts`(Node, WASM 경로)와 `pnpm rust:engine-smoke`의 5번(브라우저, 실제 워크릿)이 지킵니다. `garak-engine-wasm` ABI 3.

| 일 | 엔진 (`garak-engine`) | 웹 호스트 |
|---|---|---|
| 트랙·다이내믹스 미터 | `Renderer::track_peaks`, `take_dynamics`(데스크톱 셸과 같은 탭) | 워크릿이 트랙별 최고 피크를 모아 미터 블록(SAB seqlock, 없으면 상태 메시지)에 ~21 ms마다 씀. 메인은 그래프 리비전별 트랙 순서로 `getTrackLevel`·`getDeviceMeter`(인서트 id)에 연결 |
| 마스터 바이패스 | `set_master_bypass`: 오프라인에서 마스터 게인·프로세서 생략(C++ `setMasterBypass`) | `renderAudio({ preMaster })`가 Worker 렌더에 `masterBypass`. 스템·프리즈도 엔진 |
| 카운트인 | `play_count_in(frames)`: 예약 시작. 카운트인 동안 전송 프레임 고정, 끝난 다음 프레임에 시작. 클릭은 시작 지점의 템포·박자(박자 맵)로 | `play({ countInBars })` → `countIn`. 박자 맵 강박·국악 소리는 `metronomeStrokes`(데스크톱과 같은 PCM)로 한 번 전달. `play()`는 다운비트에서 끝남(녹음 시작 시점) |
| 메트로놈 | `set_metronome` + `renderClicks` 포팅(마스터 뒤, 오프라인은 안 침) | 엔진 재생 중 클릭은 엔진이 침(`WebMetronome` 예약 없음) |
| 라이브 노트·미리 듣기 | `Controller::live(track, LiveEvent)` → `Track::live_event`(오디오 트랙은 무시·집계) | 링 명령(`RING_LIVE`, 다음 퀀텀). 엔진이 렌더하는 악기 트랙이면 노트 온/오프·CC가 엔진으로, 라이브러리 미리 듣기(트랙 없음)는 엔진이 들리는 동안 미리 듣기 전용 작은 그래프로(프로젝트 그래프 아님) |
| 입력 모니터링 | `render_io(out, input, channels)` + `set_monitoring`: 트랙 입력 채널, 저지연 모니터는 PDC 생략, 스테레오 입력은 밸런스 팬 | MediaStream → 워크릿 입력 0. 엔진이 소유하면 Web Audio 모니터는 끔(둘 다 켜지지 않음). 캡처는 그대로 MediaRecorder |
| 트랙 입력 라우트 | `prepareRoutes` 포팅: 레벨 순서, 루프 끊기, 마스터 피드·리샘플 트랙, pre/post-FX·post-fader 탭 | 라우트 모니터링은 같은 모니터 마스크 |
| 라우트 녹음 | 블록마다 탭 트랙의 라우트 입력을 `tap_output`에(최대 8) | 워크릿 출력 1(16채널) → 분배기 → `RouteRecordings`. 테이크 위치는 상태의 (전송 프레임, 컨텍스트 프레임) |
| 큰 `project.set` | `stage_json` → `step`(트랙 하나) → `commit`; 결과는 `set`과 비트 동일 | 워크릿이 렌더 뒤 남는 시간(퀀텀의 35 %)에 트랙을 지음. 그동안 뒤 메시지·전송 명령은 순서대로 기다림 |
| 리버브 커널 | `reverb_kernel_for`(도우미) / `import_reverb_kernel`(다음 업데이트까지 보존) | `KernelHelper` Worker가 새 리버브 파라미터의 커널을 만들고 워크릿은 가져오기만 |

**CPU (워크릿 렌더 경로):** 프로파일(32트랙, 128프레임)에서 2배 오버샘플 드라이브가 53 %(FIR 20 %, libm `tanh`/`expm1` 21 %), 위상기가 17 %였습니다. `garak-dsp/src/simd.rs`의 두 레인(`f64x2`, 채널당 같은 연산 순서·비융합이라 스칼라와 비트 동일), 드라이브의 이중 길이 히스토리·두 합 병렬·버리는 출력 합 생략, 위상기 올패스 6단 두 레인, WASM 전용 Cephes `tanh`(가져온 `exp`, 상대 오차 2.5e-16 이하; 네이티브는 C 라이브러리 그대로), 팬 법칙 sin/cos 재사용(같은 입력 → 같은 값). `project.set` 첫 적용 59 ms 중 51 ms가 리버브 IR 생성이었고, 이제 Worker에서 만듭니다.

측정(`pnpm rust:engine-smoke`, Chrome, 128프레임 퀀텀, 예산 2667 µs, 이 PC는 다른 빌드가 함께 도는 중). "정상 재생"은 프로젝트 적재·단계 빌드·편집 메시지가 없는 재생 퀀텀만, isolated 페이지는 µs 시계(`engineBenchmark.preciseClock`):

| 32트랙 + 리턴 2 | 이전 | 지금 |
|---|---|---|
| 워크릿 퀀텀 평균 | 1.3~1.7 ms, 초과 41~96회/3 s | 정상 재생 0.82~0.96 ms(예산의 31~36 %), 최대 2.2 ms, **초과 0** |
| Node, 같은 루프(`realtimeBench.test.ts`) | 1627 µs, p99 3285 µs | 700~1030 µs(기계 부하에 따라) |
| 16트랙 정상 재생 | 0.8~0.9 ms | 0.48~0.54 ms, 최대 1.6 ms, 초과 0 |

크기: 259 → 289 KiB raw / 105 → 118 KB gzip(예산 304 KiB / 124 KB로 올림, `scripts/rust.mjs`에 이유).

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
| G5 | 데스크톱 호스트에서 기능 플래그(`GARAK_RUST_ENGINE=1`)로 전환 가능, 이후 기본값 | 플래그 동작(10장), 기본값 전환은 G2·G3 뒤 |

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

## 10. 데스크톱 호스트 경로 (`GARAK_RUST_ENGINE`, G5 첫 단계)

> **상태 (2026-11-17):** 기본값은 **꺼짐**입니다. 켜면 Rust 엔진이 받아들이는 그래프(오디오 트랙·내장 이펙트·센드/리턴·오토메이션·템포 맵·스템/프리즈 탭)는 장치 콜백과 `render.wav`(스템·프리즈·바운스 옵션 포함) 모두 트랙을 Rust 그래프에서 렌더합니다. 거부하는 그래프(악기·VST3·기타 리그·트랙 입력 라우트·얼린 윈도)는 C++ 트랙으로 렌더합니다.

### 10.1 켜는 법

| 값 | 동작 |
|---|---|
| (없음), `0` | C++ `RenderEngine` 그대로 (기본값) |
| `GARAK_RUST_ENGINE=1` | Rust가 받아들이는 그래프는 Rust로, 거부하면 그 그래프만 C++로 (`EngineSnapshot::rustRefusals`, `RenderEngine::lastRustRefusal()`, 호스트 `engine.snapshot`의 `rustRefusal`) |
| `GARAK_RUST_ENGINE=strict` | 거부하면 `update`/`submit`이 예외 (회귀 테스트용) |

환경 변수는 `RenderEngine` 생성 시 읽고, `RenderEngine::setRustEngine(mode)`로 첫 제출 전에 바꿀 수 있습니다. Electron이 띄우는 `garak-audio-host`는 환경을 물려받습니다. 호스트 `hello`는 `rustEngine: { available, requested }`를, `engine.snapshot`은 `rustEngine`(마지막 블록이 Rust로 렌더됐는지)·`rustRefusals`를, `render.wav` 응답은 `rustEngine`을 돌려줍니다.

### 10.2 구조: C++ `RenderEngine`이 셸, Rust 그래프가 트랙 렌더

```
RenderEngine (C++) ─ 전송(재생/정지/탐색·사이클·카운트인), 메트로놈, 라이브 MIDI, 입력 모니터링·녹음 캡처,
 │                   마스터 버스(게인·마스터 프로세서·masterBypass), 스냅숏·미터 게시, 워커 풀
 ├ prepare()  C++ 그래프는 항상 준비(폴백·tail/latency 값) + Rust에 넘길 PCM 수집
 ├ submit()/update()  같은 계획을 timeline JSON(rust_engine.inc, 왕복 정확한 숫자)으로 garak_rs_engine_set
 │                    → C++ 명령 뒤에 RustSync{허용 티켓, 켜짐} 명령
 └ render()  블록마다: 활성 그래프가 Rust면 garak_rs_engine_render_block(out, frames, position, playing, 허용 티켓)
                       → 트랙 합(마스터 전) → C++ 마스터 → 녹음·클릭
```

- **티켓 게이트:** Rust 명령 큐는 셸이 넘긴 티켓까지만 적용됩니다(`Consumer::peek`). 그래서 Rust 그래프 교체·diff가 C++ 쪽 같은 업데이트의 명령과 **같은 블록**에 적용됩니다.
- **전송은 셸 소유:** Rust는 셸이 정한 위치·재생 여부로 블록을 렌더하고, 셸의 `reset(chase, effects)`(재생·일시정지·탐색·사이클 순환)이 `garak_rs_engine_reset`으로 그대로 전달됩니다. 카운트인·메트로놈·사이클 분할은 C++ 그대로라 Rust 쪽 동작이 비트 단위로 같습니다.
- **미터:** 트랙 피크(`trackPeaks`)와 컴프·리미터·게이트 다이내믹스 미터(`garak_rs_engine_take_dynamics`)를 Rust 그래프에서 받아 같은 홀드 규칙으로 게시합니다.
- **폴백:** 거부된 업데이트는 C++ 트랙으로 넘어갑니다. 엔진을 바꾸는 순간 넘겨받는 쪽 상태를 리셋하므로(유휴였던 C++ 트랙은 꼬리가 없음) 재생 중 전환은 꼬리가 끊길 수 있습니다. 모니터링 중인 트랙이 있으면 입력을 C++ 트랙 경로로 들어야 하므로 그동안 C++로 렌더합니다.
- **멀티코어:** 셸의 워커 풀(`setProcessing(threads)`)이 있으면 Rust 그래프의 센더 트랙을 풀에서 병렬로 렌더하고(`GarakRsParallelRun` 콜백, 트랙마다 한 워커), 리턴은 콜백 스레드에서 이어서, 합은 트랙 순서대로 합니다. 출력은 1스레드와 **비트 동일**하고, 풀은 원자 변수로만 동기화합니다(할당·잠금 없음). Rust 그래프가 렌더 중일 때 render-ahead는 쓰지 않습니다.
- **스템·프리즈·바운스 탭:** `preFader`(보정된 인서트 후 신호, 팬·페이더·뮤트 없음, 모노는 모노 유지)와 `directOut=false`(마스터 합에서 빠지고 센드는 유지)를 Rust 엔진이 직접 렌더합니다. `masterBypass`는 셸의 마스터 버스가 처리합니다.

### 10.3 테스트와 CI

| 테스트 | 내용 | 결과 (MinGW GCC 16, 이 PC) |
|---|---|---|
| `native/tests/rust_engine_host_test.cpp` (`ctest -R native-rust-engine-host`) | C++ 엔진 ↔ Rust 셸: 오프라인 내보내기 3종, 마스터 바이패스, 프리페이더 트랙, 리턴 스템, 재생 중 diff·트랙 재준비·탐색·사이클·일시정지·마스터 게인, 멀티코어 0 ↔ N 워커(라이브·오프라인 24트랙), 폴백/strict | 전부 **비트 동일** (폴백 후 탐색 비교만 -141 dBFS) |
| 같은 테스트의 메트로놈 경우 | `garak_rs_metronome_render` ↔ `metronome.hpp`(RenderEngine::renderClicks와 같은 구동): 4/4, 6/8+템포 램프, 박자 맵+템포 맵, 곡 중간 12/8-5/4-9/16, 매핑된 위치의 카운트인, 3/4 카운트인 | 전부 **비트 동일** |
| `rust/garak-engine/tests/host.rs` | `render_block`: 엔진 자체 전송과 같은 진행, 티켓 게이트, 병렬 센더 비트 동일, 힙 사용 0 | 통과 |
| `scripts/rust-engine-suite.mjs` (rust.yml) | `engine_test.cpp` 전체를 `GARAK_RUST_ENGINE=1`(전부 통과해야 함)과 `strict`(목록에 있는 차단 요인만 실패 허용, `native/tests/rust_engine_expected_failures.txt`)로 실행, 케이스별 Rust 렌더 블록 수를 잡 요약에 | 1: **43/43**, strict: 7개가 Rust 그래프로 통과, 9개는 그래프 렌더 없이 통과, 27개 예상 실패 |
| desktop.yml / macos.yml | 네이티브 스모크(`--test-clock`)를 `GARAK_RUST_ENGINE=1`로 한 번 더. 오디오 전용 `render.wav`가 Rust로 렌더됐는지 확인 | 로컬 21/21 통과 |

strict 예상 실패의 차단 요인: 내장·샘플 악기(20개, instruments 브랜치), VST3 호스트 훅(6개), 트랙 입력 라우트·녹음 탭(1개). 프리즈/스템 케이스는 악기도 필요합니다.

CPU (128프레임 블록, 10 s, 테스트 프로젝트, `garak-rust-engine-host-test --bench`, 이 PC 8워커):

| 트랙(+리턴 2) | C++ 엔진 | Rust 셸 1스레드 | Rust 셸 8워커 | 워커 / 1스레드 |
|---|---|---|---|---|
| 16 | 2.2× 실시간 | 4.8× | 12.1× | **2.50×** |
| 32 | 1.6× | 3.7× | 8.9× | **2.38×** |

### 10.4 아직 C++에 남은 것 (다음 단계)

| 항목 | 지금 | 계획 |
|---|---|---|
| 내장 신스·드럼·샘플 악기, 라이브 MIDI·미리 듣기 | C++ 폴백 | instruments 브랜치(`rust/engine-instruments`)가 들어오면 `rustIneligibility`의 해당 줄을 지우고 라이브 MIDI를 셸에서 Rust 음표 명령으로 전달 |
| VST3 악기·인서트, IEUM WAVE | C++ 폴백 | 4장 설계대로 `External{slot}` 노드 + 호스트 콜백(`process_external`, 지연·꼬리는 준비 시 resolver가 보고, 블록마다 템포·박자 맵 위치 전달) |
| 기타 리그 | C++ 폴백 | garak-dsp 포팅(패리티 ≤ -90 dBFS, CPU ≤ 1.15× C++) 후 인서트 목록에 추가 |
| 입력 모니터링·트랙 라우트·녹음 탭(프리FX/포스트FX/포스트페이더, 마스터 리샘플) | 모니터링 중·라우트가 있으면 C++ | `render_block`에 입력 버퍼와 모니터 마스크를 넘기고 트랙 탭을 셸에 노출 |
| 메트로놈·카운트인 | 데스크톱은 C++ 셸이 섞음(동작 동일). `garak-engine/src/metronome.rs`에 `metronome.hpp`·`meter.hpp` 포팅 완료(격자, 복합 박자 묶음, 박자 맵 재시작·강박, 템포 맵, 카운트인, 6보이스 스트로크 플레이어 + 호스트가 주는 클릭 PCM — 국악 소리 포함). 호스트 테스트 6가지 경우 **비트 동일** | 워크릿/통합 엔진의 `Renderer`에서 마스터 뒤에 섞기 |
| 얼린 윈도(꼬리 포함) | C++ 폴백 | 클릭 가드 없음·프로젝트 끝 이후 읽기·`tailSeconds`를 clip/track에 추가 |
| render-ahead | Rust 그래프 동안 꺼짐 | 필요하면 Rust 트랙 링으로 |
