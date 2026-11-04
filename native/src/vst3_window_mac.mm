#include "garak/vst3.hpp"
#include "vst3_window.hpp"
#include <stdexcept>

#import <Cocoa/Cocoa.h>

#ifndef GARAK_ENABLE_VST3
#define GARAK_ENABLE_VST3 0
#endif

#if GARAK_ENABLE_VST3
#include <pluginterfaces/base/funknownimpl.h>
#include <pluginterfaces/gui/iplugview.h>

namespace garak { class MacPluginWindow; }
@interface GarakVstWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, assign) garak::MacPluginWindow* owner;
@end

namespace garak {
namespace S = Steinberg;
class MacWindowFrame final : public S::U::Implements<S::U::Directly<S::IPlugFrame>> {
 public:
  MacPluginWindow* owner = nullptr;
  S::tresult PLUGIN_API resizeView(S::IPlugView*, S::ViewRect*) override;
};
class MacPluginWindow final : public NativePluginWindow {
 public:
  MacPluginWindow(S::IPlugView* view, const std::string& title) : view_(view), frame_(S::owned(new MacWindowFrame)) {
    if (![NSThread isMainThread]) throw std::runtime_error("VST3 editors must be opened on the native main thread.");
    if (!view_ || view_->isPlatformTypeSupported(S::kPlatformTypeNSView) != S::kResultTrue)
      throw std::runtime_error("The VST3 editor does not support native macOS views.");
    S::ViewRect size{};
    if (view_->getSize(&size) != S::kResultTrue || size.getWidth() < 1 || size.getHeight() < 1)
      throw std::runtime_error("The VST3 editor reported an invalid size.");
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
    if (view_->canResize() == S::kResultTrue) style |= NSWindowStyleMaskResizable;
    window_ = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, size.getWidth(), size.getHeight())
                                        styleMask:style backing:NSBackingStoreBuffered defer:NO];
    window_.releasedWhenClosed = NO;
    window_.title = [NSString stringWithUTF8String:(title + " — Garak Ieum").c_str()];
    delegate_ = [[GarakVstWindowDelegate alloc] init];
    delegate_.owner = this;
    window_.delegate = delegate_;
    frame_->owner = this;
    view_->setFrame(frame_);
    if (view_->attached((__bridge void*)window_.contentView, S::kPlatformTypeNSView) != S::kResultTrue) {
      detach();
      delegate_.owner = nullptr;
      window_.delegate = nil;
      [window_ close];
      frame_->owner = nullptr;
      throw std::runtime_error("The VST3 editor could not attach to its native macOS view.");
    }
    attached_ = true;
    [window_ center];
    [window_ makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
  }
  ~MacPluginWindow() override {
    detach();
    delegate_.owner = nullptr;
    window_.delegate = nil;
    [window_ close];
    frame_->owner = nullptr;
  }
  bool isOpen() const noexcept override { return attached_; }
  void detach() noexcept {
    if (attached_) { attached_ = false; view_->removed(); }
    if (view_) view_->setFrame(nullptr);
  }
  void userResized() {
    if (!attached_ || resizing_) return;
    const NSSize size = window_.contentView.bounds.size;
    S::ViewRect rect(0, 0, int(size.width), int(size.height));
    view_->checkSizeConstraint(&rect);
    resize(view_, &rect);
  }
  S::tresult resize(S::IPlugView* source, S::ViewRect* rect) {
    if (![NSThread isMainThread] || !attached_ || source != view_.get() || !rect ||
        rect->getWidth() < 1 || rect->getHeight() < 1 || rect->getWidth() > 16384 || rect->getHeight() > 16384)
      return S::kInvalidArgument;
    resizing_ = true;
    [window_ setContentSize:NSMakeSize(rect->getWidth(), rect->getHeight())];
    const auto result = view_->onSize(rect);
    resizing_ = false;
    return result;
  }
 private:
  S::IPtr<S::IPlugView> view_;
  S::IPtr<MacWindowFrame> frame_;
  __strong NSWindow* window_;
  __strong GarakVstWindowDelegate* delegate_;
  bool attached_ = false, resizing_ = false;
};
S::tresult MacWindowFrame::resizeView(S::IPlugView* view, S::ViewRect* rect) {
  return owner ? owner->resize(view, rect) : S::kResultFalse;
}
std::unique_ptr<NativePluginWindow> makePluginWindow(S::IPlugView* view, const std::string& title) {
  return std::make_unique<MacPluginWindow>(view, title);
}
} // namespace garak

@implementation GarakVstWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
  (void)sender;
  if (self.owner) self.owner->detach();
  return YES;
}
- (void)windowDidResize:(NSNotification*)notification {
  (void)notification;
  if (self.owner) self.owner->userResized();
}
@end
#endif

namespace garak {
void initializeNativeEvents() {
  if (![NSThread isMainThread]) throw std::runtime_error("The native audio host requires its main thread.");
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
  }
}
void pumpNativeEvents() {
  @autoreleasepool {
    for (;;) {
      NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast]
                                            inMode:NSDefaultRunLoopMode dequeue:YES];
      if (!event) break;
      [NSApp sendEvent:event];
    }
    [NSApp updateWindows];
  }
}
} // namespace garak
