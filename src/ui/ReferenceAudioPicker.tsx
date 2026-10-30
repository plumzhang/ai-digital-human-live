import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function ReferenceAudioPicker({ value, onChange, disabled = false, active = true }: {
  value: string; onChange: (path: string) => void; disabled?: boolean; active?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const pending = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    request.current++; pending.current = false; setChoosing(false);
    return () => { request.current++; pending.current = false; };
  }, [active]);

  async function choose() {
    if (!active || disabled || pending.current) return;
    const id = ++request.current;
    pending.current = true; setChoosing(true); setError('');
    try {
      const path = await invoke<string | null>('component_pick_reference_audio');
      if (id === request.current && path) change.current(path);
    } catch (error) { if (id === request.current) setError(String(error)); }
    finally { if (id === request.current) { pending.current = false; setChoosing(false); } }
  }

  return <div className="full reference-audio-picker">
    <label>参考音频<input readOnly value={value} title={value || undefined} placeholder="请选择参考音频文件" aria-label="参考音频文件路径"/></label>
    <button type="button" disabled={disabled || choosing || !active} onClick={() => void choose()}>{choosing ? '选择中…' : '选择文件'}</button>
    {error && <p className="voice-notice error" role="alert">{error}</p>}
  </div>;
}
