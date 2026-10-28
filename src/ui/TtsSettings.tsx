import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { loadTtsConfig, ttsStorageKey } from '../ttsConfig';

type ServiceStatus = { state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'; running_model?: string | null; device?: string; managed?: boolean; installed_models: string[]; acceleration?: { flashinfer: boolean; cuda_graph: boolean; verified: boolean; gpu?: string }; stt?: { ready: boolean; model: string }; error?: string };
type Operation = 'starting' | 'stopping' | 'preview' | null;
const models = ['k2-fsa/OmniVoice'];

export function TtsSettings({ active = true }: { active?: boolean } = {}) {
  const [config, setConfig] = useState(loadTtsConfig);
  const [service, setService] = useState<ServiceStatus>({ state: 'stopped', installed_models: [] });
  const [notice, setNotice] = useState('');
  const [operation, setOperation] = useState<Operation>(null);
  const [sampleText, setSampleText] = useState('你好，欢迎来到直播间。');
  const [sampleUrl, setSampleUrl] = useState('');
  const request = useRef(0);
  const statusRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; statusRequest.current++; }; }, []);
  useEffect(() => {
    if (config.ref_audio) return;
    void invoke<{ ref_audio: string; ref_text: string } | null>('component_local_voice').then(voice => { if (voice && mounted.current) setConfig(old => old.ref_audio ? old : { ...old, ...voice }); }).catch(() => {});
  }, []);

  const refresh = async () => {
    const id = ++statusRequest.current;
    try {
      const next = await invoke<ServiceStatus>('component_local_status', { tts: config });
      if (mounted.current && id === statusRequest.current) setService(next);
    } catch { if (mounted.current && id === statusRequest.current) setService(old => ({ ...old, state: 'error' })); }
  };
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    void listen('tts-service-state', () => { if (!disposed) void refresh(); }).then(detach => { if (disposed) detach(); else unlisten = detach; }).catch(() => {});
    return () => { disposed = true; statusRequest.current++; clearInterval(timer); unlisten?.(); };
  }, [active, config.base_url]);

  const update = (patch: Partial<typeof config>) => { setConfig(old => ({ ...old, ...patch })); setNotice(''); };
  const local = config.base_url.trim().replace(/\/$/, '') === 'http://127.0.0.1:8766';
  const switching = service.state === 'ready' && service.running_model !== config.model;
  const act = async (action: Exclude<Operation, null>) => {
    const id = ++request.current;
    statusRequest.current++;
    setOperation(action);
    setNotice(action === 'starting' ? '正在加载 FunASR / OmniVoice 并预热 FlashInfer…' : action === 'stopping' ? '正在关闭 TTS 并释放显存…' : '正在本机合成试听…');
    try {
      if (action === 'preview') {
        const url = await invoke<string>('component_tts_preview', { tts: config, text: sampleText });
        if (mounted.current && request.current === id) { setSampleUrl(url); setNotice('试听已生成，仅使用本机模型。'); }
      } else {
        await invoke(action === 'starting' ? 'component_start_local' : 'component_stop_local', { tts: config });
        if (mounted.current && request.current === id) {
          if (action === 'starting') {
            localStorage.setItem(ttsStorageKey, JSON.stringify(config)); window.dispatchEvent(new Event('speech-config-updated'));
            setNotice('FunASR / OmniVoice 已启动，语音配置已保存。');
          } else { setService({ state: 'stopped', installed_models: service.installed_models }); setSampleUrl(''); setNotice('本机语音服务已关闭，进程及显存已释放；自动回答已暂停。'); }
        }
      }
    } catch (error) { if (mounted.current && request.current === id) setNotice(String(error)); }
    finally { if (mounted.current && request.current === id) { setOperation(null); void refresh(); } }
  };
  const state = operation === 'starting' || operation === 'stopping' ? operation : service.state;
  const labels = { stopped: '未运行', starting: '加载中', ready: '运行中', stopping: '关闭中', error: '服务异常' };

  return <section className="card model-settings">
    <div className="section-title"><h2>OmniVoice 本地声音克隆</h2></div>
    <div className="model-saved-summary" role="status"><span>语音服务：{labels[state]}</span><strong>{service.running_model || '尚未加载模型'}</strong>{service.device && <small>{service.device}</small>}</div>
    <p role="status" className="hint">FunASR：{service.stt?.ready ? '已就绪' : '未就绪'} · FlashInfer：{service.acceleration?.verified && service.acceleration.flashinfer ? '已验证启用' : '未验证'} · CUDA Graph：{service.acceleration?.verified && service.acceleration.cuda_graph ? '已验证启用' : '未验证'}{service.acceleration?.gpu && <span> · {service.acceleration.gpu}</span>}</p>
    {service.error && <p role="alert">{service.error}</p>}
    <p className="hint">首次运行 npm run setup:speech 安装 WSL2 语音服务。/api/stt：FunASR 中文识别；/api/tts：OmniVoice 克隆。关闭服务会取消当前语音并释放显存。</p>
    <fieldset disabled={operation !== null}><div className="form-grid">
      <label className="full">语音服务基础地址<input value={config.base_url} onChange={e => update({ base_url: e.target.value })}/></label>
      <label className="full">模型<select value={config.model} onChange={e => update({ model: e.target.value })}>{models.map(model => <option key={model} value={model}>{model}（{service.installed_models.includes(model) ? '已安装' : '未安装'}）</option>)}</select></label>
      <label className="full">参考音频绝对路径<input value={config.ref_audio} onChange={e => update({ ref_audio: e.target.value })} placeholder="G:\声音\参考.wav"/></label>
      <label className="full">参考音频中的原话<textarea rows={3} value={config.ref_text} onChange={e => update({ ref_text: e.target.value })} placeholder="逐字填写参考录音内容，供克隆音色复用"/></label>
    </div></fieldset>
    <p className="hint">选用清晰、单人、无背景音乐的短录音。合成按句排队，并在播放当前句时准备下一句；字幕显示实际合成的台词。</p>
    <div className="button-row">
      <button type="button" className="primary" disabled={operation !== null} onClick={() => { try { localStorage.setItem(ttsStorageKey, JSON.stringify(config)); window.dispatchEvent(new Event('speech-config-updated')); setNotice(switching ? '配置已保存，请点击“切换并重启服务”使用所选模型。' : '已保存，下一条播报生效。'); } catch { setNotice('保存失败，请检查本机存储。'); } }}>保存语音配置</button>
      <button type="button" disabled={!local || operation !== null || service.state === 'starting' || (service.state === 'ready' && !switching)} onClick={() => void act('starting')}>{operation === 'starting' ? '加载中…' : switching ? '切换并重启服务' : '启动本机服务'}</button>
      <button type="button" className="danger" disabled={!local || operation === 'stopping' || (service.state === 'stopped' && operation === null)} onClick={() => void act('stopping')}>{operation === 'stopping' ? '关闭中…' : '关闭本机服务'}</button>
      <button type="button" onClick={() => void refresh()}>刷新服务状态</button>
    </div>
    <label>试听文本<input maxLength={200} value={sampleText} disabled={operation !== null} onChange={event => setSampleText(event.target.value)}/></label>
    <button type="button" disabled={operation !== null || service.state !== 'ready' || switching || !config.ref_audio.trim() || !config.ref_text.trim()} onClick={() => void act('preview')}>生成克隆试听</button>
    {sampleUrl && <audio controls src={sampleUrl}/>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
