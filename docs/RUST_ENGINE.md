# Rust 렌더 엔진 (4단계)

> **0.3.3:** 데스크톱과 웹 모두 이 엔진이 **유일한 렌더 경로**입니다(웹의 Web Audio 대체 경로는 웹 문서 참고). 데스크톱의 C++ 트랙 경로·C++ 이펙트 DSP·스위치(`GARAK_RUST_ENGINE`, `GARAK_RUST_EFFECTS`, `GARAK_RUST=OFF` 빌드)를 지웠고, 마스터 버스와 메트로놈도 엔진 안으로 옮겼습니다. C++ `RenderEngine`은 셸입니다([10장](#10-데스크톱-호스트-경로-셸--rust-그래프)). C++ 경로와의 패리티는 그 출력을 한 번 기록한 골든 레퍼런스로 검사합니다([7장](#7-패리티-전략과-결과)). 아래 상태 문단과 7.2·7.3의 C++ 비교 수치는 0.3.2까지의 기록입니다.

> **상태 (2026-11-17, 첫 마일스톤):** `rust/garak-engine`이 오디오 트랙(PCM 클립·게인·페이드·크로스페이드), 트랙 볼륨/팬/뮤트/솔로, 내장 이펙트 체인(garak-dsp, 기타 랙 인서트 포함), 센드/리턴, 마스터, 볼륨/팬/뮤트/센드/인서트 파라미터 오토메이션, 템포 맵을 C++ `RenderEngine`과 같은 의미로 렌더합니다. 같은 엔진이 **네이티브(C++ 호스트, `garak-ffi`)와 브라우저(WASM, `garak-engine-wasm`)에서 처음부터 똑같이** 돕니다. 패리티: C++ 엔진 대비 **비트 동일**(MinGW·MSVC, 오프라인 내보내기 4종 + 재생 중 diff, C++·Rust 이펙트 모두. macOS arm64는 Rust 이펙트 기준 비트 동일, C++ 이펙트 기준 ≤ -138 dBFS), WASM 대비 네이티브 Rust **-144.5 dBFS**. 웹 앱은 **플래그(`garak.rustEngine`, 기본 꺼짐)로 이 엔진을 AudioWorklet에서 씁니다**([5장](#5-wasm-호스트-audioworklet--5단계-웹-호스트)); 기본 동작 변화 없음. 데스크톱은 0.3.3부터 이 엔진만 씁니다([10장](#10-데스크톱-호스트-경로-셸--rust-그래프)). VST3·IEUM WAVE(호스트 노드), 입력 모니터링·트랙 입력 라우트·녹음 탭, 얼린 윈도, render-ahead도 Rust 그래프로 렌더합니다(2026-11-17, C++ 대비 비트 동일). 두 호스트는 하나의 `Track::render(.., &Io)`와 하나의 `routes::prepare`를 공유합니다: 데스크톱은 `Io::host` 콜백으로, 브라우저는 `Io::input`(입력 블록)으로 모니터 입력을 줍니다. 내장 악기도 두 호스트에서 Rust 엔진이 렌더합니다(아래).

> **악기 마일스톤 (2026-11-17, G2):** 내장 악기 전부가 Rust 엔진에서 돕니다 — 신스 5종(벨벳 키 `keys`, 틴 EP `rhodes`, 모노 베이스 `bass`, 클라우드 패드 `pad`, 글라스 플럭 `pluck`), 포켓 드럼 `drums`, 샘플 악기·킷 전부(`builtin-sampled`: 그랜드/콘서트 그랜드/월리처, 스튜디오·808·로파이 킷, 사물놀이, 가야금·해금·대금), 옥구슬 EP·한밤 106, IEUM WAVE(`native-wavetable`: `native/devices/wavetable-synth` 전체 포팅). 음표/컨트롤러 커서, 서스테인 페달, 피치벤드·모듈레이션·프레셔, CC7/CC11, 릴리스 노이즈 규칙, 보이스 스틸, 편집 중 음표 상태 승계(음표 id 재부여, 지운 음표 릴리스), 탐색·사이클 추적(페달 포함), 악기 파라미터 오토메이션, 라이브 MIDI까지 C++ `RenderEngine`과 같은 의미입니다. 패리티: C++ 엔진 대비 **비트 동일**(MinGW, 오프라인 10종 × C++/Rust 이펙트 + 재생 중 편집·사이클·라이브 MIDI·WAVE 패치 크로스페이드, [7.2](#72-결과-이-pc-mingw-w64-gcc-16-release-x86-64)). 아직 아닌 것: VST3 악기(C++ 유지, 4장 hook).

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
  src/track.rs                TrackRuntime: 윈도 또는 악기 → (리턴 입력) → 인서트(32프레임 오토메이션 청크) → PDC → 페이더/팬/뮤트 → 출력 지연, 탭
  src/instrument.rs           악기 소스: compileSynth·resolveSet, 음표/컨트롤러/이벤트 커서, 추적(chase), 라이브 MIDI·페달,
                              renumberNotes/removedNotes, 옥구슬 EP·한밤 106·IEUM WAVE의 플러그인 이벤트 경로(rust_instrument.hpp·wavetable.cpp와 같음)
  src/wave/                   IEUM WAVE: schema.rs(patch_schema.hpp에서 생성), patch.rs(IEWAVE01 디코더·검증), tables.rs(FFT 밉맵),
                              dsp.rs(엔벨로프·SVF·이펙트), synth.rs(16보이스·유니즌·모드 매트릭스·테이블 크로스페이드), processor.rs(호스트 쪽)
  src/clip.rs                 오디오 윈도: 게인, 페이드 5종, 4 ms 클릭 가드, 선형 보간 리샘플, 4/6채널 다운믹스
  src/insert.rs               garak-dsp Fx + 소유 저장 공간, 리버브 커널 캐시(공유 Arc), 라이브 파라미터 판정
  src/automation.rs tempo.rs  automationShape/evaluate/value, TempoMap (C++과 같은 식)
  src/master.rs delay.rs      dsp::Master(마스터 컴프/세이프티), CompensationDelay
  src/queue.rs                고정 용량 SPSC 큐(명령 1024칸, 반환 2056칸)
  src/offline.rs              host.cpp renderStopped와 같은 오프라인 내보내기
  src/testkit.rs              패리티용 결정적 테스트 프로젝트(JSON + PCM)
  src/testkit/instruments.rs  악기 패리티 프로젝트(JSON + 합성 PCM + samples.register JSON): 신스, 샘플, 빈티지, 전부
  tests/engine.rs             오프라인 렌더, diff == 새 그래프, 트랙 교체, 전송, 거부, patch 병합
  tests/realtime.rs           카운팅 전역 할당기: Renderer::render가 힙을 전혀 건드리지 않음
  tests/instruments.rs        engine_test.cpp의 악기 항목 이식(블록 크기 독립, 존·릴리스 노이즈, 페달, 컨트롤러 측정, 편집 승계 …)
  tests/realtime_instruments.rs  악기 + 라이브 MIDI + 교체·새 그래프·탐색·사이클도 무할당
rust/garak-dsp/src/instruments/builtin.rs  내장 보이스: Synth/Voice/pickZone/oscillator/envelope/voicesInto의 줄 단위 포팅(no_std, 128보이스 고정 풀)
rust/garak-ffi/src/engine.rs  C ABI(garak_rs_engine_*, garak_rs_testkit_*) + include/garak_engine.h
rust/garak-ffi/src/engine/instruments.rs  악기 추가분(샘플 세트 등록, 라이브 MIDI, 악기 testkit) + include/garak_engine_instruments.h
rust/garak-ffi/src/heap.rs    staticlib 전역 할당기 = CRT malloc (Rust 런타임 라이브러리 불필요 유지)
rust/garak-engine-wasm/       워크릿용 cdylib: 원시 extern "C" (wasm-bindgen 없음), 모듈 인스턴스당 엔진 1개
src/audio/rust/garakEngineWasm.ts  워크릿·워커·Node 공용 로더
src/audio/rust/RustWebAudioEngine.ts, engine.worklet.ts, engineHost.ts, engineChannel.ts, engineOffline.ts
                              웹 호스트 (5장, 플래그 `garak.rustEngine`)
src/audio/rust/engine.test.ts      WASM 렌더 ↔ 네이티브 Rust 렌더
src/audio/rust/engineAB.test.ts    웹 경로 A/B (Project → 컴파일러 → WASM ↔ Web Audio 의미), CPU 보고
scripts/rust-engine-smoke.mjs      Chromium: 재생·내보내기·대체·A/B·CPU (pnpm rust:engine-smoke)
native/tests/golden.hpp, golden/*.golden  0.3.2 C++ 경로의 골든 레퍼런스(해시 + 표본·구간 RMS, 7.1)
native/tests/rust_engine_parity_test.cpp  Rust 엔진 ↔ 골든 레퍼런스(오디오 프로젝트, 기타 랙)
native/tests/rust_engine_instrument_parity_test.cpp  악기 ↔ 골든 레퍼런스 + `bench` 인자로 악기 중심 프로젝트 CPU
native/tests/rust_engine_host_test.cpp    RenderEngine 셸(호스트 노드·멀티코어·render-ahead·메트로놈) ↔ 골든 레퍼런스
```

## 3. 데이터 모델과 실시간 규칙

### 3.1 입력: 렌더-diff 프로토콜 그대로

엔진의 입력은 [RENDER_DIFF_PROTOCOL.md](RENDER_DIFF_PROTOCOL.md)의 계약을 바꾸지 않습니다. 렌더러(TS)의 `NativeTimelineCompiler`가 만든 `timeline` JSON과 바이너리 프레임이 C++ 호스트에 가듯 Rust 엔진에도 갑니다.

| 메시지 | Rust API | C ABI | WASM |
|---|---|---|---|
| `project.set` (전체 계획 + 바이너리) | `Controller::set_json(text, blob)` / `update(Plan)` | `garak_rs_engine_set` | `garak_engine_set` |
| `project.patch` (헤더 + 순서 + 바뀐 트랙) | `Controller::patch_json` (호스트의 `patchTimeline` 병합과 같은 규칙) | `garak_rs_engine_patch` | `garak_engine_patch` |
| `asset.put` (PCM, 프로토콜 밖) | `Controller::put_asset(id, PcmAsset)` | `garak_rs_engine_put_asset` | `garak_engine_put_asset` |
| `samples.register` (샘플 악기·킷) | `Controller::put_sample_set` / `register_samples_json` | `garak_rs_engine_register_samples` | `garak_engine_register_samples` |
| 라이브 노트 온/오프·미리 듣기·컨트롤러·패닉 | `note_on`/`note_off`/`preview_note`/`control_change`/`all_notes_off` | `garak_rs_engine_note_on` … `_all_notes_off` | `garak_engine_note_on` … |
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

C++ 셸(`native/src/engine.cpp` `RenderEngine`)은 장치 콜백, 전송·카운트인 타이밍, 녹음 캡처, VST3·IEUM WAVE 처리를 갖고, 나머지(트랙·마스터 버스·메트로놈 클릭)를 Rust 엔진에 맡깁니다.

```
garak-audio-host (C++)
  JSON 줄 + 바이너리 프레임 ─▶ project.set / patch ─▶ garak_rs_engine_set / _patch   (제어 스레드)
  asset.put ──────────────────────────────────────▶ garak_rs_engine_put_asset
  장치 콜백 (miniaudio/ASIO/CoreAudio) ────────────▶ garak_rs_engine_render(out, frames)   (오디오 스레드)
  주기적으로 ──────────────────────────────────────▶ garak_rs_engine_collect / _snapshot
```

- 스레드 규칙: `garak_rs_engine_render`만 오디오 반쪽이고, 나머지 `garak_rs_engine_*`는 제어 반쪽(한 번에 한 제어 스레드)입니다. 두 반쪽은 서로 다른 스레드에서 동시에 돌 수 있습니다(핸들 안의 `Controller`와 `Renderer`가 원자적 큐로만 통신). 오류는 예외가 아니라 -1 반환 + `garak_rs_engine_last_error`.
- **VST3·IEUM WAVE: 호스트 노드 (구현됨, `src/external.rs`):** 플러그인 인스턴스·에디터·상태 저장은 C++ 소유로 둡니다. 셸은 플랜 JSON에서 `"kind":"vst3"`/`"native-wavetable"` 소스와 `"type":"vst3"` 인서트에 `"host":{"latencyFrames","tailSeconds","stereo"}`를 붙여 보냅니다(C++이 준비한 프로세서의 값, `ControlTrack::sourceLatency`/`pluginInserts`). 엔진은 그 자리에 호스트 소스 노드(`Track::host_source`)와 호스트 인서트 단계(`Stage::Host`)를 두고 PDC·꼬리·스테레오 판정에 넣습니다.
  - 렌더 중 엔진은 그 트랙을 렌더하는 스레드에서 `GarakRsHostNodes` 콜백을 부릅니다: `source(user, track, stereo, frames)`(악기 출력), `insert(user, track, insert, stereo, frames)`(인서트 처리), `input(user, track, stereo, frames)`(모니터링 중인 트랙의 장치 입력). 다른 트랙끼리는 동시에, 한 트랙에는 한 번에 하나만.
  - C++ 쪽은 `HostTrack::renderSource`(음표·컨트롤러·서스테인·라이브 MIDI·체이스·파라미터 오토메이션 점 이벤트 → `PluginProcessor::process`)와 `HostTrack::processPlugin`(VST3 인서트 오토메이션의 32점 격자)입니다. 0.3.2의 C++ 트랙 경로에서 그대로 남긴 함수라 이벤트 타이밍·`ProcessContext`(템포 맵·박자 맵 위치·재생·사이클·녹음)가 이전과 비트 단위로 같습니다.
  - 호스트 노드의 상태 이전·리셋은 셸이 `HostTrack`에 합니다(재생/정지/탐색/사이클, 그래프 교체의 `adopt`). 그 밖의 트랙 상태(내장 악기·이펙트·PDC·페이더)는 Rust 그래프가 갖습니다.
- **입력 모니터링·트랙 입력 라우트·녹음 탭 (구현됨):** `garak_rs_engine_render_host`에 `GarakRsBlock`(위치·재생·티켓·`master`(마스터 버스 적용)·모니터 마스크·호스트 노드·render-ahead 링 출력)을 넘깁니다. 엔진이 `prepareRoutes`를 그대로 옮겨(`src/routes.rs`) 처리 레벨(라우트 소스·센더 먼저), 루프 끊기, 마스터 피드, 프리FX/포스트FX/포스트페이더 탭을 만들고, 녹음은 셸이 블록 뒤에 `garak_rs_engine_route_input`으로 라우트 입력을 읽습니다. 저지연 모니터링(PDC 건너뛰기)·모노 입력의 등전력 팬도 C++과 같습니다.
- **마스터 버스·메트로놈 (0.3.3):** `GarakRsBlock::master`가 켜져 있으면 `render_host`가 트랙 합(비유한 값 정리 뒤)에 마스터 게인(엔진이 소유, 프로젝트 `masterGain`과 `garak_rs_engine_set_master_gain`의 목표로 12 ms 글라이드)과 마스터 프로세서를 적용합니다(오프라인 + `garak_rs_engine_set_master_bypass`이면 건너뜀). 셸이 녹음·미터를 마친 뒤 `garak_rs_engine_clicks(out, frames, 위치, 재생, 카운트인 여부, 경과, 길이)`로 메트로놈·카운트인 클릭을 섞습니다(오프라인 없음). 클릭 PCM과 켜짐·볼륨은 `garak_rs_engine_set_metronome`(유지/교체/비움)으로 티켓 순서에 맞춰 넘깁니다. 웹 호스트는 같은 `render_clicks`를 엔진 자체 전송으로 씁니다.
- **그래프 제출 (0.3.3):** `RenderEngine::prepare()`가 호스트 노드를 만든 뒤 계획을 Rust 그래프에 넘기고(`garak_rs_engine_set`, 셸의 `submit`까지 티켓으로 보류), 지연·꼬리는 `garak_rs_engine_graph_details`에서 받습니다. `update()`도 Rust 엔진에 먼저 물어 거부되면 두 그래프 모두 그대로 둡니다. `UpdateResult`의 종류는 셸과 Rust 분류 중 큰 쪽, `replacedTracks`는 `garak_rs_engine_replaced_tracks`를 반영합니다. 스냅숏의 지연은 렌더 중인 그래프의 값(`garak_rs_engine_active_latency`)입니다.
- **멀티코어:** 레벨마다 트랙을 셸의 워커 풀에서 병렬로 렌더하고(호스트 노드 콜백도 그 워커에서), 합은 트랙 순서대로. 0 ↔ N 워커 비트 동일.
- **render-ahead (구현됨, `engine/ahead.rs`):** 셸의 링·워커 스케줄링·라이브 트랙 회수를 그대로 쓰고, 링에 든 트랙은 워커가 `garak_rs_engine_render_ahead`로 Rust 그래프의 그 트랙을 렌더합니다. 콜백의 `render_host`는 그 트랙을 건너뛰고 링 출력을 섞으며(`GarakRsBlock::ahead`), 전송 리셋도 그 트랙을 건너뜁니다(`garak_rs_engine_reset_skip`). 링에서 어긋난 채로 회수한 트랙은 `garak_rs_engine_reset_track`. Rust 명령은 워커를 밖에 둔 채(quiesce) 적용합니다.

## 5. WASM 호스트 (AudioWorklet) — 5단계 웹 호스트

> **상태 (0.3.2):** 웹 앱은 **기본으로 이 엔진을 씁니다.** 비상시 `localStorage.setItem('garak.rustEngine', '0')` 또는 `VITE_GARAK_RUST_ENGINE=0`으로 Web Audio 엔진으로 되돌립니다(다음 패치에서 제거). 아래는 처음 플래그로 도입할 때의 기록입니다: 기본값은 꺼짐이었습니다(`garak.rustEngine`). 켜면 엔진이 받아들이는 프로젝트(지금은 오디오 트랙·내장 이펙트·센드/리턴·오토메이션·템포 맵)는 재생과 내보내기 모두 Rust 엔진으로, 받아들이지 않는 프로젝트(악기 트랙, 얼린 트랙, 기타 랙, pre-master 렌더 등)는 지금의 Web Audio 엔진으로 돌고 콘솔에 이유를 남깁니다. 판정은 **엔진 자신의 거부 메시지**라서, 악기 포팅(G2)이 엔진에 들어오면 그 프로젝트들은 코드 변경 없이 저절로 Rust 엔진으로 넘어갑니다.

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

크기(악기 통합 후, `rust/engine-integrate`): 291 → 460 KiB raw / 119 → 189 KB gzip, 기타 랙까지 512 KiB / 207 KB(예산 528 KiB / 212 KB, `scripts/rust.mjs`에 이유). 늘어난 대부분은 악기 코드 자체(IEUM WAVE 신스·테이블 준비와 팩토리 하모닉 표, 옥구슬 EP·한밤 106 커널, 내장 보이스, 샘플 세트 파서, 커서·승계 로직)입니다. ABI 4: 샘플 세트 등록(`garak_engine_register_samples`)과 라이브 MIDI 내보내기가 늘었고, `garak_engine_live`(라이브 링·미리 듣기)도 내장 악기를 연주합니다.

## 6. 악기·보이스 (인벤토리와 지원 현황)

| 소스 | 앱 악기 | C++ (데스크톱) | Rust 엔진 | 패리티 (MinGW) |
|---|---|---|---|---|
| 내장 신스 `keys`·`rhodes`·`bass`·`pad`·`pluck` | 벨벳 키, 틴 EP, 모노 베이스, 클라우드 패드, 글라스 플럭 | `engine.cpp` `Synth`/`Voice`/`oscillator`(polyBLEP·삼각 급수), 엔벨로프, 톤 필터 | **지원**: `garak-dsp::instruments::builtin`(같은 식·같은 연산 순서, 128보이스 고정 풀) | 비트 동일 |
| 내장 드럼 `drums` | 포켓 드럼 | `Synth::Kind::Drums`(스윕 사인, LCG 노이즈 + 하이패스) | **지원** | 비트 동일 |
| 샘플 악기 / 킷 `builtin-sampled` | 그랜드(Salamander), 콘서트 그랜드(bitKlavier), 월리처, 가야금·해금·대금, 스튜디오·808·로파이 킷, 사물놀이 | `SampleSet`, `pickZone`, 루프, 릴리스 존, 초크, 코덱 오프셋 | **지원**: `samples.register`와 같은 JSON으로 등록, PCM은 `put_asset` 저장소 공유 | 비트 동일 |
| 옥구슬 EP `okgu-ep`, 한밤 106 `hanbam-106` | 빈티지 | `rust_instrument.hpp`(플러그인 이벤트 경로로 Rust 커널 호출) | **지원**: 같은 커널을 엔진이 직접, 이벤트 변환·정렬·리셋 규칙 동일 | 비트 동일 |
| IEUM WAVE `native-wavetable` | IEUM WAVE | `native/devices/wavetable-synth`(C++ 라이브러리) + `wavetable.cpp`(호스트 쪽) | **지원**: `garak-engine::wave`(같은 상태·같은 연산 순서; 테이블·딜레이선은 제어 스레드에서 할당, 테이블 세트는 사용자 뱅크가 같으면 공유) | 비트 동일 |
| VST3 악기 | — | `vst3.cpp` | 거부. C++ 유지, 4장 외부 hook | — |
| 기타 랙 인서트 `guitar-rig` | — | `dsp.cpp` | 거부 | — |

### 6.1 옮긴 규칙 (engine.cpp와 같음)

- **음표/컨트롤러 커서.** 블록 안에서 컨트롤러와 음표 시작을 시간 순서로 처리하고, 같은 샘플이면 컨트롤러가 먼저입니다. 보이스는 그 사이 구간만 렌더하므로(`voicesInto`) 블록 크기와 무관하게 같은 샘플이 나옵니다. 빈티지 악기는 음표·컨트롤러를 샘플 오프셋 이벤트로 받고(`eventOrder`: 리셋 → 컨트롤러 → 노트 오프 → 노트 온), 프로젝트 끝의 노트 오프는 꼬리 첫 블록에서 받습니다.
- **컨트롤러.** 피치벤드(범위 컨트롤러 131 포함)·모듈레이션/프레셔 비브라토(±50 cent, 5.5 Hz)·CC7×CC11 레벨은 5 ms 스무딩, 킷은 벤드/비브라토 무시. CC64는 타임라인에서는 렌더러가 노트 오프에 반영한 상태로 오고(내장 소스), 라이브에서는 노트 오프를 미룹니다. 빈티지 악기는 모든 컨트롤러를 이벤트로 받습니다.
- **탐색·사이클·정지.** `reset(frame, chase)`: 보이스를 끄고, 그 위치의 컨트롤러 값을 추적(정지 때는 모드·익스프레션·페달·프레셔·벤드만 기본값)하고, 위치에 걸친 음표를 다시 시작합니다(킷 제외). 빈티지 악기는 `requestReset`(전체 릴리스 + 컨트롤러 휴지) 뒤 추적한 컨트롤러·음표 이벤트를 받습니다. 사이클 랩은 추적 리셋, 프로젝트 끝(사이클 없음)은 빈티지 악기만 리셋하고 내장 보이스는 울리게 둡니다.
- **릴리스 노이즈.** 피아노 릴리스 존은 노트 오프 순간 한 번, 벨로시티·양·눌린 시간(τ 2 s)으로 스케일. 클립·루프·프로젝트 끝에서 잘린 음, 아주 약한 음, 이미 다 울린 음(샘플 길이보다 오래 누른 음)에는 없습니다.
- **보이스 스틸.** 빈 보이스가 없으면 가장 오래된 보이스(첫 최댓값). 킷의 초크 그룹은 3 ms로 페이드.
- **편집 중 상태 승계(프로토콜 4.2).** 업데이트는 새 음표를 이전 음표와 (프레임·피치·벨로시티)로 맞춰 id를 이어 주고(`renumberNotes`), 악기 정체성(종류·악기 id·샘플 세트와 같은 PCM 객체)이 같으면 보이스·컨트롤러·라이브 노트·페달을 넘깁니다. 짝 없는 이전 음표가 울리고 있으면 릴리스(빈티지: 노트 오프)합니다. 재생 위치에 걸친 새 음표는 다음 반복부터 들립니다. 새 그래프(템포·트랙 추가/삭제)도 트랙 id로 같은 규칙, 새 트랙은 추적 리셋.
- **오토메이션.** 내장 악기 파라미터는 블록 시작에 `Synth` 필드를 바꿔 새로 시작하는 음표에 적용(보이스는 시작할 때 복사), 빈티지 악기는 블록 시작마다 `set_param`(내부 글라이드).
- **IEUM WAVE.** 벨로시티를 1로 자르지 않고(최대 2) 받고, 벤드 범위(131)는 받지 않으며, CC7/CC11은 5 ms로 스무딩한 출력 게인입니다. 정지·탐색은 신스 리셋 + 매크로(모드·프레셔)를 패치 값으로, 프로젝트 끝에서는 리셋하지 않습니다. 라이브 패닉은 오디션 노트를 한 이벤트로 놓습니다. 같은 패치의 트랙 재준비는 실행 중인 프로세서를 그대로 넘겨받고, 패치가 바뀌면 새 그래프가 되어 실행 중인 신스가 새 테이블 세트로 20 ms 크로스페이드합니다. 크로스페이드 중에는 다음 그래프 교체가 끝날 때까지 기다립니다(`readyToPreserve`, 이후 명령도 순서대로 대기).
- **라이브 MIDI.** 노트 온/오프(id 또는 피치), 미리 듣기(길이 지정), 컨트롤러, 패닉(페달 해제 + 벤드/모드 중앙). 라이브 페달 중 노트 오프는 지연, 같은 키 재타격은 이전 음을 먼저 놓음. 명령 큐로 블록 경계에 적용합니다(호스트의 블록 내 오프셋 큐 `queueLiveMidi` 연결은 호스트 통합 몫).

## 7. 패리티 전략과 결과

### 7.1 하네스

**골든 레퍼런스 (0.3.3).** C++ 트랙 경로를 지우기 전에 패리티 테스트의 C++ 쪽 렌더(C++ 이펙트 사용)를 한 번 기록했습니다: `native/tests/golden/`의 네 파일(약 700 KB) — `rust-kernels`(이펙트·기타 랙 커널 1113개), `rust-engine-parity`(8), `rust-engine-instruments`(11), `rust-engine-host`(20, 새 "shell metronome" `RenderEngine` 경우 포함). 기록할 때 MinGW에서 모든 경우가 Rust 렌더와 비트 동일이었습니다. `native/tests/golden.hpp`가 비교합니다:

- 렌더 전체의 FNV-1a 64 해시(-0은 +0으로): 기록 당시 비트 동일이던 경우는 **Windows x64(MSVC·MinGW)에서 비트 동일**이어야 합니다.
- 모든 플랫폼: 저장한 표본(경우마다 일정 간격 2048개, 커널은 32개), 구간 RMS(64개, 커널은 16개), 피크, 전체 RMS와의 차이가 **≤ -90 dBFS**. |rms(a)−rms(b)| ≤ max|a−b|이므로 구간·전체 비교도 모든 샘플을 이전 게이트와 같은 기준으로 묶습니다(느슨해진 기준 없음).
- 경우별 보조 값(지연, 길이, 꼬리, 다이내믹스 미터, render-ahead 트랙 수)을 이전 허용 오차로.

다시 기록하려면 C++ 경로가 있는 0.3.2 체크아웃에서 `GARAK_GOLDEN_RECORD=1`로 테스트를 돌립니다(`Suite::record`). 아래 표의 "C++ ↔ Rust"는 0.3.2까지의 비교입니다.

| 테스트 | 비교 | 기준 |
|---|---|---|
| `native/tests/rust_engine_parity_test.cpp` (`ctest -R native-rust-engine-parity`) | Rust 엔진 ↔ 0.3.2 C++ `RenderEngine`의 골든 레퍼런스, 같은 JSON·PCM(`testkit`을 C ABI로) | residual ≤ -90 dBFS, 지연·길이 동일 |
| `src/audio/rust/engine.test.ts` | WASM 엔진 ↔ 네이티브 Rust 엔진(`cargo test`가 `rust/target/engine-parity/`에 쓴 렌더) | ≤ -90 dBFS |
| `rust/garak-engine/tests/engine.rs` | diff 경로 ↔ 같은 편집을 새 그래프로(`Controller::rebuild`) | ≤ 1e-6 (프로토콜 8.5) |
| `rust/garak-engine/tests/realtime.rs` | 렌더 중 힙 사용 | 0회 |
| `native/tests/rust_engine_instrument_parity_test.cpp` (`ctest -R native-rust-engine-instruments`) | Rust ↔ 골든 레퍼런스, 악기 프로젝트(`testkit/instruments.rs`) 오프라인 + 재생 중 편집 | residual ≤ -90 dBFS, 지연·길이·diff 분류 동일 |
| `rust/garak-engine/tests/instruments.rs` | `engine_test.cpp`의 악기 항목(측정값·동등성) | 원래 기준 그대로 |
| `rust/garak-engine/tests/realtime_instruments.rs` | 악기·라이브 MIDI·교체 중 힙 사용 | 0회 |

테스트 프로젝트(`testkit.rs`): 오디오 트랙 N개 + 리턴 2개. 겹치는 윈도(크로스페이드)와 페이드 5종, 클립 오프셋·게인, 모노/스테레오/44.1 kHz PCM(48 kHz 엔진에서 리샘플), 기타 랙을 뺀 내장 이펙트 15종 전부(드라이브가 PDC 8프레임: 트랙 쪽 8 + 리턴 쪽 8로 센드/리턴 지연 보정까지 거침), 꺼진 인서트, 프리/포스트 센드, 볼륨·팬·뮤트·센드·인서트(컷오프 로그 범위, 컴프 임계값) 오토메이션, 템포 램프(싱크 딜레이·트레몰로), `audible:false` 트랙의 프리 센드 무음. PCM은 사칙연산만으로 만들어 플랫폼마다 같습니다. 기타 랙 경우는 이 프로젝트에서 트랙 1의 코러스를 리그(컴프·드라이브·크런치 앰프·캐비닛·드라이브 사본·코러스·딜레이·리버브·페이저)로 바꾸고 필터 레인을 앰프 게인 오토메이션으로 바꾼 것입니다(`rust_engine_parity_test.cpp` `withGuitarRig`; 엔진 쪽 단위 테스트는 `tests/guitar_rig.rs`: 렌더 중 힙 사용 0, diff 분류).

(0.3.2까지) C++ 쪽은 두 번 돌렸습니다: C++ 이펙트로(완전히 독립된 두 구현) 그리고 Rust 이펙트로(엔진 구조만 비교). 골든 레퍼런스는 C++ 이펙트 쪽입니다. 오프라인 경우는 host.cpp `renderStopped`와 같은 루프(길이 + 꼬리 ≤ 30 s, PDC 앞쪽 제거)이고, 라이브 경우는 재생 중 0.5 s에 Mix+Send+Param+Master diff, 1.5 s에 트랙 재준비를 두 엔진에 같은 JSON으로 보냅니다(분류 결과 `Diff`/`Tracks`도 같아야 통과).

악기 프로젝트(`testkit/instruments.rs`): IEUM WAVE(사용자 뱅크 + 유니즌 3 + 세 오실레이터 + 서브·노이즈 + 필터 두 개 + LFO/엔벨로프/벨로시티 루트 + 드라이브·코러스·딜레이 패치, 그리고 기본 패치; base64 IEWAVE01로 전송), 신스 5종 + 드럼(화음·겹치는 같은 음·클립 끝에서 잘린 음·프로젝트 앞에서 시작한 음, 벤드+범위·모드·프레셔·CC7/11, 트랙마다 악기 파라미터 오토메이션, EQ 인서트, 리버브 리턴 센드), 샘플(4단 벨로시티 그랜드 + 릴리스 존 + 코덱 오프셋, 루프 걸린 44.1 kHz 스테레오 찰현, 벨로시티 3단·초크 킷), 빈티지(서스테인 페달 포함), 전부. PCM은 사칙연산만으로 합성해 플랫폼마다 같습니다. 재생 중 경우는 사이클(1–4 s) 안에서 노브 편집(같은 소스 → 교체 + 보이스 승계), 울리는 음표 삭제·음표 이동·재생 위치에 걸친 음표 추가, 믹스, 탐색(페달 구간), 라이브 MIDI(키·EP·106, 페달·벤드·미리 듣기·패닉), 다른 악기로 교체, 템포 변경(새 그래프), 일시정지·정지·재생, 트랙 삭제(새 그래프)를 두 엔진에 같은 시점에 보냅니다(분류도 같아야 통과).

### 7.2 결과 (이 PC, MinGW-w64 GCC 16 Release, x86-64; 0.3.2 C++ ↔ Rust 기록)

0.3.3에서 같은 경우를 골든 레퍼런스와 비교한 결과도 MinGW에서 전부 비트 동일입니다.

| 경우 | 트랙 | 블록 | 이펙트 | 지연 C++/Rust | residual |
|---|---|---|---|---|---|
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 128 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 44.1 kHz, 3 s | 6+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 1 s | 1+2 | 512 | C++ / Rust | 0 / 0 | **비트 동일** |
| 재생 중 diff(믹스·센드·파라미터·마스터) + 트랙 재준비 | 8+2 | 128 | C++ / Rust | — | **비트 동일** |
| 오프라인 내보내기 + 기타 랙(리버브·사본, 앰프 게인 오토메이션) 48 kHz, 4 s | 8+2 | 4096 | C++ / Rust | 40 / 40 | **비트 동일** |
| 오프라인 내보내기 + 기타 랙 44.1 kHz, 3 s | 6+2 | 128 | C++ / Rust | 40 / 40 | **비트 동일** |
| 재생 중 리그 노브 diff + 랙 재배치(트랙 재준비) | 4+2 | 128 | C++ / Rust | — | **비트 동일** |
| WASM ↔ 네이티브 Rust, 오프라인 3 s | 8+2 | 4096 | — | 16 / 16 | **-144.5 dBFS** |

악기 (`garak-rust-engine-instrument-parity-test`, C++ 엔진 쪽 이펙트를 C++·Rust로 두 번, 모두 같은 결과):

| 경우 | 길이 | 레이트 | 블록 | residual |
|---|---|---|---|---|
| 오프라인: 신스 + 드럼 | 4 s / 3 s | 48 kHz | 4096 / 128 | **비트 동일** |
| 오프라인: 샘플(그랜드·찰현·킷) | 4 s / 3 s | 48 / 44.1 kHz | 4096 / 512 | **비트 동일** |
| 오프라인: 빈티지(EP·106) | 4 s / 3 s | 48 kHz | 4096 / 128 | **비트 동일** |
| 오프라인: IEUM WAVE(사용자 뱅크·유니즌·모드 루트·이펙트 / 기본 패치) | 4 s / 3 s / 3 s | 48 / 48 / 44.1 kHz | 4096 / 128 / 512 | **비트 동일** |
| 오프라인: 악기 전부(12트랙) | 3 s | 48 kHz | 1024 | **비트 동일** |
| 재생 중: 사이클·편집·탐색·라이브 MIDI·WAVE 패치 교체(크로스페이드 중 템포 편집)·템포·트랙 삭제 | 9 s | 48 kHz | 128 | **비트 동일** |

**CI (PR #56):** Windows MSVC x64는 위 악기 표 전부 비트 동일. macOS arm64는 샘플·빈티지(Rust 이펙트)가 비트 동일이고 나머지는 -140.97 ~ -150.51 dBFS(C++ 쪽 AppleClang FMA 축약). WASM ↔ 네이티브 Rust(악기 12트랙 프로젝트, `target/engine-parity/instruments/`, 이 PC의 Node): **-192.7 dBFS**, 오디오 프로젝트는 비트 동일.

**CI (PR #50):** Windows MSVC x64는 위 표와 똑같이 전부 비트 동일입니다. macOS arm64(AppleClang)는 Rust 이펙트를 쓴 C++ 엔진과 비교하면 전부 비트 동일이고(엔진 구조·식이 FMA 축약까지 같다는 뜻), C++ 이펙트와 비교하면 -138.5 ~ -156.5 dBFS입니다. 이 차이는 1단계 커널 표에서 이미 macOS에서만 비트 동일이 아닌 커널 몇 개에서 옵니다.

엔진 자체의 식(페이더·팬 법칙·페이드·오토메이션 곡선·마스터)은 garak-dsp처럼 같은 연산 순서와 플랫폼 libm을 쓰고, AppleClang이 FMA로 합치는 `a*b + c` 자리에는 `math::mul_add`/`mul_add_f32`를 둬서 macOS arm64에서도 같은 반올림을 따르게 했습니다. CI 요약(`rust.yml`)에도 같은 표가 나옵니다.

### 7.3 CPU (단일 스레드, 128프레임 블록, 10 s × 최고 3회, `garak-rust-engine-bench`; 0.3.2 측정)

> 비교 대상 C++ 엔진과 이 벤치는 0.3.3에서 삭제했습니다. 지금은 `garak-rust-engine-host-test --bench`(1스레드 ↔ N워커)와 `garak-rust-engine-instrument-parity-test bench`(악기 프로젝트)가 Rust 엔진만 잽니다.

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

악기 중심 프로젝트(악기 트랙 12개(IEUM WAVE 포함) + 리버브 리턴, 촘촘한 화음, `garak-rust-engine-instrument-parity-test bench 10 3 128`, 이 PC):

| 프로젝트 | C++ 엔진 + C++ 이펙트 | C++ 엔진 + Rust 이펙트 | Rust 엔진 | 블록당 µs (C++ / Rust) |
|---|---|---|---|---|
| 악기 12트랙 + 리턴 | 1.6× 실시간 | 1.7× | **1.9×** (1.20배 빠름) | 1711 / 1431 |
| 악기 11트랙 + 리턴 (WAVE 제외) | 2.0× | 2.1× | **2.5×** (1.26배 빠름) | 1324 / 1048 |

CI 러너(같은 벤치): Windows MSVC x64 12트랙 1.0× / 1.0× / **1.3×**(1.29배, 2622 / 2039 µs), 11트랙 1.32배. macOS arm64 12트랙 1.4× / 1.4× / **1.4×**(1.06배, 1955 / 1844 µs), 11트랙 1.50배 — WAVE 보이스는 arm64에서 C++ 쪽과 거의 같은 속도입니다.

보이스 합성 자체(초월 함수 호출, WAVE의 테이블 보간)는 두 엔진이 같은 식이라 오디오 트랙만큼 차이가 나지 않습니다. Rust 쪽은 마지막 활성 보이스 뒤를 건너뛰고(합산 순서가 같아 출력은 그대로), 릴리스 존이 없는 트랙은 릴리스 검사를 생략합니다.

### 7.4 단계 게이트

| 게이트 | 조건 | 상태 |
|---|---|---|
| G1 (이번) | 오디오 트랙·이펙트·센드·오토메이션·템포 맵 오프라인/라이브 패리티 ≤ -90 dBFS, 렌더 무할당, WASM ↔ 네이티브 ≤ -90 dBFS, CI(MSVC·macOS) | 통과 (MinGW·MSVC·macOS) |
| G2 | 내장 신스·드럼·샘플 악기 + 컨트롤러, 음표 상태 이전 | 통과 (IEUM WAVE 포함, MinGW 비트 동일) |
| G3 | VST3·IEUM WAVE 외부 hook, 입력 모니터링·녹음 탭, 멀티코어 | 통과 (10장) |
| G4 | `engine_test.cpp`의 모든 항목을 Rust 엔진 하네스로 옮겨 통과, 장시간 재생 소크 테스트, CPU ≥ C++ (MSVC·macOS) | `engine_test` 전부 Rust 엔진으로 통과, CPU ≥ C++(7.3). 소크 테스트는 남음 |
| G5 | 데스크톱 호스트에서 기능 플래그로 전환 가능, 이후 기본값 | 0.3.2 기본값, 0.3.3 유일한 경로(플래그·C++ 경로 삭제) |

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

**악기 마일스톤에서 추가:** 내장 신스 5종·드럼·샘플 악기/킷·옥구슬 EP·한밤 106·IEUM WAVE(패치 교체 크로스페이드 포함), 음표/컨트롤러 커서, 페달·벤드·모드·프레셔·CC7/11, 릴리스 노이즈, 보이스 스틸·초크, 탐색·사이클 추적, 음표 id 재부여·지운 음표 릴리스, 악기 파라미터 오토메이션, 라이브 MIDI(엔진 API·C ABI·WASM, 웹의 `LiveEvent` 링과 데스크톱 셸의 라이브 MIDI·명령 모두 `Track::live_event`로), 샘플 세트 등록(데스크톱 셸이 `samples.register` JSON으로 넘김).

**0.3.2에서 추가:** 웹 호스트도 샘플 세트를 같은 JSON과 PCM으로 엔진에 등록합니다(내보내기·바운스·스템 포함). 데스크톱과 웹 모두 Rust 엔진이 기본이 됐습니다(0.3.2의 데스크톱 비상 경로 `GARAK_RUST_ENGINE=0`은 0.3.3에서 C++ 경로와 함께 삭제).

**0.3.3에서 추가:** 데스크톱의 마스터 버스·메트로놈을 엔진으로(`GarakRsBlock::master`, `garak_rs_engine_clicks`), C++ 트랙 경로·이펙트 DSP 삭제, 골든 레퍼런스 패리티(7.1).

**아직 아님:** 라이브 MIDI의 블록 내 오프셋(블록 경계에 적용). 데스크톱의 IEUM WAVE는 계속 C++ 호스트 노드(편집기·상태가 C++ 쪽)이고, 웹은 Rust IEUM WAVE를 씁니다.

**다음 마일스톤 제안:**

1. ~~**G2 악기**~~ (완료, 6장: IEUM WAVE까지 모든 내장 악기). WAVE의 메모리 예산(테이블 바이트·인스턴스 추정)은 아직 512 MB 상한 계산에 넣지 않습니다.
2. ~~**웹 워크릿 호스트(병렬):**~~ 5장(플래그, 기본 꺼짐). 남은 일은 5.6.
3. **G3 외부 hook:** VST3·IEUM WAVE를 C++ 인스턴스로 끼우는 콜백, 입력 탭·녹음, 그리고 엔진 내부 트랙 병렬화.
4. ~~**G4~G5:**~~ 회귀 테스트 전부 이전, 기본값 전환(0.3.2), 이전 경로 삭제(0.3.3). 남은 것: 소크 테스트.

## 10. 데스크톱 호스트 경로 (셸 + Rust 그래프)

> **상태 (0.3.3):** 데스크톱의 모든 그래프가 Rust 그래프로 렌더합니다. 0.3.2의 스위치(`GARAK_RUST_ENGINE=0/1/strict`, 진단용 `GARAK_RUST_ENGINE_REFUSE_INSERT`·`GARAK_RUST_ENGINE_HOST_INSTRUMENTS`, `GARAK_RUST_EFFECTS`)와 C++ 트랙 경로(`TrackRuntime`의 내장 악기·이펙트·믹스·라우트·센드, `dsp.cpp`·`sigimsae_effects.inc`·`eq_effects.inc`·C++ 기타 랙·`rust_effects.inc`·`rust_instrument.hpp`·`metronome.hpp`)는 삭제했습니다. 모든 네이티브 빌드가 `garak-ffi`를 링크합니다(`GARAK_RUST=OFF` 빌드 없음). 호스트 `hello`의 `rustEngine`은 진단용으로 항상 `{available: true, requested: true}`, `engine.snapshot`·`render.wav`의 `rustEngine`은 Rust 그래프가 렌더했는지를 알려 줍니다.

### 10.1 구조: C++ `RenderEngine`이 셸, Rust 그래프가 트랙·마스터·메트로놈

```
RenderEngine (C++ 셸) ─ 전송(재생/정지/탐색·사이클·카운트인 타이밍), 라이브 MIDI 전달, 녹음 캡처, 스냅숏·미터 게시,
 │                     워커 풀·render-ahead 링, VST3·IEUM WAVE 프로세서(HostTrack, 호스트 노드), 장치 입력
 ├ prepare()  호스트 트랙(플러그인 인스턴스, 지연·꼬리) 준비 → 같은 계획을 timeline JSON(rust_engine.inc)으로
 │            garak_rs_engine_set (submit까지 티켓으로 보류); 지연·꼬리 ← garak_rs_engine_graph_details
 ├ submit()/update()  셸 명령(Graph / Replace / Touch / Revision) 뒤에 RustSync{허용 티켓}
 │                    update()는 Rust에 먼저 물어 거부되면 아무것도 큐에 넣지 않음; Rust가 새 그래프를 만들면 셸도 새 그래프
 └ render()  블록마다: (Rust 명령 적용) → render-ahead 링 소비 →
                       garak_rs_engine_render_host(out, GarakRsBlock{위치, 재생, 티켓, master=1, 모니터, 노드, 링})
                       = 트랙 합 → 마스터 게인·마스터 프로세서 (Rust)
                       → 녹음(라우트 입력은 garak_rs_engine_route_input) → 비유한 값 정리·마스터 미터 (셸)
                       → garak_rs_engine_clicks(메트로놈·카운트인, Rust)
```

- **티켓 게이트:** Rust 명령 큐는 셸이 넘긴 티켓까지만 적용됩니다. 그래서 Rust 그래프 교체·diff·마스터 게인·메트로놈 설정이 셸의 같은 업데이트와 **같은 블록**에 적용됩니다.
- **전송은 셸 소유:** Rust는 셸이 정한 위치·재생 여부로 블록을 렌더하고, 셸의 `reset(chase, effects)`(재생·일시정지·탐색·사이클 순환)이 `garak_rs_engine_reset_skip`으로 전달됩니다. 카운트인 길이·경과는 셸이 세고 클릭은 Rust가 섞습니다.
- **라이브 편집과 render-ahead:** 믹스·내장 인서트 파라미터 편집은 셸의 `Touch` 명령(트랙을 링에서 회수하고 2초간 콜백에 둠)과 함께 가서, 링에 든 트랙도 다음 블록에 편집이 들립니다. 호스트 노드가 바뀐 트랙은 `Replace`로 `HostTrack`을 교체하고 상태를 넘깁니다.
- **미터:** 트랙 피크와 컴프·리미터·게이트 다이내믹스 미터(`garak_rs_engine_take_dynamics`)를 Rust 그래프에서 받아 같은 홀드 규칙으로 게시합니다. 지연은 렌더 중인 그래프의 값(`garak_rs_engine_active_latency`).
- **호스트 노드:** VST3 악기·인서트와 IEUM WAVE는 C++ 프로세서로 남고, Rust 그래프가 체인의 그 자리에서 셸을 부릅니다(4장). 이벤트·PDC·오토메이션 점·`ProcessContext`는 0.3.2와 비트 동일합니다.
- **멀티코어:** 셸의 워커 풀(`setProcessing(threads)`)이 Rust 그래프의 처리 레벨마다 트랙을 병렬로 렌더하고(`GarakRsParallelRun`, 호스트 노드 콜백도 그 워커에서), 합은 트랙 순서대로. 출력은 1스레드와 **비트 동일**.
- **render-ahead:** 셸의 링(ASIO-Guard식)·워커 스케줄링·라이브 트랙 회수 규칙으로, 링에 든 트랙은 워커가 `garak_rs_engine_render_ahead`로 렌더합니다. 콜백은 그 트랙을 건너뛰고 링 출력을 섞습니다. 출력은 콜백 렌더와 **비트 동일**.
- **스템·프리즈·바운스:** `preFader`·`directOut=false`는 Rust 엔진이 렌더하고, `setMasterBypass`(오프라인)는 `garak_rs_engine_set_master_bypass`로 마스터 버스를 건너뜁니다.

### 10.2 테스트와 CI

| 테스트 | 내용 | 결과 (MinGW GCC 16, 이 PC) |
|---|---|---|
| `native/tests/rust_engine_host_test.cpp` (`ctest -R native-rust-engine-host`) | `RenderEngine` ↔ 0.3.2 C++ 엔진의 골든 레퍼런스: 오프라인 내보내기 3종, 마스터 바이패스, 프리페이더 트랙, 리턴 스템, 재생 중 diff·트랙 재준비·탐색·사이클·일시정지·`setMasterGain`; 호스트 노드(상태 있는 대역 플러그인의 VST3 악기·인서트, 지연 있는 리턴, 라우트·마스터 리샘플러·모니터링·녹음 테이크, 라이브 MIDI), 오프라인 내보내기, 꼬리 있는 얼린 윈도, render-ahead(Normal·High; 링에 든 트랙 수도 기록과 같아야 함); `garak_rs_metronome_render` 6가지 경우; **셸 메트로놈**(템포·박자 맵, 매핑된 위치의 카운트인, 탐색, 일시정지 후 3/4 카운트인, 클릭 세트 교체). 0 ↔ N 워커, render-ahead ↔ 콜백 렌더는 서로 비트 동일 | 전부 **비트 동일** |
| `native/tests/engine_test.cpp` (`ctest -R native-engine`) | 엔진 회귀 43가지(모두 Rust 그래프로 렌더, 경우마다 Rust 블록 수 출력). 이펙트 단위 검사는 `native/tests/rust_fx.hpp`로 Rust 커널을 직접 | 43/43 |
| `rust/garak-engine/tests/host.rs` | `render_block`: 엔진 자체 전송과 같은 진행, 티켓 게이트, 병렬 센더 비트 동일, 힙 사용 0 | 통과 |
| rust.yml | Windows MSVC·macOS arm64에서 위 테스트와 7장 테스트(골든 레퍼런스: Windows 비트 동일, macOS ≤ -90 dBFS) | |
| desktop.yml / macos.yml | 네이티브 스모크(`--test-clock`): `hello.rustEngine`과 `render.wav`가 Rust 그래프로 렌더했는지 확인 | |

0.3.2의 C++ ↔ Rust 셸 CPU 비교(128프레임 블록, 10 s, 이 PC 8워커): 16트랙 C++ 2.2× / Rust 1스레드 4.8× / 8워커 12.1×, 32트랙 1.6× / 3.7× / 8.9×. 지금은 `garak-rust-engine-host-test --bench`가 1스레드 ↔ N워커만 잽니다.

### 10.3 남은 일

- 데스크톱 IEUM WAVE는 아직 C++ 호스트 노드입니다(편집기·상태가 C++ 쪽). 웹은 Rust IEUM WAVE(`src/wave/`)를 씁니다.
- 장시간 재생 소크 테스트(G4).

참고(바꾸지 않음): 탐색·정지 리셋은 리턴 지연 정렬용 출력 지연선을 비우지 않으므로, 지연 있는 리턴이 있을 때 탐색 직후 몇 프레임은 이전 위치의 소리이고 render-ahead 중이면 링이 얼마나 앞서 있었는지에 따라 달라집니다. 일시정지에서 링이 비어 있었는지(이음매 없는 회수)도 워커 타이밍에 달려 있습니다. 그래서 render-ahead 테스트는 재생·탐색·사이클 순환으로 비교합니다.
