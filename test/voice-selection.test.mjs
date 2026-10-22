import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(path, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, ...globals });
  return exports;
}
const catalog = compile('src/voiceCatalog.ts');
const { normalizeStoredVoice, validateVoiceSelection, qwenClonedVoices } = compile('src/voiceSelection.ts', { require: () => catalog });

function mount(overrides = {}) {
  const selections = [], changes = [];
  const requests = [];
  let cloneVisits = 0, refreshes = 0;
  let cursor = 0;
  const values = [];
  const props = { source: 'builtin', voice: 'Tina', provider: 'qwen_omni', region: 'cn', clonedVoices: [], loading: false, error: '',
    onSelect: (...args) => selections.push(args), onSource: value => changes.push(value), cloneProvider: () => 'qwen_omni',
    onClone: () => cloneVisits++, onRefresh: () => refreshes++, ...overrides };
  const modules = {
    react: { useState: initial => { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; } },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '../voiceCatalog': catalog,
    '@tauri-apps/api/core': { isTauri: () => true, invoke: async (name, args) => { requests.push({ name, args }); if (overrides.openError) throw Error(overrides.openError); } },
  };
  const { VoiceSelector } = compile('src/ui/VoiceSelector.tsx', { require: name => modules[name] });
  return { render: () => { cursor = 0; return VoiceSelector(props); }, selections, changes, requests, visits: () => cloneVisits, refreshes: () => refreshes };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const options = tree => nodes(tree).filter(node => node.tag === 'button' && node.props.className?.includes('voice-catalog-option'));

test('only official Qwen Omni realtime voices appear and select the exact API voice ID', () => {
  const voices = catalog.builtinVoices;
  assert.equal(new Set(voices.map(voice => `${voice.provider}:${voice.id}`)).size, voices.length);
  const p = mount();
  assert.ok(voices.every(voice => voice.provider === 'qwen_omni'));
  assert.equal(nodes(p.render()).filter(node => node.tag === 'select').length, 1);
  assert.ok(!JSON.stringify(p.render()).includes('豆包'));
  assert.ok(voices.length > 0);
  assert.ok(voices.some(voice => voice.id === 'Liora Mira'));
  assert.equal(options(p.render()).length, voices.filter(voice => voice.provider === 'qwen_omni').length);
  nodes(p.render()).find(node => node.tag === 'input').props.onChange({ target: { value: '甜甜' } });
  const option = options(p.render()).find(node => node.props.children[0].props.children === '甜甜 Tina');
  assert.ok(option);
  option.props.onClick();
  assert.deepEqual(p.selections[0], ['Tina', 'qwen_omni', 'builtin']);
});

test('Qwen realtime voices work in both API regions and reject mismatched providers', () => {
  for (const region of ['cn', 'global']) {
    const p = mount({ region });
    assert.ok(options(p.render()).every(option => !option.props.disabled));
    assert.doesNotThrow(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'Tina', voiceProvider: 'qwen_omni', region }, []));
  }
  assert.throws(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'Tina', voiceProvider: 'doubao', region: 'cn' }, []), /qwen_omni/);
  assert.throws(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'zh_female_vv_uranus_bigtts', voiceProvider: 'qwen_omni', region: 'cn' }, []), /供应商/);
});

test('clone selection only exposes successfully created voices, with links to clone and refresh', () => {
  const empty = mount({ source: 'clone' });
  assert.equal(options(empty.render()).length, 0);
  nodes(empty.render()).find(node => node.tag === 'button' && node.props.children === '前往音色克隆').props.onClick();
  assert.equal(empty.visits(), 1);
  assert.throws(() => validateVoiceSelection({ voiceSource: 'clone', voice: 'NotCreated', voiceProvider: 'qwen_omni', region: 'cn' }, []), /尚未创建或已删除/);
  const p = mount({ source: 'clone', clonedVoices: ['MyClone_01'] });
  options(p.render())[0].props.onClick();
  assert.deepEqual(p.selections[0], ['MyClone_01', 'qwen_omni', 'clone']);
  assert.doesNotThrow(() => validateVoiceSelection({ voiceSource: 'clone', voice: 'MyClone_01', voiceProvider: 'qwen_omni', region: 'cn' }, ['MyClone_01']));
});

test('official voice links invoke the desktop browser opener and prevent WebView popup navigation', async () => {
  const p = mount();
  let prevented = 0;
  for (const link of nodes(p.render()).filter(node => node.tag === 'a')) {
    link.props.onClick({ preventDefault: () => prevented++ });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1);
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].name, 'open_voice_document');
  assert.equal(p.requests[0].args.provider, 'ali');
});

