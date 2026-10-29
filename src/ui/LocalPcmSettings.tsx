import { useState } from 'react';
import { loadLocalPcmDelayMs, MAX_LOCAL_PCM_DELAY_MS, saveLocalPcmDelayMs } from '../localPcmSettings';

export function LocalPcmSettings() {
  const [draft, setDraft] = useState(() => String(loadLocalPcmDelayMs()));
  const [notice, setNotice] = useState('');
  const save = () => {
    try {
      if (!draft.trim()) throw new Error('请输入播放延迟毫秒数');
      const delay = Number(draft);
      saveLocalPcmDelayMs(delay);
      setDraft(String(delay));
      setNotice(`已保存 ${delay} 毫秒，从下一条弹幕回复生效`);
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)); }
  };
  return <div className="queue-handoff-controls">
    <strong>弹幕声音同步</strong>
    <div className="fields-row"><label>弹幕 PCM 播放延迟（毫秒）<input type="number" min={0} max={MAX_LOCAL_PCM_DELAY_MS} step={1} value={draft} onChange={event => { setDraft(event.target.value); setNotice(''); }} onKeyDown={event => { if (event.key === 'Enter') save(); }}/></label><button onClick={save}>保存播放延迟</button></div>
    <p className="hint">默认0。设置500时，弹幕与礼物回复的声音在 PCM 发送给 Vidu 后延迟500毫秒播放。保存后从下一条回复生效，当前回复沿用开始时的设置。</p>
    {notice && <p className="hint" role="status">{notice}</p>}
  </div>;
}
