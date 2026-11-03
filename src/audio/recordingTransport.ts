export interface RecordingControl {
  cancelPreparation(): boolean
  finishRecording(): boolean
}

interface PlaybackEngine {
  pause(): void
  stop(): void
  togglePlayback(): Promise<void>
}

interface ObservableTransport {
  getSnapshot(): { playing: boolean }
  subscribe(listener: () => void): () => void
}

export async function togglePlaybackWithRecording(
  engine: Pick<PlaybackEngine, 'pause' | 'togglePlayback'>,
  recording: RecordingControl,
): Promise<void> {
  // Call both even if preparation was cancelled: pending final recorder events
  // still belong to this take and must not accidentally resume playback.
  const cancelled = recording.cancelPreparation()
  const finished = recording.finishRecording()
  if (cancelled || finished) engine.pause()
  else await engine.togglePlayback()
}

export function stopPlaybackWithRecording(engine: Pick<PlaybackEngine, 'stop'>, recording: RecordingControl): void {
  recording.cancelPreparation()
  recording.finishRecording()
  engine.stop()
}

export function pausePlaybackWithRecording(engine: Pick<PlaybackEngine, 'pause'>, recording: RecordingControl): void {
  recording.cancelPreparation()
  recording.finishRecording()
  engine.pause()
}

/** Natural project end and output interruptions finish a take just like a transport pause. */
export function bindRecordingToTransport(engine: ObservableTransport, finishRecording: () => boolean): () => void {
  let playing = engine.getSnapshot().playing
  return engine.subscribe(() => {
    const next = engine.getSnapshot().playing
    const stopped = playing && !next
    // Completion can itself publish another snapshot; update before calling it.
    playing = next
    if (stopped) finishRecording()
  })
}
