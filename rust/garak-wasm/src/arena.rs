//! Storage for effect delay lines and reverb kernels in the module's linear memory.
//!
//! Effects are created on the worklet's control path (processor construction, a parameter that
//! needs a rebuild), never inside `process()`. Their buffers come from this arena: best-fit reuse of
//! freed regions, otherwise the top grows (`memory.grow` on wasm32). Growth replaces the memory's
//! `ArrayBuffer`, so the loader re-creates its views after any create call; `process()` never grows.
//! There is no general allocator in the module (no `alloc` crate).

/// Region bookkeeping capacity (each effect uses at most three regions at a time).
const REGIONS: usize = 160;
const ALIGN: usize = 16;

#[derive(Clone, Copy, Debug)]
struct Region {
    start: usize,
    len: usize,
    used: bool,
}

const EMPTY: Region = Region { start: 0, len: 0, used: false };

#[derive(Debug)]
pub struct Arena {
    regions: [Region; REGIONS],
    count: usize,
    base: usize,
    top: usize,
}

#[cfg(target_arch = "wasm32")]
mod memory {
    unsafe extern "C" {
        /// First free byte after the module's data and stack (defined by wasm-ld).
        static __heap_base: u8;
    }

    pub fn base() -> usize {
        (&raw const __heap_base) as usize
    }

    /// Makes `[0, end)` addressable.
    pub fn reserve(end: usize) -> bool {
        let pages = end.div_ceil(65_536);
        let current = core::arch::wasm32::memory_size(0);
        pages <= current || core::arch::wasm32::memory_grow(0, pages - current) != usize::MAX
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod memory {
    //! Host builds (unit tests): a fixed 48 MiB block stands in for linear memory.
    use core::cell::UnsafeCell;

    const WORDS: usize = 6 << 20;
    struct Heap(UnsafeCell<[u64; WORDS]>);
    // SAFETY: only reached through `Arena`, which the tests serialise behind a mutex.
    unsafe impl Sync for Heap {}
    static HEAP: Heap = Heap(UnsafeCell::new([0; WORDS]));

    pub fn base() -> usize {
        HEAP.0.get() as usize
    }

    pub fn reserve(end: usize) -> bool {
        end <= base() + WORDS * 8
    }
}

impl Arena {
    pub const fn new() -> Self {
        Self { regions: [EMPTY; REGIONS], count: 0, base: 0, top: 0 }
    }

    /// Bytes currently reserved by the arena (diagnostics).
    pub fn reserved(&self) -> usize {
        self.top.saturating_sub(self.base)
    }

    /// Address of a zero-length-safe region of at least `bytes`, 16-byte aligned. None when the
    /// memory cannot grow or the region table is full.
    pub fn alloc(&mut self, bytes: usize) -> Option<usize> {
        if self.base == 0 {
            self.base = memory::base().next_multiple_of(ALIGN);
            self.top = self.base;
        }
        let bytes = bytes.max(ALIGN).next_multiple_of(ALIGN);
        // Best fit among free regions.
        let mut best: Option<usize> = None;
        for (i, r) in self.regions.iter().enumerate().take(self.count) {
            if !r.used
                && r.len >= bytes
                && best.is_none_or(|b| self.regions.get(b).is_some_and(|br| r.len < br.len))
            {
                best = Some(i);
            }
        }
        if let Some(i) = best {
            let (start, len) = self.regions.get(i).map(|r| (r.start, r.len))?;
            if len - bytes >= 4096 && self.count < REGIONS {
                // Split: keep the tail free.
                self.insert(i + 1, Region { start: start + bytes, len: len - bytes, used: false });
                if let Some(r) = self.regions.get_mut(i) {
                    r.len = bytes;
                }
            }
            if let Some(r) = self.regions.get_mut(i) {
                r.used = true;
            }
            return Some(start);
        }
        if self.count >= REGIONS {
            return None;
        }
        let start = self.top;
        let end = start.checked_add(bytes)?;
        if !memory::reserve(end) {
            return None;
        }
        self.insert(self.count, Region { start, len: bytes, used: true });
        self.top = end;
        Some(start)
    }

    fn insert(&mut self, at: usize, region: Region) {
        if self.count >= REGIONS || at > self.count {
            return;
        }
        if let Some(tail) = self.regions.get_mut(at..=self.count) {
            tail.rotate_right(1);
        }
        if let Some(slot) = self.regions.get_mut(at) {
            *slot = region;
        }
        self.count += 1;
    }

    fn remove(&mut self, at: usize) {
        if at >= self.count {
            return;
        }
        if let Some(tail) = self.regions.get_mut(at..self.count) {
            tail.rotate_left(1);
        }
        self.count -= 1;
        if let Some(slot) = self.regions.get_mut(self.count) {
            *slot = EMPTY;
        }
    }

    /// Returns a region from `alloc`; neighbouring free regions merge. Unknown addresses are ignored.
    pub fn free(&mut self, start: usize) {
        let Some(i) = self.regions.iter().take(self.count).position(|r| r.used && r.start == start) else {
            return;
        };
        if let Some(r) = self.regions.get_mut(i) {
            r.used = false;
        }
        // Merge with the next, then with the previous free neighbour.
        let next_free = self.regions.get(i + 1).filter(|_| i + 1 < self.count).is_some_and(|n| !n.used);
        if next_free {
            let extra = self.regions.get(i + 1).map_or(0, |n| n.len);
            if let Some(r) = self.regions.get_mut(i) {
                r.len += extra;
            }
            self.remove(i + 1);
        }
        if i > 0 && self.regions.get(i - 1).is_some_and(|p| !p.used) {
            let extra = self.regions.get(i).map_or(0, |r| r.len);
            if let Some(p) = self.regions.get_mut(i - 1) {
                p.len += extra;
            }
            self.remove(i);
        }
    }

    /// Usable bytes of the region `alloc` returned at `start`; None for any other address.
    pub fn len_of(&self, start: usize) -> Option<usize> {
        self.regions.iter().take(self.count).find(|r| r.used && r.start == start).map(|r| r.len)
    }

    /// Bytes in use (diagnostics and tests).
    pub fn used(&self) -> usize {
        self.regions.iter().take(self.count).filter(|r| r.used).map(|r| r.len).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_and_merges_freed_regions() {
        let mut a = Arena::new();
        let x = a.alloc(10_000).unwrap();
        let y = a.alloc(100).unwrap();
        let z = a.alloc(50_000).unwrap();
        assert!(x.is_multiple_of(16) && y > x && z > y);
        a.free(y);
        a.free(x);
        // x and y merged: a request that fits their union reuses it.
        let w = a.alloc(10_050).unwrap();
        assert_eq!(w, x);
        a.free(w);
        a.free(z);
        assert_eq!(a.used(), 0);
        let top = a.reserved();
        let again = a.alloc(60_000).unwrap();
        assert_eq!(again, x);
        assert_eq!(a.reserved(), top);
        a.free(12345); // unknown: ignored
    }
}
