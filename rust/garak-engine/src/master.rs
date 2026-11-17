//! Master bus processor (the former C++ DSP (0.3.2) `Master`): a causal, linked-channel soft-knee compressor and
//! safety ceiling, no lookahead. Applied after the master gain, for playback and offline alike.

use crate::math;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Master {
    attack: f64,
    release: f64,
    envelope: f64,
}

impl Master {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            attack: math::exp(-1.0 / (sample_rate * 0.003)),
            release: math::exp(-1.0 / (sample_rate * 0.12)),
            envelope: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.envelope = 0.0;
    }

    pub fn take_state_from(&mut self, previous: &Master) {
        self.envelope = previous.envelope;
    }

    pub fn process(&mut self, s: &mut [f32]) {
        for [l, r] in s.as_chunks_mut::<2>().0 {
            let louder = if l.abs() < r.abs() { r.abs() } else { l.abs() };
            let peak = math::std_min(32.0, f64::from(louder));
            let c = if peak > self.envelope { self.attack } else { self.release };
            self.envelope = math::mul_add(c, self.envelope - peak, peak);
            let mut gain = 1.0;
            if self.envelope > 0.5956621435 {
                let above = math::mul_add(20.0, math::log10(self.envelope), 3.0);
                let over = if above < 1.5 { (above + 1.5) * (above + 1.5) / 6.0 } else { above };
                gain = garak_dsp::db_to_gain(-(11.0 / 12.0) * over);
            }
            for x in [l, r] {
                let value = math::std_clamp(f64::from(*x), -32.0, 32.0) * gain;
                let magnitude = value.abs();
                *x = if magnitude <= 0.9 {
                    value as f32
                } else {
                    let soft = math::mul_add(0.08, math::tanh((magnitude - 0.9) / 0.08), 0.9);
                    soft.copysign(value) as f32
                };
            }
        }
    }
}
