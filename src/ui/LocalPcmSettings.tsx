import { useState } from 'react';
import { loadLocalPcmDelayMs, loadPcmSendDelayMs, MAX_LOCAL_PCM_DELAY_MS, saveLocalPcmDelayMs, savePcmSendDelayMs } from '../localPcmSettings';

export function LocalPcmSettings({ kind = 'play' }: { kind?: 'send' | 'play' } = {}) {
  const sending = kind === 'send';
  const [draft, setDraft] = useState(() => String(sending ? loadPcmSendDelayMs() : loadLocalPcmDelayMs()));
  const [notice, setNotice] = useState('');
  const save = () => {
    try {
      if (!draft.trim()) throw new Error(sending ? '请输入发送延迟毫秒数' : '请输入播放延迟毫秒数');
      const delay = Number(draft);
      if (sending) savePcmSendDelayMs(delay); else saveLocalPcmDelayMs(delay);
      setDraft(String(delay));
      setNotice(`已保存 ${delay} 毫秒，从下一条弹幕回复生效`);
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)); }
  };
  return <div className="queue-audio-sync-settings">
    <strong>{sending ? '弹幕PCM发送延迟' : '本地弹幕PCM播放延迟'}</strong>
    <div className="fields-row"><label>{sending ? '弹幕PCM发送延迟（毫秒）' : '本地弹幕PCM播放延迟（毫秒）'}<input type="number" min={0} max={MAX_LOCAL_PCM_DELAY_MS} step={1} value={draft} onChange={event => { setDraft(event.target.value); setNotice(''); }} onKeyDown={event => { if (event.key === 'Enter') save(); }}/></label><button onClick={save}>{sending ? '保存发送延迟' : '保存播放延迟'}</button></div>
    <p className="hint">{sending ? '默认0。从切换到当前槽位开始计时，到设定时间后向 Vidu 发送 PCM。' : '默认0。从切换到当前槽位开始计时，到设定时间后播放本地 PCM，与发送延迟独立计时。'}保存后从下一条回复生效。</p>
    {notice && <p className="hint" role="status">{notice}</p>}
  </div>;
}
