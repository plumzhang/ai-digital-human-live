import { useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { emit } from '@tauri-apps/api/event';
import { RotateCcw, Play, SlidersHorizontal, Shield } from 'lucide-react';
import { CAPTION_SETTINGS_KEY, defaultCaptionSettings, loadCaptionSettings, normalizeCaptionSettings, type CaptionSettings } from '../captionSettings';
import { ObsCaption } from './ObsCaption';

function Range({ label, value, min = 0, max = 100, unit = '', onChange }: { label: string; value: number; min?: number; max?: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="caption-range"><span>{label}<output>{value}{unit}</output></span><input type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))}/></label>;
}
function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="caption-color"><span>{label}</span><span><input type="color" value={value} onChange={event => onChange(event.target.value)}/><code>{value.toUpperCase()}</code></span></label>;
}

export function DanmakuSettings({ filters, avatarSrc }: { filters: ReactNode; avatarSrc: string }) {
  const [tab, setTab] = useState<'filter' | 'appearance'>('filter');
  const [settings, setSettings] = useState(loadCaptionSettings);
  const [notice, setNotice] = useState('设置自动保存，并实时应用到 OBS');
  const [error, setError] = useState(false);
  const [sample, setSample] = useState('[弹幕] 小宇：今天的直播好好看！\n[回复] 谢谢小宇，欢迎来直播间聊天～');
  const [replay, setReplay] = useState(0);
  const [portrait, setPortrait] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; startX: number; startY: number; x: number; y: number; travelX: number; travelY: number } | null>(null);
  const currentRef = useRef(settings);
  const change = (patch: Partial<CaptionSettings>) => {
    const next = normalizeCaptionSettings({ ...currentRef.current, ...patch });
    currentRef.current = next; setSettings(next);
    try {
      localStorage.setItem(CAPTION_SETTINGS_KEY, JSON.stringify(next));
      setError(false); setNotice('已自动保存 · OBS 实时同步');
    } catch { setError(true); setNotice('本机保存失败，当前预览仍有效，请重试'); }
    void emit('caption-settings-changed', next).catch(() => { setError(true); setNotice('OBS 同步失败，请调整设置重试'); });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    change({ x: drag.x + (drag.travelX ? (event.clientX - drag.startX) / drag.travelX * 100 : 0), y: drag.y + (drag.travelY ? (event.clientY - drag.startY) / drag.travelY * 100 : 0) });
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stage = event.currentTarget;
    const bounds = stage.getBoundingClientRect();
    const anchor = stage.querySelector('.obs-caption-anchor')?.getBoundingClientRect();
    const travelX = bounds.width - (anchor?.width || bounds.width * settings.width / 100);
    const travelY = Math.max(0, bounds.height - (anchor?.height || 0));
    const onText = (event.target as HTMLElement).closest('.obs-caption-anchor');
    const x = onText ? settings.x : travelX > 0 ? (event.clientX - bounds.left - (anchor?.width || 0) / 2) / travelX * 100 : settings.x;
    const y = onText ? settings.y : travelY > 0 ? (event.clientY - bounds.top - (anchor?.height || 0) / 2) / travelY * 100 : settings.y;
    change({ x, y });
    stage.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: currentRef.current.x, y: currentRef.current.y, travelX, travelY };
  };
  return <div className="content danmaku-config">
    <div className="danmaku-tabs" role="tablist" aria-label="弹幕配置">
      <button role="tab" id="danmaku-filter-tab" aria-selected={tab === 'filter'} aria-controls="danmaku-filter-panel" onClick={() => setTab('filter')}><Shield size={16}/> 弹幕过滤</button>
      <button role="tab" id="danmaku-appearance-tab" aria-selected={tab === 'appearance'} aria-controls="danmaku-appearance-panel" onClick={() => setTab('appearance')}><SlidersHorizontal size={16}/> 弹幕设置</button>
    </div>
    {tab === 'filter' ? <div id="danmaku-filter-panel" role="tabpanel" aria-labelledby="danmaku-filter-tab">{filters}</div> : <div id="danmaku-appearance-panel" role="tabpanel" aria-labelledby="danmaku-appearance-tab" className="caption-settings-layout">
      <section className="card caption-controls">
        <div className="section-title"><h2>文字与显示</h2><button className="caption-reset" onClick={() => { change(defaultCaptionSettings); setReplay(value => value + 1); }}><RotateCcw size={14}/> 恢复默认</button></div>
        <p className={error ? 'caption-save-state error' : 'caption-save-state'} role="status">{notice}</p>
        <fieldset><legend>显示位置</legend>
          <div className="caption-presets">{[['左上', 0, 0], ['居中', 50, 50], ['底部居中', 50, 94], ['右下', 100, 100]].map(([label, x, y]) => <button key={label} onClick={() => change({ x: Number(x), y: Number(y) })}>{label}</button>)}</div>
          <Range label="水平位置" value={settings.x} unit="%" onChange={x => change({ x })}/>
          <Range label="垂直位置" value={settings.y} unit="%" onChange={y => change({ y })}/>
          <Range label="文字区域宽度" min={10} value={settings.width} unit="%" onChange={width => change({ width })}/>
        </fieldset>
        <fieldset><legend>文字样式</legend><div className="caption-control-grid">
          <label>字体<select value={settings.fontFamily} onChange={event => change({ fontFamily: event.target.value as CaptionSettings['fontFamily'] })}><option value="sans">微软雅黑</option><option value="hei">黑体</option><option value="song">宋体</option><option value="kai">楷体</option></select></label>
          <label>对齐方式<select value={settings.align} onChange={event => change({ align: event.target.value as CaptionSettings['align'] })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
          <Color label="文字颜色" value={settings.color} onChange={color => change({ color })}/>
          <label className="caption-checkbox"><input type="checkbox" checked={settings.bold} onChange={event => change({ bold: event.target.checked })}/>加粗文字</label>
        </div><Range label="文字大小" min={12} max={100} value={settings.fontSize} unit=" px" onChange={fontSize => change({ fontSize })}/>
          <Range label="整体不透明度" value={settings.opacity} unit="%" onChange={opacity => change({ opacity })}/>
          <p className="hint">字号以 1080 像素宽画面为基准，随 OBS 窗口等比例缩放。</p>
        </fieldset>
        <fieldset><legend>阴影与描边</legend><div className="caption-control-grid">
          <label className="caption-checkbox"><input type="checkbox" checked={settings.shadow} onChange={event => change({ shadow: event.target.checked })}/>开启文字阴影</label>
          <Color label="阴影颜色" value={settings.shadowColor} onChange={shadowColor => change({ shadowColor })}/>
        </div>{settings.shadow && <Range label="阴影模糊" max={24} value={settings.shadowBlur} unit=" px" onChange={shadowBlur => change({ shadowBlur })}/>}
          <div className="caption-control-grid"><label className="caption-checkbox"><input type="checkbox" checked={settings.stroke} onChange={event => change({ stroke: event.target.checked })}/>开启文字描边</label><Color label="描边颜色" value={settings.strokeColor} onChange={strokeColor => change({ strokeColor })}/></div>
          {settings.stroke && <Range label="描边宽度" max={8} value={settings.strokeWidth} unit=" px" onChange={strokeWidth => change({ strokeWidth })}/>}
        </fieldset>
        <fieldset><legend>文字背景</legend><div className="caption-control-grid"><label className="caption-checkbox"><input type="checkbox" checked={settings.background} onChange={event => change({ background: event.target.checked })}/>开启背景</label><Color label="背景颜色" value={settings.backgroundColor} onChange={backgroundColor => change({ backgroundColor })}/></div>
          {settings.background && <><Range label="背景不透明度" value={settings.backgroundOpacity} unit="%" onChange={backgroundOpacity => change({ backgroundOpacity })}/><Range label="背景内边距" max={48} value={settings.padding} unit=" px" onChange={padding => change({ padding })}/><Range label="背景圆角" max={48} value={settings.radius} unit=" px" onChange={radius => change({ radius })}/></>}
        </fieldset>
        <fieldset><legend>入场效果</legend><label>动画效果<select value={settings.entrance} onChange={event => { change({ entrance: event.target.value as CaptionSettings['entrance'] }); setReplay(value => value + 1); }}><option value="fade">淡入淡出</option><option value="slide">向上浮入</option><option value="zoom">轻微缩放</option><option value="none">无动画</option></select></label>
          {settings.entrance !== 'none' && <Range label="入场时长" min={100} max={1200} value={settings.entranceMs} unit=" ms" onChange={entranceMs => change({ entranceMs })}/>}
        </fieldset>
      </section>
      <section className="card caption-preview-card"><div className="section-title"><h2>OBS 效果预览</h2><select aria-label="预览画面比例" value={portrait ? 'portrait' : 'landscape'} onChange={event => setPortrait(event.target.value === 'portrait')}><option value="portrait">竖屏 9:16</option><option value="landscape">横屏 16:9</option></select></div>
        <div className="caption-preview-mat"><div ref={stageRef} className={`caption-preview-stage obs-caption-viewport ${portrait ? 'portrait' : 'landscape'}`} onPointerDown={start} onPointerMove={move} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onLostPointerCapture={() => { dragRef.current = null; }}>
          {avatarSrc && !imageFailed ? <img src={avatarSrc} alt="数字人预览背景" draggable={false} onError={() => setImageFailed(true)}/> : <div className="caption-preview-backdrop"><span>OBS</span><small>画面预览</small></div>}
          <div className="caption-preview-guide"/>
          <ObsCaption key={replay} content={sample} settings={settings}/>
        </div></div>
        <p className="hint">点击画面定位，拖动文字微调；位置相对于 OBS 的实际视频画面。</p>
        <label className="caption-sample">预览文字<textarea rows={3} value={sample} onChange={event => setSample(event.target.value)}/></label>
        <div className="button-row"><button onClick={() => setReplay(value => value + 1)}><Play size={14}/> 重播入场效果</button><span className="hint">预览文字仅用于此处演示</span></div>
      </section>
    </div>}
  </div>;
}
