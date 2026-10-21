import { pinyin } from 'pinyin-pro';

export type ReplyMatch = { matched: boolean; progress: number; method: 'text' | 'phonetic'; scope: 'full' | 'tail'; compared_chars: number };
export type RecognitionTarget = { live_id: string; task_id: string; capture_id: string; enabled: boolean };
export type WhisperSegment = { text: string; start_ms: number; end_ms: number; words?: { text: string; start_ms: number; end_ms: number; probability: number }[] };
export type WhisperAudioRequest = RecognitionTarget & { samples: number[]; offset_ms: number; captured_at: number };
export type WhisperResult = RecognitionTarget & { segments: WhisperSegment[]; offset_ms: number; captured_at: number; inference_ms: number };
export type RecognitionObservation = RecognitionTarget & { text: string; segments?: WhisperSegment[]; captured_at: number; inference_ms: number; error?: string };

export function mergeWhisperTimeline(previous: WhisperSegment[], fresh: WhisperSegment[], offsetMs: number): WhisperSegment[] {
  const committed = previous.flatMap(segment => {
    if (segment.end_ms <= offsetMs) return [segment];
    if (segment.start_ms >= offsetMs) return [];
    // A rolling window can cut through a long segment. Commit its individual
    // words instead of losing all progress before that boundary.
    const words = segment.words?.filter(word => word.end_ms <= offsetMs) || [];
    return words.length ? [{ ...segment, text: words.map(word => word.text).join(''), end_ms: words.at(-1)!.end_ms, words }] : [];
  });
  return [...committed, ...fresh];
}

function normalizeNumber(value: string): string {
  const digits = '零一二三四五六七八九';
  const digit = (char: string) => /\d/.test(char) ? Number(char) : char === '两' ? 2 : char === '〇' ? 0 : digits.indexOf(char);
  if (!/[十百千万亿]/.test(value)) return [...value].map(digit).join('');
  let total = 0, section = 0, number = 0;
  for (const char of value) {
    const unit = ({ 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 } as Record<string, number>)[char];
    if (!unit) { number = number * 10 + digit(char); continue; }
    if (unit < 10000) section += (number || 1) * unit;
    else { total += (section + number) * unit; section = 0; }
    number = 0;
  }
  return String(total + section + number);
}

export function normalizeSpeech(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[零〇一二两三四五六七八九十百千万亿\d]+/g, normalizeNumber).replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

function matchTokens(expected: readonly string[], observed: readonly string[]): { matched: boolean; progress: number } {
  if (!expected.length || !observed.length) return { matched: false, progress: 0 };
  const length = Math.max(expected.length, observed.length);
  const distance = editDistance(expected, observed);
  return { matched: distance * 10 <= length * 3, progress: Math.max(0, 1 - distance / length) };
}

export function matchReplyEnding(expectedText: string, observedText: string): ReplyMatch {
  const fullExpected = Array.from(normalizeSpeech(expectedText));
  const fullObserved = Array.from(normalizeSpeech(observedText));
  const scope = fullExpected.length >= 15 ? 'tail' as const : 'full' as const;
  // Short and medium replies use the whole transcript. At 15 characters and
  // above, compare only the last ten characters on both sides.
  const expected = scope === 'tail' ? fullExpected.slice(-10) : fullExpected;
  const observed = scope === 'tail' ? fullObserved.slice(-10) : fullObserved.slice(-8000);
  const context = { scope, compared_chars: expected.length };
  const literal = { ...matchTokens(expected, observed), method: 'text' as const, ...context };
  if (literal.progress === 1 || !expected.length || !observed.length || !/\p{Script=Han}/u.test(expected.join('') + observed.join(''))) return literal;
  // Compare syllables, not concatenated Latin letters: "xi an" and "xian"
  // must stay distinct. Preserve non-Chinese characters as literal tokens.
  const sounds = (text: readonly string[]) => pinyin(text.join(''), { type: 'all', toneType: 'none', v: true })
    .map(token => token.isZh ? `zh:${token.pinyin}` : `literal:${token.origin}`);
  return { ...matchTokens(sounds(expected), sounds(observed)), method: 'phonetic', ...context };
}

