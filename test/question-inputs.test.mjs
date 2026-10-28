import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ui/QuestionInputs.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports: api, require: name => name === 'lucide-react' ? { Ban: 'Ban', Send: 'Send' } : { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }), Fragment: 'Fragment' } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props.children)] : [];
function mount(extra = {}) {
  const sent = [], changes = []; let interrupted = 0;
  const props = { question: '请挥挥手', canSend: true, canInterrupt: true, onQuestionChange: value => changes.push(value), onSend: () => sent.push('sent'), onInterrupt: () => interrupted++, ...extra };
  const tree = nodes(api.QuestionInputs(props));
  return { tree, inputs: tree.filter(node => node.tag === 'input'), buttons: tree.filter(node => node.tag === 'button'), sent, changes, interrupted: () => interrupted };
}

test('only the text message input is shown without protocol labels', () => {
  const p = mount();
  assert.equal(p.inputs.length, 1);
  assert.equal(p.inputs[0].props.value, '请挥挥手');
  p.inputs[0].props.onChange({ target: { value: '文本消息草稿' } });
  assert.deepEqual(p.changes, ['文本消息草稿']);
  p.buttons[0].props.onClick(); p.buttons[1].props.onClick();
  assert.deepEqual(p.sent, ['sent']); assert.equal(p.interrupted(), 1);
  const view = JSON.stringify(p.tree);
  assert.match(view, /文本消息/);
  assert.doesNotMatch(view, /text_msg|text_dialog|文本对话/);
});

test('Enter sends only the focused nonempty input and respects readiness and IME composition', () => {
  const key = composing => ({ key: 'Enter', nativeEvent: { isComposing: composing }, preventDefault() {} });
  const p = mount(); p.inputs[0].props.onKeyDown(key(true)); assert.equal(p.sent.length, 0);
  p.inputs[0].props.onKeyDown(key(false)); assert.deepEqual(p.sent, ['sent']);
  for (const extra of [{ canSend: false }, { question: ' ' }]) {
    const blocked = mount(extra);
    for (const input of blocked.inputs) input.props.onKeyDown(key(false));
    assert.equal(blocked.sent.length, 0);
    assert.ok(blocked.buttons.slice(0, 1).every(button => button.props.disabled));
  }
});
