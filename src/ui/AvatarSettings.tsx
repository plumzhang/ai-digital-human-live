import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Pencil, Plus, Save, Settings2, Video } from 'lucide-react';
import { avatarConfigOf, defaultAvatarConfig, newAvatarProfile, validateAdvanced, type AvatarConfig, type AvatarLibrary, type AvatarProfile } from '../avatarProfiles';
import { normalizeStoredVoice } from '../voiceSelection';

type Props = {
  active: boolean; library: AvatarLibrary | null; loading: boolean; saving: boolean; error: string;
  runtimeBusy: boolean; apiKey: string; onConfigureApi: () => void;
  onSave: (profile: AvatarProfile) => Promise<void>; onSelect: (id: string) => Promise<void>; onRetry: () => void;
};

function AvatarCard({ profile, selected, disabled, saving, onEdit, onSelect }: {
  profile: AvatarProfile; selected: boolean; disabled: boolean; saving: boolean; onEdit: () => void; onSelect: () => void;
}) {
  const [failedImage, setFailedImage] = useState(false);
  const src = profile.image?.data || profile.config.imageUri.trim();
  useEffect(() => setFailedImage(false), [src]);
  return <article className={`card avatar-profile-card${selected ? ' selected' : ''}`}>
    <div className="avatar-card-picture">{src && !failedImage ? <img src={src} alt={`${profile.name}的形象`} loading="lazy" onError={() => setFailedImage(true)}/> : <div><Video size={38}/><span>{failedImage ? '图片加载失败' : '待设置形象图片'}</span></div>}{selected && <span className="avatar-current-badge"><Check size={13}/> 当前使用</span>}</div>
    <h3>{profile.name}</h3><p className="avatar-card-model">{profile.config.avatarModel} · {profile.config.region === 'cn' ? '中国区' : '国际区'}</p>
    <p className="avatar-card-voice">音色：本机 OmniVoice</p>
    <p className="avatar-card-persona">{profile.config.persona || '待填写人设'}</p>
    <div className="button-row"><button type="button" className={selected ? '' : 'primary'} disabled={disabled || selected} onClick={onSelect}><Check size={15}/>{selected ? '当前使用' : '设为当前'}</button><button type="button" disabled={saving} onClick={onEdit}><Pencil size={15}/> 编辑</button></div>
  </article>;
}

function AvatarEditor({ profile, isNew, saving, locked, onClose, onSave, ...props }: {
  profile: AvatarProfile; isNew: boolean; saving: boolean; locked: boolean;
  onClose: () => void; onSave: (profile: AvatarProfile) => Promise<void>;
} & Pick<Props, 'active' | 'apiKey' | 'onConfigureApi'>) {
  const [name, setName] = useState(profile.name);
  const [settings, setSettings] = useState<AvatarConfig>(() => ({ ...avatarConfigOf(profile.config), ...normalizeStoredVoice(profile.config) }));
  const [image, setImage] = useState(profile.image);
  const [imageReading, setImageReading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [error, setError] = useState('');
  const imageInput = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  const submitting = useRef(false);
  const [submittingState, setSubmittingState] = useState(false);
  const previewSrc = image?.data || settings.imageUri.trim();
  const update = (patch: Partial<AvatarConfig>) => { setSettings(old => ({ ...old, ...patch })); setError(''); };
  const disabled = saving || submittingState || imageReading;
  useEffect(() => setPreviewError(false), [previewSrc]);
  useEffect(() => () => { if (reader.current) { reader.current.onload = null; reader.current.onerror = null; reader.current.onabort = null; reader.current.abort(); } }, []);

  function readImage(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size >= 10 * 1024 * 1024) { setError('请选择小于 10 MB 的 PNG、JPG 或 WebP 图片'); return; }
    setImageReading(true); setError('');
    const next = new FileReader(); reader.current = next;
    next.onload = () => { setImage({ data: String(next.result), name: file.name }); setImageReading(false); };
    next.onerror = () => { setError('读取所选图片失败，请重新选择'); setImageReading(false); };
    next.onabort = () => setImageReading(false);
    next.readAsDataURL(file);
  }

  async function save() {
    if (submitting.current || disabled || locked) return;
    setError('');
    try {
      if (!name.trim() || name.trim().length > 50) throw new Error('请填写 1～50 个字符的数字人名称');
      validateAdvanced(settings.advanced);
      if (settings.greeting.length > 200) throw new Error('开场白指令不能超过 200 字');
      submitting.current = true; setSubmittingState(true);
      await onSave({ ...profile, name: name.trim(), config: avatarConfigOf(settings), image });
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { submitting.current = false; setSubmittingState(false); }
  }

  return <>
    <div className="avatar-library-heading"><div className="avatar-editor-heading"><button type="button" disabled={disabled} onClick={onClose}><ArrowLeft size={16}/> 返回卡片</button><div><h2>{isNew ? '新建数字人' : `编辑数字人 · ${profile.name}`}</h2><p className="hint">独立保存形象与主播人设，语音使用本机 OmniVoice。</p></div></div></div>
    <form className="settings-layout avatar-editor-layout" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <section className="card settings-form"><div className="section-title"><h2>数字人配置</h2><Settings2 size={19}/></div>
        <fieldset className="avatar-editor-fields" disabled={disabled}><div className="form-grid">
          <label className="full">数字人名称<input value={name} onChange={event => { setName(event.target.value); setError(''); }} maxLength={50} placeholder="例如：晚晚" required/></label>
          <label className="full">数字人模型<select value={settings.avatarModel} onChange={e => update({ avatarModel: e.target.value as AvatarConfig['avatarModel'] })}><option value="vidu-s2">vidu-s2（最新模型，灰度测试中）</option><option value="vidu-s1">vidu-s1</option></select></label>
          <label>API 地区<select value={settings.region} onChange={e => update({ region: e.target.value as AvatarConfig['region'] })}><option value="cn">中国区 · api.vidu.cn</option><option value="global">国际区 · api.vidu.com</option></select></label>
          {!props.apiKey.trim() && <div className="voice-notice error full">请先配置 Vidu API Key。<button type="button" onClick={props.onConfigureApi}>前往模型配置</button></div>}
          <label className="full">形象图片 URL<input value={settings.imageUri} onChange={e => update({ imageUri: e.target.value })} placeholder="https://..."/></label>
          <label className="full">或选择本地形象图片<input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) readImage(file); }}/></label>
          {image && <div className="full local-image-row"><span>当前使用：{image.name}</span><button type="button" onClick={() => { setImage(null); setError(''); }}>改用图片 URL</button></div>}
          <p className="hint full">组件版使用本机 OmniVoice 克隆音色，请在“模型配置 → OmniVoice 语音”设置参考音频。</p>
          <label className="full">人设<textarea rows={7} value={settings.persona} onChange={e => update({ persona: e.target.value })}/></label>
        </div>
        </fieldset>
        {locked && <p className="hint">此数字人正在使用中，请先结束直播会话，再保存修改。</p>}
        <div className="button-row"><button type="submit" className="primary" disabled={disabled || locked}><Save size={16}/>{saving || submittingState ? '保存中…' : imageReading ? '读取图片中…' : '保存数字人'}</button><button type="button" disabled={disabled} onClick={onClose}>取消</button></div>
        {error && <div className="voice-notice error" role="alert">{error}</div>}
      </section>
      <aside className="card settings-preview"><div className="section-title"><h2>{name.trim() || '形象预览'}</h2><Video size={19}/></div>
        <div className="avatar-preview-stage">{previewSrc && !previewError ? <img src={previewSrc} alt="数字人形象预览" onError={() => setPreviewError(true)}/> : <div className="avatar-preview-empty"><Video size={32}/><strong>{previewError ? '图片加载失败' : '尚未设置形象图片'}</strong><span>填写图片 URL，或选择本地图片。</span></div>}</div>
        <div className="preview-details"><div><span>图片来源</span><strong>{image ? '本地图片' : settings.imageUri.trim() ? '图片 URL' : '未设置'}</strong></div><div><span>音色</span><strong>本机 OmniVoice</strong></div><div><span>人设</span><p>{settings.persona || '未设置'}</p></div></div>
      </aside>
    </form>
  </>;
}

