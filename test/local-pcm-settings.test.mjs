import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function settings(storage = new Map()) {
  const exports = {};
  vm.runInNewContext(compile('src/localPcmSettings.ts'), { exports, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  return exports;
}
test('saved playback delay survives reopening and malformed values cannot enter the player', () => {
  const storage = new Map(), api = settings(storage);
  assert.equal(api.loadLocalPcmDelayMs(), 0);
  api.saveLocalPcmDelayMs(500);
  assert.equal(settings(storage).loadLocalPcmDelayMs(), 500);
  for (const value of [-1, 10001, 1.5, NaN, Infinity, '500', null]) {
    assert.throws(() => api.saveLocalPcmDelayMs(value), /0–10000/);
    assert.equal(api.loadLocalPcmDelayMs(), 500);
  }
  for (const value of ['{broken', '"500"', '-1', '10001', 'null']) {
    storage.set(api.LOCAL_PCM_DELAY_KEY, value); assert.equal(api.loadLocalPcmDelayMs(), 0);
  }
});
test('queue settings expose a millisecond input, save explicitly and reject empty or invalid input', () => {
  const storage = new Map(), api = settings(storage), values = [];
  let cursor = 0;
  const imports = {
    react: { useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], value => { values[i] = value; }]; } },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '../localPcmSettings': api,
  };
  const exports = {};
  vm.runInNewContext(compile('src/ui/LocalPcmSettings.tsx'), { exports, require: name => imports[name] });
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '');
  const render = () => { cursor = 0; return exports.LocalPcmSettings(); };
  const input = () => nodes(render()).find(node => node.tag === 'input');
  const save = () => nodes(render()).find(node => node.tag === 'button').props.onClick();
  assert.match(text(render()), /弹幕 PCM 播放延迟（毫秒）/);
  assert.equal(input().props.value, '0'); assert.equal(input().props.step, 1);
  input().props.onChange({ target: { value: '500' } }); assert.equal(api.loadLocalPcmDelayMs(), 0);
  save(); assert.equal(api.loadLocalPcmDelayMs(), 500); assert.match(text(render()), /下一条弹幕回复生效/);
  for (const value of ['', '-1', '10001', '1.5']) {
    input().props.onChange({ target: { value } }); save(); assert.equal(api.loadLocalPcmDelayMs(), 500);
    assert.match(text(render()), /请输入|需为0–10000/);
  }
  input().props.onChange({ target: { value: '0' } }); input().props.onKeyDown({ key: 'Enter' });
  assert.equal(api.loadLocalPcmDelayMs(), 0);
});