// Stateful box resampling preserves fractional sample boundaries at 44.1kHz.
export class Pcm16Encoder {
  private sum = 0;
  private weight = 0;
  constructor(private inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < 16000 || inputRate > 192000) throw new Error('不支持的下行音频采样率');
  }
  encode(samples: Float32Array): Int16Array {
    const output: number[] = [];
    const ratio = this.inputRate / 16000;
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += Math.max(-1, Math.min(1, sample)) * take; this.weight += take; remaining -= take;
        if (this.weight >= ratio - 1e-9) {
          const value = this.sum / this.weight;
          output.push(Math.round(value * (value < 0 ? 32768 : 32767)));
          this.sum = 0; this.weight = 0;
        }
      }
    }
    return Int16Array.from(output);
  }
}

export class WhisperCapture {
  private target?: RecognitionTarget;
  private generation = 0;
  private frames: Int16Array[] = [];
  private size = 0;
  private total = 0;
  private encoder?: Pcm16Encoder;
  private rate = 0;
  private lastVoice = 0;
  private submittedVoice = 0;
  private submittedAt = 0;
  private submittedFinal = false;
  private busy = false;
  private timeline: WhisperSegment[] = [];
  constructor(
    private transcribe: (request: WhisperAudioRequest) => Promise<WhisperResult>,
    private observed: (result: RecognitionObservation) => void,
    private now: () => number = Date.now,
  ) {}
  start(target?: RecognitionTarget) {
    if (target?.enabled && this.target?.capture_id === target.capture_id && this.target.live_id === target.live_id && this.target.task_id === target.task_id) return;
    this.generation++; this.target = target?.enabled ? { ...target } : undefined;
    this.frames = []; this.size = 0; this.total = 0; this.encoder = undefined; this.rate = 0;
    this.lastVoice = 0; this.submittedVoice = 0; this.submittedAt = 0; this.submittedFinal = false; this.timeline = [];
  }
  invalidate(message: string) {
    const target = this.target;
    this.start();
    if (target) this.observed({ ...target, text: '', captured_at: this.now(), inference_ms: 0, error: message });
  }
  push(samples: Float32Array, sampleRate: number, quietMs: number) {
    if (!this.target) return;
    if (this.rate && sampleRate !== this.rate) { this.invalidate('下行音频采样率发生变化，请确认当前任务'); return; }
    this.rate = sampleRate; this.encoder ||= new Pcm16Encoder(sampleRate);
    const pcm = this.encoder.encode(samples);
    if (!pcm.length) return;
    this.frames.push(pcm); this.size += pcm.length; this.total += pcm.length;
    while (this.size > 384000 && this.frames.length > 1) this.size -= this.frames.shift()!.length;
    if (quietMs === 0) { this.lastVoice = this.total; this.submittedFinal = false; }
    const final = quietMs >= 350;
    if (this.busy || !this.lastVoice || this.total < 16000 || (this.lastVoice <= this.submittedVoice && (!final || this.submittedFinal))) return;
    if (!final && this.total - this.submittedAt < 24000) return;
    void this.submit(final);
  }
  private async submit(final: boolean) {
    const target = this.target;
    if (!target) return;
    const generation = this.generation;
    const samples = new Int16Array(this.size);
    let cursor = 0;
    for (const frame of this.frames) { samples.set(frame, cursor); cursor += frame.length; }
    this.submittedAt = this.total; this.submittedVoice = this.lastVoice; this.submittedFinal = final;
    const offset = Math.round((this.total - this.size) / 16);
    const capturedAt = this.now();
    this.busy = true;
    try {
      const result = await this.transcribe({ ...target, samples: Array.from(samples), offset_ms: offset, captured_at: capturedAt });
      if (generation !== this.generation || !this.target || result.capture_id !== target.capture_id || result.task_id !== target.task_id || result.live_id !== target.live_id) return;
      const fresh = result.segments.filter(segment => segment.text && Number.isFinite(segment.start_ms) && Number.isFinite(segment.end_ms) && segment.start_ms >= 0 && segment.end_ms >= segment.start_ms && segment.end_ms <= samples.length / 16 + 500)
        .map(segment => ({ ...segment, start_ms: segment.start_ms + offset, end_ms: segment.end_ms + offset,
          words: segment.words?.map(word => ({ ...word, start_ms: word.start_ms + offset, end_ms: word.end_ms + offset })) }));
      this.timeline = mergeWhisperTimeline(this.timeline, fresh, offset);
      const text = this.timeline.map(segment => segment.text).join('');
      this.observed({ ...target, text, segments: this.timeline, captured_at: capturedAt, inference_ms: result.inference_ms });
    } catch (error) {
      if (generation === this.generation) this.invalidate(String(error));
    } finally { this.busy = false; }
  }
}
