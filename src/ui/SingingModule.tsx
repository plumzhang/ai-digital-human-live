import { loadTtsConfig } from '../ttsConfig';
import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { FolderOpen, Music2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { loadModelConfig } from '../modelConfig';
import { readDirectorAudio, songCueSendAt, songTimelineGaps, type SongCue, type SongDirector } from '../songDirector';

type Props = { active: boolean; onConfigureModel: () => void; onEnqueue: (song: SongDirector) => Promise<void>; queuedSongIds: string[]; queueAvailable: boolean };
type Library = { songs: SongDirector[]; directory: string };
const statusText = (status: string) => ({ ready: '导播已就绪', draft: '等待歌词校正', transcribing: '语音识别中 / 可重试', failed: '识别失败' }[status] || status);
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${(ms / 1000 % 60).toFixed(3).padStart(6, '0')}`;
const IGNORED_GAP_WARNINGS_KEY = 'song-director-ignored-gap-warnings';
function loadIgnoredGapWarnings(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(IGNORED_GAP_WARNINGS_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

export function SingingModule({ active, onConfigureModel, onEnqueue, queuedSongIds, queueAvailable }: Props) {
  const [tab, setTab] = useState<'library' | 'generate'>('library');
  const [library, setLibrary] = useState<Library>({ songs: [], directory: '' });
  const [title, setTitle] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [audio, setAudio] = useState<Awaited<ReturnType<typeof readDirectorAudio>> | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [cues, setCues] = useState<SongCue[]>([]);
  const [leadDraft, setLeadDraft] = useState('500');
  const [pcmLeadDraft, setPcmLeadDraft] = useState('0');
  const [ignoredGapWarnings, setIgnoredGapWarnings] = useState<string[]>(loadIgnoredGapWarnings);
  const lock = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const desktop = isTauri();
  const refresh = useCallback(async () => { if (desktop) setLibrary(await invoke<Library>('director_list')); }, [desktop]);
  useEffect(() => { if (active) void refresh().catch(e => setError(String(e))); }, [active, refresh]);
  useEffect(() => { container.current?.querySelectorAll('audio').forEach(el => el.pause()); }, [active, tab]);
  async function work(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { try { await refresh(); } catch (e) { setError(String(e)); } lock.current = false; setBusy(''); }
  }
  async function correct(song: SongDirector) {
    const config = loadModelConfig();
    if (!config.apiKey.trim() || !config.baseUrl.trim() || !config.selectedModel.trim()) throw new Error('请先在“模型配置 → 大语言模型”保存 API 地址、Key 和模型。原始字幕已保留，可稍后校正。');
    const result = await invoke<SongDirector>('director_correct', { id: song.id, baseUrl: config.baseUrl, key: config.apiKey, model: config.selectedModel });
    if (editing === result.id) loadEditorCues(result.cues);
    setNotice(`“${result.title}”导播已生成，可点击“编辑”检查歌词与提前量后加入队列。`);
  }
  function loadEditorCues(next: SongCue[]) {
    setCues(structuredClone(next));
    setLeadDraft(next.length && next.every(cue => cue.lead_ms === next[0].lead_ms) ? String(next[0].lead_ms) : next.length ? '' : '500');
  }
  function edit(song: SongDirector) { setEditing(song.id); setPcmLeadDraft(String(song.pcm_lead_ms ?? 0)); loadEditorCues(song.cues.length ? song.cues : song.raw_segments); }
  function ignoreGapWarning(songId: string) {
    const next = [...new Set([...loadIgnoredGapWarnings(), ...ignoredGapWarnings, songId])];
    try {
      localStorage.setItem(IGNORED_GAP_WARNINGS_KEY, JSON.stringify(next));
      setIgnoredGapWarnings(next);
    } catch { setError('无法保存忽略提醒设置，请检查本地存储后重试。'); }
  }
  return <div ref={container} className="content singing-module" style={{ display: active ? undefined : 'none' }}>
    <div className="danmaku-tabs" role="tablist" aria-label="唱歌模块">
      <button type="button" id="songs-library-tab" role="tab" aria-selected={tab === 'library'} aria-controls="songs-library" onClick={() => setTab('library')}><Music2 size={16}/> 已有歌曲导播 <span className="count">{library.songs.filter(s => s.status === 'ready' && s.available).length}</span></button>
      <button type="button" id="songs-generate-tab" role="tab" aria-selected={tab === 'generate'} aria-controls="songs-generate" onClick={() => setTab('generate')}><Music2 size={16}/> 生成歌曲导播</button>
    </div>
    {!desktop && <div className="voice-notice error">请在桌面应用中生成和播放歌曲导播。</div>}
    {error && <div className="voice-notice error" role="alert">{error}</div>}
    {notice && <div className="voice-notice success" role="status">{notice}</div>}
    {busy && <div className="voice-notice" role="status">{busy}</div>}
    <section id="songs-library" role="tabpanel" aria-labelledby="songs-library-tab" hidden={tab !== 'library'}>
      <div className="song-library-heading"><div><h2>已有歌曲导播</h2><p className="hint">先按每段歌词的起止时间截取原唱PCM，播放时发送已截取的片段，歌词空档发送静音；本地播放完整原歌曲。点击歌曲“编辑”可设置PCM提前量，默认0毫秒。加入时替换槽位3的原待播任务，保留槽位1、2；不足三条时排在队尾。歌曲结束后自动释放队列槽位。</p></div><div className="button-row">
        <button disabled={!!busy || !desktop} onClick={() => void work('读取歌曲导播…', refresh)}><RefreshCw size={15}/> 刷新</button>
        <button disabled={!desktop} onClick={() => void invoke('director_open_folder', { id: null }).catch(e => setError(String(e)))}><FolderOpen size={15}/> 打开保存目录</button>
      </div></div>
      {library.directory && <p className="song-storage-path">保存目录：{library.directory}</p>}
      {!library.songs.length && <div className="card song-empty"><Music2 size={42}/><h3>还没有歌曲导播</h3><p className="hint">上传歌曲和完整歌词，先识别字幕，再由大语言模型校正。</p><button className="primary" onClick={() => setTab('generate')}>生成歌曲导播</button></div>}
      <div className="song-library-grid">{library.songs.map(song => {
        const queued = queuedSongIds.includes(song.id);
        const gaps = songTimelineGaps(editing === song.id ? cues : song.cues);
        return <article key={song.id} className={`card song-card${editing === song.id ? ' song-card-editing' : ''}`}>
          <div className="song-card-heading"><h3>{song.title}</h3><span className="tag">{song.status === 'ready' && !song.pcm_ready ? '歌词已就绪，待截取PCM' : statusText(song.status)}</span></div>
          <p className="hint">{clock(song.duration_ms)} · {song.cues.length} 段歌词 · {song.pcm_ready ? `${song.pcm_segments?.length ?? 0}段PCM已截取 · PCM提前${song.pcm_lead_ms ?? 0}毫秒` : 'PCM待截取'}{queued && ' · 已在队列中'}</p>
          {!!gaps.length && !ignoredGapWarnings.includes(song.id) && <p className="song-error song-gap-warning">时间轴有 {gaps.length} 处超过10秒的空档：{gaps.slice(0,3).map(gap => `${clock(gap.start_ms)}～${clock(gap.end_ms)}`).join('、')}。请试听确认是间奏还是漏词；漏词需重新识别，仅校正文字无法补齐时间。<button type="button" aria-label={`忽略《${song.title}》的时间轴空档提醒`} onClick={() => ignoreGapWarning(song.id)}>忽略提醒</button></p>}
          <div className="button-row">
            <button className="primary" disabled={!!busy || !queueAvailable || song.status !== 'ready' || !song.available || !song.pcm_ready} onClick={() => void work('加入互动任务队列…', async () => { await onEnqueue(song); setNotice(`“${song.title}”已加入待播队列；队列满时已替换槽位3，数字人与 OBS 就绪后按顺序自动播放。`); })}>加入播放歌曲槽位</button>
            <button disabled={!!busy || queued || !song.available || !song.cues.length} onClick={() => void work('正在按歌词起止时间截取PCM…', async () => { await invoke('director_prepare_pcm', { id: song.id }); setNotice(`“${song.title}”歌词PCM已截取完成。`); })}>截取歌词PCM</button>
            <button disabled={!!busy} aria-expanded={editing === song.id} aria-controls={`song-details-${song.id}`} onClick={() => editing === song.id ? setEditing(null) : edit(song)}>{editing === song.id ? '收起详情' : '编辑'}</button>
            <button className="danger" disabled={!!busy || queued} onClick={() => { if (window.confirm(`删除“${song.title}”的导播、原歌曲和字幕文件？`)) void work('删除歌曲导播…', async () => { await invoke('director_delete', { id: song.id }); if (editing === song.id) setEditing(null); }); }}><Trash2 size={14}/> 删除</button>
          </div>
          {editing === song.id && <div id={`song-details-${song.id}`} className="song-timeline-editor">
            {song.available ? <audio controls preload="none" src={convertFileSrc(song.audio_path)} aria-label={`${song.title}原歌曲试听`}/> : <p className="song-error">原歌曲文件缺失，请重新上传。</p>}
            {song.error && <p className="song-error">{song.error}</p>}
            {!song.pcm_ready && song.pcm_error && <p className="hint">{song.pcm_error}</p>}
            {queued && <p className="hint">已在队列中，请先完成或跳过，再编辑或删除。</p>}
            <div className="button-row">
              {!!song.raw_segments.length && <button disabled={!!busy || queued} onClick={() => void work('大语言模型正在校正歌词…', () => correct(song))}>校正歌词</button>}
              <button disabled={!!busy || queued || !song.available} onClick={() => void work('正在重新识别整首歌曲…', async () => { const result = await invoke<SongDirector>('director_transcribe', { id: song.id, tts: loadTtsConfig() }); loadEditorCues(result.raw_segments); await correct(result); })}>重新识别并校正</button>
              <button onClick={() => void invoke('director_open_folder', { id: song.id }).catch(e => setError(String(e)))}><FolderOpen size={14}/> 字幕与文件</button>
              <label className="song-bulk-lead">PCM提前量（毫秒）<input type="number" min={0} max={5000} step={50} value={pcmLeadDraft} disabled={!!busy || queued} onChange={event => setPcmLeadDraft(event.target.value)} onBlur={() => { const value = Number(pcmLeadDraft); if (!pcmLeadDraft.trim() || !Number.isInteger(value) || value < 0 || value > 5000) { setPcmLeadDraft(String(song.pcm_lead_ms ?? 0)); setError('PCM提前量需为0–5000毫秒的整数'); } }}/></label>
              <label className="song-bulk-lead">歌词文字提前量（毫秒）<input type="number" min={0} max={5000} step={50} value={leadDraft} placeholder="各段不同" disabled={!!busy || queued || !cues.length} title="修改后覆盖全部歌词段，保存时间轴后生效" onChange={event => {
                const value = event.target.value; setLeadDraft(value);
                const lead = value.trim() ? Number(value) : NaN;
                if (Number.isInteger(lead) && lead >= 0 && lead <= 5000) {
                  setCues(old => old.map(cue => ({ ...cue, lead_ms: lead }))); setError('');
                }
              }} onBlur={() => {
                const lead = leadDraft.trim() ? Number(leadDraft) : NaN;
                if (!Number.isInteger(lead) || lead < 0 || lead > 5000) {
                  setLeadDraft(cues.length && cues.every(cue => cue.lead_ms === cues[0].lead_ms) ? String(cues[0].lead_ms) : '');
                  if (leadDraft.trim()) setError('提前量需为0～5000毫秒的整数');
                }
              }}/></label>
            </div>
            {!!cues.length && <>
            <p className="hint">修改上方歌词文字提前量会覆盖全部歌词段，也可逐段调整或删除。删除后点击“保存时间轴”重新截取PCM，至少保留一段歌词。</p>
            <p className="hint">PCM按每段原始起止时间截取；提前量0按原时间发送。设置500毫秒时，PCM相对本地听到的原歌曲提前500毫秒，开头和结尾音频均完整保留。保存后生效，歌词文字提前量独立设置。</p>
            <p className="hint">识别原文：raw.srt；校正字幕：corrected.srt；歌词发送时间轴：timeline.json。“时间”列以秒显示歌词开始位置，精确到0.1秒；开始、结束和提前量输入单位为毫秒。</p>
            <div className="song-timeline-scroll"><table className="song-timeline"><thead><tr><th>时间</th><th>开始</th><th>结束</th><th>歌词</th><th>提前量</th><th>发送时刻</th><th>操作</th></tr></thead><tbody>{cues.map((cue, index) => <tr key={index}>
              <td className="song-timeline-time">{(cue.start_ms / 1000).toFixed(1)}s</td>
              {(['start_ms', 'end_ms'] as const).map(key => <td key={key}><input aria-label={`第${index+1}段${key === 'start_ms' ? '开始' : '结束'}时间`} type="number" min={0} max={song.duration_ms} step={1} disabled={!!busy || queued} value={cue[key]} onChange={e => setCues(old => old.map((c,i) => i === index ? { ...c, [key]:Number(e.target.value) } : c))}/></td>)}
              <td><textarea rows={2} aria-label={`第${index+1}段歌词`} value={cue.text} maxLength={300} disabled={!!busy || queued} onChange={e => setCues(old => old.map((c,i) => i === index ? { ...c, text:e.target.value } : c))}/></td>
              <td><input type="number" aria-label={`第${index+1}段提前量`} min={0} max={5000} step={50} value={cue.lead_ms} disabled={!!busy || queued} onChange={e => setCues(old => old.map((c,i) => i === index ? { ...c, lead_ms:Number(e.target.value) } : c))}/></td><td>{clock(songCueSendAt(cue))}</td>
              <td><button type="button" className="danger song-cue-delete" aria-label={`删除第${index+1}段歌词`} disabled={!!busy || queued || cues.length <= 1} title={cues.length <= 1 ? '至少保留一段歌词' : '删除此行，保存时间轴后生效'} onClick={() => setCues(old => old.filter((_, i) => i !== index))}><Trash2 size={14}/>删除</button></td>
            </tr>)}</tbody></table></div>
            <div className="button-row"><button className="primary" disabled={!!busy || queued} onClick={() => void work('保存时间轴并截取歌词PCM…', async () => { const lead = Number(pcmLeadDraft); if (!pcmLeadDraft.trim() || !Number.isInteger(lead) || lead < 0 || lead > 5000) throw new Error('PCM提前量需为0–5000毫秒的整数'); await invoke('director_save', { id: song.id, cues, pcmLeadMs: lead }); setNotice('时间轴与PCM提前量已保存，歌词PCM已截取完成。'); })}>保存时间轴</button></div>
            </>}
          </div>}
        </article>;
      })}</div>
    </section>
    <section id="songs-generate" role="tabpanel" aria-labelledby="songs-generate-tab" hidden={tab !== 'generate'}>
      <form className="card song-form" onSubmit={e => { e.preventDefault(); void work('FunASR 正在转录整首歌曲，请等待…', async () => {
        if (!audio || !lyrics.trim() || !title.trim()) throw new Error('请填写歌名、上传歌曲并输入完整歌词');
        const song = await invoke<SongDirector>('director_create', { tts: loadTtsConfig(), request: { title:title.trim(), audio_name:audio.name, audio_data:audio.data, duration_ms:audio.duration_ms, lyrics:lyrics.trim() } });
        setTab('library'); setBusy('大语言模型正在校正歌词…'); await correct(song);
      }); }}>
        <div className="section-title"><h2>生成歌曲导播</h2><Music2 size={22}/></div>
        <label>歌曲名称<input value={title} required maxLength={100} disabled={!!busy} onChange={e => setTitle(e.target.value)}/></label>
        <label className="song-upload-picker"><Upload size={24}/><span>{audio ? `${audio.name} · ${clock(audio.duration_ms)}` : '上传原歌曲（包含人声和伴奏）'}</span><input type="file" accept=".mp3,.wav,.aac,.m4a" disabled={!!busy || !desktop} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void work('读取歌曲…', async () => { setAudio(null); const result = await readDirectorAudio(file); setAudio(result); if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0,100)); }); }}/></label>
        <p className="hint">MP3、WAV、AAC、M4A · 小于100 MB · 最长30分钟</p>
        <label>完整歌词（必填）<textarea rows={12} value={lyrics} required disabled={!!busy} maxLength={30000} placeholder="粘贴与歌曲版本一致的完整歌词，保留重复演唱部分" onChange={e => setLyrics(e.target.value)}/></label>
        <p className="hint">先生成FunASR原始SRT，再校正歌词，按每段起止时间预截取24kHz单声道PCM。播放时发送已截取的歌词片段，歌词间空档发送静音，只听原歌曲。PCM提前量默认0，可在歌曲编辑区设置。</p>
        <div className="button-row"><button className="primary" type="submit" disabled={!!busy || !desktop || !audio || !title.trim() || !lyrics.trim()}>生成字幕并校正歌词</button><button type="button" onClick={onConfigureModel}>配置大语言模型</button></div>
      </form>
    </section>
  </div>;
}
