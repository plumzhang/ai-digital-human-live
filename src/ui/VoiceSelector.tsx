import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { builtinVoices } from '../voiceCatalog';

export type VoiceSource = 'builtin' | 'clone';
type Props = {
  source: VoiceSource; voice: string; provider: 'qwen_omni' | 'doubao'; region: 'cn' | 'global';
  clonedVoices: string[]; loading: boolean; error: string;
  onSource: (source: VoiceSource) => void;
  onSelect: (voice: string, provider: 'qwen_omni' | 'doubao', source: VoiceSource) => void;
  cloneProvider: (voice: string) => 'qwen_omni' | 'doubao';
  onClone: () => void; onRefresh: () => void;
};

export function VoiceSelector(props: Props) {
  const [query, setQuery] = useState('');
  const [linkError, setLinkError] = useState('');
  const openDocumentation = async (provider: 'ali') => {
    setLinkError('');
    try {
      if (isTauri()) await invoke('open_voice_document', { provider });
      else window.open(`https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=${provider}`, '_blank', 'noopener,noreferrer');
    } catch (error) { setLinkError(`打开官方音色列表失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const term = query.trim().toLocaleLowerCase();
  const builtin = builtinVoices.filter(voice => voice.provider === 'qwen_omni' && `${voice.name} ${voice.id} ${voice.description} ${voice.languages}`.toLocaleLowerCase().includes(term));
  const clones = props.clonedVoices.filter(voice => props.cloneProvider(voice) === 'qwen_omni' && voice.toLocaleLowerCase().includes(term));
  const selected = props.source === 'builtin' ? builtinVoices.find(voice => voice.id === props.voice && voice.provider === props.provider) : undefined;
  return <div className="full voice-selector">
    <div className="fields-row"><label className="grow">音色来源<select value={props.source} onChange={event => { setQuery(''); props.onSource(event.target.value as VoiceSource); }}><option value="builtin">音色列表</option><option value="clone">克隆音色</option></select></label>
      {props.source === 'builtin' && <span className="hint">千问 qwen_omni · 实时音色（{builtinVoices.length} 款）</span>}
    </div>
    <p className="hint">当前音色：{props.provider === 'qwen_omni' ? selected?.name || props.voice || '尚未选择' : '待重新选择千问音色'}{props.voice && props.provider === 'qwen_omni' && ' · 千问 qwen_omni'}</p>
    <input aria-label="搜索音色" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索音色名称、ID、语种或场景"/>
    {props.source === 'builtin' ? <>

      {selected?.domesticOnly && props.region !== 'cn' && <p role="alert" className="hint">当前选中的内置音色仅适用于中国区，请重新选择。</p>}
      <div className="voice-catalog" role="group" aria-label="内置音色列表">{builtin.map(voice => <button type="button" className={props.voice === voice.id && props.provider === voice.provider ? 'voice-catalog-option selected' : 'voice-catalog-option'} key={`${voice.provider}:${voice.id}`} disabled={voice.domesticOnly && props.region !== 'cn'} aria-pressed={props.voice === voice.id && props.provider === voice.provider} onClick={() => props.onSelect(voice.id, voice.provider, 'builtin')}>
        <strong>{voice.name}</strong><span>{voice.description}</span><small>{voice.id}</small><small title={voice.languages}>{voice.languages}</small>
      </button>)}</div>
      {!builtin.length && <p className="hint">未找到匹配的内置音色。</p>}

      <p className="hint"><a href="https://platform.vidu.cn/vidu-stream/doc/voice-list?provider=ali" target="_blank" rel="noreferrer" onClick={event => { event.preventDefault(); void openDocumentation('ali'); }}>千问官方音色列表</a></p>
      {linkError && <p className="hint" role="alert">{linkError}</p>}
    </> : <>
      <div className="button-row"><button type="button" disabled={props.loading} onClick={props.onRefresh}>{props.loading ? '刷新中…' : '刷新克隆音色'}</button><button type="button" onClick={props.onClone}>前往音色克隆</button></div>
      {props.error && <p className="hint" role="alert">{props.error}</p>}
      {!props.loading && !clones.length && !term && <p className="hint">暂无可选克隆音色</p>}
      <div className="voice-catalog" role="group" aria-label="克隆音色列表">{clones.map(voice => <button type="button" key={voice} className={props.voice === voice ? 'voice-catalog-option selected' : 'voice-catalog-option'} aria-pressed={props.voice === voice} onClick={() => props.onSelect(voice, props.cloneProvider(voice), 'clone')}><strong>{voice}</strong><span>已创建的克隆音色</span><small>千问 qwen_omni</small></button>)}</div>
      {!!term && !clones.length && <p className="hint">未找到匹配的克隆音色。</p>}
    </>}
  </div>;
}
