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
const { normalizeStoredVoice, validateVoiceSelection } = compile('src/voiceSelection.ts', { require: () => catalog });

function mount(overrides = {}) {
  const selections = [], changes = [];
  const requests = [];
  let cloneVisits = 0, refreshes = 0;
  let cursor = 0;
  const values = [];
  const props = { source: 'builtin', voice: 'zh_female_vv_uranus_bigtts', provider: 'doubao', region: 'cn', clonedVoices: [], loading: false, error: '',
    onSelect: (...args) => selections.push(args), onSource: value => changes.push(value), cloneProvider: () => 'doubao',
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

test('only Doubao voices appear and select the exact API voice ID', () => {
  const voices = catalog.builtinVoices;
  assert.equal(new Set(voices.map(voice => `${voice.provider}:${voice.id}`)).size, voices.length);
  const p = mount();
  assert.ok(voices.every(voice => voice.provider === 'doubao'));
  assert.equal(nodes(p.render()).filter(node => node.tag === 'select').length, 1);
  assert.ok(!JSON.stringify(p.render()).includes('千问'));
  assert.equal(options(p.render()).length, voices.filter(voice => voice.provider === 'doubao').length);
  nodes(p.render()).find(node => node.tag === 'input').props.onChange({ target: { value: 'Vivi' } });
  const option = options(p.render()).find(node => node.props.children[0].props.children === 'Vivi 2.0');
  assert.ok(option);
  option.props.onClick();
  assert.deepEqual(p.selections[0], ['zh_female_vv_uranus_bigtts', 'doubao', 'builtin']);
});

test('domestic Doubao voices cannot be selected for the global API region', () => {
  const p = mount({ provider: 'doubao', region: 'global' });
  assert.ok(options(p.render()).every(option => option.props.disabled));
  assert.throws(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'zh_female_vv_uranus_bigtts', voiceProvider: 'doubao', region: 'global' }, []), /中国区/);
  assert.throws(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'Tina', voiceProvider: 'doubao', region: 'cn' }, []), /供应商/);
});

test('clone selection only exposes successfully created voices, with links to clone and refresh', () => {
  const empty = mount({ source: 'clone' });
  assert.equal(options(empty.render()).length, 0);
  nodes(empty.render()).find(node => node.tag === 'button' && node.props.children === '前往音色克隆').props.onClick();
  assert.equal(empty.visits(), 1);
  assert.throws(() => validateVoiceSelection({ voiceSource: 'clone', voice: 'NotCreated', voiceProvider: 'doubao', region: 'cn' }, []), /尚未创建或已删除/);
  const p = mount({ source: 'clone', clonedVoices: ['MyClone_01'] });
  options(p.render())[0].props.onClick();
  assert.deepEqual(p.selections[0], ['MyClone_01', 'doubao', 'clone']);
  assert.doesNotThrow(() => validateVoiceSelection({ voiceSource: 'clone', voice: 'MyClone_01', voiceProvider: 'doubao', region: 'cn' }, ['MyClone_01']));
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
  assert.equal(p.requests[0].args.provider, 'doubao3');
});

test('a browser launch failure is visible beside the documentation links', async () => {
  const p = mount({ openError: 'No default browser' });
  nodes(p.render()).find(node => node.tag === 'a').props.onClick({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const alert = nodes(p.render()).find(node => node.props?.role === 'alert');
  assert.ok(alert.props.children.includes('No default browser'));
});

test('saved Cindy settings are cleared for reselection while existing Doubao settings are preserved', () => {
  const old = normalizeStoredVoice({ voice: 'Cindy', voiceProvider: 'qwen_omni', voiceSource: 'builtin' });
  assert.equal(old.voice, '');
  assert.equal(old.voiceProvider, 'doubao');
  assert.equal(old.voiceSource, 'builtin');
  assert.equal(normalizeStoredVoice({ voice: 'MyClone_01', voiceProvider: 'doubao', voiceSource: 'clone' }).voice, 'MyClone_01');
  assert.throws(() => validateVoiceSelection({ voiceSource: 'builtin', voice: 'Cindy', voiceProvider: 'qwen_omni', region: 'cn' }, []), /仅支持豆包/);
});

test('legacy non-Doubao clones are not offered as selectable voices', () => {
  const p = mount({ source: 'clone', clonedVoices: ['OldQwenClone', 'MyDoubaoClone'], cloneProvider: voice => voice === 'MyDoubaoClone' ? 'doubao' : 'qwen_omni' });
  const list = options(p.render());
  assert.equal(list.length, 1);
  assert.equal(list[0].props.children[0].props.children, 'MyDoubaoClone');
});
