#pragma once

#include <memory>
#include <string>

namespace Steinberg { class IPlugView; }
namespace garak {
class NativePluginWindow {
 public:
  virtual ~NativePluginWindow() = default;
  [[nodiscard]] virtual bool isOpen() const noexcept = 0;
};
std::unique_ptr<NativePluginWindow> makePluginWindow(Steinberg::IPlugView*, const std::string& title);
}
