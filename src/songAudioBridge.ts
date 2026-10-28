// Send the original song waveform to the component, rather than synthesizing
// its lyrics as speech. The media element remains the playback clock.
export async function createSongAudioBridge(audio: HTMLAudioElement, send: (samples: number[], sequence: number) => Promise<void>, failed: (message: string) => void) {
  const context = new AudioContext({ sampleRate: 24000 });
  const code = `class SongPcm extends AudioWorkletProcessor {
    constructor(){super();this.samples=[];}
    process(inputs){const channels=inputs[0];if(!channels?.length)return true;
      for(let i=0;i<channels[0].length;i++){let sample=0;for(const c of channels)sample+=c[i]||0;sample=Math.max(-1,Math.min(1,sample/channels.length));this.samples.push(Math.round(sample*(sample<0?32768:32767)));}
      while(this.samples.length>=2400)this.port.postMessage(this.samples.splice(0,2400));return true;}
  } registerProcessor('song-pcm',SongPcm);`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  let disposed = false, busy = false, sequence = 0;
  const pending: number[][] = [];
  let source: MediaElementAudioSourceNode | undefined, processor: AudioWorkletNode | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true; pending.length = 0;
    if (processor) { processor.port.onmessage = null; processor.port.close(); processor.disconnect(); }
    source?.disconnect(); void context.close().catch(() => {});
  };
  const pump = async () => {
    if (busy) return;
    busy = true;
    try { while (!disposed && pending.length) await send(pending.shift()!, sequence++); }
    catch (error) { if (!disposed) { dispose(); failed(`歌曲 PCM 发送失败：${String(error)}`); } }
    finally { busy = false; }
  };
  try {
    await context.audioWorklet.addModule(url);
    source = context.createMediaElementSource(audio);
    processor = new AudioWorkletNode(context, 'song-pcm');
    source.connect(context.destination); source.connect(processor); processor.connect(context.destination);
    processor.port.onmessage = event => {
      if (disposed) return;
      if (!Array.isArray(event.data) || event.data.length !== 2400) { dispose(); failed('歌曲 PCM 帧无效'); return; }
      if (pending.length >= 5) { dispose(); failed('歌曲音频发送积压超过500毫秒，已停止以避免口型继续错位'); return; }
      pending.push(event.data); void pump();
    };
    processor.onprocessorerror = () => { dispose(); failed('歌曲音频采集失败'); };
    return { dispose, resume: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([context.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
          const error = new Error('请点击恢复播放以启用歌曲音频'); error.name = 'NotAllowedError'; reject(error);
        }, 1000); })]);
      } finally { clearTimeout(timer); }
    } };
  } catch (error) { dispose(); throw error; }
  finally { URL.revokeObjectURL(url); }
}
