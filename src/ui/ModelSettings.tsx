import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Cpu, RefreshCw, Save } from 'lucide-react';
import { loadModelConfig, modelStorageKey, type ModelConfig } from '../modelConfig';

type ModelInfo = { id: string; owned_by?: string | null };

export function ModelSettings() {
  const [savedConfig, setSavedConfig] = useState<ModelConfig>(loadModelConfig);
  const [config, setConfig] = useState<ModelConfig>(savedConfig);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [queried, setQueried] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [saveNotice, setSaveNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    setModels([]); setError(''); setQueried(false);
    if (!config.apiKey.trim() || !config.baseUrl.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void invoke<ModelInfo[]>('list_models', { baseUrl: config.baseUrl, key: config.apiKey })
        .then(result => {
          if (cancelled) return;
          setModels(result); setQueried(true);
        })
        .catch(reason => {
          if (cancelled) return;
          const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '模型查询失败，请重试';
          setError(message.split(config.apiKey.trim()).join('***'));
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [config.baseUrl, config.apiKey, refresh]);

  const changeConnection = (patch: Partial<ModelConfig>) => {
    setConfig(old => ({ ...old, ...patch, selectedModel: '' }));
    setSearch('');
    setSaveNotice('');
  };
  const persistConfig = (next: ModelConfig, message: string) => {
    try {
      localStorage.setItem(modelStorageKey, JSON.stringify(next));
      setSavedConfig(next); setConfig(next); setStorageError(false); setSaveNotice(message);
    } catch { setStorageError(true); setSaveNotice(''); }
  };
  const saveConfig = () => persistConfig({ ...config, baseUrl: config.baseUrl.trim(), apiKey: config.apiKey.trim(), persona: config.persona.trim() }, '模型配置已保存，下次进入会恢复此模型。');
  const clearSavedKey = () => persistConfig({ ...config, apiKey: '', selectedModel: '' }, '已清除本机保存的 Key 和模型选择。');
  const hasUnsavedChanges = config.baseUrl !== savedConfig.baseUrl || config.apiKey !== savedConfig.apiKey || config.selectedModel !== savedConfig.selectedModel || config.persona !== savedConfig.persona;
  const visibleModels = models.filter(model => model.id.toLowerCase().includes(search.trim().toLowerCase()));

  return <div className="content narrow"><section className="card model-settings">
    <div className="section-title"><div><h2>模型配置</h2></div><Cpu size={19}/></div>
    <div className="model-saved-summary" role="status"><span>已保存模型</span><strong>{savedConfig.selectedModel || '尚未保存模型'}</strong>{hasUnsavedChanges && <small>有修改尚未保存</small>}</div>
    <div className="form-grid">
      <label className="full">API 基础地址<input type="url" value={config.baseUrl} onChange={event => changeConnection({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" spellCheck={false}/></label>
      <div className="api-key-field full"><label>模型 API Key<input type="password" autoComplete="off" value={config.apiKey} onChange={event => changeConnection({ apiKey: event.target.value })} placeholder="填写 OpenAI 或兼容服务的 API Key"/></label>
        <div className="api-key-actions"><span>{storageError ? '本机保存失败' : config.apiKey ? config.apiKey === savedConfig.apiKey ? '已保存在本机' : '待保存' : '尚未填写'}</span><button type="button" disabled={!config.apiKey && !savedConfig.apiKey} onClick={clearSavedKey}>清除已保存的 Key</button></div>
      </div>
    </div>
    <p className="hint">默认使用 OpenAI；使用兼容服务时填写服务商提供的 API 基础地址。填写 Key 后自动查询模型，也可手动刷新。</p>
    <div className="button-row"><button type="button" disabled={loading || !config.apiKey.trim() || !config.baseUrl.trim()} onClick={() => setRefresh(old => old + 1)}><RefreshCw size={16}/> {loading ? '查询中…' : '刷新模型列表'}</button></div>
    {error && <div className="voice-notice error" role="alert">{error}</div>}
    {storageError && <div className="voice-notice error" role="alert">无法保存模型配置，请检查本机存储权限。</div>}
    <div className="model-list-heading"><strong>可用模型</strong><span className="count">{models.length} 个</span></div>
    <label>搜索模型<input value={search} onChange={event => setSearch(event.target.value)} placeholder="输入模型名称筛选" disabled={!models.length}/></label>
    {config.selectedModel && <p className="hint">当前选择：{config.selectedModel}{hasUnsavedChanges ? '（未保存，请点击“保存配置”）' : '（已保存）'}</p>}
    {queried && config.selectedModel && !models.some(model => model.id === config.selectedModel) && <p className="hint">当前接口未返回所选模型，已保留选择，可刷新列表或重新选择。</p>}
    <div className="model-list" aria-label="可用模型列表" aria-busy={loading}>
      {loading ? <div className="empty" role="status">正在查询可用模型…</div> : visibleModels.length ? visibleModels.map(model =>
        <button type="button" key={model.id} className={`model-option${config.selectedModel === model.id ? ' selected' : ''}`} aria-pressed={config.selectedModel === model.id} onClick={() => { setConfig(old => ({ ...old, selectedModel: model.id })); setSaveNotice(''); }}>
          <span><strong>{model.id}</strong>{model.owned_by && <small>{model.owned_by}</small>}</span><span className="model-selection">{config.selectedModel === model.id ? '已选择' : '选择'}</span>
        </button>) : <div className="empty">{error ? '查询失败，请检查配置后重试。' : queried ? models.length ? '没有匹配的模型。' : '接口未返回可用模型。' : '填写 API 地址和 Key 后，这里会显示可用模型。'}</div>}
    </div>
    <label className="model-persona-field">固定人设<textarea rows={15} value={config.persona} onChange={event => { setConfig(old => ({ ...old, persona: event.target.value })); setSaveNotice(''); }} placeholder="填写主播身份、性格和互动规则"/></label>
    <p className="hint">手动文字提问和自动弹幕使用已保存的模型与人设生成回复，再由数字人播报。每次独立发送人设、观众昵称和弹幕内容。先判断弹幕意图：普通问答和聊天只播报台词，确定是动作要求时才随口播发送对应动作；礼物按礼物动作规则处理。队列中可查看动作描述与提交状态；画面效果由数字人模型生成，暂不支持逐句精确同步。</p>
    <p className="hint">选择模型后点击“保存配置”，地址、Key、所选模型和人设会保存在本机，下次进入自动恢复。Key 仅发送到你填写的模型服务地址。</p>
    <div className="button-row"><button type="button" className="primary" disabled={!config.selectedModel || !config.apiKey.trim() || !config.baseUrl.trim() || !config.persona.trim()} onClick={saveConfig}><Save size={16}/> 保存配置</button></div>
    {saveNotice && <div className="voice-notice success" role="status">{saveNotice}</div>}
  </section></div>;
}
