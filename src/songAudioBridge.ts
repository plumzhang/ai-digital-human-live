import type { SongPcmSegment } from './songDirector';
import { songPcmSchedule } from './songDirector';

// PCM is cut and saved in the singing module. Playback only reads those clips;
// the accompaniment remains the clock; only separated vocals go to Vidu.
export async function createSongAudioBridge(audio: HTMLAudioElement, segments: SongPcmSegment[], readPcm: (path: string) => Promise<ArrayBuffer>, leadMs: number,
  send: (samples: number[], sequence: number) => Promise<void>, failed: (message: string) => void,
  phase: (active: boolean, sequence: number) => Promise<void> = async () => {},
  cueSent: (index: number, sentAt: number) => void = () => {}) {
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
  // Only PCM dispatch moves earlier. The original audio's clock, playback
  // path and audible output are never delayed or rewound by this sender.
  const scheduled=songPcmSchedule(parts,leadMs);
  let disposed = false, busy = false, sequence = 0, nextSample = 0, cursor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let work: Promise<void> = Promise.resolve();
  const pending: Array<{ samples?: number[]; active?: boolean; cues?: number[] }> = [];
  const queuedCues = new Set<number>();
  let scheduledActive = false;
  let active: typeof scheduled = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearInterval(timer); pending.length = 0;
  };
  const pump = () => {
    if (busy) return; busy = true;
    work = (async () => {
      try { while (!disposed && pending.length) {
        const frame=pending.shift()!;
        if(frame.active!==undefined) await phase(frame.active,sequence);
        else {
          await send(frame.samples!,sequence++);
          const sentAt = Date.now();
          if (!disposed) for (const index of frame.cues || []) cueSent(index, sentAt);
        }
      } }
      catch (error) { if (!disposed) { dispose(); failed(`歌曲PCM发送失败：${String(error)}`); } }
      finally { busy = false; }
    })();
  };
  const enqueue = (position: number) => {
    if (position - nextSample > 12000) { dispose(); failed('歌曲PCM调度落后超过500毫秒，已停止以避免错位'); return; }
    while (!disposed && nextSample <= position) {
      if (pending.length >= 25) { dispose(); failed('歌曲PCM发送积压超过500毫秒，已停止'); return; }
      const end = nextSample + 480;
      while (cursor < scheduled.length && scheduled[cursor].send_at_ms * 24 < end) active.push(scheduled[cursor++]);
      // Sending early must not release the song channel while that phrase is
      // still audible alongside the accompaniment. Short gaps stay reserved.
      active = active.filter(part => Math.max(part.end_ms, part.send_end_ms) * 24 > nextSample);
      const singing=active.length>0;
      if(singing!==scheduledActive){scheduledActive=singing;pending.push({active:singing});}
      const samples = new Int16Array(480);
      const cues: number[] = [];
      for (const part of active) {
        const begin = Math.max(nextSample, part.send_at_ms * 24), until = Math.min(end, part.send_end_ms * 24);
        if (until > begin) {
          samples.set(part.samples.subarray(begin - part.send_at_ms * 24, until - part.send_at_ms * 24), begin - nextSample);
          if (!queuedCues.has(part.index)) { queuedCues.add(part.index); cues.push(part.index); }
        }
      }
      // Keep the stream clock running through reserved short gaps and the
      // lead-out, so Vidu can consume buffered phrase tails on time. A released
      // interlude still sends nothing and remains available to viewer replies.
      if(singing) pending.push({samples:Array.from(samples), cues});
      nextSample = end; pump();
    }
  };
  const tick = () => {
    if (disposed || audio.paused) return;
    const position = Math.floor(audio.currentTime * 24000);
    if (position + 2400 < nextSample) { dispose(); failed('原歌曲位置发生回退，已停止旧PCM'); return; }
    enqueue(position);
  };
  return { dispose, resume: async () => {
    if (!disposed && timer === undefined) { pending.push({active:scheduledActive});pump();timer = setInterval(tick, 20); tick(); }
  }, drain: async () => {
    clearInterval(timer); timer = undefined;
    if (disposed) return;
    enqueue(Math.ceil(audio.currentTime * 24000) - 1);
    if(scheduledActive){scheduledActive=false;pending.push({active:false});pump();}
    await work;
  } };
}