test('a browser launch failure is visible beside the documentation links', async () => {
  const p = mount({ openError: 'No default browser' });
  nodes(p.render()).find(node => node.tag === 'a').props.onClick({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const alert = nodes(p.render()).find(node => node.props?.role === 'alert');
  assert.ok(alert.props.children.includes('No default browser'));
});

test('saved Qwen settings are preserved and Doubao or invalid settings migrate to Tina', () => {
  for (const voice of ['Cindy', 'Liora Mira']) {
    const saved = normalizeStoredVoice({ voice, voiceProvider: 'qwen_omni', voiceSource: 'builtin' });
    assert.equal(saved.voice, voice);
    assert.equal(saved.voiceProvider, 'qwen_omni');
  }
  for (const voiceSource of ['builtin', 'clone']) {
    const migrated = normalizeStoredVoice({ voice: 'OldDoubao', voiceProvider: 'doubao', voiceSource });
    assert.equal(migrated.voice, 'Tina');
    assert.equal(migrated.voiceProvider, 'qwen_omni');
    assert.equal(migrated.voiceSource, 'builtin');
  }
  assert.equal(normalizeStoredVoice({ voice: '', voiceProvider: 'qwen_omni', voiceSource: 'builtin' }).voice, 'Tina');
  assert.equal(normalizeStoredVoice({ voice: 'MyClone_01', voiceProvider: 'qwen_omni', voiceSource: 'clone' }).voice, 'MyClone_01');
});

test('legacy Doubao clones are excluded while API provider metadata takes precedence', () => {
  const p = mount({ source: 'clone', clonedVoices: ['OldDoubaoClone', 'MyQwenClone'], cloneProvider: voice => voice === 'MyQwenClone' ? 'qwen_omni' : 'doubao' });
  const list = options(p.render());
  assert.equal(list.length, 1);
  assert.equal(list[0].props.children[0].props.children, 'MyQwenClone');
  assert.deepEqual(Array.from(qwenClonedVoices([
    { voice: 'OldDoubaoClone' }, { voice: 'MyQwenClone', provider: 'qwen_omni' },
    { voice: 'ExplicitDoubao', provider: 'doubao' }, { voice: 'DefaultQwen' },
  ], voice => voice === 'OldDoubaoClone' ? 'doubao' : 'qwen_omni')), ['MyQwenClone', 'DefaultQwen']);
});

test('stored avatar cards migrate Doubao voices atomically without losing images or persona', async () => {
  const model = compile('src/avatarProfiles.ts');
  assert.equal(model.defaultAvatarConfig.voice, 'Tina');
  assert.equal(model.defaultAvatarConfig.voiceProvider, 'qwen_omni');
  let stored = {
    version: 1, activeId: 'one', profiles: [
      { id: 'one', name: '旧形象', image: { data: 'photo', name: 'avatar.png' }, config: { ...model.defaultAvatarConfig, persona: '保留人设', voice: 'OldDoubao', voiceProvider: 'doubao' } },
      { id: 'two', name: '千问形象', image: null, config: { ...model.defaultAvatarConfig, voice: 'Cindy' } },
    ],
  };
  let writes = 0;
  const indexedDB = { open: () => {
    const request = {};
    request.result = { close() {}, transaction: () => {
      const transaction = { objectStore: () => ({
        get: () => { const read = {}; queueMicrotask(() => { read.onsuccess({ target: { result: stored } }); transaction.oncomplete(); }); return read; },
        put: value => { stored = value; writes++; },
      }) };
      return transaction;
    } };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  const storage = compile('src/imageStorage.ts', { indexedDB, require: name => name === './avatarProfiles' ? model : { normalizeStoredVoice } });
  const loaded = await storage.loadAvatarLibrary(model.defaultAvatarConfig);
  assert.equal(loaded.profiles[0].config.voice, 'Tina');
  assert.equal(loaded.profiles[0].config.voiceProvider, 'qwen_omni');
  assert.equal(loaded.profiles[0].config.persona, '保留人设');
  assert.equal(loaded.profiles[0].image.data, 'photo');
  assert.equal(loaded.profiles[1].config.voice, 'Cindy');
  assert.equal(writes, 1);
  await storage.loadAvatarLibrary(model.defaultAvatarConfig);
  assert.equal(writes, 1);
});
