export type VadActivity = { speaking: boolean; ended: boolean; healthy: boolean };

// Energy VAD for the clean, synthesized RTC downlink. Hysteresis prevents quiet
// syllables from flickering; onset rejects clicks; hangover bridges word pauses.
export class DownlinkVad {
  private noise = 0.0003;
  private onset = 0;
  private silence = 0;
  private voiced = false;
  reset() { this.noise = 0.0003; this.onset = 0; this.silence = 0; this.voiced = false; }
  frame(rms: number, durationMs: number): VadActivity {
    if (!Number.isFinite(rms) || rms < 0 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 100) {
      this.reset(); return { speaking: false, ended: false, healthy: false };
    }
    const threshold = Math.max(this.voiced ? 0.001 : 0.002, this.noise * (this.voiced ? 2 : 3.5));
    const active = rms >= threshold;
    let ended = false;
    if (active) {
      this.onset += durationMs; this.silence = 0;
      if (this.onset >= 60) this.voiced = true;
    } else {
      this.onset = 0;
      this.silence += durationMs;
      if (!this.voiced) this.noise = this.noise * 0.98 + Math.min(rms, 0.003) * 0.02;
      if (this.voiced && this.silence >= 900) { this.voiced = false; ended = true; }
    }
    return { speaking: this.voiced, ended, healthy: true };
  }
}

const processorCode = `
class DownlinkMeter extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.sumSquares = 0; this.samples = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0].length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      value /= channels.length;
      this.sum += value; this.sumSquares += value * value; this.samples++;
    }
    if (this.samples >= sampleRate * 0.02) {
      const mean = this.sum / this.samples;
      this.port.postMessage({ rms: Math.sqrt(Math.max(0, this.sumSquares / this.samples - mean * mean)), durationMs: this.samples / sampleRate * 1000, audioTime: currentTime });
      this.sum = 0; this.sumSquares = 0; this.samples = 0;
    }
    return true;
  }
}
registerProcessor('downlink-meter', DownlinkMeter);`;

export type DownlinkMonitor = { dispose: () => void; resume: () => Promise<void> };

export async function monitorDownlinkAudio(
  track: MediaStreamTrack,
  receiving: () => boolean,
  activity: (state: VadActivity) => void,
  failed: (message: string) => void,
): Promise<DownlinkMonitor> {
  const context = new AudioContext();
  const url = URL.createObjectURL(new Blob([processorCode], { type: 'text/javascript' }));
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let gain: GainNode | undefined;
  let disposed = false;
  const vad = new DownlinkVad();
  let lastReport = 0;
  let previousSpeaking = false;
  let previousHealthy = false;
  const unavailable = () => {
    vad.reset(); previousSpeaking = false;
    const now = performance.now();
    if (previousHealthy || now - lastReport >= 100) {
      lastReport = now; activity({ speaking: false, ended: false, healthy: false });
    }
    previousHealthy = false;
  };
  const onState = () => { if (!disposed && context.state !== 'running') unavailable(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    track.removeEventListener('mute', unavailable);
    track.removeEventListener('ended', unavailable);
    context.removeEventListener('statechange', onState);
    if (processor) { processor.port.onmessage = null; processor.onprocessorerror = null; processor.port.close(); processor.disconnect(); }
    source?.disconnect(); gain?.disconnect();
    void context.close().catch(() => {});
    // The track belongs to RTC: never stop it or play this analysis branch.
  };
  try {
    await context.audioWorklet.addModule(url);
    source = context.createMediaStreamSource(new MediaStream([track]));
    processor = new AudioWorkletNode(context, 'downlink-meter');
    gain = context.createGain(); gain.gain.value = 0;
    source.connect(processor); processor.connect(gain); gain.connect(context.destination);
    processor.port.onmessage = event => {
      if (disposed) return;
      if (context.state !== 'running' || track.readyState !== 'live' || track.muted || !track.enabled || !receiving() || context.currentTime - event.data.audioTime > 0.25) {
        unavailable(); return;
      }
      const state = vad.frame(event.data.rms, event.data.durationMs);
      const now = performance.now();
      if (state.ended || !previousHealthy || state.speaking !== previousSpeaking || now - lastReport >= 100) {
        lastReport = now; previousSpeaking = state.speaking; previousHealthy = state.healthy; activity(state);
      }
    };
    processor.onprocessorerror = () => { unavailable(); failed('下行音频分析器异常，自动播报已停止等待检测信号'); };
    track.addEventListener('mute', unavailable);
    track.addEventListener('ended', unavailable);
    context.addEventListener('statechange', onState);
    if (context.state !== 'running') {
      unavailable(); failed('请点击“恢复播放”启用下行音频检测');
    }
    return { dispose, resume: async () => { await context.resume(); } };
  } catch (error) { dispose(); throw error; }
  finally { URL.revokeObjectURL(url); }
}
