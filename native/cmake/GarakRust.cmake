# Optional Rust DSP core (docs/RUST.md), enabled with -DGARAK_RUST=ON.
# Builds rust/garak-ffi with cargo (a plain custom command: no Corrosion dependency to pin) and
# exposes it as the imported static library `garak_rust`. garak-ffi is #![no_std], so it needs
# no Rust runtime system libraries on any platform.

set(GARAK_RUST_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../rust")
get_filename_component(GARAK_RUST_ROOT "${GARAK_RUST_ROOT}" ABSOLUTE)

find_program(GARAK_CARGO cargo
  HINTS "$ENV{CARGO_HOME}/bin" "$ENV{HOME}/.cargo/bin" "$ENV{USERPROFILE}/.cargo/bin"
  DOC "cargo (rustup proxy; rust/rust-toolchain.toml pins the toolchain)")
if(NOT GARAK_CARGO)
  message(FATAL_ERROR "GARAK_RUST=ON needs Rust. Run scripts/setup-rust.ps1 (Windows) or scripts/setup-rust.sh, "
                      "or configure with -DGARAK_RUST=OFF.")
endif()

# The Rust target must match the C++ ABI: MSVC <-> *-windows-msvc, MinGW <-> *-windows-gnu.
set(GARAK_RUST_TARGET "" CACHE STRING "Override the Rust target triple for garak-ffi")
set(garak_rust_target "${GARAK_RUST_TARGET}")
if(NOT garak_rust_target)
  set(garak_arch "${CMAKE_SYSTEM_PROCESSOR}")
  if(CMAKE_GENERATOR_PLATFORM)
    set(garak_arch "${CMAKE_GENERATOR_PLATFORM}")
  endif()
  if(APPLE AND CMAKE_OSX_ARCHITECTURES)
    set(garak_arch "${CMAKE_OSX_ARCHITECTURES}")
  endif()
  string(TOLOWER "${garak_arch}" garak_arch)
  if(garak_arch MATCHES "^(arm64|aarch64)$")
    set(garak_arch aarch64)
  else()
    set(garak_arch x86_64)
  endif()
  if(MSVC)
    set(garak_rust_target "${garak_arch}-pc-windows-msvc")
  elseif(MINGW)
    set(garak_rust_target "${garak_arch}-pc-windows-gnu")
  elseif(APPLE)
    set(garak_rust_target "${garak_arch}-apple-darwin")
  else()
    set(garak_rust_target "${garak_arch}-unknown-linux-gnu")
  endif()
endif()

if(MSVC)
  set(garak_rust_lib_name "garak_ffi.lib")
else()
  set(garak_rust_lib_name "libgarak_ffi.a")
endif()
# A per-build target directory keeps CMake builds from clobbering `pnpm rust:*` outputs.
set(garak_rust_target_dir "${CMAKE_BINARY_DIR}/rust-target")
# Always the optimised profile: audio-thread code is never shipped or parity-tested unoptimised.
set(garak_rust_lib "${garak_rust_target_dir}/${garak_rust_target}/release/${garak_rust_lib_name}")
file(GLOB_RECURSE garak_rust_sources CONFIGURE_DEPENDS
  "${GARAK_RUST_ROOT}/garak-dsp/src/*.rs" "${GARAK_RUST_ROOT}/garak-ffi/src/*.rs")
set(garak_rust_manifests
  "${GARAK_RUST_ROOT}/Cargo.toml" "${GARAK_RUST_ROOT}/Cargo.lock" "${GARAK_RUST_ROOT}/rust-toolchain.toml"
  "${GARAK_RUST_ROOT}/garak-dsp/Cargo.toml" "${GARAK_RUST_ROOT}/garak-ffi/Cargo.toml")

message(STATUS "Rust DSP core: ${garak_rust_target} via ${GARAK_CARGO}")
add_custom_command(
  OUTPUT "${garak_rust_lib}"
  COMMAND "${CMAKE_COMMAND}" -E env "CARGO_TARGET_DIR=${garak_rust_target_dir}"
          "${GARAK_CARGO}" build --locked -p garak-ffi --release --target ${garak_rust_target}
  WORKING_DIRECTORY "${GARAK_RUST_ROOT}"
  DEPENDS ${garak_rust_sources} ${garak_rust_manifests}
  COMMENT "cargo build garak-ffi (${garak_rust_target})"
  USES_TERMINAL
  VERBATIM)
add_custom_target(garak_rust_build DEPENDS "${garak_rust_lib}")

add_library(garak_rust STATIC IMPORTED GLOBAL)
set_target_properties(garak_rust PROPERTIES
  IMPORTED_LOCATION "${garak_rust_lib}"
  INTERFACE_INCLUDE_DIRECTORIES "${GARAK_RUST_ROOT}/garak-ffi/include")
add_dependencies(garak_rust garak_rust_build)

# The Rust effects behind the StereoProcessor interface (native/src/rust_effects.inc). makeEffect()
# still uses C++ unless a type is listed here, in the GARAK_RUST_EFFECTS environment variable, or
# switched with garak::dsp::setEffectBackend().
target_link_libraries(garak_core PUBLIC garak_rust)
target_compile_definitions(garak_core PRIVATE GARAK_RUST=1)
set(GARAK_RUST_EFFECTS "" CACHE STRING
  "Effect types makeEffect() runs in Rust by default (list of type ids, or 'all'); empty keeps C++")
if(GARAK_RUST_EFFECTS)
  string(REPLACE ";" "," garak_rust_effects_list "${GARAK_RUST_EFFECTS}")
  target_compile_definitions(garak_core PRIVATE "GARAK_RUST_EFFECTS_DEFAULT=\"${garak_rust_effects_list}\"")
  message(STATUS "Rust effects by default: ${garak_rust_effects_list}")
endif()

if(GARAK_BUILD_TESTS)
  # Rust kernels vs the existing C++ kernels on identical input (tolerance-based).
  add_executable(garak-rust-parity-test tests/rust_parity_test.cpp)
  # CPU baseline (frames/s per effect, C++ vs Rust); prints a table, not part of ctest.
  add_executable(garak-rust-bench tests/rust_bench.cpp)
  foreach(target garak-rust-parity-test garak-rust-bench)
    target_link_libraries(${target} PRIVATE garak_core garak_rust)
    if(MSVC)
      target_compile_options(${target} PRIVATE /W4 /utf-8)
    else()
      target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
  endforeach()
  add_test(NAME native-rust-parity COMMAND garak-rust-parity-test)
endif()
