import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/avatarOutput.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const { parseAvatarOutput, mergeAvatarText } = exports;

test('only nonempty type=10 output is accepted, retaining receipt time and optional correlation', () => {
  const frame = { type: 10, live_id: 'live', received_at: 1234, payload: { text_msg: { content: ' 实际回答 ', msg_id: 'out-1', reply_to: 'tts-task', is_final: false } } };
  const result = parseAvatarOutput(frame, 9999);
  assert.equal(result.text, '实际回答'); assert.equal(result.received_at, 1234);
  assert.equal(result.msg_id, 'out-1'); assert.equal(result.request_id, 'tts-task'); assert.equal(result.final, false);
  for (const extra of [{ type: 9 }, { type: 99 }, { live_id: '' }, { received_at: NaN }, { payload: { text_msg: { content: ' ' } } }]) assert.equal(parseAvatarOutput({ ...frame, ...extra }), null);
  assert.equal(parseAvatarOutput({ ...frame, received_at: undefined }, 9999).received_at, 9999);
});

test('output merging accepts cumulative, overlapping, repeated, and separate sentences', () => {
  let text = mergeAvatarText('', '你好');
  text = mergeAvatarText(text, '你好，宝子。'); assert.equal(text, '你好，宝子。');
  text = mergeAvatarText(text, '你好'); assert.equal(text, '你好，宝子。');
  text = mergeAvatarText(text, '宝子。'); assert.equal(text, '你好，宝子。');
  text = mergeAvatarText(text, '宝子。欢迎来看我扎马尾。'); assert.equal(text, '你好，宝子。欢迎来看我扎马尾。');
  text = mergeAvatarText(text, '现在扎好啦。'); assert.equal(text, '你好，宝子。欢迎来看我扎马尾。现在扎好啦。');
});

const ui = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ui/TaskDialogue.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: ui, require: name => { assert.equal(name, 'react/jsx-runtime'); return { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }), Fragment: 'fragment' }; } });
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'object' && node ? textOf(node.props.children) : node || '';
test('each slot labels the outgoing text as question and the actual output as answer', () => {
  const task = { status: 'playing', result: { speech: '宝子希望你扎个高马尾，请自然回应并配合动作。' }, answer: { text: '已经扎好了，宝子喜欢吗？' } };
  const view = textOf(ui.TaskDialogue({ task }));
  assert.equal(view, '问：宝子希望你扎个高马尾，请自然回应并配合动作。答：已经扎好了，宝子喜欢吗？');
  assert.match(textOf(ui.TaskDialogue({ task: { ...task, answer: undefined } })), /答：等待数字人返回回答/);
  assert.match(textOf(ui.TaskDialogue({ task: { ...task, status: 'uncertain', answer: undefined } })), /答：尚未收到此槽位的回答文本/);
});
