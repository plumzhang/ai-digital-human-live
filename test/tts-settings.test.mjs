import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const small = 'k2-fsa/OmniVoice', large = small;
const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
const flush = () => new Promise(resolve => setImmediate(resolve));
function mount(query, model = small, active = true) {
  const values = [], refs = [], effects = [], timers = new Map(), listeners = new Map(), calls = [];
  const config = { base_url: 'http://127.0.0.1:8766', key: '', model, ref_audio: 'C:\\reference.wav', ref_text: '参考原话' };
  const storage = new Map([['speech-service-config-v1', JSON.stringify(config)]]);
  const localStorage = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) };
  let cursor = 0, refCursor = 0, effectCursor = 0, pending = [];
  const configExports = {}, exports = {};
  vm.runInNewContext(compile('src/ttsConfig.ts'), { exports: configExports, localStorage });
  const modules = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
      useRef(initial) { const i = refCursor++; return refs[i] ??= { current: initial }; },
      useEffect(effect, deps) { const i = effectCursor++; const previous = effects[i]; if (!previous || deps.some((v, j) => !Object.is(v, previous.deps[j]))) pending.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: effect() }; }); },
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '@tauri-apps/api/core': { invoke: async (name, args) => { calls.push({ name, args }); return query(name, args); } },
    '@tauri-apps/api/event': { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } },
    '../ttsConfig': configExports,
    './ReferenceVoiceFields': { ReferenceVoiceFields: function ReferenceVoiceFields() {} },
  };
  const windowListeners = new Map();
  const window = { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name), dispatchEvent: event => windowListeners.get(event.type)?.() };
  vm.runInNewContext(compile('src/ui/TtsSettings.tsx'), { exports, require: name => modules[name], localStorage, window, Event: class { constructor(type) { this.type = type; } }, setInterval: callback => { const key = Symbol(); timers.set(key, callback); return key; }, clearInterval: key => timers.delete(key) });
  const render = () => { cursor = refCursor = effectCursor = 0; pending = []; const result = exports.TtsSettings({ active }); pending.forEach(effect => effect()); return result; };
  return { render, calls, storage, timers, listeners, sync: () => window.dispatchEvent({ type: 'speech-config-updated' }), setActive: value => { active = value; }, close: () => effects.forEach(effect => effect.cleanup?.()) };
}
const ready = model => ({ state: 'ready', running_model: model, device: 'cuda', managed: true, installed_models: [small], acceleration: { flashinfer: true, cuda_graph: true, verified: true }, stt: { ready: true, model: "FunASR/Paraformer-zh" } });
const stopped = { state: 'stopped', installed_models: [small, large] };
const button = (p, label) => nodes(p.render()).find(node => node.tag === 'button' && text(node) === label);

test('OmniVoice displays actual acceleration and replaces a legacy service with the unified backend', async () => {
  let status = { ...ready(small), state: "error", running_model: "Legacy/Qwen" };
  const p = mount(async (name, args) => { if (name === 'component_local_status') return status; if (name === 'component_start_local') { status = ready(args.tts.model); return { ready: true, model: args.tts.model }; } }, large);
  p.render(); await flush();
  assert.ok(text(p.render()).includes('Legacy/Qwen'));
  assert.ok(text(p.render()).includes('FlashInfer：已验证启用'));
  assert.ok(text(p.render()).includes('FunASR：已就绪'));
  assert.equal(nodes(p.render()).filter(node => node.tag === 'option' && text(node).includes('已安装')).length, 1);
  button(p, '启动本机服务').props.onClick(); await flush();
  assert.equal(p.calls.find(call => call.name === 'component_start_local').args.tts.model, large);
  assert.equal(JSON.parse(p.storage.get('speech-service-config-v1')).model, large);
  assert.ok(text(p.render()).includes('FunASR / OmniVoice 已启动'));
  p.close();
});

test('closing TTS stays available during model loading and ignores the old start response', async () => {
  let rejectStart;
  const p = mount(async name => name === 'component_local_status' ? stopped : name === 'component_start_local' ? new Promise((_, reject) => { rejectStart = reject; }) : { state: 'stopped' });
  p.render(); await flush(); button(p, '启动本机服务').props.onClick(); await flush();
  assert.equal(button(p, '关闭本机服务').props.disabled, false);
  button(p, '关闭本机服务').props.onClick(); await flush();
  rejectStart('TTS 启动已取消'); await flush();
  const view = text(p.render()); assert.ok(view.includes('本机语音服务已关闭')); assert.ok(!view.includes('TTS 启动已取消'));
  assert.equal(button(p, '启动本机服务').props.disabled, false); p.close();
});

