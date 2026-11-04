cmake_minimum_required(VERSION 3.16)
project(ieum_wave VERSION 0.1.0 LANGUAGES CXX)

option(IEUM_WAVE_BUILD_TESTS "Build standalone DSP tests" ON)
option(IEUM_WAVE_SANITIZE "Enable address/undefined sanitizers" OFF)

add_library(ieum_wave STATIC
  src/wavetable.cpp src/patch.cpp src/dsp.cpp src/synth.cpp)
target_include_directories(ieum_wave PUBLIC include)
target_compile_features(ieum_wave PUBLIC cxx_std_17)
set_target_properties(ieum_wave PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE ON)
if(MSVC)
  target_compile_options(ieum_wave PRIVATE /W4 /permissive- /fp:precise)
else()
  target_compile_options(ieum_wave PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow)
  # Do not use -ffast-math: event validation and finite guards are intentional.
endif()
if(IEUM_WAVE_SANITIZE AND NOT MSVC)
  target_compile_options(ieum_wave PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(ieum_wave PUBLIC -fsanitize=address,undefined)
endif()

add_executable(ieum-wave-render tools/render.cpp)
target_link_libraries(ieum-wave-render PRIVATE ieum_wave)

if(IEUM_WAVE_BUILD_TESTS)
  enable_testing()
  add_executable(ieum-wave-tests tests/tests.cpp)
  target_link_libraries(ieum-wave-tests PRIVATE ieum_wave)
  add_test(NAME ieum-wave-native COMMAND ieum-wave-tests)
endif()
