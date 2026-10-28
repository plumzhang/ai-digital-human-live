import { Cpu, Video } from 'lucide-react';
import { TtsSettings } from './TtsSettings';
import { ModelSettings } from './ModelSettings';

export type ModelSettingsTab = 'reply' | 'vidu' | 'tts';

export function ModelConfiguration({ tab, onTabChange, apiKey, onApiKeyChange, storageError }: {
  tab: ModelSettingsTab; onTabChange: (tab: ModelSettingsTab) => void;
  apiKey: string; onApiKeyChange: (key: string) => void; storageError: boolean;
}) {
  return <div className="content narrow model-configuration">
    <div className="danmaku-tabs" role="tablist" aria-label="模型配置">
      <button type="button" id="reply-model-tab" role="tab" aria-selected={tab === 'reply'} aria-controls="reply-model-panel" onClick={() => onTabChange('reply')}><Cpu size={16}/> 大语言模型</button>
      <button type="button" id="vidu-model-tab" role="tab" aria-selected={tab === 'vidu'} aria-controls="vidu-model-panel" onClick={() => onTabChange('vidu')}><Video size={16}/> Vidu数字人</button>
      <button type="button" role="tab" aria-selected={tab === 'tts'} onClick={() => onTabChange('tts')}>OmniVoice 语音</button>
    </div>
    <div hidden={tab !== 'tts'}><TtsSettings active={tab === 'tts'}/></div>
    <div id="reply-model-panel" role="tabpanel" aria-labelledby="reply-model-tab" hidden={tab !== 'reply'}>
      <ModelSettings active={tab === 'reply'}/>
    </div>
    <section id="vidu-model-panel" className="card vidu-model-settings" role="tabpanel" aria-labelledby="vidu-model-tab" hidden={tab !== 'vidu'}>
      <div className="section-title"><h2>Vidu数字人</h2><Video size={19}/></div>
      <p className="vidu-key-description">所有数字人共用此 API Key，供组件版数字人画面生成使用。</p>
      <div className="api-key-field"><label>Vidu API Key<input type="password" autoComplete="off" value={apiKey} onChange={event => onApiKeyChange(event.target.value)} placeholder="vda_..."/></label>
        <div className="api-key-actions"><span>{storageError ? '本机保存失败' : apiKey.trim() ? '已保存在本机' : '尚未填写'}</span><button type="button" disabled={!apiKey} onClick={() => onApiKeyChange('')}>清除已保存的 Key</button></div>
      </div>
      {storageError && <div className="voice-notice error" role="alert">无法保存 Vidu API Key，请检查本机存储权限。</div>}
    </section>
  </div>;
}
