import type { SongPcmSegment } from './songDirector';

// PCM is cut and saved in the singing module. Playback only reads those clips;
// the original media element remains the clock and the only audible song.
export async function createSongAudioBridge(audio: HTMLAudioElement, segments: SongPcmSegment[], readPcm: (path: string) => Promise<ArrayBuffer>, leadMs: number,
  send: (samples: number[], sequence: number) => Promise<void>, failed: (message: string) => void) {
  if (!segments.length || segments.length > 2000 || !Number.isInteger(leadMs) || leadMs < 0 || leadMs > 5000) throw new Error('歌词PCM片段或提前量无效，请先在唱歌模块截取PCM');
  const parts: Array<SongPcmSegment & { samples: Int16Array }> = [];
  let total = 0;
  // Bound file reads and retain each exact crop, including repeated lyrics.
  for (let offset = 0; offset < segments.length; offset += 4) {
    const batch = await Promise.all(segments.slice(offset, offset + 4).map(async part => {
      const data = await readPcm(part.pcm_path);
      if (data.byteLength !== part.sample_count * 2 || part.sample_count !== (part.end_ms - part.start_ms) * 24 || part.end_ms <= part.start_ms) throw new Error('歌词PCM片段与时间轴不匹配，请重新截取');
      return { ...part, samples: new Int16Array(data) };
    }));
    for (const part of batch) { total += part.samples.length; if (total > 86400000) throw new Error('歌词PCM缓存超过60分钟'); parts.push(part); }
  }
  if (parts.some((p, i) => i > 0 && p.start_ms < parts[i - 1].start_ms)) throw new Error('歌词PCM时间轴未排序');
  let context: AudioContext | undefined, source: MediaElementAudioSourceNode | undefined, delay: DelayNode | undefined;
  // Preserve the complete first lyric: advance PCM relative to the audible
  // original song using a local output delay rather than dropping its beginning.
  // With no lead, keep original-song output on the media element's direct
  // playback path. The PCM sender must never take over or mute that output.
  if (leadMs > 0) try {
    context = new AudioContext({ sampleRate: 24000 });
    source = context.createMediaElementSource(audio); delay = context.createDelay(5); delay.delayTime.value = leadMs / 1000;
    source.connect(delay); delay.connect(context.destination);
  } catch (error) { void context?.close().catch(() => {}); throw error; }
  let disposed = false, busy = false, sequence = 0, nextSample = 0, cursor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let work: Promise<void> = Promise.resolve();
  const pending: number[][] = [];
  let active: typeof parts = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearInterval(timer); pending.length = 0;
    source?.disconnect(); delay?.disconnect(); void context?.close().catch(() => {});
  };
  const pump = () => {
    if (busy) return; busy = true;
    work = (async () => {
      try { while (!disposed && pending.length) await send(pending.shift()!, sequence++); }
      catch (error) { if (!disposed) { dispose(); failed(`歌曲PCM发送失败：${String(error)}`); } }
      finally { busy = false; }
    })();
  };
  const enqueue = (position: number) => {
    if (position - nextSample > 12000) { dispose(); failed('歌曲PCM调度落后超过500毫秒，已停止以避免错位'); return; }
    while (!disposed && nextSample <= position) {
      if (pending.length >= 25) { dispose(); failed('歌曲PCM发送积压超过500毫秒，已停止'); return; }
      const end = nextSample + 480;
      while (cursor < parts.length && parts[cursor].start_ms * 24 < end) active.push(parts[cursor++]);
      active = active.filter(part => part.end_ms * 24 > nextSample);
      const samples = new Int16Array(480);
      for (const part of active) {
        const begin = Math.max(nextSample, part.start_ms * 24), until = Math.min(end, part.end_ms * 24);
        if (until > begin) samples.set(part.samples.subarray(begin - part.start_ms * 24, until - part.start_ms * 24), begin - nextSample);
      }
      pending.push(Array.from(samples)); nextSample = end; pump();
    }
  };
  const tick = () => {
    if (disposed || audio.paused) return;
    const position = Math.floor(audio.currentTime * 24000);
    if (position + 2400 < nextSample) { dispose(); failed('原歌曲位置发生回退，已停止旧PCM'); return; }
    enqueue(position);
  };
  return { dispose, resume: async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (context) await Promise.race([context.resume(), new Promise<never>((_, reject) => { timeout = setTimeout(() => { const error = new Error('请点击恢复播放以启用歌曲音频'); error.name = 'NotAllowedError'; reject(error); }, 1000); })]);
      if (!disposed && timer === undefined) { timer = setInterval(tick, 20); tick(); }
    } finally { clearTimeout(timeout); }
  }, drain: async () => {
    clearInterval(timer); timer = undefined;
    if (disposed) return;
    enqueue(Math.ceil(audio.currentTime * 24000) - 1); await work;
    if (!disposed && leadMs) await new Promise(resolve => setTimeout(resolve, leadMs));
  } };
}
