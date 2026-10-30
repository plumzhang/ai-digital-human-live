import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { loadTtsConfig, ttsStorageKey, type TtsPreview } from '../ttsConfig';
import { ReferenceVoiceFields } from './ReferenceVoiceFields';

type ServiceStatus = { state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'; running_model?: string | null; device?: string; managed?: boolean; installed_models: string[]; acceleration?: { flashinfer: boolean; cuda_graph: boolean; verified: boolean; gpu?: string }; stt?: { ready: boolean; model: string }; error?: string };
type Operation = 'starting' | 'stopping' | 'preview' | null;
const models = ['k2-fsa/OmniVoice'];

export function TtsSettings({ active = true }: { active?: boolean } = {}) {
  const [config, setConfig] = useState(loadTtsConfig);
  const [service, setService] = useState<ServiceStatus>({ state: 'stopped', installed_models: [] });
  const [notice, setNotice] = useState('');
  const [operation, setOperation] = useState<Operation>(null);
  const [recognizingReference, setRecognizingReference] = useState(false);
  const [sampleText, setSampleText] = useState('你好，欢迎来到直播间。');
  const [sampleUrl, setSampleUrl] = useState('');
  const [sampleFileName, setSampleFileName] = useState('');
  const request = useRef(0);
  const previewVersion = useRef(0);
  const statusRequest = useRef(0);
  const mounted = useRef(true);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; statusRequest.current++; }; }, []);
  useEffect(() => {
    const sync = () => {
      previewVersion.current++;
      setConfig(loadTtsConfig()); setSampleUrl(''); setNotice('');
      setOperation(old => old === 'preview' ? null : old);
    };
    window.addEventListener('speech-config-updated', sync);
    return () => window.removeEventListener('speech-config-updated', sync);
  }, []);
  useEffect(() => {
    if (active) return;
    player.current?.pause();
    previewVersion.current++;
    setOperation(old => old === 'preview' ? null : old);
  }, [active]);
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

  const update = (patch: Partial<typeof config>) => { setConfig(old => ({ ...old, ...patch })); setSampleUrl(''); setNotice(''); };
  const local = config.base_url.trim().replace(/\/$/, '') === 'http://127.0.0.1:8766';
  const switching = service.state === 'ready' && service.running_model !== config.model;
  const act = async (action: Exclude<Operation, null>) => {
    const id = ++request.current;
    const version = previewVersion.current;
    statusRequest.current++;
    setOperation(action);
    setNotice(action === 'starting' ? '正在加载 FunASR / OmniVoice 并预热 FlashInfer…' : action === 'stopping' ? '正在关闭 TTS 并释放显存…' : '正在本机合成试听…');
    try {
      if (action === 'preview') {
        setSampleUrl(''); setSampleFileName('');
        const result = await invoke<TtsPreview>('component_tts_preview', { tts: config, text: sampleText });
        if (mounted.current && request.current === id && previewVersion.current === version) { setSampleUrl(result.audio_url); setSampleFileName(result.file_name); setNotice(`试听已保存：${result.file_name}`); }
      } else {
        await invoke(action === 'starting' ? 'component_start_local' : 'component_stop_local', { tts: config });
        if (mounted.current && request.current === id) {
          if (action === 'starting') {
            localStorage.setItem(ttsStorageKey, JSON.stringify(config)); window.dispatchEvent(new Event('speech-config-updated'));
            setNotice('FunASR / OmniVoice 已启动，语音配置已保存。');
          } else { setService({ state: 'stopped', installed_models: service.installed_models }); setSampleUrl(''); setNotice('本机语音服务已关闭，进程及显存已释放；自动回答已暂停。'); }
        }
      }
    } catch (error) { if (mounted.current && request.current === id && (action !== 'preview' || previewVersion.current === version)) setNotice(String(error)); }
    finally { if (mounted.current && request.current === id) { setOperation(null); void refresh(); } }
  };
  const state = operation === 'starting' || operation === 'stopping' ? operation : service.state;
  const labels = { stopped: '未运行', starting: '加载中', ready: '运行中', stopping: '关闭中', error: '服务异常' };

  return <section className="card model-settings">
    <div className="section-title"><h2>OmniVoice 本地声音克隆</h2></div>
    <p className="hint">角色音色在“形象设定 → 编辑数字人”中独立保存并试听。本页参考音频用于语音服务测试。</p>
    <div className="model-saved-summary" role="status"><span>语音服务：{labels[state]}</span><strong>{service.running_model || '尚未加载模型'}</strong>{service.device && <small>{service.device}</small>}</div>
    <p role="status" className="hint">FunASR：{service.stt?.ready ? '已就绪' : '未就绪'} · FlashInfer：{service.acceleration?.verified && service.acceleration.flashinfer ? '已验证启用' : '未验证'} · CUDA Graph：{service.acceleration?.verified && service.acceleration.cuda_graph ? '已验证启用' : '未验证'}{service.acceleration?.gpu && <span> · {service.acceleration.gpu}</span>}</p>
    {service.error && <p role="alert">{service.error}</p>}
    <p className="hint">首次运行 npm run setup:speech 安装 WSL2 语音服务。/api/stt：FunASR 中文识别；/api/tts：OmniVoice 克隆。关闭服务会取消当前语音并释放显存。</p>
    <fieldset disabled={operation !== null}><div className="form-grid">
      <label className="full">语音服务基础地址<input value={config.base_url} onChange={e => update({ base_url: e.target.value })}/></label>
      <label className="full">模型<select value={config.model} onChange={e => update({ model: e.target.value })}>{models.map(model => <option key={model} value={model}>{model}（{service.installed_models.includes(model) ? '已安装' : '未安装'}）</option>)}</select></label>
      <ReferenceVoiceFields voice={config} tts={config} onChange={voice => update(voice)} active={active} disabled={operation !== null} onRecognizingChange={setRecognizingReference}/>
    </div></fieldset>
    <p className="hint">选用清晰、单人、无背景音乐的短录音。合成按句排队，并在播放当前句时准备下一句；字幕显示实际合成的台词。</p>
    <div className="button-row">
      <button type="button" className="primary" disabled={operation !== null || recognizingReference} onClick={() => { try { localStorage.setItem(ttsStorageKey, JSON.stringify(config)); window.dispatchEvent(new Event('speech-config-updated')); setNotice(switching ? '配置已保存，请点击“切换并重启服务”使用所选模型。' : '已保存，下一条播报生效。'); } catch { setNotice('保存失败，请检查本机存储。'); } }}>保存语音配置</button>
      <button type="button" disabled={!local || operation !== null || service.state === 'starting' || (service.state === 'ready' && !switching)} onClick={() => void act('starting')}>{operation === 'starting' ? '加载中…' : switching ? '切换并重启服务' : '启动本机服务'}</button>
      <button type="button" className="danger" disabled={!local || operation === 'stopping' || (service.state === 'stopped' && operation === null)} onClick={() => void act('stopping')}>{operation === 'stopping' ? '关闭中…' : '关闭本机服务'}</button>
      <button type="button" onClick={() => void refresh()}>刷新服务状态</button>
    </div>
    <label className="voice-sample-label">试听文本<input maxLength={200} value={sampleText} disabled={operation !== null} onChange={event => { setSampleText(event.target.value); setSampleUrl(''); }}/></label>
    <div className="button-row"><button type="button" disabled={operation !== null || recognizingReference || service.state !== 'ready' || switching || !config.ref_audio.trim() || !config.ref_text.trim() || !sampleText.trim()} onClick={() => void act('preview')}>{operation === 'preview' ? '正在生成试听…' : '生成克隆试听'}</button><button type="button" disabled={operation === 'preview'} onClick={() => { void invoke('component_tts_open_preview_folder', { fileName: sampleUrl ? sampleFileName : null }).catch(error => { if (mounted.current) setNotice(String(error)); }); }}>打开生成文件夹</button></div>
    {sampleUrl && <div className="voice-preview-player"><span>克隆声音试听</span><audio ref={player} controls src={sampleUrl} aria-label="克隆声音试听"/></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
