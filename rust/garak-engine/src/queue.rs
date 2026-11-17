//! Bounded single-producer / single-consumer queue (the C++ engine's SPSC command and retire
//! queues). Lock-free and allocation-free after construction: `push` and `pop` only move values
//! through preallocated slots. One [`Producer`] and one [`Consumer`] exist per queue, so the
//! single-producer / single-consumer contract is enforced by ownership.

use alloc::boxed::Box;
use alloc::sync::Arc;
use core::cell::UnsafeCell;
use core::mem::MaybeUninit;
use core::sync::atomic::{AtomicUsize, Ordering};

struct Ring<T> {
    slots: Box<[UnsafeCell<MaybeUninit<T>>]>,
    /// Next slot to read (owned by the consumer).
    head: AtomicUsize,
    /// Next slot to write (owned by the producer).
    tail: AtomicUsize,
}

// SAFETY: a slot is written only by the producer before it publishes `tail` (Release) and read
// only by the consumer after observing it (Acquire), and vice versa for `head`; values of `T`
// move between the two threads, hence `T: Send`.
unsafe impl<T: Send> Sync for Ring<T> {}
// SAFETY: as above.
unsafe impl<T: Send> Send for Ring<T> {}

impl<T> Drop for Ring<T> {
    fn drop(&mut self) {
        let (mut head, tail) = (*self.head.get_mut(), *self.tail.get_mut());
        let n = self.slots.len();
        while head != tail {
            if let Some(slot) = self.slots.get_mut(head % n) {
                // SAFETY: slots in [head, tail) were written and not yet read.
                unsafe { slot.get_mut().assume_init_drop() };
            }
            head = head.wrapping_add(1);
        }
    }
}

pub struct Producer<T>(Arc<Ring<T>>);
pub struct Consumer<T>(Arc<Ring<T>>);

impl<T> core::fmt::Debug for Producer<T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Producer")
    }
}

impl<T> core::fmt::Debug for Consumer<T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Consumer")
    }
}

/// A queue holding at most `capacity` values (control thread: allocates).
pub fn channel<T>(capacity: usize) -> (Producer<T>, Consumer<T>) {
    let capacity = capacity.max(1);
    let slots = (0..capacity).map(|_| UnsafeCell::new(MaybeUninit::uninit())).collect();
    let ring = Arc::new(Ring { slots, head: AtomicUsize::new(0), tail: AtomicUsize::new(0) });
    (Producer(ring.clone()), Consumer(ring))
}

impl<T> Producer<T> {
    /// Hands `value` back when the queue is full.
    pub fn push(&mut self, value: T) -> Result<(), T> {
        let r = &*self.0;
        let tail = r.tail.load(Ordering::Relaxed);
        let head = r.head.load(Ordering::Acquire);
        let n = r.slots.len();
        if tail.wrapping_sub(head) >= n {
            return Err(value);
        }
        let Some(slot) = r.slots.get(tail % n) else { return Err(value) };
        // SAFETY: the slot at `tail` is free (the consumer released it through `head`), and only
        // this producer writes slots.
        unsafe { (*slot.get()).write(value) };
        r.tail.store(tail.wrapping_add(1), Ordering::Release);
        Ok(())
    }

    pub fn is_full(&self) -> bool {
        let r = &*self.0;
        r.tail.load(Ordering::Relaxed).wrapping_sub(r.head.load(Ordering::Acquire)) >= r.slots.len()
    }
}

impl<T> Consumer<T> {
    /// The value `pop` would return next, left in the queue (a host gating commands by ticket).
    pub fn peek(&self) -> Option<&T> {
        let r = &*self.0;
        let head = r.head.load(Ordering::Relaxed);
        let tail = r.tail.load(Ordering::Acquire);
        if head == tail {
            return None;
        }
        let slot = r.slots.get(head % r.slots.len())?;
        // SAFETY: published through `tail` and not released yet; only this consumer reads it, and
        // the borrow of `self` keeps `pop` from moving it out meanwhile.
        Some(unsafe { (*slot.get()).assume_init_ref() })
    }

    pub fn pop(&mut self) -> Option<T> {
        let r = &*self.0;
        let head = r.head.load(Ordering::Relaxed);
        let tail = r.tail.load(Ordering::Acquire);
        if head == tail {
            return None;
        }
        let slot = r.slots.get(head % r.slots.len())?;
        // SAFETY: the producer published this slot through `tail`; only this consumer reads it,
        // and it is read exactly once before `head` releases it.
        let value = unsafe { (*slot.get()).assume_init_read() };
        r.head.store(head.wrapping_add(1), Ordering::Release);
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    #[test]
    fn fifo_full_and_drop() {
        let (mut p, mut c) = channel::<Box<u32>>(3);
        for i in 0..3 {
            assert!(p.push(Box::new(i)).is_ok());
        }
        assert!(p.is_full());
        assert_eq!(p.push(Box::new(9)).map_err(|b| *b), Err(9));
        assert_eq!(c.peek().map(|b| **b), Some(0));
        assert_eq!(c.pop().map(|b| *b), Some(0));
        assert_eq!(c.peek().map(|b| **b), Some(1));
        assert!(p.push(Box::new(3)).is_ok());
        let rest: Vec<u32> = core::iter::from_fn(|| c.pop().map(|b| *b)).collect();
        assert_eq!(rest, [1, 2, 3]);
        assert!(p.push(Box::new(4)).is_ok()); // dropped with the ring, no leak
    }

    #[test]
    fn across_threads() {
        let (mut p, mut c) = channel::<u64>(8);
        let t = std::thread::spawn(move || {
            let mut sum = 0;
            let mut seen = 0;
            while seen < 10_000 {
                if let Some(v) = c.pop() {
                    sum += v;
                    seen += 1;
                }
            }
            sum
        });
        for i in 0..10_000u64 {
            let mut v = i;
            while let Err(back) = p.push(v) {
                v = back;
                core::hint::spin_loop();
            }
        }
        assert_eq!(t.join().unwrap(), (0..10_000u64).sum());
    }
}
