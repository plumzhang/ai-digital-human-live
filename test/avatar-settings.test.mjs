import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function mount(preview = async () => ({ audio_url: 'data:audio/wav;base64,role', file_name: '试听-role.wav' }), openFolder = async () => {}, pickFile = async () => 'G:\\声音\\角色参考.wav', transcribe = async () => 'FunASR 自动识别的原话') {
  const instances = new Map(), calls = [], saves = [], storageWrites = [];
  let instance, pending = [], active = true;
  const load = (file, modules = {}, extra = {}) => {
    const exports = {};
    vm.runInNewContext(compile(file), { exports, require: name => modules[name], crypto: webcrypto, structuredClone, ...extra });
    return exports;
  };
  const model = load('src/avatarProfiles.ts');
  const service = load('src/ttsConfig.ts', {}, { localStorage: { getItem: () => JSON.stringify({ ref_audio: 'global.wav', ref_text: '全局测试音色' }), setItem: (...args) => storageWrites.push(args) } });
  const modules = {
    react: {
      useState(initial) { const current = instance, i = current.stateIndex++; if (!(i in current.values)) current.values[i] = typeof initial === 'function' ? initial() : initial; return [current.values[i], next => { current.values[i] = typeof next === 'function' ? next(current.values[i]) : next; }]; },
      useRef(initial) { const i = instance.refIndex++; return instance.refs[i] ??= { current: initial }; },
      useEffect(effect, deps) { const current = instance, i = current.effectIndex++, old = current.effects[i]; if (!old || deps.some((value, j) => !Object.is(value, old.deps[j]))) pending.push(() => { old?.cleanup?.(); current.effects[i] = { deps, cleanup: effect() }; }); },
    },
    'react/jsx-runtime': { jsx: (tag, props, key) => ({ tag, props, key }), jsxs: (tag, props, key) => ({ tag, props, key }) },
    'lucide-react': new Proxy({}, { get: () => 'svg' }),
    '../avatarProfiles': model,
    '../voiceSelection': { normalizeStoredVoice: () => ({}) },
    '../ttsConfig': service,
    '@tauri-apps/api/core': { invoke: async (name, args) => { calls.push({ name, args: args === undefined ? undefined : plain(args) }); return name === 'component_tts_preview' ? preview() : name === 'component_tts_open_preview_folder' ? openFolder() : name === 'component_pick_reference_audio' ? pickFile() : name === 'component_transcribe_reference_audio' ? transcribe(args) : {}; } },
  };
  modules['./ReferenceAudioPicker'] = load('src/ui/ReferenceAudioPicker.tsx', modules);
  modules['./ReferenceVoiceFields'] = load('src/ui/ReferenceVoiceFields.tsx', modules);
  modules['./AvatarVoiceFields'] = load('src/ui/AvatarVoiceFields.tsx', modules);
  const ui = load('src/ui/AvatarSettings.tsx', modules);
  const first = model.newAvatarProfile({ ...model.defaultAvatarConfig, referenceVoice: { ref_audio: 'first.wav', ref_text: '第一位原话' } }, '第一位');
  const second = model.newAvatarProfile({ ...model.defaultAvatarConfig, referenceVoice: { ref_audio: 'second.wav', ref_text: '第二位原话' } }, '第二位');
  let library = { version: 1, activeId: first.id, profiles: [first, second] };
  function expand(node, path = 'root') {
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${child?.key ?? i}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.tag === 'function') {
      const key = `${path}/${node.tag.name}/${node.key ?? ''}`;
      const current = instances.get(key) ?? { values: [], refs: [], effects: [] };
      instances.set(key, current); instance = current;
      current.stateIndex = current.refIndex = current.effectIndex = 0;
      return expand(node.tag(node.props), `${key}/result`);
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, `${path}/children`) } };
  }
  const p = {
    calls, saves, storageWrites, library: () => library,
    render() {
      pending = [];
      const tree = expand({ tag: ui.AvatarSettings, props: { active, library, loading: false, saving: false, error: '', runtimeBusy: false, apiKey: 'key', onSave: async profile => { saves.push(plain(profile)); library = model.saveProfileInLibrary(library, profile); }, onSelect: async id => { library = model.activateProfile(library, id); } } });
      pending.forEach(effect => effect()); return tree;
    },
    setActive(value) { active = value; },
    close() { for (const current of instances.values()) for (const effect of current.effects) effect?.cleanup?.(); },
  };
  p.button = label => nodes(p.render()).find(node => node.tag === 'button' && text(node).trim() === label);
  p.field = label => nodes(nodes(p.render()).find(node => node.tag === 'label' && text(node) === label)).find(node => node.tag === 'input' || node.tag === 'textarea');
  return p;
}