export function AvatarSettings(props: Props) {
  const [editor, setEditor] = useState<{ profile: AvatarProfile; isNew: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const busy = props.loading || props.saving;
  async function select(id: string) {
    setNotice(''); setError('');
    try { await props.onSelect(id); setNotice('已切换当前数字人，直播中控将使用这张卡片的配置。'); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="content avatar-library" style={{ display: props.active ? undefined : 'none' }}>
    {editor ? <AvatarEditor key={editor.profile.id} {...props} profile={editor.profile} isNew={editor.isNew} locked={props.runtimeBusy && editor.profile.id === props.library?.activeId}
      onClose={() => setEditor(null)} onSave={async profile => { await props.onSave(profile); setNotice(`“${profile.name}”已保存到数字人卡片。`); }}/>
    : <>
      <div className="avatar-library-heading"><div><h2>我的数字人 <span className="count">{props.library?.profiles.length || 0}</span></h2><p className="hint">保存多个数字人，选择一位用于直播。</p></div><button type="button" className="primary" disabled={busy || !props.library} onClick={() => { setNotice(''); setError(''); setEditor({ profile: newAvatarProfile({ ...defaultAvatarConfig, region: props.library?.profiles.find(profile => profile.id === props.library?.activeId)?.config.region || 'cn' }), isNew: true }); }}><Plus size={17}/> 新建数字人</button></div>
      {!props.apiKey.trim() && <div className="voice-notice error">请先配置 Vidu API Key。<button type="button" onClick={props.onConfigureApi}>前往模型配置</button></div>}
      {notice && <div className="voice-notice success" role="status">{notice}</div>}
      {(error || props.error) && <div className="voice-notice error" role="alert">{error || props.error}{props.error && <button type="button" onClick={props.onRetry}>重试读取</button>}</div>}
      {props.loading ? <div className="card empty">正在读取数字人卡片…</div> : props.library && <>
        {props.runtimeBusy && <p className="hint">直播会话进行中，结束后可切换当前数字人。</p>}
        <div className="avatar-profile-grid">{props.library.profiles.map(profile => <AvatarCard key={profile.id} profile={profile} selected={profile.id === props.library?.activeId} disabled={busy || props.runtimeBusy} saving={busy} onEdit={() => { setError(''); setNotice(''); setEditor({ profile: structuredClone(profile), isNew: false }); }} onSelect={() => void select(profile.id)}/>)}</div>
      </>}
    </>}
  </div>;
}
