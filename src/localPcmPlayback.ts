export type LocalPcmEvent = {
  live_id: string; epoch: number; state: 'frame' | 'buffer' | 'stop'; pcm?: number[]; task_id?: string;
  pcm_base64?: string; play_at_ms?: number;
};

// The component API uses our TTS audio to render the avatar. Play those same
// cached audio locally on the slot clock; RTC is not our audio source.
export class LocalPcmPlayback {
  private context = new AudioContext({ latencyHint: 'interactive' });
  private output = this.context.createGain();
  private capture = this.context.createMediaStreamDestination();
  private silence = this.context.createConstantSource();
  private sources = new Set<AudioBufferSourceNode>();
  private epoch = -1;
  private stoppedThrough = -1;
  private nextAt = 0;
  private bufferedBytes = 0;
  private disposed = false;

  constructor(private now = Date.now) {
    this.output.connect(this.context.destination);
    this.output.connect(this.capture);
    // Keep the playback observer receiving real silence between replies so
    // queue readiness never depends on an optional remote audio publication.
    this.silence.offset.value = 0;
    this.silence.connect(this.output);
    this.silence.start();
  }
  get track() { return this.capture.stream.getAudioTracks()[0]; }
  get running() { return !this.disposed && this.context.state === 'running'; }
  async resume() { if (!this.disposed) await this.context.resume(); }

  accept(event: LocalPcmEvent) {
    if (this.disposed || event.epoch < this.epoch) return;
    if (event.state === 'stop') {
      this.stoppedThrough = Math.max(this.stoppedThrough, event.epoch);
      this.clear();
      return;
    }
    if (event.epoch <= this.stoppedThrough) return;
    if (event.epoch !== this.epoch) {
      this.clear(); this.epoch = event.epoch;
    }
    if (!this.running) throw new Error('请点击“恢复播放”启用本地 PCM 声音');
    const prepared = event.state === 'buffer';
    let pcm: number[] | Uint8Array | undefined = event.pcm;
    if (prepared) {
      if (!event.pcm_base64 || event.pcm_base64.length > 3_840_000 || !Number.isFinite(event.play_at_ms)) throw new Error('本地 PCM 缓存格式无效');
      const bytes = atob(event.pcm_base64);
      pcm = Uint8Array.from(bytes, byte => byte.charCodeAt(0));
      if (this.bufferedBytes + pcm.length > 48_000 * 60) throw new Error('本地 PCM 缓存超过60秒');
      this.bufferedBytes += pcm.length;
    }
    if (!pcm?.length || pcm.length % 2 || (!prepared && pcm.length > 960)) throw new Error('本地 PCM 帧格式无效');
    if (!prepared && this.nextAt - this.context.currentTime > 0.5) {
      this.clear();
      throw new Error('本地音频播放积压，已停止当前回答');
    }
    const buffer = this.context.createBuffer(1, pcm.length / 2, 24000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const value = pcm[i * 2] | (pcm[i * 2 + 1] << 8);
      samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    this.sources.add(source);
    const targetAt = prepared ? this.context.currentTime + (event.play_at_ms! - this.now()) / 1000 : this.context.currentTime;
    const startAt = Math.max(this.context.currentTime + 0.03, targetAt + 0.03, this.nextAt);
    source.start(startAt);
    this.nextAt = startAt + buffer.duration;
  }
  private clear() {
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextAt = 0; this.bufferedBytes = 0;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.clear();
    this.silence.stop(); this.silence.disconnect(); this.output.disconnect();
    this.capture.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => {});
  }
}