test('role voice fields and preview belong to the avatar form and save with its profile', async () => {
  const p = mount(); p.button('编辑').props.onClick();
  const form = nodes(p.render()).find(node => node.tag === 'form');
  assert.ok(nodes(form).some(node => node.tag === 'label' && text(node) === '参考音频'));
  assert.ok(nodes(form).some(node => node.tag === 'button' && text(node) === '生成克隆试听'));
  assert.equal(p.button('保存语音配置'), undefined);
  assert.equal(p.field('参考音频').props.readOnly, true);
  p.button('选择文件').props.onClick(); await flush();
  p.field('参考音频中的原话').props.onChange({ target: { value: '编辑后的角色原话' } });
  p.button('生成克隆试听').props.onClick(); await flush();
  assert.equal(p.calls.find(call => call.name === 'component_tts_preview').args.tts.ref_audio, 'G:\\声音\\角色参考.wav');
  assert.equal(nodes(p.render()).find(node => node.tag === 'audio').props.src, 'data:audio/wav;base64,role');
  assert.equal(p.saves.length, 0); assert.equal(p.storageWrites.length, 0);
  nodes(p.render()).find(node => node.tag === 'form').props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(p.saves[0].config.referenceVoice.ref_text, '编辑后的角色原话');
  assert.equal(p.library().profiles[0].config.referenceVoice.ref_audio, 'G:\\声音\\角色参考.wav');
  assert.equal(p.library().profiles[1].config.referenceVoice.ref_audio, 'second.wav');
  p.button('编辑').props.onClick();
  assert.equal(p.field('参考音频').props.value, 'G:\\声音\\角色参考.wav');
  p.close();
});

test('cancel does not persist role voice edits and changing audition text discards pending audio', async () => {
  let finish;
  const p = mount(() => new Promise(resolve => { finish = resolve; }));
  p.button('编辑').props.onClick(); p.render();
  p.button('生成克隆试听').props.onClick(); await flush();
  p.field('试听文本').props.onChange({ target: { value: '另一段试听文本' } }); p.render();
  finish({ audio_url: 'data:audio/wav;base64,old', file_name: '试听-old.wav' }); await flush();
  assert.equal(nodes(p.render()).some(node => node.tag === 'audio'), false);
  p.button('取消').props.onClick();
  assert.equal(p.saves.length, 0); assert.equal(p.library().profiles[0].config.referenceVoice.ref_audio, 'first.wav');
  p.close();
});

test('cancelling file selection preserves the current reference and picker failures remain visible', async () => {
  let result = null;
  const p = mount(undefined, undefined, async () => { if (result instanceof Error) throw result.message; return result; });
  p.button('编辑').props.onClick(); p.render();
  p.button('选择文件').props.onClick(); await flush();
  assert.equal(p.field('参考音频').props.value, 'first.wav');
  result = new Error('所选音频文件不存在，请重新选择');
  p.button('选择文件').props.onClick(); await flush();
  assert.ok(text(p.render()).includes(result.message));
  assert.equal(p.field('参考音频').props.value, 'first.wav');
  p.close();
});

test('late file picker result cannot edit a role after leaving its page', async () => {
  let finish;
  const p = mount(undefined, undefined, () => new Promise(resolve => { finish = resolve; }));
  p.button('编辑').props.onClick(); p.render();
  p.button('选择文件').props.onClick(); await flush();
  p.setActive(false); p.render();
  finish('G:\\另一角色.wav'); await flush();
  p.setActive(true);
  assert.equal(p.field('参考音频').props.value, 'first.wav');
  p.close();
});

