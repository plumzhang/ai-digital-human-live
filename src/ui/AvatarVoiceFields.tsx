import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReferenceVoice } from '../avatarProfiles';
import { loadTtsConfig, type TtsPreview } from '../ttsConfig';
import { ReferenceVoiceFields } from './ReferenceVoiceFields';

export function AvatarVoiceFields({ voice, onChange, active, disabled, onRecognizingChange }: {
  voice: ReferenceVoice; onChange: (voice: ReferenceVoice) => void; active: boolean; disabled: boolean; onRecognizingChange?: (busy: boolean) => void;
}) {
  const [text, setText] = useState('你好，欢迎来到直播间。');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const pending = useRef(false);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    request.current++; pending.current = false;
    setBusy(false); setUrl(''); setFileName(''); setError('');
    player.current?.pause();
    return () => { request.current++; pending.current = false; };
  }, [voice.ref_audio, voice.ref_text, text, active]);

  async function preview() {
    if (!active || disabled || recognizing || pending.current || !voice.ref_audio.trim() || !voice.ref_text.trim() || !text.trim()) return;
    const id = ++request.current;
    pending.current = true; setBusy(true); setUrl(''); setFileName(''); setError('');
    try {
      const tts = loadTtsConfig(voice);
      await invoke('component_preflight', { tts });
      if (id !== request.current) return;
      const result = await invoke<TtsPreview>('component_tts_preview', { tts, text });
      if (id === request.current) { setUrl(result.audio_url); setFileName(result.file_name); }
    } catch (error) { if (id === request.current) setError(String(error)); }
    finally { if (id === request.current) { pending.current = false; setBusy(false); } }
  }

  async function openPreviewFolder() {
    const id = request.current;
    try { await invoke('component_tts_open_preview_folder', { fileName: fileName || null }); }
    catch (error) { if (id === request.current) setError(String(error)); }
  }

  return <>
    <ReferenceVoiceFields voice={voice} tts={loadTtsConfig(voice)} onChange={onChange} active={active} disabled={disabled || busy} onRecognizingChange={value => { setRecognizing(value); onRecognizingChange?.(value); }}/>
    <p className="hint full">音色与当前角色一起保存。选择清晰、单人、无背景音乐的短录音，可先试听再保存数字人。</p>
    <label className="full">试听文本<input maxLength={200} value={text} onChange={event => setText(event.target.value)}/></label>
    <div className="full"><div className="button-row"><button type="button" disabled={disabled || busy || recognizing || !voice.ref_audio.trim() || !voice.ref_text.trim() || !text.trim()} onClick={() => void preview()}>{busy ? '正在生成试听…' : '生成克隆试听'}</button><button type="button" disabled={disabled || busy} onClick={() => void openPreviewFolder()}>打开生成文件夹</button></div>
      {url && <div className="voice-preview-player"><span>当前角色音色试听</span><audio ref={player} controls src={url} aria-label="当前角色音色试听"/></div>}
      {fileName && <p className="hint">已保存：{fileName}</p>}
      {error && <p className="voice-notice error" role="alert">{error}</p>}
    </div>
  </>;
}