test('closing during preview clears output and does not replace the stop notice with a late error', async () => {
  let rejectPreview, status = ready(small);
  const p = mount(async name => {
    if (name === 'component_local_status') return status;
    if (name === 'component_tts_preview') return new Promise((_, reject) => { rejectPreview = reject; });
    if (name === 'component_stop_local') { status = stopped; return status; }
  });
  p.render(); await flush(); button(p, '生成克隆试听').props.onClick(); await flush();
  assert.equal(button(p, '关闭本机服务').props.disabled, false);
  button(p, '关闭本机服务').props.onClick(); await flush(); rejectPreview('connection closed'); await flush();
  assert.ok(text(p.render()).includes('本机语音服务已关闭')); assert.ok(!text(p.render()).includes('connection closed'));
  p.close();
});

test('hidden TTS settings do not poll and stopping a foreign service reports the backend error', async () => {
  const hidden = mount(async () => ready(small), small, false); hidden.render(); await flush(); assert.equal(hidden.calls.length, 0); assert.equal(hidden.timers.size, 0); hidden.close();
  const p = mount(async name => { if (name === 'component_stop_local') throw '端口程序不匹配'; return ready(small); });
  p.render(); await flush(); button(p, '关闭本机服务').props.onClick(); await flush();
  assert.ok(text(p.render()).includes('端口程序不匹配')); assert.ok(!text(p.render()).includes('进程及显存已释放'));
  p.close(); assert.equal(p.timers.size, 0);
});

const input = (p, label) => nodes(p.render()).find(node => node.tag === 'label' && text(node) === label)?.props.children;
const field = (p, label) => nodes(input(p, label)).find(node => node.tag === 'input' || node.tag === 'textarea');
const referenceFields = p => nodes(p.render()).find(node => node.tag?.name === 'ReferenceVoiceFields');

test('service test previews a draft reference without persisting it before save', async () => {
  const p = mount(async name => name === 'component_local_status' ? ready(small) : { audio_url: 'data:audio/wav;base64,preview', file_name: '试听-service.wav' });
  p.render(); await flush();
  assert.ok(text(p.render()).includes('语音服务测试'));
  referenceFields(p).props.onChange({ ref_audio: 'G:\\声音\\新音色.wav', ref_text: '新的参考原话' });
  field(p, '试听文本').props.onChange({ target: { value: '试听这段声音' } });
  button(p, '生成克隆试听').props.onClick(); await flush();
  const preview = p.calls.find(call => call.name === 'component_tts_preview');
  assert.equal(preview.args.tts.ref_audio, 'G:\\声音\\新音色.wav');
  assert.equal(preview.args.tts.ref_text, '新的参考原话');
  assert.equal(preview.args.text, '试听这段声音');
  assert.equal(nodes(p.render()).find(node => node.tag === 'audio').props.src, 'data:audio/wav;base64,preview');
  button(p, '打开生成文件夹').props.onClick(); await flush();
  assert.equal(p.calls.find(call => call.name === 'component_tts_open_preview_folder').args.fileName, '试听-service.wav');
  assert.equal(JSON.parse(p.storage.get('speech-service-config-v1')).ref_text, '参考原话');
  button(p, '保存语音配置').props.onClick();
  assert.equal(JSON.parse(p.storage.get('speech-service-config-v1')).ref_text, '新的参考原话');
  p.close();
});

test('shared voice changes synchronize mounted settings and discard an older pending preview', async () => {
  let finishPreview;
  const p = mount(async name => name === 'component_local_status' ? ready(small) : new Promise(resolve => { finishPreview = resolve; }));
  p.render(); await flush(); button(p, '生成克隆试听').props.onClick(); await flush();
  const next = { ...JSON.parse(p.storage.get('speech-service-config-v1')), ref_audio: 'G:\\changed.wav', ref_text: '已在另一页保存' };
  p.storage.set('speech-service-config-v1', JSON.stringify(next)); p.sync();
  assert.equal(referenceFields(p).props.voice.ref_audio, next.ref_audio);
  assert.equal(referenceFields(p).props.voice.ref_text, next.ref_text);
  finishPreview('data:audio/wav;base64,old'); await flush();
  assert.equal(nodes(p.render()).some(node => node.tag === 'audio'), false);
  p.close();
});
