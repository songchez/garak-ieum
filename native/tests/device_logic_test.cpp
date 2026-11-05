#include "garak/device.hpp"
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace garak;
using namespace garak::device_logic;
using Sizes = std::vector<std::uint32_t>;

void check(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
template <class F> bool throws(F&& f) { try { f(); } catch (const std::invalid_argument&) { return true; } return false; }

void bufferSnapping() {
  // Powers of two (-1): never rejected, nearest allowed, ties prefer the larger size.
  const BufferCaps pow2{64, 1024, 256, -1};
  check(allowedBufferSizes(pow2) == Sizes{64, 128, 256, 512, 1024}, "power-of-two size list");
  check(snapBufferSize(pow2, 256).frames == 256 && !snapBufferSize(pow2, 256).adjusted, "valid size kept");
  check(snapBufferSize(pow2, 100).frames == 128 && snapBufferSize(pow2, 100).adjusted, "100 snaps to 128");
  check(snapBufferSize(pow2, 192).frames == 256, "tie snaps to the larger size");
  check(snapBufferSize(pow2, 16).frames == 64 && snapBufferSize(pow2, 16384).frames == 1024, "clamped to the driver range");
  check(snapBufferSize(pow2, kDriverBuffer).frames == 256 && !snapBufferSize(pow2, kDriverBuffer).adjusted, "\"driver\" uses preferred");
  // A non-power-of-two preferred size reported with -1 stays selectable.
  const BufferCaps odd{32, 512, 96, -1};
  check(allowedBufferSizes(odd) == Sizes{32, 64, 96, 128, 256, 512}, "odd preferred size listed");
  check(snapBufferSize(odd, 100).frames == 96, "odd preferred size is a snap target");

  // Granularity steps from the minimum.
  const BufferCaps steps{48, 480, 144, 48};
  check(allowedBufferSizes(steps) == Sizes{48, 96, 144, 192, 240, 288, 336, 384, 432, 480}, "granularity steps from min");
  check(snapBufferSize(steps, 100).frames == 96 && snapBufferSize(steps, 130).frames == 144, "nearest step");
  check(snapBufferSize(steps, 120).frames == 144, "step tie prefers the larger size");
  check(snapBufferSize(steps, 500).frames == 480, "step clamp");

  // Fixed drivers: granularity 0 or min == max accept only the preferred size.
  for (const auto fixed : {BufferCaps{64, 1024, 512, 0}, BufferCaps{256, 256, 256, -1}, BufferCaps{256, 256, 256, 32}}) {
    check(allowedBufferSizes(fixed) == Sizes{std::uint32_t(fixed.preferred)}, "fixed list has only preferred");
    const auto choice = snapBufferSize(fixed, 128);
    check(choice.frames == std::uint32_t(fixed.preferred) && choice.adjusted, "fixed driver snaps to preferred");
  }

  // More than 32 sizes: ends, preferred and powers of two are kept.
  const BufferCaps fine{16, 4096, 120, 8};
  const auto listed = allowedBufferSizes(fine);
  check(listed.size() <= kMaxListedBufferSizes, "size list capped at 32");
  check(listed == Sizes{16, 32, 64, 120, 128, 256, 512, 1024, 2048, 4096}, "reduced size list");
  check(snapBufferSize(fine, 100).frames == 104 && snapBufferSize(fine, 100).adjusted, "snapping uses every accepted size, not the shortened list");
  const BufferCaps wide{1, 16384, 128, 1};
  check(allowedBufferSizes(wide).size() <= kMaxListedBufferSizes, "granularity 1 list capped");
  check(snapBufferSize(wide, 333).frames == 333 && !snapBufferSize(wide, 333).adjusted, "granularity 1 accepts any size");

  // Malformed reports: a missing range falls back to the preferred size.
  check(snapBufferSize(BufferCaps{0, 0, 256, -1}, 64).frames == 256, "zero range uses preferred");
  check(snapBufferSize(BufferCaps{512, 128, 256, -1}, 64).frames == 256, "inverted range uses preferred");
  check(snapBufferSize(BufferCaps{128, 1024, 0, -1}, kDriverBuffer).frames == 128, "missing preferred uses min");
  check(snapBufferSize(BufferCaps{}, 256).frames == 256 && allowedBufferSizes(BufferCaps{}).empty(), "unknown caps leave the request alone");

  // Recovery after a control-panel change follows the driver's new preferred size.
  const BufferCaps changed{64, 1024, 512, -1};
  const auto follow = snapBufferSize(changed, 128, 256);
  check(follow.frames == 512 && follow.followedDriver && follow.adjusted, "changed preference followed");
  const auto same = snapBufferSize(changed, 128, 512);
  check(same.frames == 128 && !same.followedDriver, "unchanged preference keeps the request");
  check(followsDriverBuffer(DeviceFault::ResetRequest) && followsDriverBuffer(DeviceFault::BufferSizeChange) &&
        !followsDriverBuffer(DeviceFault::Stopped) && !followsDriverBuffer(DeviceFault::SampleRateChange), "which faults follow the driver buffer");
}

void errorClassification() {
  check(std::string(deviceErrorCodeName(DeviceErrorCode::NotFound)) == "DEVICE_NOT_FOUND" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::InUse)) == "DEVICE_IN_USE" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::DriverInitFailed)) == "DRIVER_INIT_FAILED" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::SampleRateUnsupported)) == "SAMPLE_RATE_UNSUPPORTED" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::BufferUnsupported)) == "BUFFER_UNSUPPORTED" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::ChannelsUnavailable)) == "CHANNELS_UNAVAILABLE" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::Lost)) == "DEVICE_LOST" &&
        std::string(deviceErrorCodeName(DeviceErrorCode::None)).empty(), "wire names match the contract");
  // miniaudio results (busy, access denied, exclusive refused, missing, format).
  for (const int inUse : {-19, -6, -23, -202}) check(classifyMaResult(inUse) == DeviceErrorCode::InUse, "miniaudio in-use result");
  for (const int missing : {-204, -7, -22}) check(classifyMaResult(missing) == DeviceErrorCode::NotFound, "miniaudio missing device");
  check(classifyMaResult(-200) == DeviceErrorCode::SampleRateUnsupported, "exclusive format");
  check(classifyMaResult(-1) == DeviceErrorCode::DriverInitFailed && classifyMaResult(-401) == DeviceErrorCode::DriverInitFailed, "unknown miniaudio failure");
  // ASIO errors depend on the step that failed.
  check(classifyAsioFailure(AsioStep::Load, -1000) == DeviceErrorCode::NotFound, "ASIO hardware not present");
  check(classifyAsioFailure(AsioStep::Load, -999) == DeviceErrorCode::DriverInitFailed, "ASIO load failure");
  check(classifyAsioFailure(AsioStep::Channels, -999) == DeviceErrorCode::ChannelsUnavailable, "ASIO channel query");
  check(classifyAsioFailure(AsioStep::SampleRate, -997) == DeviceErrorCode::SampleRateUnsupported, "ASIO rate refused");
  check(classifyAsioFailure(AsioStep::SampleRate, -995) == DeviceErrorCode::SampleRateUnsupported, "ASIO no clock");
  check(classifyAsioFailure(AsioStep::CreateBuffers, -997) == DeviceErrorCode::BufferUnsupported &&
        classifyAsioFailure(AsioStep::CreateBuffers, -998) == DeviceErrorCode::BufferUnsupported, "ASIO buffer refused");
  check(classifyAsioFailure(AsioStep::CreateBuffers, -994) == DeviceErrorCode::DriverInitFailed, "ASIO out of memory");
  check(classifyAsioFailure(AsioStep::Start, -1000) == DeviceErrorCode::Lost && classifyAsioFailure(AsioStep::Start, -999) == DeviceErrorCode::Lost, "ASIO start on vanished hardware");
  const DeviceError error(DeviceErrorCode::SampleRateUnsupported, "rate", DeviceErrorDetails{{44100, 48000}, std::nullopt, std::nullopt, std::nullopt});
  check(error.code() == DeviceErrorCode::SampleRateUnsupported && error.details().supportedSampleRates.size() == 2 && std::string(error.what()) == "rate", "DeviceError carries code and details");
}

