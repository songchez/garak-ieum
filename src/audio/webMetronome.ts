import { countInClicks, DEFAULT_METRONOME_PREFS, effectiveLevel, metronomeGrid, scheduleSegment, type MetronomeEngineState, type MetronomeLevel } from '../core/metronome'
import type { Project } from '../core/types'
import { metronomeStrokes } from './metronomeSounds'

interface Scheduled { source: AudioBufferSourceNode; start: number }

/**
 * Browser metronome. Clicks are AudioBufferSourceNodes started at exact
 * audio-clock times by the engine's look-ahead scheduler (never by timers), on
 * a bus straight to the destination: after the master, outside every track,
 * the MediaRecorder input and OfflineAudioContext export.
 */
export class WebMetronome {
  private state: MetronomeEngineState = { enabled: false, sound: DEFAULT_METRONOME_PREFS.sound, volume: DEFAULT_METRONOME_PREFS.volume, accent: true }
  private bus: GainNode | null = null
  private buffers: { context: BaseAudioContext; key: string; strokes: AudioBuffer[] } | null = null
  private scheduled = new Set<Scheduled>()

  getState(): MetronomeEngineState { return this.state }

  setState(state: MetronomeEngineState, now: number): void {
    const previous = this.state
    this.state = { ...state, volume: Math.min(1, Math.max(0, Number.isFinite(state.volume) ? state.volume : 0)) }
    if (this.bus) this.bus.gain.setTargetAtTime(this.state.volume, now, 0.01)
    // Turning the metronome off silences clicks already queued in the look-ahead window.
    if (previous.enabled && !this.state.enabled) this.cancel(now)
  }

  countInSeconds(project: Project, bars: number): number {
    return countInClicks(project.timeSignature, bars).lengthBeats * 60 / project.bpm
  }

  /** Count-in clicks play even with the metronome off: they are the cue to start. */
  scheduleCountIn(context: BaseAudioContext, project: Project, bars: number, startTime: number): void {
    const beatSeconds = 60 / project.bpm
    for (const click of countInClicks(project.timeSignature, bars).clicks) this.click(context, startTime + click.beat * beatSeconds, click.level)
  }

  /** One transport segment of the engine scheduler: [startBeat, endBeat) starting at `startTime`. */
  scheduleSegment(context: BaseAudioContext, project: Project, startBeat: number, endBeat: number, startTime: number): void {
    if (!this.state.enabled) return
    for (const click of scheduleSegment(metronomeGrid(project.timeSignature), startBeat, endBeat, startTime, 60 / project.bpm)) this.click(context, click.time, click.level)
  }

  /** Stops clicks that have not started yet; ringing ones decay naturally. */
  cancel(now: number): void {
    for (const item of this.scheduled) {
      if (item.start > now) {
        try { item.source.stop() } catch { /* already stopped */ }
        item.source.disconnect()
        this.scheduled.delete(item)
      }
    }
  }

  dispose(): void {
    for (const item of this.scheduled) {
      try { item.source.stop() } catch { /* already stopped */ }
      item.source.disconnect()
    }
    this.scheduled.clear()
    this.bus?.disconnect()
    this.bus = null
    this.buffers = null
  }

  private output(context: BaseAudioContext): GainNode {
    if (this.bus?.context === context) return this.bus
    this.bus?.disconnect()
    this.bus = context.createGain()
    this.bus.gain.value = this.state.volume
    this.bus.connect(context.destination)
    return this.bus
  }

  private strokes(context: BaseAudioContext): AudioBuffer[] {
    const key = `${this.state.sound}:${this.state.accent}:${context.sampleRate}`
    if (this.buffers?.context === context && this.buffers.key === key) return this.buffers.strokes
    const strokes = metronomeStrokes(this.state.sound, this.state.accent, context.sampleRate).map(data => {
      const buffer = context.createBuffer(1, data.length, context.sampleRate)
      buffer.copyToChannel(data, 0)
      return buffer
    })
    this.buffers = { context, key, strokes }
    return strokes
  }

  private click(context: BaseAudioContext, time: number, level: MetronomeLevel): void {
    const now = context.currentTime
    if (time < now - 0.002) return
    const buffer = this.strokes(context)[effectiveLevel(level, this.state.accent)]
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.output(context))
    const item: Scheduled = { source, start: time }
    source.onended = () => { source.disconnect(); this.scheduled.delete(item) }
    this.scheduled.add(item)
    source.start(Math.max(time, now))
  }
}
