import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ReferenceVoice } from '../avatarProfiles';
import type { TtsConfig } from '../ttsConfig';
import { ReferenceAudioPicker } from './ReferenceAudioPicker';

export function ReferenceVoiceFields({ voice, tts, onChange, active, disabled, onRecognizingChange }: {
  voice: ReferenceVoice; tts: TtsConfig; onChange: (voice: ReferenceVoice) => void;
  active: boolean; disabled: boolean; onRecognizingChange?: (busy: boolean) => void;
}) {
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const latest = useRef({ voice, tts, onChange, active, onRecognizingChange });
  latest.current = { voice, tts, onChange, active, onRecognizingChange };
  const job = useRef<{ path: string; text: string; base: string; key: string } | null>(null);
  const busy = (value: boolean) => { setRecognizing(value); latest.current.onRecognizingChange?.(value); };
  const invalidate = () => { request.current++; job.current = null; busy(false); setNotice(''); };
  const update = (next: ReferenceVoice) => { latest.current.voice = next; latest.current.onChange(next); };
  useEffect(() => () => { request.current++; job.current = null; latest.current.onRecognizingChange?.(false); }, []);
  useEffect(() => {
    const pending = job.current;
    if (!active || (pending && (pending.path !== voice.ref_audio || pending.text !== voice.ref_text || pending.base !== tts.base_url || pending.key !== tts.key))) invalidate();
  }, [active, voice.ref_audio, voice.ref_text, tts.base_url, tts.key]);

  async function recognize(next: ReferenceVoice) {
    if (!active || disabled || !next.ref_audio.trim()) return;
    const id = ++request.current;
    const config = { ...latest.current.tts, ...next };
    job.current = { path: next.ref_audio, text: next.ref_text, base: config.base_url, key: config.key };
    busy(true); setError(''); setNotice('正在使用 FunASR 识别参考音频…');
    try {
      const result = await invoke<string>('component_transcribe_reference_audio', { tts: config });
      if (id !== request.current || !latest.current.active) return;
      const current = latest.current;
      if (current.voice.ref_audio !== next.ref_audio || current.voice.ref_text !== next.ref_text || current.tts.base_url !== config.base_url || current.tts.key !== config.key) { invalidate(); return; }
      if (!result.trim()) throw new Error('未识别到原话，请手动填写或重新识别');
      job.current = null;
      update({ ref_audio: next.ref_audio, ref_text: result });
      setNotice('FunASR 已填写原话，请核对后保存。');
    } catch (error) { if (id === request.current) { setNotice(''); setError(`${String(error)}。可手动填写，或启动语音服务后点击“FunASR 识别原话”。`); } }
    finally { if (id === request.current) { job.current = null; busy(false); } }
  }

  function select(path: string) {
    invalidate(); setError('');
    const next = { ref_audio: path, ref_text: path === latest.current.voice.ref_audio ? latest.current.voice.ref_text : '' };
    update(next);
    void recognize(next);
  }

  return <>
    <ReferenceAudioPicker value={voice.ref_audio} onChange={select} active={active} disabled={disabled}/>
    <label className="full">参考音频中的原话<textarea rows={3} value={voice.ref_text} onChange={event => { invalidate(); setError(''); update({ ...latest.current.voice, ref_text: event.target.value }); }} placeholder="选择音频后由 FunASR 自动识别，也可手动填写或修正"/></label>
    <div className="full"><button type="button" disabled={disabled || !active || recognizing || !voice.ref_audio.trim()} onClick={() => void recognize(latest.current.voice)}>{recognizing ? 'FunASR 识别中…' : 'FunASR 识别原话'}</button>
      {notice && <p className="hint" role="status">{notice}</p>}
      {error && <p className="voice-notice error" role="alert">{error}</p>}
    </div>
  </>;
}
