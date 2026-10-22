import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SongSyncProgress, SongPlaybackIdentity } from '../songDirector';

export type TtsLogEntry = {
  id: string; at_ms: number; live_id: string; command: string; content: string;
  msg_id: string | null; seq_id: number | null; status: 'sent' | 'failed' | 'audio_detected' | 'unconfirmed' | 'overlap' | 'skipped'; error: string | null; detail?: string;
};
const labels: Record<string, string> = { text_tts: '台词 / 歌词', text_action: '动作指令', text_msg: '台词 / 歌词 / 对话', text_dialog: '文本对话', interrupt: '打断', song_sync: '歌曲同步检测' };
const statuses = { sent: '已写入连接', failed: '发送失败', audio_detected: '检测到下行发声', unconfirmed: '尚未确认生成', overlap: '无法独立测量', skipped: '已过期跳过' };
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${(ms / 1000 % 60).toFixed(2).padStart(5, '0')}`;

// Merge a disk snapshot with live events that may have arrived while loading.
export function mergeTtsLog(current: TtsLogEntry[], incoming: TtsLogEntry[]): TtsLogEntry[] {
  const entries = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) entries.set(entry.id, entry);
  return [...entries.values()].sort((a, b) => b.at_ms - a.at_ms || (b.seq_id ?? 0) - (a.seq_id ?? 0)).slice(0, 300);
}

export function TtsLog() {
  const [entries, setEntries] = useState<TtsLogEntry[]>([]);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<(SongSyncProgress & SongPlaybackIdentity) | null>(null);
  useEffect(() => {
    let active = true;
    const detach: Array<() => void> = [];
    void (async () => {
      const events = await listen<TtsLogEntry>('tts-log-entry', event => {
        if (active) setEntries(current => mergeTtsLog(current, [event.payload]));
      });
      if (!active) { events(); return; } detach.push(events);
      const errors = await listen<string>('tts-log-error', event => { if (active) setError(event.payload); });
      if (!active) { errors(); return; } detach.push(errors);
      const sync = await listen<SongSyncProgress & SongPlaybackIdentity>('song-sync-progress', event => {
        if (active) setProgress(event.payload.ended ? null : event.payload);
      });
      if (!active) { sync(); return; } detach.push(sync);
      const saved = await invoke<{ entries: TtsLogEntry[]; path: string }>('tts_log_load');
      if (active) { setEntries(current => mergeTtsLog(current, saved.entries)); setPath(saved.path); }
    })().catch(reason => { if (active) setError(`读取 TTS 日志失败：${String(reason)}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; detach.forEach(fn => fn()); };
  }, []);
  return <section className="tts-log-panel" aria-label="TTS 日志">
    <div className="section-title"><h2>TTS 日志</h2><span className="count">最近 {entries.length} 条</span></div>
    <p className="hint">已写入连接不代表 Vidu 已生成。下行发声仅用于估计响应延迟，不等于已验证视频口型；可据此调整歌词提前量。</p>
    {progress && <p className="hint" role="status">原歌曲 {clock(progress.position_ms)} · 已发送 {progress.sent}/{progress.total} 段 · {progress.next_send_ms != null
      ? `下一句 ${clock(progress.next_send_ms)} 发送（${Math.max(0, (progress.next_send_ms - progress.position_ms) / 1000).toFixed(1)} 秒后）：${progress.next_text}` : '全部歌词已处理，等待原歌曲结束'}</p>}
    {error && <p className="tts-log-error" role="alert">{error}</p>}
    <div className="tts-log-list">
      {entries.length ? entries.map(entry => <article className={`tts-log-entry ${entry.status}`} key={entry.id}>
        <div className="tts-log-meta"><time dateTime={new Date(entry.at_ms).toISOString()}>{new Date(entry.at_ms).toLocaleString('zh-CN', { hour12: false })}.{String(entry.at_ms % 1000).padStart(3,'0')}</time><span>{labels[entry.command] || entry.command}</span><strong>{statuses[entry.status]}</strong></div>
        <p className="tts-log-content">{entry.content}</p>
        {entry.error && <p className="tts-log-error">{entry.error}</p>}
        {entry.detail && <p className="hint">{entry.detail}</p>}
        <small className="tts-log-identity">会话 {entry.live_id}{entry.msg_id && ` · ${entry.msg_id}`}{entry.seq_id != null && ` · 序号 ${entry.seq_id}`}</small>
      </article>) : <div className="empty">{loading ? '正在读取 TTS 日志…' : '发送台词、歌词或动作后，这里会记录完整指令。'}</div>}
    </div>
    {path && <p className="hint tts-log-path" title={path}>保存位置：{path}</p>}
  </section>;
}
