#pragma once
// Lock-free, allocation-free queues for live MIDI (docs/MIDI_RECORDING.md).
// MpscQueue: device callback threads (WinMM may call from several) -> audio callback.
// SpscRing: audio callback -> control thread (observed, transport-stamped events).
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace garak::midi {

/** Bounded multi-producer queue (Vyukov). Capacity must be a power of two.
 * push/pop never allocate or lock; a full queue drops the new item. */
template<class T, std::size_t N> class MpscQueue {
  static_assert(N >= 2 && (N & (N - 1)) == 0, "MpscQueue capacity must be a power of two");
 public:
  MpscQueue() noexcept { for (std::size_t i = 0; i < N; ++i) cells_[i].sequence.store(i, std::memory_order_relaxed); }
  bool push(const T& value) noexcept {
    auto position = enqueue_.load(std::memory_order_relaxed);
    for (;;) {
      auto& cell = cells_[position & (N - 1)];
      const auto sequence = cell.sequence.load(std::memory_order_acquire);
      const auto difference = static_cast<std::intptr_t>(sequence) - static_cast<std::intptr_t>(position);
      if (difference == 0) {
        if (enqueue_.compare_exchange_weak(position, position + 1, std::memory_order_relaxed)) {
          cell.value = value; cell.sequence.store(position + 1, std::memory_order_release); return true;
        }
      } else if (difference < 0) {
        dropped_.fetch_add(1, std::memory_order_relaxed); return false;
      } else position = enqueue_.load(std::memory_order_relaxed);
    }
  }
  /** Single consumer. */
  bool pop(T& value) noexcept {
    const auto position = dequeue_.load(std::memory_order_relaxed);
    auto& cell = cells_[position & (N - 1)];
    const auto sequence = cell.sequence.load(std::memory_order_acquire);
    if (static_cast<std::intptr_t>(sequence) - static_cast<std::intptr_t>(position + 1) < 0) return false;
    value = cell.value; cell.sequence.store(position + N, std::memory_order_release);
    dequeue_.store(position + 1, std::memory_order_relaxed); return true;
  }
  [[nodiscard]] std::uint64_t dropped() const noexcept { return dropped_.load(std::memory_order_relaxed); }
 private:
  struct Cell { std::atomic<std::size_t> sequence{0}; T value{}; };
  std::array<Cell, N> cells_{};
  alignas(64) std::atomic<std::size_t> enqueue_{0};
  alignas(64) std::atomic<std::size_t> dequeue_{0};
  alignas(64) std::atomic<std::uint64_t> dropped_{0};
};

/** Bounded single-producer/single-consumer ring; a full ring counts drops. */
template<class T, std::size_t N> class SpscRing {
 public:
  bool push(const T& value) noexcept {
    const auto write = write_.load(std::memory_order_relaxed);
    if (write - read_.load(std::memory_order_acquire) >= N) { dropped_.fetch_add(1, std::memory_order_relaxed); return false; }
    data_[write % N] = value; write_.store(write + 1, std::memory_order_release); return true;
  }
  bool pop(T& value) noexcept {
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == write_.load(std::memory_order_acquire)) return false;
    value = data_[read % N]; read_.store(read + 1, std::memory_order_release); return true;
  }
  /** Consumer side: drops since the last call. */
  std::uint64_t takeDropped() noexcept { return dropped_.exchange(0, std::memory_order_relaxed); }
 private:
  std::array<T, N> data_{};
  alignas(64) std::atomic<std::uint64_t> write_{0};
  alignas(64) std::atomic<std::uint64_t> read_{0};
  alignas(64) std::atomic<std::uint64_t> dropped_{0};
};

/** One short MIDI message from a source (hardware device or injected virtual keyboard). */
struct RawMidi {
  std::uint16_t source = 0;
  std::uint8_t status = 0, data1 = 0, data2 = 0;
  std::int64_t nanos = 0; // steady_clock time since epoch at arrival
};

/** What the audio callback did with a message: the transport frame it belongs to. */
struct ObservedMidi {
  std::uint16_t source = 0;
  std::uint8_t status = 0, data1 = 0, data2 = 0;
  bool playing = false;
  std::int64_t frame = 0; // latency-compensated transport frame; valid only when playing
};

} // namespace garak::midi
