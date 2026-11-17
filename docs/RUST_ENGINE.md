# Rust 렌더 엔진 (4단계)

> **상태 (2026-11-16, 첫 마일스톤):** `rust/garak-engine`이 오디오 트랙(PCM 클립·게인·페이드·크로스페이드), 트랙 볼륨/팬/뮤트/솔로, 내장 이펙트 체인(garak-dsp), 센드/리턴, 마스터, 볼륨/팬/뮤트/센드/인서트 파라미터 오토메이션, 템포 맵을 C++ `RenderEngine`과 같은 의미로 렌더합니다. 같은 엔진이 **네이티브(C++ 호스트, `garak-ffi`)와 브라우저(WASM, `garak-engine-wasm`)에서 처음부터 똑같이** 돕니다. 패리티: C++ 엔진 대비 **비트 동일**(MinGW·MSVC, 오프라인 내보내기 4종 + 재생 중 diff, C++·Rust 이펙트 모두. macOS arm64는 Rust 이펙트 기준 비트 동일, C++ 이펙트 기준 ≤ -138 dBFS), WASM 대비 네이티브 Rust **-144.5 dBFS**. **앱은 아직 이 엔진을 쓰지 않습니다**(기본 동작 변화 없음). VST3·입력 모니터링·녹음은 다음 마일스톤입니다([9장](#9-이번-마일스톤의-범위와-다음-단계)).

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
src/audio/rust/garakEngineWasm.ts  워크릿·Node 공용 로더 (앱에서 아직 import하지 않음)
src/audio/rust/engine.test.ts      WASM 렌더 ↔ 네이티브 Rust 렌더
native/tests/rust_engine_parity_test.cpp  C++ RenderEngine ↔ Rust 엔진 (GARAK_RUST=ON)
native/tests/rust_engine_bench.cpp        16/32트랙 CPU 비교
native/tests/rust_engine_instrument_parity_test.cpp  악기 패리티(C++ ↔ Rust) + `bench` 인자로 악기 중심 프로젝트 CPU 비교
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

## 5. WASM 호스트 (AudioWorklet)

같은 크레이트를 `wasm32-unknown-unknown`으로 빌드합니다(`garak-engine-wasm`, `profile wasm`).

- **모듈 = 워크릿 노드 하나 = 엔진 하나.** 원시 `extern "C"` 내보내기라 `AudioWorkletGlobalScope`에서 글루 없이 돕니다(`garakEngineWasm.ts`가 Node·워크릿 공용 로더).
- 제어 호출(`put_asset`, `set`, `patch`, `transport`)은 워크릿의 `port.onmessage`에서, `process()` 사이에 실행합니다. 이 호출은 메모리를 키울 수 있으므로 로더가 호출 뒤 뷰를 다시 만듭니다. `garak_engine_render`는 할당하지 않으므로(3.2의 테스트) `process()`마다 같은 출력 뷰를 씁니다.
- 큰 `project.set`의 파싱·IR 생성은 워크릿 스레드에서 돌면 렌더 퀀텀을 놓칠 수 있습니다. 5단계에서는 계획 준비를 Worker의 두 번째 인스턴스에서 하고 결과를 넘기는 방식, 또는 증분 준비(트랙 단위 Replace)로 나눕니다. 이번 마일스톤은 오프라인 렌더로 동작만 확인합니다.
- 크기: `garak_engine_wasm.wasm` 477 KiB(488,050 B, gzip 195,731 B; 악기 전 277 KiB / gzip 115 KB). 늘어난 대부분은 악기 코드 자체(IEUM WAVE 신스·테이블 준비와 팩토리 하모닉 표, 옥구슬 EP·한밤 106 커널, 내장 보이스, 샘플 세트 파서, 커서·승계 로직)입니다. 제어 쪽 정렬은 인스턴스마다 수 KiB가 드는 std 정렬 대신 공용 인덱스 병합 정렬 하나를 씁니다(-60 KB). 앱에 넣기 전에 `no_std` + 작은 할당기, 오류 문자열 축소로 줄입니다. CI가 크기를 보고합니다. `garak-dsp.wasm`(이펙트·빈티지 악기 워크릿)은 그대로 145 KiB(예산 160 KiB).
- 결정성: 네이티브는 플랫폼 libm(`platform-math`), WASM은 `libm` 크레이트라 비트 동일은 보장하지 않지만 패리티 테스트에서 **-144.5 dBFS**였습니다(7장).

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

| 테스트 | 비교 | 기준 |
|---|---|---|
| `native/tests/rust_engine_parity_test.cpp` (`ctest -R native-rust-engine-parity`) | C++ `RenderEngine` ↔ Rust 엔진, 같은 JSON·PCM(`testkit`을 C ABI로 받아 양쪽에 투입) | residual ≤ -90 dBFS, 지연·길이 동일 |
| `src/audio/rust/engine.test.ts` | WASM 엔진 ↔ 네이티브 Rust 엔진(`cargo test`가 `rust/target/engine-parity/`에 쓴 렌더) | ≤ -90 dBFS |
| `rust/garak-engine/tests/engine.rs` | diff 경로 ↔ 같은 편집을 새 그래프로(`Controller::rebuild`) | ≤ 1e-6 (프로토콜 8.5) |
| `rust/garak-engine/tests/realtime.rs` | 렌더 중 힙 사용 | 0회 |
| `native/tests/rust_engine_instrument_parity_test.cpp` (`ctest -R native-rust-engine-instruments`) | C++ ↔ Rust, 악기 프로젝트(`testkit/instruments.rs`) 오프라인 + 재생 중 편집 | residual ≤ -90 dBFS, 지연·길이·diff 분류 동일 |
| `rust/garak-engine/tests/instruments.rs` | `engine_test.cpp`의 악기 항목(측정값·동등성) | 원래 기준 그대로 |
| `rust/garak-engine/tests/realtime_instruments.rs` | 악기·라이브 MIDI·교체 중 힙 사용 | 0회 |

테스트 프로젝트(`testkit.rs`): 오디오 트랙 N개 + 리턴 2개. 겹치는 윈도(크로스페이드)와 페이드 5종, 클립 오프셋·게인, 모노/스테레오/44.1 kHz PCM(48 kHz 엔진에서 리샘플), 기타 랙을 뺀 내장 이펙트 15종 전부(드라이브가 PDC 8프레임: 트랙 쪽 8 + 리턴 쪽 8로 센드/리턴 지연 보정까지 거침), 꺼진 인서트, 프리/포스트 센드, 볼륨·팬·뮤트·센드·인서트(컷오프 로그 범위, 컴프 임계값) 오토메이션, 템포 램프(싱크 딜레이·트레몰로), `audible:false` 트랙의 프리 센드 무음. PCM은 사칙연산만으로 만들어 플랫폼마다 같습니다.

C++ 쪽은 두 번 돌립니다: C++ 이펙트로(완전히 독립된 두 구현) 그리고 `GARAK_RUST_EFFECTS=all`처럼 Rust 이펙트로(엔진 구조만 비교). 오프라인 경우는 host.cpp `renderStopped`와 같은 루프(길이 + 꼬리 ≤ 30 s, PDC 앞쪽 제거)이고, 라이브 경우는 재생 중 0.5 s에 Mix+Send+Param+Master diff, 1.5 s에 트랙 재준비를 두 엔진에 같은 JSON으로 보냅니다(분류 결과 `Diff`/`Tracks`도 같아야 통과).

악기 프로젝트(`testkit/instruments.rs`): IEUM WAVE(사용자 뱅크 + 유니즌 3 + 세 오실레이터 + 서브·노이즈 + 필터 두 개 + LFO/엔벨로프/벨로시티 루트 + 드라이브·코러스·딜레이 패치, 그리고 기본 패치; base64 IEWAVE01로 전송), 신스 5종 + 드럼(화음·겹치는 같은 음·클립 끝에서 잘린 음·프로젝트 앞에서 시작한 음, 벤드+범위·모드·프레셔·CC7/11, 트랙마다 악기 파라미터 오토메이션, EQ 인서트, 리버브 리턴 센드), 샘플(4단 벨로시티 그랜드 + 릴리스 존 + 코덱 오프셋, 루프 걸린 44.1 kHz 스테레오 찰현, 벨로시티 3단·초크 킷), 빈티지(서스테인 페달 포함), 전부. PCM은 사칙연산만으로 합성해 플랫폼마다 같습니다. 재생 중 경우는 사이클(1–4 s) 안에서 노브 편집(같은 소스 → 교체 + 보이스 승계), 울리는 음표 삭제·음표 이동·재생 위치에 걸친 음표 추가, 믹스, 탐색(페달 구간), 라이브 MIDI(키·EP·106, 페달·벤드·미리 듣기·패닉), 다른 악기로 교체, 템포 변경(새 그래프), 일시정지·정지·재생, 트랙 삭제(새 그래프)를 두 엔진에 같은 시점에 보냅니다(분류도 같아야 통과).

### 7.2 결과 (이 PC, MinGW-w64 GCC 16 Release, x86-64)

| 경우 | 트랙 | 블록 | 이펙트 | 지연 C++/Rust | residual |
|---|---|---|---|---|---|
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 4 s | 8+2 | 128 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 44.1 kHz, 3 s | 6+2 | 4096 | C++ / Rust | 16 / 16 | **비트 동일** |
| 오프라인 내보내기 48 kHz, 1 s | 1+2 | 512 | C++ / Rust | 0 / 0 | **비트 동일** |
| 재생 중 diff(믹스·센드·파라미터·마스터) + 트랙 재준비 | 8+2 | 128 | C++ / Rust | — | **비트 동일** |
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

악기 중심 프로젝트(악기 트랙 12개(IEUM WAVE 포함) + 리버브 리턴, 촘촘한 화음, `garak-rust-engine-instrument-parity-test bench 10 3 128`, 이 PC):

| 프로젝트 | C++ 엔진 + C++ 이펙트 | C++ 엔진 + Rust 이펙트 | Rust 엔진 | 블록당 µs (C++ / Rust) |
|---|---|---|---|---|
| 악기 12트랙 + 리턴 | 1.6× 실시간 | 1.7× | **1.9×** (1.20배 빠름) | 1711 / 1431 |
| 악기 11트랙 + 리턴 (WAVE 제외) | 2.0× | 2.1× | **2.5×** (1.26배 빠름) | 1324 / 1048 |

보이스 합성 자체(초월 함수 호출, WAVE의 테이블 보간)는 두 엔진이 같은 식이라 오디오 트랙만큼 차이가 나지 않습니다. Rust 쪽은 마지막 활성 보이스 뒤를 건너뛰고(합산 순서가 같아 출력은 그대로), 릴리스 존이 없는 트랙은 릴리스 검사를 생략합니다.

### 7.4 단계 게이트

| 게이트 | 조건 | 상태 |
|---|---|---|
| G1 (이번) | 오디오 트랙·이펙트·센드·오토메이션·템포 맵 오프라인/라이브 패리티 ≤ -90 dBFS, 렌더 무할당, WASM ↔ 네이티브 ≤ -90 dBFS, CI(MSVC·macOS) | 통과 (MinGW·MSVC·macOS) |
| G2 | 내장 신스·드럼·샘플 악기 + 컨트롤러, 음표 상태 이전 | 통과 (IEUM WAVE 포함, MinGW 비트 동일) |
| G3 | VST3·IEUM WAVE 외부 hook, 입력 모니터링·녹음 탭, 멀티코어 | |
| G4 | `engine_test.cpp`의 모든 항목을 Rust 엔진 하네스로 옮겨 통과, 장시간 재생 소크 테스트, CPU ≥ C++ (MSVC·macOS) | |
| G5 | 데스크톱 호스트에서 기능 플래그(`GARAK_RUST_ENGINE=1`)로 전환 가능, 이후 기본값 | |

## 8. 5단계(웹 전환) 중 지금 병렬로 할 수 있는 일

**지금 바로 (엔진 패리티를 기다리지 않음):**

- **워크릿 호스트 뼈대:** `garakEngineWasm.ts` 로더 위에 `AudioWorkletProcessor` 하나(입력 없음, 스테레오 출력)와 메인 스레드 브리지를 만들고, `timelineSync.ts`가 이미 만드는 `project.set`/`project.patch` 메시지와 바이너리 프레임을 `port.postMessage`로 그대로 보내는 경로. 데스크톱 `native-audio.ts`와 같은 메시지를 쓰므로 렌더러 쪽 계획 컴파일은 공유됩니다.
- **PCM 전달:** 웹의 디코드된 `AudioBuffer`를 `putAsset`(인터리브 f32)로 넘기는 코드, 메모리 예산·해제(`remove_asset`) 정책.
- **기능 플래그와 대체 동작:** `rustDspRequested()`와 같은 방식의 `rustEngineRequested()`(기본 꺼짐), 모듈이 없거나 실패하면 지금의 `WebAudioEngine`.
- **오디오 트랙만 있는 프로젝트의 A/B:** 이번 마일스톤 범위(오디오 클립·이펙트·센드·오토메이션)는 이미 패리티가 있으므로, 그런 프로젝트를 플래그로 워크릿 엔진에서 재생하고 `WebAudioEngine`과 귀로·측정으로 비교하는 작업(웹 Web Audio 그래프와 C++ 엔진 사이의 기존 차이를 찾는 일이기도 함).
- **WASM 크기 줄이기**(5장), **워크릿 준비 비용 분리**(큰 `project.set` 파싱·IR 생성을 Worker로).
- 계측: 워크릿 `process()` 시간, 언더런 카운터, 스냅숏(위치·피크) 게시.

**패리티를 기다리는 일:**

- **웹 기본값 전환:** G2(내장 악기·샘플)까지 끝나야 합니다(웹 프로젝트 대부분이 악기 트랙). 데스크톱 기본값 전환은 G4~G5.
- **TS 그래프(`graph.ts`, `WebAudioEngine` 렌더 부분)와 C++ `RenderEngine` 트랙 루프 삭제(6단계):** 양쪽 기본값 전환 후 한 릴리스 이상 지나서.
- 웹 녹음·입력 모니터링을 엔진 경유로 바꾸는 일(G3의 입력 탭 이후).

## 9. 이번 마일스톤의 범위와 다음 단계

**포함:** 오디오 클립(PCM, 게인, 페이드 5종, 크로스페이드, 클릭 가드, 리샘플, 다운믹스), 트랙 볼륨/팬(모노 등전력·스테레오 밸런스)/뮤트/솔로(`audible`/`unmutedAudible`), 내장 이펙트 15종 체인과 PDC, 프리/포스트 센드와 리턴(리턴 지연 보정 포함), 마스터 게인·마스터 프로세서, 볼륨·팬·뮤트·센드·인서트 파라미터 오토메이션(샘플 단위 / 32프레임 청크), 템포 맵(싱크 이펙트), 사이클·정지·탐색, project.set/patch 파싱과 diff 분류·상태 이전, 오프라인 렌더 API, C ABI, WASM 빌드.

**악기 마일스톤에서 추가:** 내장 신스 5종·드럼·샘플 악기/킷·옥구슬 EP·한밤 106·IEUM WAVE(패치 교체 크로스페이드 포함), 음표/컨트롤러 커서, 페달·벤드·모드·프레셔·CC7/11, 릴리스 노이즈, 보이스 스틸·초크, 탐색·사이클 추적, 음표 id 재부여·지운 음표 릴리스, 악기 파라미터 오토메이션, 라이브 MIDI(엔진 API·C ABI·WASM), 샘플 세트 등록.

**아직 아님:** 얼린 트랙·바운스·스템(`AudioWindow.freeze`, `TrackTimeline.preFader`/`directOut` — 파서가 거부, 옮길 항목은 [BOUNCE_FREEZE_STEMS.md](BOUNCE_FREEZE_STEMS.md#rust-렌더-엔진stage-4이-지원해야-할-것)), 박자 맵(`meterMap` — 메트로놈 전용이라 파싱 없이 무시, 메트로놈을 옮길 때 `native/include/garak/meter.hpp`와 같은 마디 계산 필요; [METER_MAP.md](METER_MAP.md)), VST3 인서트/소스(거부; 4장 설계), 기타 랙(거부), 입력 모니터링·녹음·트랙 라우트 탭(파싱만), 메트로놈·카운트인, 라이브 MIDI의 블록 내 오프셋(`queueLiveMidi`; 지금은 명령 큐로 블록 경계에 적용), 멀티코어·렌더-어헤드, 다이내믹스 미터·트랙 피크 게시(마스터 피크만), 음표 id 재부여.

**다음 마일스톤 제안:**

1. ~~**G2 악기**~~ (완료, 6장: IEUM WAVE까지 모든 내장 악기). WAVE의 메모리 예산(테이블 바이트·인스턴스 추정)은 아직 512 MB 상한 계산에 넣지 않습니다.
2. **웹 워크릿 호스트(병렬):** 8장의 "지금 바로" 항목, 플래그로 오디오 트랙 프로젝트 재생.
3. **G3 외부 hook:** VST3·IEUM WAVE를 C++ 인스턴스로 끼우는 콜백, 입력 탭·녹음, 그리고 엔진 내부 트랙 병렬화.
4. **G4~G5:** 회귀 테스트 전부 이전, 데스크톱 `GARAK_RUST_ENGINE` 플래그, 소크 테스트, 기본값 전환.