test('generated audio folder opens from the button beside role audition without submitting the avatar form', async () => {
  const p = mount(); p.button('编辑').props.onClick();
  const row = nodes(p.render()).find(node => node.tag === 'div' && node.props.className === 'button-row' && nodes(node).some(child => child.tag === 'button' && text(child) === '生成克隆试听'));
  assert.ok(nodes(row).some(node => node.tag === 'button' && text(node) === '打开生成文件夹'));
  assert.equal(p.button('打开生成文件夹').props.type, 'button');
  p.button('打开生成文件夹').props.onClick(); await flush();
  assert.equal(p.calls.filter(call => call.name === 'component_tts_open_preview_folder').length, 1);
  assert.equal(p.calls.find(call => call.name === 'component_tts_open_preview_folder').args.fileName, null);
  p.button('生成克隆试听').props.onClick(); await flush();
  assert.ok(text(p.render()).includes('已保存：试听-role.wav'));
  p.button('打开生成文件夹').props.onClick(); await flush();
  assert.equal(p.calls.filter(call => call.name === 'component_tts_open_preview_folder').at(-1).args.fileName, '试听-role.wav');
  assert.equal(p.saves.length, 0);
  p.close();
});

test('opening a removed preview reports the file error in the role editor', async () => {
  const p = mount(undefined, async () => { throw '试听文件不存在，请重新生成试听'; });
  p.button('编辑').props.onClick(); p.render();
  p.button('生成克隆试听').props.onClick(); await flush();
  p.button('打开生成文件夹').props.onClick(); await flush();
  assert.ok(text(p.render()).includes('试听文件不存在，请重新生成试听'));
  p.close();
});

test('selecting audio uses FunASR to fill its transcript and saves both fields with the role', async () => {
  let finish;
  const p = mount(undefined, undefined, undefined, () => new Promise(resolve => { finish = resolve; }));
  p.button('编辑').props.onClick(); p.render();
  p.button('选择文件').props.onClick(); await flush();
  assert.equal(p.field('参考音频中的原话').props.value, '');
  assert.equal(p.button('保存数字人').props.disabled, true);
  assert.equal(p.button('生成克隆试听').props.disabled, true);
  const call = p.calls.find(call => call.name === 'component_transcribe_reference_audio');
  assert.equal(call.args.tts.ref_audio, 'G:\\声音\\角色参考.wav');
  assert.equal(call.args.tts.ref_text, '');
  finish('你好，欢迎来到直播间。'); await flush();
  assert.equal(p.field('参考音频中的原话').props.value, '你好，欢迎来到直播间。');
  assert.equal(p.button('保存数字人').props.disabled, false);
  nodes(p.render()).find(node => node.tag === 'form').props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(p.saves[0].config.referenceVoice.ref_text, '你好，欢迎来到直播间。');
  assert.equal(p.library().profiles[1].config.referenceVoice.ref_text, '第二位原话');
  p.close();
});

test('late FunASR output never overwrites manual corrections', async () => {
  let finish;
  const p = mount(undefined, undefined, undefined, () => new Promise(resolve => { finish = resolve; }));
  p.button('编辑').props.onClick(); p.render();
  p.button('选择文件').props.onClick(); await flush(); p.render();
  p.field('参考音频中的原话').props.onChange({ target: { value: '我手动校对的原话' } }); p.render();
  finish('迟到的识别结果'); await flush();
  assert.equal(p.field('参考音频中的原话').props.value, '我手动校对的原话');
  assert.equal(p.button('保存数字人').props.disabled, false);
  p.close();
});

test('changing audio discards old recognition and a failed request can be retried', async () => {
  let selected = 'G:\\one.wav', first, attempt = 0;
  const p = mount(undefined, undefined, async () => selected, async () => {
    attempt++;
    if (attempt === 1) return new Promise(resolve => { first = resolve; });
    if (attempt === 2) throw '请先启动 FunASR / OmniVoice 本机服务';
    return '第二段录音的原话';
  });
  p.button('编辑').props.onClick(); p.render();
  p.button('选择文件').props.onClick(); await flush(); p.render();
  selected = 'G:\\two.wav'; p.button('选择文件').props.onClick(); await flush();
  assert.ok(text(p.render()).includes('请先启动 FunASR'));
  p.button('FunASR 识别原话').props.onClick(); await flush();
  first('第一段录音的迟到结果'); await flush();
  assert.equal(p.field('参考音频').props.value, selected);
  assert.equal(p.field('参考音频中的原话').props.value, '第二段录音的原话');
  p.close();
});
