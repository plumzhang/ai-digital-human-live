import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Cpu, RefreshCw, Save } from 'lucide-react';
import { defaultModelPersona, loadModelConfig, modelStorageKey, type ModelConfig } from '../modelConfig';

type ModelInfo = { id: string; owned_by?: string | null };

export function ModelSettings({ active = true }: { active?: boolean } = {}) {
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
    if (!active) { setLoading(false); return; }
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
  }, [active, config.baseUrl, config.apiKey, refresh]);

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

  return <section className="card model-settings">
    <div className="section-title"><div><h2>大语言模型</h2></div><Cpu size={19}/></div>
    <div className="model-saved-summary" role="status"><span>已保存模型</span><strong>{savedConfig.selectedModel || '尚未保存模型'}</strong>{hasUnsavedChanges && <small>有修改尚未保存</small>}</div>
    <div className="form-grid">
      <label className="full">API 基础地址<input type="url" value={config.baseUrl} onChange={event => changeConnection({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" spellCheck={false}/></label>
      <div className="api-key-field full"><label>模型 API Key<input type="password" autoComplete="off" value={config.apiKey} onChange={event => changeConnection({ apiKey: event.target.value })} placeholder="填写 OpenAI 或兼容服务的 API Key"/></label>
        <div className="api-key-actions"><span>{storageError ? '本机保存失败' : config.apiKey ? config.apiKey === savedConfig.apiKey ? '已保存在本机' : '待保存' : '尚未填写'}</span><button type="button" disabled={!config.apiKey && !savedConfig.apiKey} onClick={clearSavedKey}>清除已保存的 Key</button></div>
      </div>
    </div>

    <div className="button-row"><button type="button" disabled={loading || !config.apiKey.trim() || !config.baseUrl.trim()} onClick={() => setRefresh(old => old + 1)}><RefreshCw size={16}/> {loading ? '查询中…' : '刷新模型列表'}</button></div>
    {error && <div className="voice-notice error" role="alert">{error}</div>}
    {storageError && <div className="voice-notice error" role="alert">无法保存模型配置，请检查本机存储权限。</div>}
    <div className="model-list-heading"><strong>可用模型</strong><span className="count">{models.length} 个</span></div>
    <label>搜索模型<input value={search} onChange={event => setSearch(event.target.value)} placeholder="输入模型名称筛选" disabled={!models.length}/></label>
    {config.selectedModel && <p className="hint">当前选择：{config.selectedModel}{hasUnsavedChanges ? '（未保存）' : '（已保存）'}</p>}
    {queried && config.selectedModel && !models.some(model => model.id === config.selectedModel) && <p className="hint">当前接口未返回所选模型</p>}
    <div className="model-list" aria-label="可用模型列表" aria-busy={loading}>
      {loading ? <div className="empty" role="status">正在查询可用模型…</div> : visibleModels.length ? visibleModels.map(model =>
        <button type="button" key={model.id} className={`model-option${config.selectedModel === model.id ? ' selected' : ''}`} aria-pressed={config.selectedModel === model.id} onClick={() => { setConfig(old => ({ ...old, selectedModel: model.id })); setSaveNotice(''); }}>
          <span><strong>{model.id}</strong>{model.owned_by && <small>{model.owned_by}</small>}</span><span className="model-selection">{config.selectedModel === model.id ? '已选择' : '选择'}</span>
        </button>) : <div className="empty">{error ? '查询失败，请检查配置后重试。' : queried ? models.length ? '没有匹配的模型。' : '接口未返回可用模型。' : '暂无可用模型'}</div>}
    </div>
    <label className="model-persona-field">固定人设与回复规则<textarea rows={15} value={config.persona} onChange={event => { setConfig(old => ({ ...old, persona: event.target.value })); setSaveNotice(''); }} placeholder="填写主播人设和回答风格，模型直接生成最终口播台词"/></label>
    <p className="hint">大语言模型直接生成回答，按句交给 OmniVoice 合成；“形象设定”的人设作为当前数字人的身份背景。</p>
    <button type="button" onClick={() => { setConfig(old => ({ ...old, persona: defaultModelPersona })); setSaveNotice(''); }}>恢复默认回复规则</button>

    <div className="button-row"><button type="button" className="primary" disabled={!config.selectedModel || !config.apiKey.trim() || !config.baseUrl.trim() || !config.persona.trim()} onClick={saveConfig}><Save size={16}/> 保存配置</button></div>
    {saveNotice && <div className="voice-notice success" role="status">{saveNotice}</div>}
  </section>;
}
