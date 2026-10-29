export type SongCue = { start_ms: number; end_ms: number; text: string; lead_ms: number };
export type SongPcmSegment = { index: number; start_ms: number; end_ms: number; sample_count: number; pcm_path: string };
export type SongDirector = {
  id: string; title: string; created_at: number; duration_ms: number;
  audio_name: string; audio_path: string; directory: string; available: boolean;
  lyrics: string; status: string; raw_segments: SongCue[]; cues: SongCue[]; error: string | null;
  pcm_ready?: boolean; pcm_segments?: SongPcmSegment[]; pcm_error?: string; pcm_lead_ms?: number;
};
export type SongPlaybackIdentity = { live_id: string; task_id: string; playback_token: string };
export type SongPcmPhase = SongPlaybackIdentity & { active: boolean };
export type SongPlaybackState = SongPlaybackIdentity & { state: 'started' | 'blocked' | 'ended' | 'error' | 'stopped'; error?: string };
export type SongSyncObservation = {
  index: number; text: string; status: 'audio_detected' | 'unconfirmed' | 'overlap' | 'skipped';
  position_ms: number; latency_ms?: number; offset_ms?: number;
};
export type SongSyncProgress = { position_ms: number; sent: number; total: number; next_text?: string; next_send_ms?: number; ended?: boolean };

// Long instrumentals are valid, but must be visible rather than look like a
// stuck sender. A gap is not proof that there is no singing in that interval.
export function songTimelineGaps(cues: SongCue[]): Array<{ start_ms: number; end_ms: number }> {
  const gaps: Array<{ start_ms: number; end_ms: number }> = [];
  let end = cues[0]?.end_ms ?? 0;
  for (const cue of cues.slice(1)) {
    if (cue.start_ms - end >= 10000) gaps.push({ start_ms: end, end_ms: cue.start_ms });
    end = Math.max(end, cue.end_ms);
  }
  return gaps;
}

export function songCueSendAt(cue: SongCue): number { return Math.max(0, cue.start_ms - cue.lead_ms); }

export function songPcmSchedule<T extends { start_ms:number; end_ms:number }>(segments:T[],leadMs:number):Array<T&{send_at_ms:number;send_end_ms:number}>{
  if(!Number.isInteger(leadMs)||leadMs<0||leadMs>5000)throw new Error('PCM提前量需为0–5000毫秒的整数');
  const scheduled:Array<T&{send_at_ms:number;send_end_ms:number}>=[];
  for(let i=0;i<segments.length;i++){
    const part=segments[i];
    if(!Number.isInteger(part.start_ms)||!Number.isInteger(part.end_ms)||part.start_ms<0||part.end_ms<=part.start_ms||(i>0&&part.start_ms<segments[i-1].start_ms))throw new Error('歌词PCM时间轴无效');
  }
  let previousEnd=0;
  for(let first=0;first<segments.length;){
    let last=first+1,sourceEnd=segments[first].end_ms;
    while(last<segments.length&&segments[last].start_ms<=sourceEnd){sourceEnd=Math.max(sourceEnd,segments[last].end_ms);last++;}
    // Negative lead-in times clamp to zero. Preserve complete early phrases
    // in order when several would otherwise collide before playback starts.
    const sendStart=Math.max(0,segments[first].start_ms-leadMs,previousEnd);
    for(let i=first;i<last;i++)scheduled.push({...segments[i],send_at_ms:sendStart+segments[i].start_ms-segments[first].start_ms,send_end_ms:sendStart+segments[i].end_ms-segments[first].start_ms});
    previousEnd=sendStart+sourceEnd-segments[first].start_ms;first=last;
  }
  return scheduled;
}

