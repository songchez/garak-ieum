// Parametric EQ ("Curve 8") and Sweep filter: response and saved-state compatibility.
// Included by engine_test.cpp (uses its check/near helpers).

// Magnitude in dB of an effect's (left-channel) impulse response at `hz`.
double effectResponseDb(dsp::StereoProcessor& effect, double hz, std::size_t frames = 32768) {
  std::vector<float> buffer(frames * 2);buffer[0] = buffer[1] = 1;
  for (std::size_t at = 0; at < frames; at += 256) effect.process(buffer.data() + 2 * at, static_cast<std::uint32_t>(std::min<std::size_t>(256, frames - at)));
  double re = 0, im = 0;
  for (std::size_t i = 0; i < frames; ++i) { const double phase = 2 * dsp::pi * hz * i / 48000; re += buffer[2 * i] * std::cos(phase); im -= buffer[2 * i] * std::sin(phase); }
  return 20 * std::log10(std::hypot(re, im));
}
double eqDb(const Parameters& params, double hz, const char* type = "eq") { auto effect = dsp::makeEffect(type, params, 48000, 120); return effectResponseDb(*effect, hz); }

void parametricEqAndSweep() {
  // Saved 3-band projects (low/mid/midFreq/high) render bit-identically to the original fixed voicing.
  std::vector<float> input(9000 * 2);for (std::size_t i = 0; i < input.size() / 2; ++i) input[2 * i] = input[2 * i + 1] = static_cast<float>(.3 * std::sin(.03 * i) + .2 * std::sin(.71 * i));
  auto legacy = dsp::makeEffect("eq", {{"low", 6}, {"mid", -4}, {"midFreq", 800}, {"high", 3}}, 48000, 120);auto got = input;
  for (std::size_t at = 0; at < 9000; at += 300) legacy->process(got.data() + 2 * at, 300);
  dsp::Biquad ref[3];ref[0].configure(dsp::Filter::LowShelf, 48000, 220, 1, 6);ref[1].configure(dsp::Filter::Peak, 48000, 800, .9, -4);ref[2].configure(dsp::Filter::HighShelf, 48000, 4500, 1, 3);
  auto want = input;for (auto& f : ref) for (std::size_t i = 0; i < 9000; ++i) { want[2 * i] = f.sample(want[2 * i], 0); want[2 * i + 1] = f.sample(want[2 * i + 1], 1); }
  for (std::size_t i = 0; i < want.size(); ++i) check(got[i] == want[i], "Legacy 3-band EQ no longer renders identically");
  // Default EQ is transparent.
  near(eqDb({}, 100), 0, 1e-6, "Default EQ is not flat at 100 Hz");near(eqDb({}, 5000), 0, 1e-6, "Default EQ is not flat at 5 kHz");
  // Bell: +6 dB at its centre; output gain adds.
  near(eqDb({{"b5On", 1}, {"b5Freq", 1000}, {"b5Gain", 6}, {"b5Q", 2}}, 1000), 6, .02, "Bell band missed its gain at the centre");
  near(eqDb({{"output", -3}}, 1000), -3, 1e-4, "EQ output gain is wrong");
  // Low cut 24 dB/oct Butterworth: -3 dB at the corner, about -24 dB one octave below.
  const Parameters cut{{"b4On", 1}, {"b4Freq", 200}, {"b4Q", .70710678}, {"b4Slope", 1}};
  near(eqDb(cut, 200), -3.01, .05, "24 dB low cut is not -3 dB at its corner");
  near(eqDb(cut, 100), -24.1, .4, "24 dB low cut slope is wrong");
  near(eqDb({{"b8On", 1}, {"b8Freq", 1000}, {"b8Q", .70710678}, {"b8Slope", 3}}, 2000), -48.2, .8, "48 dB high cut slope is wrong");
  check(eqDb({{"b6On", 1}, {"b6Type", 5}, {"b6Freq", 1000}, {"b6Q", 4}}, 1000) < -40, "Notch does not cut its centre");
  near(eqDb({{"b6On", 1}, {"b6Type", 5}, {"b6Freq", 1000}, {"b6Q", 4}}, 4000), 0, .1, "Notch affects far frequencies");
  near(eqDb({{"b5On", 2}, {"b5Freq", 1000}, {"b5Gain", 12}}, 1000), 0, 1e-6, "A bypassed band (state 2) still sounds");
  near(eqDb({{"mid", 6}, {"b2On", 2}}, 1000), 0, 1e-6, "Bypassing a legacy band left its gain in");
  // Sweep: 12 dB/oct equals the original single node; cascades are flat (-3 dB) at the default resonance.
  dsp::Biquad single;single.configure(dsp::Filter::Lowpass, 48000, 1200, .7);
  std::vector<float> one(32768 * 2);one[0] = one[1] = 1;for (std::size_t i = 0; i < 32768; ++i) one[2 * i] = single.sample(one[2 * i]);
  double re = 0, im = 0;for (std::size_t i = 0; i < 32768; ++i) { const double ph = 2 * dsp::pi * 2400 * i / 48000; re += one[2 * i] * std::cos(ph); im -= one[2 * i] * std::sin(ph); }
  near(eqDb({}, 2400, "filter"), 20 * std::log10(std::hypot(re, im)), 1e-6, "Sweep 12 dB/oct changed from the original filter");
  near(eqDb({{"slope", 1}}, 1200, "filter"), -3.01, .05, "Sweep 24 dB/oct is not flat at the default resonance");
  near(eqDb({{"slope", 2}, {"mode", 1}, {"cutoff", 500}}, 250, "filter"), -48.2, .8, "Sweep 48 dB high-pass slope is wrong");
  rejects([] { (void)dsp::makeEffect("eq", {{"b9On", 1}}, 48000, 120); }, "Unknown EQ band was silently accepted");
  rejects([] { (void)dsp::makeEffect("eq", {{"b4Type", 6}}, 48000, 120); }, "Out-of-range EQ band type was accepted");
}
