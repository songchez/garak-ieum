# Rust 오디오 코어

> **상태:** 1단계(기반). `rust/`에 작은 DSP 커널 묶음(바이쿼드, 게인·팬 법칙, Utility)과 C ABI·WASM 빌드, 패리티 테스트가 있습니다. **앱의 어떤 오디오 경로도 아직 Rust를 쓰지 않습니다.** 기본 경로는 그대로 TypeScript 워크릿 커널과 C++ 네이티브 엔진입니다.

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
  garak-ffi/             C ABI staticlib (#![no_std]) + include/garak_rust.h (손으로 작성)
  garak-wasm/            워크릿용 cdylib: 원시 extern "C" 내보내기, 정적 메모리
native/cmake/GarakRust.cmake      -DGARAK_RUST=ON일 때 cargo로 garak-ffi 빌드 + 패리티 테스트
native/tests/rust_parity_test.cpp Rust ↔ 기존 C++ 커널 비교
src/audio/rust/garakWasm.ts       워크릿에서도 쓸 수 있는 WASM 로더
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
| `pnpm rust:wasm` | `garak-wasm`을 빌드해 `public/wasm/garak-dsp.wasm`에 복사, 크기 예산(96 KiB) 확인 |
| `pnpm rust:build` | 네이티브 `garak-ffi` 정적 라이브러리(release) |
| `pnpm exec vitest run src/audio/rust` | WASM ↔ TS 패리티 |
| CMake `-DGARAK_RUST=ON` 후 `ctest -R native-rust-parity` | Rust ↔ C++ 패리티 |

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
- 기능 플래그 `rustDspRequested()`(`src/audio/rust/flag.ts`)는 기본 꺼짐입니다. 켜려면 `VITE_GARAK_RUST_DSP=1 pnpm dev` 또는 브라우저 콘솔에서 `localStorage.setItem('garak.rustDsp', '1')`. 지금은 이 플래그를 읽는 엔진 경로가 없습니다.
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

- **할당 금지.** `garak-dsp`는 `#![no_std]`이고 `alloc` 크레이트를 쓰지 않으므로 할당이 *구조적으로* 불가능합니다. FFI는 호출자가 저장 공간을 소유하고(`GarakRsBiquad`를 값으로 포함), WASM은 고정 슬롯 풀과 정적 버퍼를 씁니다. WASM 메모리는 자라지 않으므로 워크릿의 `Float32Array` 뷰가 떨어져 나가지 않습니다.
- **락·I/O 금지.** `no_std`에는 둘 다 없습니다.
- **패닉 금지.** 워크스페이스 린트로 `clippy::{unwrap_used, expect_used, panic, todo, unimplemented, unreachable, indexing_slicing}`을 `deny`합니다(테스트 코드는 `clippy.toml`로 허용). 범위를 벗어난 입력은 거절하지 않고 잘라 냅니다(NaN 포함). 모든 프로필이 `panic = "abort"`이고, 그래도 버그로 패닉이 나면 staticlib은 `abort()`, WASM은 `unreachable` 트랩으로 끝납니다(풀린 스택이 C++ 프레임을 넘지 않음).
- **결정성.** 삼각·지수 함수는 순수 Rust `libm`을 써서 네이티브와 wasm32의 결과가 비트 단위로 같습니다.
- `unsafe`는 FFI/WASM 경계에만 있고 모두 `// SAFETY:` 주석이 있습니다(`unsafe_op_in_unsafe_fn = deny`).

## 테스트·패리티 전략

정답 해시(golden) 대신 **같은 입력을 기존 커널과 Rust 커널에 넣고 허용 오차로 비교**합니다. 플랫폼 libm의 마지막 비트 차이와 float 출력 반올림은 허용하고, 공식이나 처리 순서가 바뀌면 바로 잡힙니다.

| 테스트 | 비교 대상 | 내용 | 허용 오차 |
|---|---|---|---|
| `cargo test` (garak-dsp) | 이론값 | 차단 주파수 -3 dB, 피크·셸프 이득, 노치 깊이, 등전력 팬, 글라이드 수렴, 이상 입력 | 식별 |
| `cargo test` (garak-ffi) | 헤더 | 내보낸 모든 `garak_rs_*`가 `garak_rust.h`에 선언됐는지, ABI 버전 | — |
| `native-rust-parity` | C++ `garak::dsp::Biquad`, `makeEffect("utility")`, engine.cpp 팬 법칙 | 7개 필터 형태 + 범위 밖 값, 재설정 글라이드(`takeHistoryFrom`), Utility 글라이드(`takeStateFrom`), 팬·dB | 1e-5 (바이쿼드), 1e-6 (Utility), 1e-12 (팬) |
| `parity.test.ts` | TS `sectionCoefficients`, `Biquad`, `UtilityKernel` | 7개 형태 × 주파수·Q·이득 격자 계수, 잡음 입력 처리 + 글라이드, 슬롯 상한, 로더 대체 동작 | 1e-9 상대 (계수), 1e-5 / 1e-6 |

검증: 글라이드 상수를 12 ms → 13 ms로 일부러 바꾸면 C++ 패리티 11개, TS 패리티 2개가 실패하는 것을 확인했습니다.

엔진 팬 법칙은 `engine.cpp` 믹스 루프 안에 인라인으로 있어서, C++ 테스트에 그 식을 옮겨 적은 참조본을 두었습니다. 그 루프를 바꾸면 참조본과 `gain.rs`를 함께 고칩니다.

## WASM을 wasm-bindgen 없이 쓰는 이유

- `AudioWorkletGlobalScope`에는 `fetch`가 없고 엔진에 따라 `TextDecoder`도 없습니다. wasm-bindgen이 만드는 접착 코드는 이를 가정하고, 워크릿 번들에 ES 모듈로 넣어야 합니다.
- 오디오 경로는 숫자와 `f32` 블록만 오갑니다. 함수 ~15개와 정적 버퍼 2개면 충분해서 로더가 100줄 남짓한 평범한 TS입니다(`garakWasm.ts`).
- 흐름: 메인 스레드에서 `loadGarakWasmModule()`로 `WebAssembly.Module`을 컴파일(ABI 확인 포함) → `processorOptions`로 워크릿에 전달(구조적 복제 가능) → 워크릿에서 `instantiateGarakWasm(module)`로 동기 인스턴스화. 모듈이 ~24 KiB라 동기 컴파일 제한에 걸리지 않습니다.
- 워크릿 노드마다 인스턴스가 하나(단일 스레드)이고 커널 종류마다 슬롯 32개, 한 번에 최대 4096프레임(넘으면 로더가 나눠 처리)입니다.

## 빌드 프로필

| 프로필 | 설정 | 용도 |
|---|---|---|
| `dev` | opt-level 0, `garak-dsp`·`libm`만 1, incremental, 줄 번호 디버그 정보만, panic=abort | 편집·테스트 반복 |
| `release` | opt-level 3, `lto = "thin"`, `codegen-units = 1`, panic=abort | 네이티브 staticlib (CMake는 항상 이 프로필) |
| `wasm` | release 상속 + `lto = "fat"`, `strip` | `pnpm rust:wasm`. opt-level `"s"`는 20.4 KiB로 3.5 KiB 작지만, 예산에 한참 못 미치고 워크릿은 CPU가 병목이라 3을 유지 |

## 측정값

2026-11-15, Windows 11, Rust 1.100.0 (`x86_64-pc-windows-gnu`), 로컬 노트북:

| 작업 | 시간 |
|---|---|
| 툴체인 설치 (rustup 있음, 고정 버전 + wasm32 내려받기) | 약 45초 |
| `cargo test --workspace` 깨끗한 빌드(libm 포함) + 실행 | 5.9초 |
| `garak-dsp` 파일 하나 수정 후 테스트 재빌드 | 1.2초 |
| clippy (수정 후) | 2.5초 |
| `garak-ffi` release 깨끗한 빌드 / 수정 후 | 3.9초 / 0.8초 |
| `garak-wasm` (wasm 프로필) 깨끗한 빌드 / 수정 후 | 4.5초 / 1.4초 |
| CMake `garak-rust-parity-test` 빌드 (cargo + garak_core) | 11초 |
| `garak-dsp.wasm` 크기 | **24,556 바이트 (24.0 KiB)**, 코드 16 KiB + 데이터 8 KiB(슬롯 풀) |
| `rust/target` 크기 | 12 MB |
| 디스크: 고정 툴체인(gnu, minimal) | 약 1.0 GB (대부분 rustc/LLVM DLL) |

## 단계별 이전 계획

전체 아키텍처 검토는 [ARCHITECTURE_REVIEW](ARCHITECTURE_REVIEW.md)(작성되는 대로)와 [AUDIO_CORE_PLAN](AUDIO_CORE_PLAN.md), [NATIVE_AUDIO](NATIVE_AUDIO.md)를 함께 봅니다.

1. **기반 (이 단계).** 워크스페이스, 설치 스크립트, CI, 패리티 테스트. 작은 커널 세트: 바이쿼드, 게인·팬, Utility. 어떤 경로도 바꾸지 않음.
2. **상태 없는/단순 커널부터.** 시김새 커널(Chorus, Flanger, Phaser, Tremolo, Bitcrusher, Tape…)과 EQ 섹션을 하나씩 Rust로 옮기고, 매번 C++·TS 양쪽 패리티 테스트를 추가합니다. 워크릿에서 플래그를 켜면 해당 커널만 Rust로 돌립니다.
3. **경로 전환.** 패리티와 실제 청취 확인이 끝난 커널부터 웹 기본 경로를 Rust WASM으로 바꾸고(배포 빌드에 `pnpm rust:wasm` 추가), 네이티브는 `GARAK_RUST`를 데스크톱 빌드에서 켜서 C++ 구현을 Rust 호출로 대체합니다. 같은 PR에서 대응하는 TS/C++ 구현을 지워 "두 벌 유지"를 끝냅니다.
4. **상태 많은 처리.** 딜레이·리버브(컨볼버 FFT)·다이내믹스·기타 랙, 그 다음 트랙 믹스 루프(ChannelStrip)와 그래프. 할당이 필요한 초기화(IR FFT 등)는 제어 스레드 쪽 API로 분리합니다.
5. **정리.** `GARAK_RUST`를 기본 ON, 플래그 제거, release 워크플로에 Rust 빌드 추가.

## 문제 해결

- **`link.exe` not found / "you may need to install Visual Studio build tools"**: VS 없이 MSVC 호스트가 선택된 상태입니다. `scripts/setup-rust.ps1`을 다시 실행하거나 `rustup set default-host x86_64-pc-windows-gnu` 후 `rust/`에서 `rustup toolchain install`.
- **CMake에서 `can't find crate for core` (타깃 없음)**: C++ 컴파일러와 Rust 호스트가 다릅니다(예: VS 개발자 프롬프트인데 Rust 호스트가 gnu). `rustup target add x86_64-pc-windows-msvc` 또는 반대로 맞춥니다.
- **`Rust is not installed`**: `pnpm rust:*`는 cargo를 PATH와 `~/.cargo/bin`에서 찾습니다. 설치 직후에는 새 터미널을 여세요.
