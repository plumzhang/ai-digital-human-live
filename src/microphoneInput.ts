import { Pcm16Encoder, type WhisperAudioRequest, type WhisperResult } from './whisperRecognition';

// Keep a short pre-roll so the VAD onset does not clip the first syllable.
// Only the latest utterance may produce a reply after ASR returns.
export class MicrophoneInput {
  private encoder?: Pcm16Encoder;
  private rate = 0;
  private preRoll: number[] = [];
  private samples: number[] = [];
  private active = false;
  private generation = 0;
  private interruption = Promise.resolve();
  constructor(
    private liveId: string,
    private transcribe: (request: WhisperAudioRequest) => Promise<WhisperResult>,
    private started: () => Promise<void>,
    private recognized: (text: string, captureId: string) => void,
    private failed: (error: string) => void,
  ) {}
  stop() { this.generation++; this.active = false; this.samples = []; this.preRoll = []; this.encoder = undefined; this.rate = 0; }
  push(samples: Float32Array, rate: number, quietMs: number) {
    if (this.rate && this.rate !== rate) { this.stop(); this.failed('麦克风采样率变化，请重新开启'); return; }
    this.rate = rate; this.encoder ||= new Pcm16Encoder(rate);
    const pcm = Array.from(this.encoder.encode(samples));
    if (!this.active) {
      this.preRoll.push(...pcm); this.preRoll = this.preRoll.slice(-4800);
      if (quietMs !== 0) return;
      this.active = true; this.generation++; this.samples = this.preRoll; this.preRoll = [];
      this.interruption = this.started();
      // Report immediately; a failed interruption must prevent this reply.
      void this.interruption.catch(error => this.failed(String(error)));
    } else this.samples.push(...pcm);
    if (quietMs >= 900 || this.samples.length >= 320000) this.finish();
  }
  private finish() {
    this.active = false;
    const samples = this.samples; this.samples = [];
    if (samples.length < 3200) return;
    const generation = this.generation;
    const captureId = crypto.randomUUID();
    const interruption = this.interruption;
    void (async () => {
      await interruption;
      const result = await this.transcribe({ live_id: this.liveId, task_id: 'microphone', capture_id: captureId, enabled: true, samples, offset_ms: 0, captured_at: Date.now() });
      if (generation !== this.generation) return;
      const text = result.segments.map(segment => segment.text).join('').trim();
      if (text) this.recognized(text, captureId);
    })().catch(error => { if (generation === this.generation) this.failed(String(error)); });
  }
}
