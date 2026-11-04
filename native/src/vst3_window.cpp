#include "garak/vst3.hpp"
#include "vst3_window.hpp"

#include <stdexcept>
#include <string>

#ifndef GARAK_ENABLE_VST3
#define GARAK_ENABLE_VST3 0
#endif

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>
#if GARAK_ENABLE_VST3
#include <pluginterfaces/base/funknownimpl.h>
#include <pluginterfaces/gui/iplugview.h>
#include <pluginterfaces/gui/iplugviewcontentscalesupport.h>
#endif
#endif

namespace garak {

#if defined(_WIN32) && GARAK_ENABLE_VST3
namespace {
namespace S = Steinberg;
class WinPluginWindow;
class WindowFrame final : public S::U::Implements<S::U::Directly<S::IPlugFrame>> {
 public:
  WinPluginWindow* owner = nullptr;
  S::tresult PLUGIN_API resizeView(S::IPlugView*, S::ViewRect*) override;
};
std::wstring windowTitle(const std::string& text) {
  const auto size = MultiByteToWideChar(CP_UTF8, 0, text.data(), int(text.size()), nullptr, 0);
  std::wstring result(std::size_t(size), L'\0');
  if (size) MultiByteToWideChar(CP_UTF8, 0, text.data(), int(text.size()), result.data(), size);
  return result;
}
class WinPluginWindow final : public NativePluginWindow {
 public:
  explicit WinPluginWindow(S::IPlugView* view, const std::string& title) : view_(view), frame_(S::owned(new WindowFrame)) {
    if (!view_ || view_->isPlatformTypeSupported(S::kPlatformTypeHWND) != S::kResultTrue)
      throw std::runtime_error("The VST3 editor does not support native Windows windows.");
    WNDCLASSEXW cls{};
    cls.cbSize = sizeof(cls);
    cls.lpfnWndProc = &WinPluginWindow::windowProcedure;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
    cls.lpszClassName = L"GarakIeumVst3Editor";
    if (!RegisterClassExW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
      throw std::runtime_error("Cannot register the VST3 editor window.");
    S::ViewRect size{};
    if (view_->getSize(&size) != S::kResultTrue || size.getWidth() <= 0 || size.getHeight() <= 0)
      throw std::runtime_error("The VST3 editor reported an invalid size.");
    const bool canResize = view_->canResize() == S::kResultTrue;
    style_ = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | (canResize ? WS_THICKFRAME | WS_MAXIMIZEBOX : 0);
    RECT bounds{0, 0, size.getWidth(), size.getHeight()};
    AdjustWindowRectEx(&bounds, style_, FALSE, 0);
    handle_ = CreateWindowExW(0, cls.lpszClassName, windowTitle(title + " — Garak Ieum").c_str(),
        style_, CW_USEDEFAULT, CW_USEDEFAULT, bounds.right - bounds.left, bounds.bottom - bounds.top,
        nullptr, nullptr, cls.hInstance, this);
    if (!handle_) throw std::runtime_error("Cannot create the VST3 editor window.");
    frame_->owner = this;
    view_->setFrame(frame_);
    try {
      if (view_->attached(handle_, S::kPlatformTypeHWND) != S::kResultTrue)
        throw std::runtime_error("The VST3 editor could not attach to its native window.");
      attached_ = true;
      if (auto scale = S::U::cast<S::IPlugViewContentScaleSupport>(view_))
        scale->setContentScaleFactor(float(GetDpiForWindow(handle_)) / 96.f);
      ShowWindow(handle_, SW_SHOW);
      UpdateWindow(handle_);
      SetForegroundWindow(handle_);
    } catch (...) { detach(); throw; }
  }
  ~WinPluginWindow() override { detach(); frame_->owner = nullptr; }
  bool isOpen() const noexcept override { return handle_ != nullptr; }
  S::tresult resize(S::IPlugView* source, S::ViewRect* rect) {
    if (!handle_ || source != view_.get() || !rect || rect->getWidth() < 1 || rect->getHeight() < 1 ||
        rect->getWidth() > 16384 || rect->getHeight() > 16384) return S::kInvalidArgument;
    RECT bounds{0, 0, rect->getWidth(), rect->getHeight()};
    AdjustWindowRectEx(&bounds, style_, FALSE, 0);
    resizing_ = true;
    SetWindowPos(handle_, nullptr, 0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top,
                 SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER);
    const auto result = view_->onSize(rect);
    resizing_ = false;
    return result;
  }
 private:
  void detach() noexcept {
    if (attached_) { attached_ = false; view_->removed(); }
    if (view_) view_->setFrame(nullptr);
    if (handle_) { auto hwnd = handle_; handle_ = nullptr; DestroyWindow(hwnd); }
  }
  static LRESULT CALLBACK windowProcedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* self = reinterpret_cast<WinPluginWindow*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lParam);
      self = static_cast<WinPluginWindow*>(create->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (self) {
      if (message == WM_CLOSE) { self->detach(); return 0; }
      if (message == WM_SIZE && self->attached_ && !self->resizing_ && wParam != SIZE_MINIMIZED) {
        RECT client{};
        GetClientRect(hwnd, &client);
        S::ViewRect rect(0, 0, client.right, client.bottom);
        self->view_->checkSizeConstraint(&rect);
        self->resize(self->view_, &rect);
        return 0;
      }
      if (message == WM_DPICHANGED && self->attached_) {
        if (auto scale = S::U::cast<S::IPlugViewContentScaleSupport>(self->view_))
          scale->setContentScaleFactor(float(HIWORD(wParam)) / 96.f);
        return 0;
      }
      if (message == WM_DESTROY) { self->handle_ = nullptr; return 0; }
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
  }
  S::IPtr<S::IPlugView> view_;
  S::IPtr<WindowFrame> frame_;
  HWND handle_ = nullptr;
  DWORD style_ = 0;
  bool attached_ = false, resizing_ = false;
};
S::tresult WindowFrame::resizeView(S::IPlugView* view, S::ViewRect* rect) {
  return owner ? owner->resize(view, rect) : S::kResultFalse;
}
} // namespace
std::unique_ptr<NativePluginWindow> makePluginWindow(S::IPlugView* view, const std::string& title) {
  return std::make_unique<WinPluginWindow>(view, title);
}
#elif !defined(__APPLE__) && GARAK_ENABLE_VST3
std::unique_ptr<NativePluginWindow> makePluginWindow(Steinberg::IPlugView*, const std::string&) {
  throw std::runtime_error("Native plugin editors are supported in the Windows and Apple Silicon desktop builds.");
}
#endif

#if !defined(__APPLE__)
void initializeNativeEvents() {
#if defined(_WIN32)
  // Lifetime is the native process. ASIO has its own balanced COM initialization.
  const auto result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(result) && result != RPC_E_CHANGED_MODE) throw std::runtime_error("Cannot initialize native COM events.");
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
#endif
}
void pumpNativeEvents() {
#if defined(_WIN32)
  MSG message;
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
#endif
}
#endif

} // namespace garak