void channelLists() {
  check(legacyInputList(2, 3) == Sizes{3, 4} && legacyInputList(0, 5).empty(), "legacy offset/count to list");
  DeviceConfig legacy; legacy.inputChannels = 1; legacy.inputChannelOffset = 6;
  check(resolvedInputList(legacy) == Sizes{6}, "legacy config resolved");
  DeviceConfig listed = legacy; listed.inputChannelList = {0, 2, 7};
  check(resolvedInputList(listed) == Sizes{0, 2, 7}, "list wins over legacy fields");
  validateInputList({}); validateInputList({0, 1, 5, 255});
  check(throws([] { validateInputList({1, 1}); }) && throws([] { validateInputList({2, 1}); }), "list must be strictly ascending");
  check(throws([] { validateInputList({256}); }), "physical index bound");
  Sizes many; for (std::uint32_t c = 0; c < 33; ++c) many.push_back(c);
  check(throws([&] { validateInputList(many); }), "at most 32 inputs");
  many.pop_back(); validateInputList(many);
  check(inputsAvailable({}, 0) && inputsAvailable({0, 3}, 4) && !inputsAvailable({0, 4}, 4), "channel availability");
  check(outputPairAvailable(0, 2) && outputPairAvailable(2, 4) && !outputPairAvailable(3, 4) && outputPairAvailable(0, 1) && !outputPairAvailable(1, 1), "output pair availability");
}

void recoveryBackoff() {
  RecoveryBackoff b;
  check(!b.active() && !b.due(0), "idle backoff");
  b.begin(1000);
  check(b.active() && !b.due(1249) && b.due(1250), "first attempt after 0.25 s");
  b.failed(1250, false); check(b.nextAttemptMs() == 1750, "then 0.5 s");
  b.failed(1750, false); check(b.nextAttemptMs() == 2750, "then 1 s");
  b.failed(2750, false); check(b.nextAttemptMs() == 4750, "then 2 s");
  b.failed(4750, false); check(b.nextAttemptMs() == 6750, "then every 2 s");
  std::int64_t now = 6750;
  while (b.active()) { check(b.due(now), "attempt is due on schedule"); b.failed(now, false); now = b.nextAttemptMs(); }
  check(b.gaveUp() && !b.due(now + 100000), "gives up after 30 s");
  check(now - 1000 <= RecoveryBackoff::kGiveUpMs, "no attempt starts later than 30 s after the fault");

  // A vanished device is polled at the same interval until it returns.
  b.begin(0);
  std::int64_t t = 0;
  for (int i = 0; i < 100; ++i) { t = b.nextAttemptMs(); check(b.due(t), "missing device stays scheduled"); b.failed(t, true); }
  check(b.active() && !b.gaveUp() && b.nextAttemptMs() - t == 2000 && t > 60000, "missing device polled every 2 s past 30 s");
  b.succeeded();
  check(!b.active() && !b.gaveUp() && b.attempts() == 0, "success clears the schedule");
  b.begin(0); b.cancel();
  check(!b.active() && !b.gaveUp() && !b.due(100000), "cancel stops attempts");
}

int main() {
  try {
    bufferSnapping();
    errorClassification();
    channelLists();
    recoveryBackoff();
    std::cout << "PASS device buffer snapping, error classification, channel lists and recovery backoff\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
