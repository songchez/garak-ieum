# Rust 오디오 코어

> **상태:** 1단계(커널) 구현 완료, **기본값은 여전히 꺼짐.** 기타 랙을 뺀 모든 내장 이펙트(시김새 10종, 파라메트릭 EQ·스윕 필터, 컴프레서, 드라이브, 리버브)가 `rust/garak-dsp`에 있고, C++ 엔진에서는 `GARAK_RUST=ON` 빌드 + 이펙트별 스위치로, 웹 워크릿에서는 기능 플래그로 Rust 커널을 쓸 수 있습니다. 패리티 하네스가 C++·TS 커널과의 차이를 -90 dBFS 이하로 묶습니다([1단계 결과](#1단계-결과-패리티벤치마크크기)). 기본 경로는 그대로 TypeScript 워크릿 커널과 C++ 네이티브 엔진이고, 전환(그리고 `kernels.ts`·`sigimsae_effects.inc` 삭제)은 청취 확인 후 별도 PR에서 합니다.

## 왜 Rust인가

지금은 같은 DSP를 두 번 씁니다. 브라우저용 `src/devices/effects/kernels.ts`와 데스크톱용 `native/src/*.cpp`가 "한 줄씩 같게" 유지되어야 하고, 어긋나면 웹과 데스크톱 소리가 달라집니다. Rust 코어 하나를

- **WASM**으로 컴파일해 브라우저 AudioWorklet에서,
- **정적 라이브러리**로 컴파일해 기존 C++ 호스트(`garak-audio-host`)에 링크해서

쓰면 커널이 한 벌이 됩니다. 덤으로 `no_std`·린트로 "오디오 스레드에서 할당·패닉 금지"를 컴파일러가 강제합니다. 한 번에 갈아엎지 않고 커널 단위로 옮깁니다(아래 [단계별 이전](#단계별-이전-계획)).

## 구조

```
rust/
  rust-toolchain.toml    고정 툴체인(1.100.0, minimal + rustfmt/clippy + wasm32)
  Cargo.toml             워크스페이스, 린트, 빌드 프로필
  .cargo/config.toml     wasm32 플래그(simd128 등, 스택 64 KiB)
  garak-dsp/             커널 본체. #![no_std], alloc 없음, 의존성은 libm 하나
    src/biquad.rs        dsp.cpp Biquad::configure/sample, eqModel.ts sectionCoefficients
    src/gain.rs          dbToGain, 등전력 모노 팬·스테레오 밸런스(engine.cpp 트랙 믹스 루프), ChannelStrip
    src/utility.rs       sigimsae_effects.inc UtilityFx = kernels.ts UtilityKernel
    src/smooth.rs        12 ms 파라미터 글라이드
    src/params.rs        이펙트 종류(EffectKind)와 파라미터 카탈로그(dsp.cpp effectDefs와 같은 id·순서·범위)
    src/lines.rs         호출자 저장 공간 위의 Ring / DelayLine(O(1) reset) / Carver
    src/fx/mod.rs        Kernel 트레이트, Fx(모든 이펙트를 하나로 감싼 타입)
    src/fx/modulation.rs Chorus, Flanger, Phaser, Tremolo(오토팬·템포 싱크)
    src/fx/dynamics.rs   Compressor(dsp.cpp), Limiter, Gate + 다이내믹스 미터 탭
    src/fx/color.rs      Tape, Bitcrusher, Drive(2배 오버샘플 Saturator)
    src/fx/delay.rs      StudioDelay(핑퐁·싱크·테이프 에이지·필터·dry)
    src/fx/eq.rs         BiquadChain: 8밴드 파라메트릭 EQ(eq_effects.inc), 스윕 필터
    src/fx/reverb.rs     IR 합성(impulse), FFT, 분할 컨볼루션, Reverb
  garak-ffi/             C ABI staticlib (#![no_std]) + include/garak_rust.h (손으로 작성)
    src/fx.rs            garak_rs_fx_* / garak_rs_reverb_*
  garak-wasm/            워크릿용 cdylib: 원시 extern "C" 내보내기, 정적 메모리
    src/fx.rs            garak_fx_* (슬롯 모델)
    src/arena.rs         이펙트 버퍼용 영역 할당(생성 시에만 memory.grow)
native/cmake/GarakRust.cmake      -DGARAK_RUST=ON일 때 cargo로 garak-ffi 빌드, garak_core에 링크, 패리티 테스트·벤치
native/src/rust_effects.inc       RustEffect: StereoProcessor를 Rust로 구현하는 어댑터 + 이펙트별 스위치
native/tests/rust_parity_test.cpp Rust ↔ 기존 C++ 커널 비교(모든 이펙트)
native/tests/rust_bench.cpp       CPU 기준선(이펙트별 frames/s, C++ vs Rust)
src/audio/rust/garakWasm.ts       워크릿에서도 쓸 수 있는 WASM 로더(createEffect 포함)
src/audio/rust/sigimsaeRust.ts    워크릿 어댑터: Rust 이펙트를 SigimsaeKernel로
src/audio/rust/flag.ts            기능 플래그(기본 꺼짐)
src/audio/rust/parity.test.ts     Rust(WASM) ↔ 기존 TS 커널 비교
scripts/setup-rust.ps1 / .sh      한 번에 설치
scripts/rust.mjs                  pnpm rust:* 명령
.github/workflows/rust.yml        CI
```

## 한 번에 설치

```powershell
# Windows (관리자 권한·Visual Studio 필요 없음)
powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1
```

```sh
# macOS / Linux
sh scripts/setup-rust.sh
```

스크립트가 하는 일:

1. rustup이 없으면 rust-lang 공식 설치 파일(`static.rust-lang.org`의 `rustup-init.exe`, `sh.rustup.rs`)로 설치합니다. 기본 툴체인은 깔지 않고 `--profile minimal`만 씁니다.
2. **Windows에 Visual Studio C++ 도구가 없으면** rustup 기본 호스트를 `x86_64-pc-windows-gnu`로 바꿉니다. Rust의 GNU 툴체인은 자체 MinGW 링커(`rust-mingw`)를 함께 받으므로 **수 GB짜리 VS Build Tools를 깔 필요가 없습니다.** (되돌리기: `rustup set default-host x86_64-pc-windows-msvc`. 호스트를 적지 않은 툴체인 이름에만 영향이 있습니다.) VS가 있으면 MSVC를 그대로 씁니다.
3. `rust/rust-toolchain.toml`에 고정된 툴체인을 설치하고(`rustup toolchain install`), `cargo test --workspace`로 확인합니다. `-SkipVerify` / `--skip-verify`로 확인을 건너뜁니다.

다시 실행해도 안전합니다. 이미 설치된 rustup이 있으면 고정 버전만 추가합니다. `rust/` 안에서 cargo를 부르면 rustup이 항상 고정 버전을 고르므로 "내 컴퓨터에선 됐는데" 문제가 없습니다.

## 매일 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `pnpm rust:test` | `cargo test --workspace` (커널 단위 테스트, FFI 헤더 누락 검사) |
| `pnpm rust:check` | `cargo fmt --check` + clippy(호스트, wasm32) `-D warnings` |
| `pnpm rust:wasm` | `garak-wasm`을 빌드해 `public/wasm/garak-dsp.wasm`에 복사, 크기 예산(128 KiB, gzip 80 KB) 확인 |
| `pnpm rust:build` | 네이티브 `garak-ffi` 정적 라이브러리(release) |
| `pnpm exec vitest run src/audio/rust` | WASM ↔ TS 패리티 |
| CMake `-DGARAK_RUST=ON` 후 `ctest -R native-rust-parity` | Rust ↔ C++ 패리티(표 출력). 인자로 이펙트 하나만: `garak-rust-parity-test delay` |
| `garak-rust-bench [초]` | 이펙트별 CPU 기준선(Markdown 표) |
| `GARAK_RUST_EFFECTS=all ctest -R native-engine` | 엔진 회귀 테스트 전체를 Rust 이펙트로 |

`cargo`를 직접 쓰려면 `rust/`에서 실행하세요. 추가 인자는 그대로 넘어갑니다: `pnpm rust:test -- biquad`.

C++ 패리티 테스트(코어만, 장치·VST3 없이):

```sh
cmake -S native -B build/native-rust -DGARAK_RUST=ON -DGARAK_ENABLE_DEVICES=OFF -DGARAK_ENABLE_ASIO=OFF -DGARAK_ENABLE_VST3=OFF
cmake --build build/native-rust --config Release --target garak-rust-parity-test
ctest --test-dir build/native-rust -C Release -R native-rust-parity --output-on-failure
```

로컬 MinGW 빌드는 MinGW `bin`을 PATH에 두고 `-G Ninja`로 구성하면 됩니다(기존 `build/native-mingw`와 같은 방식). 이미 받은 의존성 원본이 있으면 `-DGARAK_DEPENDENCY_CACHE=<...>/build/native-deps/archives`로 다시 받지 않습니다.

## 웹만 작업하는 사람은 Rust가 필요 없습니다

- WASM 결과물은 **커밋하지 않습니다**(`/public/wasm/`는 gitignore). CI(`rust.yml`)가 빌드해 크기를 보고하고 아티팩트로 올리며, 로컬에서는 `pnpm rust:wasm`이 만듭니다. 빌드 결과는 rustc 버전이 고정되어 있어 재현 가능하지만, 바이너리를 저장소에 두면 소스와 어긋나기 쉬워서 CI 빌드 + 캐시를 택했습니다.
- 앱은 결과물이 없어도 그대로 동작합니다. `loadGarakWasmModule()`은 파일이 없거나 깨졌으면 예외 대신 `null`을 돌려주고, 호출하는 쪽은 기존 TS 커널을 씁니다.
- 기능 플래그 `rustDspRequested()`(`src/audio/rust/flag.ts`)는 기본 꺼짐입니다. 켜려면 `VITE_GARAK_RUST_DSP=1 pnpm dev` 또는 브라우저 콘솔에서 `localStorage.setItem('garak.rustDsp', '1')` 후 새로고침. 켜져 있고 결과물이 있으면 `prepareSigimsae()`가 모듈을 컴파일해 시김새 워크릿 노드의 `processorOptions.garakWasm`으로 넘기고, 워크릿은 `createRustKernel()`로 Rust 커널을 씁니다(실패하면 조용히 TS 커널). 나중에 기본으로 바꿀 때는 `rustDspRequested()`의 기본값 한 줄만 바꾸면 됩니다.
- `pnpm test`에 포함된 `parity.test.ts`는 결과물이 없으면 패리티 묶음을 건너뜁니다(로더 대체 동작 테스트만 실행).
- 나중에 Rust 경로를 기본으로 바꾸는 시점에는 배포 빌드가 `pnpm rust:wasm`을 먼저 실행하거나 CI 아티팩트를 받아야 합니다. 그 전환은 별도 PR에서 정합니다.

## 툴체인·타깃 표

| 환경 | Rust 호스트/타깃 | C++ 컴파일러 | 비고 |
|---|---|---|---|
| 로컬 Windows (VS 없음) | `x86_64-pc-windows-gnu` (기본 호스트로 설정) | MinGW-w64 (UCRT) | rust-mingw 자체 링커 사용. 고정 파일에는 넣지 않음 |
| 로컬 Windows (VS 있음) | `x86_64-pc-windows-msvc` | MSVC | 설정 변경 없음 |
| CI Windows | `x86_64-pc-windows-msvc` | MSVC (windows-latest) | `rust.yml` native-parity |
| CI·로컬 macOS | `aarch64-apple-darwin` | AppleClang arm64 | `rust.yml` native-parity |
| CI Linux | `x86_64-unknown-linux-gnu` | — | fmt·clippy·test·WASM |
| 브라우저 | `wasm32-unknown-unknown` | — | 고정 파일의 `targets`에 있는 유일한 추가 타깃 |

CMake(`GarakRust.cmake`)는 컴파일러로 타깃을 고릅니다: MSVC → `*-pc-windows-msvc`, MinGW → `*-pc-windows-gnu`, Apple → `CMAKE_OSX_ARCHITECTURES`에 맞는 `*-apple-darwin`. `-DGARAK_RUST_TARGET=`으로 덮어쓸 수 있습니다. C++ ABI(MSVC ↔ GNU)가 섞이면 링크가 안 되므로 이 짝이 중요합니다.

`garak-ffi`는 `#![no_std]`라서 Rust 표준 라이브러리 런타임(`ws2_32`, `userenv`, `msvcrt` 등)을 끌고 오지 않습니다. 그래서 msvcrt 기반 Rust GNU 타깃을 UCRT MinGW C++과 문제없이 섞을 수 있고, CMake에 플랫폼별 시스템 라이브러리 목록이 필요 없습니다. 쓰는 libc 심볼은 패닉 처리기의 `abort` 하나뿐입니다.

## 실시간 규칙

오디오 콜백 안에서 도는 코드(`process`, `sample`, FFI/WASM 진입점)는:

- **할당 금지.** `garak-dsp`는 `#![no_std]`이고 `alloc` 크레이트를 쓰지 않으므로 할당이 *구조적으로* 불가능합니다. 딜레이 라인·리버브 상태처럼 크기가 샘플레이트에 따라 정해지는 버퍼는 생성 시(제어 스레드) 호출자가 넘긴 `&mut [f32]`를 빌려 씁니다(`Fx::storage_len`으로 크기 조회). FFI는 호출자가 저장 공간을 소유하고(C++ 어댑터의 `std::vector`), WASM은 고정 슬롯 풀과 정적 버퍼, 그리고 이펙트 버퍼용 영역 할당기(`arena.rs`)를 씁니다. WASM 메모리는 **이펙트를 만들 때만** 자라고(`process`에서는 절대 안 자람), 로더가 그 뒤 뷰를 다시 만듭니다.
- **락·I/O 금지.** `no_std`에는 둘 다 없습니다.
- **패닉 금지.** 워크스페이스 린트로 `clippy::{unwrap_used, expect_used, panic, todo, unimplemented, unreachable, indexing_slicing}`을 `deny`합니다(테스트 코드는 `clippy.toml`로 허용). 범위를 벗어난 입력은 거절하지 않고 잘라 냅니다(NaN 포함). 모든 프로필이 `panic = "abort"`이고, 그래도 버그로 패닉이 나면 staticlib은 `abort()`, WASM은 `unreachable` 트랩으로 끝납니다(풀린 스택이 C++ 프레임을 넘지 않음).
- **결정성.** 삼각·지수 함수는 순수 Rust `libm`을 써서 네이티브와 wasm32의 결과가 비트 단위로 같습니다.
- `unsafe`는 FFI/WASM 경계에만 있고 모두 `// SAFETY:` 주석이 있습니다(`unsafe_op_in_unsafe_fn = deny`).

## 1단계: 내장 이펙트 커널

### 범위

`makeEffect()`가 만드는 모든 내장 이펙트 중 기타 랙(2단계)을 뺀 15종입니다.

| 종류 | C++ 원본 | TS 원본 | Rust |
|---|---|---|---|
| delay(핑퐁·싱크·테이프 에이지·하이/로우컷·dry), chorus, phaser, flanger, tremolo(오토팬·싱크), limiter, gate, tape, bitcrusher, utility | `sigimsae_effects.inc` | `kernels.ts` | `fx/{delay,modulation,dynamics,color}.rs`, `utility.rs` |
| eq(8밴드, 밴드당 최대 4단), filter(스윕) | `eq_effects.inc` | (내장 노드) | `fx/eq.rs` |
| compressor, drive(17탭 하프밴드 2배 오버샘플, 지연 8프레임) | `dsp.cpp` | (내장 노드) | `fx/dynamics.rs`, `fx/color.rs` |
| reverb(IR 합성 + 64/512/4096 분할 컨볼루션, 프리딜레이, dry) | `dsp.cpp` | `reverb.ts`(IR만) | `fx/reverb.rs` |

C++ 클래스 구조를 그대로 옮겼습니다: 같은 상태, 같은 연산 순서, 같은 float 반올림 지점(`static_cast<float>` 위치), `std::max/min/clamp`의 비교 방향까지. 단순화한 곳은 Rust가 허용하는 범위입니다:

- 블록마다 다시 계산하던 값(`step = 2π·rate/sr`)은 값이 바뀔 때 미리 계산합니다(같은 식이라 결과 동일).
- `DelayLine`의 세대 도장(O(1) reset)은 `u64` 대신 같은 `f32` 저장 공간에 정수로 넣습니다(2^24에서 한 번 지우고 처음부터).
- 리버브의 복소수는 `[f32; 2]`, 비트 반전은 `reverse_bits()`로 즉석 계산합니다.

### 공통 인터페이스

```rust
pub trait Kernel {                      // fx/mod.rs
    fn automate(&mut self, p: &ParamSet);   // C++ StereoProcessor::automate (제자리, 글라이드)
    fn set_tempo(&mut self, bpm: f64) {}    // 템포 맵(딜레이·트레몰로 싱크)
    fn frame(&mut self, l: f32, r: f32) -> (f32, f32);
    fn reset(&mut self);
    fn latency_frames(&self) -> u32 { 0 }   // drive: 8
    fn tail_seconds(&self) -> f64 { 0.0 }
    fn take_meter(&mut self) -> Option<(f32, f32)> { None } // 컴프·리미터·게이트
    fn process_interleaved(..); fn process_planar(..);      // 기본은 frame 반복, EQ는 필터 단위
}
```

`Fx<'a>`가 15종을 하나로 감싸고(`Fx::new(kind, sr, bpm, params, storage, kernels, ir_len)`), 파라미터는 C++ `effectDefs()`와 같은 id·순서의 `ParamSet`(범위 밖은 잘라 내고 NaN은 무시)으로 받습니다. `set_param` + `commit`(EffectControl처럼 바뀐 값이 있을 때만 automate), `automate(전체 값)`, `take_state_from`(C++ `takeStateFrom`: 오디오 기록과 글라이드 현재값 인계)을 제공합니다.

**리버브 IR.** `reverb::generate_ir`가 dsp.cpp `impulse()`와 같은 IR을 만들고, `reverb::prepare_kernels`가 *어떤* IR이든(직접 합성한 것이든 캐시에서 가져온 것이든) FFT 분할 커널로 만듭니다. 커널 저장 공간은 생성 후 읽기 전용이라 같은 IR을 쓰는 리버브끼리 공유할 수 있고, 상태 저장 공간만 리버브마다 따로 둡니다. 다른 브랜치의 IR 캐시가 들어오면 `prepare_kernels`에 캐시된 IR(또는 미리 만든 커널)을 넘기면 됩니다.

### C++: `GARAK_RUST=ON`과 이펙트별 스위치

- `GarakRust.cmake`가 `garak_core`에 `garak_rust`를 링크하고 `GARAK_RUST=1`로 `dsp.cpp`를 컴파일합니다. `native/src/rust_effects.inc`의 `RustEffect`가 `StereoProcessor`를 구현해 `garak_rs_fx_*`를 부릅니다: 생성 시 C++과 같은 `Reader` 검증(같은 예외), C++·Rust 카탈로그 id·순서 대조(다르면 `logic_error`), `automate(Reader)`, `setTempo`, `dynamics()` 탭, `latencyFrames`/`tailSeconds`, `takeStateFrom`(Rust가 두 상태 저장 공간을 통째로 맞바꿨으면 소유한 `std::vector`도 맞바꿈, O(1)).
- **기본값은 C++ 그대로입니다.** Rust로 돌릴 이펙트는
  - 빌드 시: `-DGARAK_RUST_EFFECTS="chorus;delay"` 또는 `all`
  - 시작 시: 환경 변수 `GARAK_RUST_EFFECTS=all` (청취 비교용)
  - 실행 중: `garak::dsp::setEffectBackend("delay", EffectBackend::Rust)`, 명시적으로는 `makeEffect(type, params, sr, bpm, EffectBackend::Rust)` (패리티 하네스)
- `GARAK_RUST=OFF`(기본) 빌드는 `rust_effects.inc`를 아예 포함하지 않고, `EffectBackend::Rust`를 요청하면 예외를 던집니다.

### C ABI (`garak_rust.h`, ABI 2)

불투명 상태(`garak_rs_fx_size/align`) + 상태 저장 공간(`garak_rs_fx_storage_len`) + 리버브 커널(`garak_rs_reverb_ir_len/generate_ir/kernel_len/prepare_kernels`)을 호출자가 할당하고 `garak_rs_fx_init`으로 만듭니다. 오디오 스레드: `process`, `process_planar`, `automate`, `set_param`/`commit`, `set_tempo`, `reset`, `meter`, `take_state`. 언제든: `latency`, `tail`, `param`, 카탈로그 조회(`param_count/param_id/param_range`). Rust 소멸자가 없으므로(컴파일 시 `!needs_drop` 확인) C++은 메모리만 해제합니다.

### WASM과 워크릿 어댑터

- `garak_fx_create(kind, sr, bpm, count)`가 슬롯 번호를 돌려줍니다(정적 `f64` 파라미터 버퍼로 값 전달, 카탈로그 순서). 나머지(`automate`, `set_param`/`commit`, `set_tempo`, `process`, `reset`, `latency`, `tail`, `meter`, `take_state`, `free`)는 기존 바이쿼드·Utility와 같은 슬롯 모델입니다. 리버브는 모듈 안에서 IR을 합성합니다.
- 딜레이 라인·리버브 버퍼는 `arena.rs`(최적 맞춤 재사용 + 이웃 병합, 모자라면 `memory.grow`)에서 받습니다. 생성·해제는 제어 경로(워크릿 생성자, 모드 변경)에서만 일어납니다.
- `GarakWasm.createEffect()`(TS)는 kernels.ts `configure()`와 같은 의미입니다: 빠진 파라미터는 기본값, 범위 밖은 잘라 냄, 템포 먼저 적용, 이후 글라이드.
- `sigimsaeRust.ts`의 `createRustKernel()`이 이를 `SigimsaeKernel`로 감쌉니다. 딜레이의 스테레오/핑퐁 모드는 (네이티브처럼) Rust 이펙트마다 고정이라, 모드가 바뀌면 새 이펙트를 만들어 이전 이펙트의 기록을 넘겨받습니다(`takeStateFrom`). 결과는 TS 커널의 즉시 전환과 같은 소리입니다(패리티 테스트에 포함).
- 워크릿 노드마다 인스턴스 하나, 슬롯 32개.

## 테스트·패리티 전략

정답 해시(golden) 대신 **같은 입력을 기존 커널과 Rust 커널에 넣고 허용 오차로 비교**합니다. 플랫폼 libm의 마지막 비트 차이와 float 출력 반올림은 허용하고, 공식이나 처리 순서가 바뀌면 바로 잡힙니다.

| 테스트 | 비교 대상 | 내용 | 허용 오차 |
|---|---|---|---|
| `cargo test` (garak-dsp) | 이론값 | 차단 주파수 -3 dB, 피크·셸프 이득, 노치 깊이, 등전력 팬, 글라이드 수렴, 이상 입력, FFT 왕복, **분할 컨볼루션 = 직접 컨볼루션**, IR RMS 정규화, 모든 이펙트 생성·처리·미터·지연·꼬리, 저장 공간 부족·잘못된 샘플레이트 거절 | 식별 |
| `cargo test` (garak-ffi) | 헤더 | 내보낸 모든 `garak_rs_*`가 `garak_rust.h`에 선언됐는지, `GARAK_RS_FX_*` 번호, ABI 버전, C ABI 왕복 | — |
| `cargo test` (garak-wasm) | — | 슬롯 상한·재사용, 모든 이펙트 생성·처리·해제 후 힙 원상복구, `take_state` 소유권 교환, 영역 할당기 병합 | — |
| `native-rust-parity` | C++ `makeEffect(..., Cpp)` vs `makeEffect(..., Rust)` (같은 `StereoProcessor` 인터페이스), 바이쿼드, 팬 법칙 | 이펙트마다: 기본값 + 무작위 템포 변경, 파라미터마다 최솟값·최댓값으로 생성, 파라미터마다 `EffectControl` 자동화 스윕(범위 밖 값 포함), 무작위 파라미터 세트 + 블록마다 무작위 자동화 + 템포 변경 + `reset` + `takeStateFrom` 인계, 44.1/96 kHz. 블록 크기는 1~37프레임과 64~512프레임 혼합 | 잔차 **≤ -90 dBFS**, 지연·꼬리 **동일**(1e-9 s), 미터 1e-5 |
| `GARAK_RUST_EFFECTS=all` + `native-engine` | 엔진 회귀 테스트 전체 | 모든 내장 이펙트를 Rust로 바꾼 채 기존 엔진 테스트(자동화·템포 맵·send/return·PDC…) | 기존 기준 |
| `parity.test.ts` | TS `sectionCoefficients`, `Biquad`, `UtilityKernel`, **kernels.ts 10종** vs WASM | 계수 격자, 글라이드, 커널마다 무작위 파라미터 4세트 × `configure()` 변경(빠진 값 = 기본값, 딜레이 모드 전환 포함) + 템포 변경 + `reset` + 홀수 블록, 미터, 생성 시 꼬리(`kernelTailSeconds`), 15종 모두 생성·처리·해제(힙 원상복구) | 잔차 **≤ -90 dBFS**, 미터 1e-5, 꼬리 1e-9 |

검증: 코러스 지연 상수 14 ms → 14.1 ms, 딜레이 드라이브 2 → 2.01로 일부러 바꾸면 C++ 하네스에서 해당 이펙트의 렌더가 모두 실패하는 것(잔차 +2 dBFS 수준)을 확인했습니다. (기반 단계에서는 글라이드 상수 12 → 13 ms로 같은 확인.)

엔진 팬 법칙은 `engine.cpp` 믹스 루프 안에 인라인으로 있어서, C++ 테스트에 그 식을 옮겨 적은 참조본을 두었습니다. 그 루프를 바꾸면 참조본과 `gain.rs`를 함께 고칩니다.

## 1단계 결과: 패리티·벤치마크·크기

### Rust ↔ C++ (`garak-rust-parity-test`)

이펙트별 최대 잔차(모든 렌더 중 최악). -400은 비트 단위로 같다는 뜻입니다. 지연·꼬리는 모든 렌더에서 같은 값, 다이내믹스 미터도 일치했습니다.

| 이펙트 | 렌더 수 | Windows MinGW (로컬) | Windows MSVC (CI) | macOS arm64 (CI) |
|---|---:|---:|---:|---:|
| chorus | 18 | -400 (비트 동일) | CI_MSVC_chorus | CI_MAC_chorus |
| flanger | 21 | -400 | CI_MSVC_flanger | CI_MAC_flanger |
| phaser | 21 | -400 | CI_MSVC_phaser | CI_MAC_phaser |
| tremolo | 24 | -400 | CI_MSVC_tremolo | CI_MAC_tremolo |
| limiter | 18 | -400 | CI_MSVC_limiter | CI_MAC_limiter |
| gate | 21 | -400 | CI_MSVC_gate | CI_MAC_gate |
| tape | 21 | -400 | CI_MSVC_tape | CI_MAC_tape |
| bitcrusher | 18 | -400 | CI_MSVC_bitcrusher | CI_MAC_bitcrusher |
| utility | 24 | -400 | CI_MSVC_utility | CI_MAC_utility |
| delay | 39 | -400 | CI_MSVC_delay | CI_MAC_delay |
| eq | 156 | -210.7 | CI_MSVC_eq | CI_MAC_eq |
| filter | 21 | -400 | CI_MSVC_filter | CI_MAC_filter |
| compressor | 24 | -400 | CI_MSVC_compressor | CI_MAC_compressor |
| drive | 21 | -400 | CI_MSVC_drive | CI_MAC_drive |
| reverb | 24 | -138.5 | CI_MSVC_reverb | CI_MAC_reverb |

MinGW에서 대부분 비트 동일인 것은 같은 식·같은 순서에 `libm`(musl 계열)과 MinGW 수학 함수가 대부분의 입력에서 같은 값을 주기 때문입니다. 리버브는 FFT 회전 인자(`cosf`/`sinf`)와 복소 곱셈 순서 차이로 float 반올림 수준(-138 dBFS) 차이가 납니다. MSVC CRT와 Apple libm(arm64는 FMA 축약까지)은 마지막 비트가 더 자주 달라 잔차가 조금 커집니다.

### Rust(WASM) ↔ TypeScript (`parity.test.ts`, Node 24)

| 커널 | 최대 잔차 |
|---|---:|
| delay | -144.5 dBFS |
| chorus | -138.5 dBFS |
| flanger | -138.5 dBFS |
| tape | -138.5 dBFS |
| phaser, tremolo, limiter, gate, bitcrusher, utility | 비트 동일 |

TS 커널은 바이쿼드 출력을 float로 반올림하지 않고 f64로 다음 단에 넘기므로(C++·Rust는 float) 필터가 있는 커널에서 float 한 비트 정도 차이가 납니다.

### CPU 기준선 (`garak-rust-bench 5`)

48 kHz 스테레오, 128프레임 블록, 바쁜 파라미터 세트(EQ 8밴드 모두 켬, 딜레이 핑퐁+에이지+로우컷 등). 2026-11-16, Windows 11 노트북, MinGW-w64 GCC 16.2 `-O3` vs Rust 1.100.0 `opt-level=3`, thin LTO, 둘 다 기본 x86-64(SSE2):

| 이펙트 | C++ (Mframes/s) | Rust (Mframes/s) | Rust / C++ | C++ 실시간 배수 |
|---|---:|---:|---:|---:|
| chorus | 75.82 | 54.24 | 0.72 | 1580 |
| flanger | 46.00 | 36.66 | 0.80 | 958 |
| phaser | 12.31 | 7.16 | 0.58 | 256 |
| tremolo | 38.49 | 31.48 | 0.82 | 802 |
| limiter | 259.46 | 191.08 | 0.74 | 5405 |
| gate | 448.85 | 470.31 | 1.05 | 9351 |
| tape | 24.21 | 11.66 | 0.48 | 504 |
| bitcrusher | 247.22 | 318.34 | 1.29 | 5150 |
| utility | 369.00 | 311.93 | 0.85 | 7688 |
| delay | 21.95 | 16.69 | 0.76 | 457 |
| eq | 22.57 | 25.48 | 1.13 | 470 |
| filter | 62.32 | 68.81 | 1.10 | 1298 |
| compressor | 52.95 | 22.79 | 0.43 | 1103 |
| drive | 5.60 | 5.94 | 1.06 | 117 |
| reverb | 0.74 | 1.77 | 2.40 | 15 |

해석:

- **초월 함수가 많은 커널(tape의 `tanh`, compressor의 `log10`+`pow`, phaser의 `sin`+`pow`+`tan`)이 0.4~0.6배**입니다. 순수 Rust `libm`(musl 이식)이 플랫폼 수학 라이브러리보다 느리기 때문입니다. 대신 네이티브·wasm32 결과가 비트 단위로 같습니다. 아키텍처 검토의 1단계 게이트(ns/샘플 1.15배 이하)는 아직 못 넘었고, 경로 전환 전에 해결합니다: 후보는 (a) 핫 루프의 `libm` 함수를 더 빠른 구현으로 교체(패리티 허용 오차 안), (b) 블록 단위 계산(LFO 등)으로 호출 수 줄이기.
- **reverb는 2.4배 빠릅니다.** C++의 `std::complex<float>` 곱셈은 NaN 처리 경로(`__mulsc3`) 때문에 느리고, Rust는 단순 곱셈입니다.
- 절대값으로는 가장 무거운 reverb도 C++ 기준 실시간의 15배(Rust 37배)라, 지금 수치로도 트랙당 부하는 작습니다.
- CI의 MSVC·macOS 수치는 각 실행의 Step Summary에 표로 남습니다.

### 크기

| 산출물 | 크기 | 예산 |
|---|---|---|
| `garak-dsp.wasm` (opt-level 3, fat LTO) | **103,835 바이트 (101.4 KiB)**, gzip 37,159 바이트 | 128 KiB / gzip 80 KB (아키텍처 검토의 1단계 예산) |
| 같은 모듈 opt-level `"s"` | 83,820 바이트, gzip 30,346 바이트 | (참고: 워크릿은 CPU가 병목이라 3 유지) |

예산을 96 KiB에서 128 KiB로 올리고 gzip 80 KB 검사를 추가했습니다(`scripts/rust.mjs`, CI가 둘 다 확인). 코드 85 KB 중 대부분은 15종 커널과 `libm` 함수입니다.

## WASM을 wasm-bindgen 없이 쓰는 이유

- `AudioWorkletGlobalScope`에는 `fetch`가 없고 엔진에 따라 `TextDecoder`도 없습니다. wasm-bindgen이 만드는 접착 코드는 이를 가정하고, 워크릿 번들에 ES 모듈로 넣어야 합니다.
- 오디오 경로는 숫자와 `f32` 블록만 오갑니다. 함수 ~40개와 정적 버퍼 몇 개(샘플 2개, 파라미터, 미터, 텍스트)면 충분해서 로더가 평범한 TS입니다(`garakWasm.ts`).
- 흐름: 메인 스레드에서 `loadGarakWasmModule()`로 `WebAssembly.Module`을 컴파일(ABI 확인 포함) → `processorOptions`로 워크릿에 전달(구조적 복제 가능) → 워크릿에서 `instantiateGarakWasm(module)`로 동기 인스턴스화. 이미 컴파일된 모듈이라 ~100 KiB여도 동기 인스턴스화 제한에 걸리지 않습니다.
- 워크릿 노드마다 인스턴스가 하나(단일 스레드)이고 커널 종류마다 슬롯 32개, 한 번에 최대 4096프레임(넘으면 로더가 나눠 처리)입니다. 메모리는 이펙트 생성 때만 자라고, 로더는 매 호출 전 `memory.buffer`가 바뀌었는지 보고 뷰를 다시 만듭니다.

## 빌드 프로필

| 프로필 | 설정 | 용도 |
|---|---|---|
| `dev` | opt-level 0, `garak-dsp`·`libm`만 1, incremental, 줄 번호 디버그 정보만, panic=abort | 편집·테스트 반복 |
| `release` | opt-level 3, `lto = "thin"`, `codegen-units = 1`, panic=abort | 네이티브 staticlib (CMake는 항상 이 프로필) |
| `wasm` | release 상속 + `lto = "fat"`, `strip` | `pnpm rust:wasm`. opt-level `"s"`는 82 KiB로 20 KiB 작지만, 예산 안이고 워크릿은 CPU가 병목이라 3을 유지 |

## 측정값

Windows 11, Rust 1.100.0 (`x86_64-pc-windows-gnu`), 로컬 노트북. 기반 단계(2026-11-15) → 1단계(2026-11-16, 15종 커널):

| 작업 | 기반 | 1단계 |
|---|---|---|
| 툴체인 설치 (rustup 있음, 고정 버전 + wasm32 내려받기) | 약 45초 | (같음) |
| `cargo test --workspace` 깨끗한 빌드(libm 포함) + 실행 | 5.9초 | 11.4초 |
| `garak-dsp` 파일 하나 수정 후 테스트 재빌드 | 1.2초 | 약 2초 |
| `garak-ffi` release 깨끗한 빌드 / 수정 후 | 3.9초 / 0.8초 | 13.8초 / 1.8초 |
| `garak-wasm` (wasm 프로필) 깨끗한 빌드 | 4.5초 | 14.3초 |
| `garak-rust-parity-test` 실행 (15종, 471렌더) | — | 약 5초 |
| `garak-dsp.wasm` 크기 | 24,556 바이트 (24.0 KiB) | **103,835 바이트 (101.4 KiB)**, gzip 37,159 |
| 디스크: 고정 툴체인(gnu, minimal) | 약 1.0 GB (대부분 rustc/LLVM DLL) | (같음) |

## 단계별 이전 계획

전체 아키텍처 검토는 [ARCHITECTURE_REVIEW](ARCHITECTURE_REVIEW.md)(작성되는 대로)와 [AUDIO_CORE_PLAN](AUDIO_CORE_PLAN.md), [NATIVE_AUDIO](NATIVE_AUDIO.md)를 함께 봅니다.

1. **기반 (완료).** 워크스페이스, 설치 스크립트, CI, 패리티 테스트. 작은 커널 세트: 바이쿼드, 게인·팬, Utility.
2. **내장 이펙트 커널 (완료, 이 문서의 1단계).** 시김새 10종, EQ·필터, 컴프레서, 드라이브, 리버브(IR 생성은 제어 스레드 API로 분리, 캐시된 IR 수용). C++ 어댑터 + 이펙트별 스위치(`GARAK_RUST=ON`, 기본 C++), WASM 슬롯 + 워크릿 어댑터(플래그, 기본 꺼짐), 패리티 하네스(C++·TS 모두 ≤ -90 dBFS)와 CPU 기준선. 남은 것: 초월 함수가 많은 커널의 CPU(위 표).
3. **경로 전환.** 청취 확인과 CPU 게이트가 끝난 커널부터 웹 기본 경로를 Rust WASM으로 바꾸고(`rustDspRequested()` 기본값 한 줄 + 배포 빌드에 `pnpm rust:wasm`), 네이티브는 데스크톱 빌드에서 `GARAK_RUST=ON` + `GARAK_RUST_EFFECTS=all`. 같은 PR에서 `kernels.ts`와 `sigimsae_effects.inc`(그리고 EQ·컴프·드라이브·리버브의 C++ 구현)를 지워 "두 벌 유지"를 끝냅니다. 웹의 EQ·필터·컴프·드라이브·리버브는 지금 내장 노드라 이 전환에서 처음으로 웹과 데스크톱 소리가 같아집니다.
4. **상태 많은 처리.** 기타 랙, 그 다음 트랙 믹스 루프(ChannelStrip)와 그래프.
5. **정리.** `GARAK_RUST`를 기본 ON, 플래그 제거, release 워크플로에 Rust 빌드 추가.

## 문제 해결

- **`link.exe` not found / "you may need to install Visual Studio build tools"**: VS 없이 MSVC 호스트가 선택된 상태입니다. `scripts/setup-rust.ps1`을 다시 실행하거나 `rustup set default-host x86_64-pc-windows-gnu` 후 `rust/`에서 `rustup toolchain install`.
- **CMake에서 `can't find crate for core` (타깃 없음)**: C++ 컴파일러와 Rust 호스트가 다릅니다(예: VS 개발자 프롬프트인데 Rust 호스트가 gnu). `rustup target add x86_64-pc-windows-msvc` 또는 반대로 맞춥니다.
- **`Rust is not installed`**: `pnpm rust:*`는 cargo를 PATH와 `~/.cargo/bin`에서 찾습니다. 설치 직후에는 새 터미널을 여세요.