export async function readDirectorAudio(file: File): Promise<{ name: string; data: string; duration_ms: number }> {
  const mime = ({ mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', m4a: 'audio/mp4' } as Record<string,string>)[file.name.split('.').at(-1)?.toLowerCase() || ''];
  if (!mime || file.size <= 0 || file.size >= 100 * 1024 * 1024) throw new Error('请上传小于100 MB的 MP3、WAV、AAC 或 M4A 歌曲');
  const url = URL.createObjectURL(file);
  let duration: number;
  try {
    duration = await new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      const finish = (error?: Error) => { clearTimeout(timer); const value = audio.duration; audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => finish(new Error('读取歌曲时长超时')), 15000);
      audio.onloadedmetadata = () => finish(); audio.onerror = () => finish(new Error('无法解码此歌曲，请检查文件'));
      audio.preload = 'metadata'; audio.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
  if (!Number.isFinite(duration) || duration < 1 || duration > 1800) throw new Error('歌曲时长需为1秒～30分钟');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(`data:${mime};base64,${String(reader.result).split(',')[1]}`);
    reader.onerror = () => reject(new Error('读取歌曲失败')); reader.onabort = () => reject(new Error('歌曲读取已取消')); reader.readAsDataURL(file);
  });
  return { name: file.name, data, duration_ms: Math.round(duration * 1000) };
}

// Drive instructions from the audio clock, so buffering never advances lyrics.
// Each cue is submitted at most once and uses a distinct Vidu msg_id.
export class SongDirectorPlayer {
  private closed = false;
  private sent = new Set<number>();
  private pending = false;
  private pendingAt = 0;
  private dispatched = 0;
  private progressAt = 0;
  private audioActivity = { healthy: false, speaking: false, quiet_ms: 0 };
  private observation?: { index: number; submittedAt: number; measurable: boolean };
  private timer?: ReturnType<typeof setInterval>;
  private lastProgress = 0;
  private lastTime = -1;
  private cleanupPromise?: Promise<void>;
  private blocked = false;
  constructor(private audio: HTMLAudioElement, private cues: SongCue[], private adapter: {
    mute: (muted: boolean) => void;
    speak: (text: string, index: number) => Promise<void>;
    interrupt: () => Promise<void>;
    prepare?: () => Promise<void>;
    activateAudio?: () => Promise<void>;
    cleanup?: () => void;
    drain?: () => Promise<void>;
    caption: (text: string) => void;
    state: (state: SongPlaybackState['state'], error?: string) => void;
    observe?: (observation: SongSyncObservation) => void;
    progress?: (progress: SongSyncProgress) => void;
  }) {}
  async start() {
    this.adapter.mute(true);
    this.audio.onended = () => { void (async () => { try { await this.adapter.drain?.(); if (!this.closed) await this.stop('ended'); } catch (error) { await this.stop('error', String(error)); } })(); };
    this.audio.onerror = () => { void this.stop('error', '原歌曲播放失败，请检查本地音频'); };
    this.lastProgress = Date.now();
    try {
      await this.adapter.prepare?.();
      if (this.closed) return;
      await this.play();
    } catch (error) { await this.stop('error', `原歌曲无法播放：${String(error)}`); }
  }
  private async play() {
    const position = this.audio.currentTime;
    try {
      await Promise.all([this.audio.play(), this.adapter.activateAudio?.()]);
    } catch (error) {
      if (this.closed) return;
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') {
        this.audio.pause(); this.audio.currentTime = position;
        this.blocked = true;
        this.adapter.state('blocked', '请在 OBS 窗口点击“恢复播放”以播放原歌曲');
        return;
      }
      throw error;
    }
    if (this.closed) { this.audio.pause(); return; }
    this.blocked = false; this.lastProgress = Date.now();
    this.adapter.state('started');
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.tick(); }, 25);
    await this.tick();
  }
  async resume() {
    if (this.closed || !this.blocked) return;
    // Call play directly during the click gesture, before awaiting other work.
    try { await this.play(); }
    catch (error) { await this.stop('error', `原歌曲无法播放：${String(error)}`); }
  }
  async tick() {
    if (this.closed) return;
    const time = this.audio.currentTime * 1000;
    if (time !== this.lastTime) { this.lastTime = time; this.lastProgress = Date.now(); }
    if (Date.now() - this.lastProgress > 15000) { await this.stop('error', '原歌曲播放停滞超过15秒，已停止导播'); return; }
    const current = this.cues.find(cue => cue.start_ms <= time && time < cue.end_ms);
    this.adapter.caption(current?.text || '');
    if (Date.now() - this.progressAt >= 1000) { this.progressAt = Date.now(); this.reportProgress(); }
    if (this.observation && Date.now() - this.observation.submittedAt >= 5000) this.finishObservation('unconfirmed');
    if (this.pending && Date.now() - this.pendingAt > 5000) {
      await this.stop('error', '歌词发送超过5秒未返回，已停止原歌曲以避免继续错位；请检查控制连接'); return;
    }
    if (this.pending || this.audio.paused) return;
    this.pending = true; this.pendingAt = Date.now();
    try {
      for (let i = 0; i < this.cues.length; i++) {
        const cue = this.cues[i];
        if (this.closed) break;
        // An IPC write can take time: never reuse the clock from before await.
        const position = this.audio.currentTime * 1000;
        if (this.audio.paused) break;
        if (this.sent.has(i) || position < songCueSendAt(cue)) continue;
        this.sent.add(i);
        // Avoid a burst of expired lyrics after a suspended window resumes.
        if (position >= cue.end_ms) {
          this.adapter.observe?.({ index: i, text: cue.text, status: 'skipped', position_ms: position }); continue;
        }
        if (this.observation) this.finishObservation('unconfirmed');
        const activity = this.audioActivity;
        this.observation = { index: i, submittedAt: Date.now(), measurable: activity.healthy && !activity.speaking && activity.quiet_ms >= 350 };
        await this.adapter.speak(cue.text, i);
        if (this.closed) break;
        this.dispatched++; this.reportProgress();
      }
    } catch (error) { await this.stop('error', `歌词指令发送失败：${String(error)}`); }
    finally { this.pending = false; }
  }
  private reportProgress(ended = false) {
    const next = this.cues.find((_, i) => !this.sent.has(i));
    this.adapter.progress?.({ position_ms: Math.round(this.audio.currentTime * 1000), sent: this.dispatched, total: this.cues.length,
      next_text: next?.text, next_send_ms: next ? songCueSendAt(next) : undefined, ended });
  }
  // This is downlink speech evidence, never a per-msg_id generation ack or a
  // visual lip-sync measurement. Only measure a fresh onset after silence.
  observeAudio(activity: { healthy: boolean; speaking: boolean; quiet_ms?: number }) {
    if (this.closed) return;
    const previous = this.audioActivity;
    this.audioActivity = { ...activity, quiet_ms: activity.quiet_ms ?? 0 };
    if (!activity.healthy) { if (this.observation) this.observation.measurable = false; return; }
    if (activity.speaking && !previous.speaking && this.observation?.measurable) this.finishObservation('audio_detected');
  }
  private finishObservation(status: SongSyncObservation['status']) {
    const pending = this.observation;
    if (!pending) return;
    this.observation = undefined;
    const cue = this.cues[pending.index];
    const position = Math.round(this.audio.currentTime * 1000);
    this.adapter.observe?.({ index: pending.index, text: cue.text,
      status: status === 'unconfirmed' && !pending.measurable ? 'overlap' : status, position_ms: position,
      ...(status === 'audio_detected' ? { latency_ms: Date.now() - pending.submittedAt, offset_ms: position - cue.start_ms } : {}) });
  }
  stop(state: 'ended' | 'error' | 'stopped' = 'stopped', error?: string): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true; clearInterval(this.timer);
    this.finishObservation('unconfirmed'); this.reportProgress(true);
    this.audio.pause(); this.audio.onended = null; this.audio.onerror = null;
    this.adapter.cleanup?.();
    this.audio.removeAttribute('src'); this.audio.load();
    this.adapter.caption('');
    this.cleanupPromise = (async () => {
      try { await this.adapter.interrupt(); }
      catch (cause) { error = `${error ? error + '；' : ''}清理歌词语音失败：${String(cause)}`; state = 'error'; }
      finally {
        // If interrupt failed, retain muting until session cleanup or a retry.
        if (state !== 'error' || !error?.includes('清理歌词语音失败')) this.adapter.mute(false);
        this.adapter.state(state, error);
      }
    })();
    return this.cleanupPromise;
  }
}
