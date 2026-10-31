"""Audio analysis helpers for cutting multi-note recordings into samples.

Used by the gugak set builders (gayageum.py, haegeum.py, daegeum.py). Everything works on the
float32 (frames, channels) arrays returned by common.decode at common.RATE.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from common import RATE, trim


def envelope_db(audio: np.ndarray, hop: float = 0.01) -> np.ndarray:
    """Peak envelope in dBFS, one value per `hop` seconds."""
    mono = np.abs(audio).max(axis=1)
    n = int(hop * RATE)
    k = len(mono) // n
    e = mono[:k * n].reshape(k, n).max(axis=1)
    return 20 * np.log10(np.maximum(e, 1e-6))


def find_segments(audio: np.ndarray, *, on_db: float = -30, off_db: float = -45, min_gap: float = 0.15,
                  hop: float = 0.01) -> list[tuple[float, float]]:
    """Regions (start, end in seconds) that stay above off_db, separated by gaps >= min_gap below it.

    Regions that never reach on_db are dropped as noise.
    """
    e = envelope_db(audio, hop)
    above = e > off_db
    n = len(e)
    gap = int(round(min_gap / hop))
    segs: list[tuple[float, float]] = []
    i = 0
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i
        while j < n:
            if above[j]:
                j += 1
                continue
            k = j
            while k < n and not above[k]:
                k += 1
            if k - j >= gap or k >= n:
                break
            j = k
        if e[i:j].max() > on_db:
            segs.append((i * hop, j * hop))
        i = j
    return segs


def find_onsets(audio: np.ndarray, *, on_db: float = -30, quiet_db: float = -45, quiet_for: float = 0.3,
                hop: float = 0.005) -> list[float]:
    """Times (s) where the envelope rises above on_db after >= quiet_for seconds below quiet_db."""
    e = envelope_db(audio, hop)
    need = int(round(quiet_for / hop))
    out: list[float] = []
    quiet = 0
    armed = False
    for i, v in enumerate(e):
        if v < quiet_db:
            quiet += 1
            if quiet >= need:
                armed = True
        else:
            quiet = 0
            if armed and v > on_db:
                out.append(i * hop)
                armed = False
    return out


def _acf_pitch(frame: np.ndarray, fmin: float, fmax: float) -> tuple[float, float] | None:
    """Normalised autocorrelation pitch of one frame -> (freq, clarity) or None."""
    frame = frame - frame.mean()
    if np.abs(frame).max() < 1e-4:
        return None
    n = len(frame)
    w = frame * np.hanning(n)
    size = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(w, size)
    acf = np.fft.irfft(spec * np.conj(spec))[:n]
    acf /= acf[0] + 1e-12
    lo = int(RATE / fmax)
    hi = min(n - 2, int(RATE / fmin))
    if hi <= lo + 2:
        return None
    seg = acf[lo:hi]
    peaks = np.nonzero((seg[1:-1] > seg[:-2]) & (seg[1:-1] >= seg[2:]))[0] + 1 + lo
    if len(peaks) == 0:
        return None
    k = int(peaks[np.argmax(acf[peaks])])
    best = float(acf[k])
    if best < 0.3:
        return None
    # The strongest lag is the true period in practice; only a sub-multiple that is a near tie
    # indicates an octave-down error. Resonant instruments (haegeum) make single harmonics loud,
    # so looser rules ("first peak above threshold", 0.95 ties) pick harmonics instead.
    for d in (2, 3):
        target = k / d
        if target < lo:
            break
        near = peaks[np.abs(peaks - target) <= max(2, 0.03 * target)]
        if len(near) and acf[near].max() >= 0.99 * best:
            k = int(near[np.argmax(acf[near])])
    a, b, c = acf[k - 1], acf[k], acf[k + 1]
    denom = a - 2 * b + c
    shift = 0.5 * (a - c) / denom if denom != 0 else 0.0
    lag = k + shift
    return RATE / lag, float(b)


def detect_pitch(audio: np.ndarray, *, fmin: float = 60, fmax: float = 2000, frame: int = 8192,
                 region: tuple[float, float] = (0.25, 0.75)) -> tuple[float, float] | None:
    """Median fundamental (Hz) over the middle `region` of a clip, plus clarity 0..1.

    Returns None when fewer than 3 frames give a clear, consistent reading.
    """
    mono = audio.mean(axis=1).astype(np.float64)
    a = int(len(mono) * region[0])
    b = int(len(mono) * region[1])
    if b - a < frame:
        a, b = 0, len(mono)
    hop = frame // 2
    freqs, clars = [], []
    for s in range(a, b - frame + 1, hop):
        r = _acf_pitch(mono[s:s + frame], fmin, fmax)
        if r is not None:
            freqs.append(r[0])
            clars.append(r[1])
    if len(freqs) < 3:
        return None
    freqs_a = np.array(freqs)
    med = float(np.median(freqs_a))
    close = np.abs(1200 * np.log2(freqs_a / med)) < 50
    if close.mean() < 0.6:
        return None
    return float(np.median(freqs_a[close])), float(np.mean(np.array(clars)[close]))


def hz_to_midi(freq: float) -> tuple[int, float]:
    """(nearest MIDI note, cents offset from it)."""
    m = 69 + 12 * np.log2(freq / 440)
    note = int(round(m))
    return note, float((m - note) * 100)


def find_loop(audio: np.ndarray, *, region: tuple[float, float] = (0.4, 0.8), min_len: float = 0.25,
              match: int = 2048) -> tuple[float, float] | None:
    """Pick loop points (seconds) inside `region` where the waveform at the end best matches the start.

    Both points sit on rising zero crossings of the mono mix so the splice is click-free.
    """
    mono = audio.mean(axis=1).astype(np.float64)
    n = len(mono)
    a = int(n * region[0])
    b = int(n * region[1])
    if b - a < int(min_len * RATE) + match:
        return None
    rising = np.nonzero((mono[:-1] <= 0) & (mono[1:] > 0))[0] + 1
    starts = rising[(rising >= a) & (rising < a + int(0.1 * RATE))]
    if len(starts) == 0:
        return None
    start = int(starts[0])
    ref = mono[start:start + match]
    if np.abs(ref).max() < 1e-5:
        return None
    ends = rising[(rising >= start + int(min_len * RATE)) & (rising + match <= b)]
    if len(ends) == 0:
        return None
    best, best_err = None, None
    for e in ends:
        seg = mono[e:e + match]
        err = float(np.mean((seg - ref) ** 2)) / float(np.mean(ref ** 2) + 1e-12)
        if best_err is None or err < best_err:
            best, best_err = int(e), err
    if best is None:
        return None
    return start / RATE, best / RATE


@dataclass
class ScaleNote:
    root: int
    cents: float
    freq: float
    clip: np.ndarray
    loop: tuple[float, float] | None
    src: tuple[float, float]  # segment position in the source file (s)


def cut_scale(audio: np.ndarray, *, min_len: float = 0.8, max_len: float = 6.0, fade: float = 0.3,
              fmin: float = 60, fmax: float = 2000, label: str = "") -> tuple[list[ScaleNote], list[str]]:
    """Split an ascending scale recording into sustained notes with pitch and loop points.

    Segments are separated by > 150 ms below -45 dBFS. Notes shorter than min_len are dropped;
    longer ones are cut to max_len. Pitch comes from the middle 50 % of the segment. Because the
    sources are ascending scales, a note that is not higher than the previous accepted one is
    treated as a detection error and dropped. Returns (notes, log messages for dropped segments).
    """
    env = envelope_db(audio)
    first = int(np.argmax(env > -40))
    floor = float(np.median(env[:max(1, first - 2)])) if first > 5 else -70.0
    end_db = max(-60.0, floor + 8)
    notes: list[ScaleNote] = []
    dropped: list[str] = []
    for s, t in find_segments(audio, on_db=-30, off_db=-45, min_gap=0.15):
        where = f"{label} {s:.2f}-{t:.2f}s"
        if t - s < min_len:
            dropped.append(f"{where}: too short ({t - s:.2f}s)")
            continue
        seg = audio[max(0, int(s * RATE) - int(0.01 * RATE)):int(t * RATE) + int(0.05 * RATE)]
        r = detect_pitch(seg, fmin=fmin, fmax=fmax, region=(0.25, 0.75))
        if r is None or r[1] < 0.8:
            dropped.append(f"{where}: pitch unreliable ({'no reading' if r is None else f'clarity {r[1]:.2f}'})")
            continue
        root, cents = hz_to_midi(r[0])
        if notes and root <= notes[-1].root:
            dropped.append(f"{where}: detected {root} ({r[0]:.1f} Hz) breaks the ascending scale after {notes[-1].root}")
            continue
        clip = trim(seg, start_db=-40, end_db=end_db, max_seconds=max_len, fade_out=fade)
        dur = len(clip) / RATE
        hi = min(0.8, (dur - fade - 0.05) / dur) if dur > 0 else 0.8
        loop = find_loop(clip, region=(0.4, hi), min_len=0.3) if hi > 0.5 else None
        if loop is None:
            dropped.append(f"{where}: no loop found (kept without loop)")
        notes.append(ScaleNote(root, cents, r[0], clip, loop, (s, t)))
    return notes, dropped
