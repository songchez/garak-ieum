# The Rust render engine and DSP core (docs/RUST.md, docs/RUST_ENGINE.md), required by the native host since 0.3.3.
# Builds rust/garak-ffi with cargo (a plain custom command: no Corrosion dependency to pin) and
# exposes it as the imported static library `garak_rust`. garak-ffi is #![no_std], so it needs
# no Rust runtime system libraries on any platform.

set(GARAK_RUST_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../rust")
get_filename_component(GARAK_RUST_ROOT "${GARAK_RUST_ROOT}" ABSOLUTE)

find_program(GARAK_CARGO cargo
  HINTS "$ENV{CARGO_HOME}/bin" "$ENV{HOME}/.cargo/bin" "$ENV{USERPROFILE}/.cargo/bin"
  DOC "cargo (rustup proxy; rust/rust-toolchain.toml pins the toolchain)")
if(NOT GARAK_CARGO)
  message(FATAL_ERROR "The native audio host needs Rust (its render engine is rust/garak-engine). "
                      "Run scripts/setup-rust.ps1 (Windows) or scripts/setup-rust.sh.")
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
  "${GARAK_RUST_ROOT}/garak-dsp/src/*.rs" "${GARAK_RUST_ROOT}/garak-dsp/src/*.golden"
  "${GARAK_RUST_ROOT}/garak-engine/src/*.rs" "${GARAK_RUST_ROOT}/garak-ffi/src/*.rs")
set(garak_rust_manifests
  "${GARAK_RUST_ROOT}/Cargo.toml" "${GARAK_RUST_ROOT}/Cargo.lock" "${GARAK_RUST_ROOT}/rust-toolchain.toml"
  "${GARAK_RUST_ROOT}/garak-dsp/Cargo.toml" "${GARAK_RUST_ROOT}/garak-engine/Cargo.toml" "${GARAK_RUST_ROOT}/garak-ffi/Cargo.toml")

message(STATUS "Rust render engine: ${garak_rust_target} via ${GARAK_CARGO}")
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

