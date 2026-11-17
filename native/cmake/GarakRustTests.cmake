# Rust render engine tests (docs/RUST_ENGINE.md 7, 10). Until 0.3.2 they compared the Rust engine with the C++ track
# path; since its removal they compare against golden references recorded from it (native/tests/golden.hpp,
# native/tests/golden/*.golden): bit-identical on Windows x64, residual <= -90 dBFS everywhere.
set(garak_golden_dir "${CMAKE_CURRENT_LIST_DIR}/../tests/golden")
get_filename_component(garak_golden_dir "${garak_golden_dir}" ABSOLUTE)

function(garak_rust_test target source)
  add_executable(${target} ${source})
  target_link_libraries(${target} PRIVATE garak_core garak_rust)
  target_include_directories(${target} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/../src" "${CMAKE_CURRENT_LIST_DIR}/../tests")
  target_include_directories(${target} SYSTEM PRIVATE "${GARAK_NLOHMANN_INCLUDE_DIR}")
  target_compile_definitions(${target} PRIVATE "GARAK_GOLDEN_DIR=\"${garak_golden_dir}\""
    "GARAK_INSTRUMENT_GOLDEN=\"${GARAK_RUST_ROOT}/garak-dsp/src/instruments/parity.golden\"")
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /utf-8)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endfunction()

# Rust DSP kernels (biquad, utility, every built-in effect, the guitar rig) through the garak-ffi C ABI.
garak_rust_test(garak-rust-parity-test tests/rust_parity_test.cpp)
add_test(NAME native-rust-parity COMMAND garak-rust-parity-test)
# The Rust engine (garak_engine.h) on the testkit project: offline exports and live diffs, with a guitar rig.
garak_rust_test(garak-rust-engine-parity-test tests/rust_engine_parity_test.cpp)
add_test(NAME native-rust-engine-parity COMMAND garak-rust-engine-parity-test)
# RenderEngine, the shell around the Rust graph: exports, live edits, multi-core, host nodes (VST3 stand-ins, routes,
# monitoring, capture), render-ahead, metronome and count-in; `--bench` prints the CPU table.
garak_rust_test(garak-rust-engine-host-test tests/rust_engine_host_test.cpp)
add_test(NAME native-rust-engine-host COMMAND garak-rust-engine-host-test)
# Built-in synths, drums, sample sets, vintage instruments and IEUM WAVE (offline + live edits/cycle/live MIDI).
garak_rust_test(garak-rust-engine-instrument-parity-test tests/rust_engine_instrument_parity_test.cpp)
add_test(NAME native-rust-engine-instruments COMMAND garak-rust-engine-instrument-parity-test)
# 옥구슬 EP / 한밤 106: checksum parity with the WASM build (parity.golden), CPU budget, engine use.
garak_rust_test(garak-rust-instrument-test tests/rust_instrument_test.cpp)
add_test(NAME native-rust-instruments COMMAND garak-rust-instrument-test)
