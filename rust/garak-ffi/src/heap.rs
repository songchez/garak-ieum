//! Global allocator of the staticlib: the C runtime's `malloc` family, which every C++ host links
//! already (so the library still needs no Rust runtime libraries). Only `garak-engine`'s control
//! half allocates (plans, graphs, PCM); garak-dsp and every audio-thread entry point never do.

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn calloc(count: usize, size: usize) -> *mut c_void;
    fn realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

/// `malloc` alignment every supported CRT guarantees on 64-bit targets (MSVC, MinGW, libSystem).
const MALLOC_ALIGN: usize = 16;

#[derive(Debug)]
pub struct Crt;

// SAFETY: the CRT functions are thread-safe and return null on failure. Over-aligned requests
// over-allocate and keep the original pointer in the word just below the aligned block.
unsafe impl GlobalAlloc for Crt {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= MALLOC_ALIGN {
            // SAFETY: plain malloc.
            return unsafe { malloc(layout.size().max(1)) }.cast();
        }
        let Some(total) = layout.size().checked_add(layout.align() + size_of::<usize>()) else {
            return core::ptr::null_mut();
        };
        // SAFETY: plain malloc.
        let raw = unsafe { malloc(total) }.cast::<u8>();
        if raw.is_null() {
            return raw;
        }
        let start = raw as usize + size_of::<usize>();
        let aligned = (start + layout.align() - 1) & !(layout.align() - 1);
        let offset = aligned - raw as usize;
        // SAFETY: `aligned - size_of::<usize>() >= raw` and the block holds `total` bytes.
        unsafe {
            let p = raw.add(offset);
            p.cast::<usize>().sub(1).write_unaligned(raw as usize);
            p
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if layout.align() <= MALLOC_ALIGN {
            // SAFETY: plain calloc.
            return unsafe { calloc(1, layout.size().max(1)) }.cast();
        }
        // SAFETY: forwarded; the block is then zeroed in full.
        unsafe {
            let p = self.alloc(layout);
            if !p.is_null() {
                core::ptr::write_bytes(p, 0, layout.size());
            }
            p
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if layout.align() <= MALLOC_ALIGN {
            // SAFETY: `ptr` came from malloc/calloc/realloc.
            unsafe { free(ptr.cast()) };
        } else {
            // SAFETY: `alloc` stored the original pointer just below `ptr`.
            unsafe { free(ptr.cast::<usize>().sub(1).read_unaligned() as *mut c_void) };
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if layout.align() <= MALLOC_ALIGN {
            // SAFETY: `ptr` came from malloc/calloc/realloc with this alignment class.
            return unsafe { realloc(ptr.cast(), new_size.max(1)) }.cast();
        }
        // SAFETY: the default move-and-free path for over-aligned blocks.
        unsafe {
            let Ok(next) = Layout::from_size_align(new_size, layout.align()) else {
                return core::ptr::null_mut();
            };
            let p = self.alloc(next);
            if !p.is_null() {
                core::ptr::copy_nonoverlapping(ptr, p, layout.size().min(new_size));
                self.dealloc(ptr, layout);
            }
            p
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_over_aligned_blocks() {
        for align in [1usize, 8, 16, 32, 64, 4096] {
            for size in [1usize, 7, 100, 10_000] {
                let layout = Layout::from_size_align(size, align).unwrap();
                unsafe {
                    let p = Crt.alloc_zeroed(layout);
                    assert!(!p.is_null() && (p as usize).is_multiple_of(align));
                    assert!((0..size).all(|i| *p.add(i) == 0));
                    core::ptr::write_bytes(p, 0xAB, size);
                    let q = Crt.realloc(p, layout, size * 3);
                    assert!(!q.is_null() && (q as usize).is_multiple_of(align));
                    assert!((0..size).all(|i| *q.add(i) == 0xAB));
                    Crt.dealloc(q, Layout::from_size_align(size * 3, align).unwrap());
                }
            }
        }
    }
}
