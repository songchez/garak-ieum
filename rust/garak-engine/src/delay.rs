//! Plug-in delay compensation line (engine.cpp `CompensationDelay`): a fixed stereo delay of
//! `frames`, O(1) reset through generation stamps (stale slots read as silence).

use alloc::vec;
use alloc::vec::Vec;

#[derive(Debug, Default)]
pub(crate) struct CompensationDelay {
    frames: u32,
    samples: Vec<f32>,
    generations: Vec<u64>,
    write: usize,
    generation: u64,
}

impl CompensationDelay {
    pub fn new(frames: u32) -> Self {
        let slots = frames as usize + 1;
        Self { frames, samples: vec![0.0; slots * 2], generations: vec![0; slots], write: 0, generation: 1 }
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }

    pub fn process(&mut self, s: &mut [f32]) {
        if self.frames == 0 {
            return;
        }
        let n = self.generations.len();
        for [a, b] in s.as_chunks_mut::<2>().0 {
            let read = (self.write + 1) % n;
            let live = self.generations.get(read).copied() == Some(self.generation);
            let (l, r) = if live {
                (
                    self.samples.get(read * 2).copied().unwrap_or(0.0),
                    self.samples.get(read * 2 + 1).copied().unwrap_or(0.0),
                )
            } else {
                (0.0, 0.0)
            };
            if let (Some(dst), Some(g)) = (
                self.samples.get_mut(self.write * 2..self.write * 2 + 2),
                self.generations.get_mut(self.write),
            ) {
                dst.copy_from_slice(&[*a, *b]);
                *g = self.generation;
                *a = l;
                *b = r;
            }
            self.write = read;
        }
    }

    pub fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
        self.write = 0;
    }

    pub fn take_state_from(&mut self, previous: &mut CompensationDelay) {
        if self.frames != previous.frames {
            return;
        }
        core::mem::swap(&mut self.samples, &mut previous.samples);
        core::mem::swap(&mut self.generations, &mut previous.generations);
        core::mem::swap(&mut self.write, &mut previous.write);
        core::mem::swap(&mut self.generation, &mut previous.generation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_by_exactly_frames_and_resets() {
        let mut d = CompensationDelay::new(3);
        let mut s: Vec<f32> = (1..=8).flat_map(|i| [i as f32, -(i as f32)]).collect();
        d.process(&mut s);
        assert_eq!(&s[..6], &[0.0; 6]);
        assert_eq!(&s[6..10], &[1.0, -1.0, 2.0, -2.0]);
        d.reset();
        let mut z = vec![0.0f32; 8];
        d.process(&mut z);
        assert!(z.iter().all(|&x| x == 0.0));
    }
}
