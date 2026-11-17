// The C++ vs Rust comparison tests (parity, host path, benches) use a default-constructed RenderEngine as the C++
// reference. Since 0.3.2 RenderEngine renders its tracks in the unified Rust engine unless GARAK_RUST_ENGINE=0, so
// these tests pin the reference to the C++ track path first (a caller that sets GARAK_RUST_ENGINE keeps its choice;
// RenderEngine::setRustEngine still selects a mode per engine).
#pragma once

#include <cstdlib>

inline void pinCppReferenceEngine() {
  if (std::getenv("GARAK_RUST_ENGINE")) return;
#ifdef _WIN32
  (void)_putenv_s("GARAK_RUST_ENGINE", "0");
#else
  (void)setenv("GARAK_RUST_ENGINE", "0", 1);
#endif
}
