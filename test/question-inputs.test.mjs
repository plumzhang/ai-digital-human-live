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
  const props = { question: '请挥挥手', dialogue: '今天过得怎么样', canSend: true, canInterrupt: true, onQuestionChange: value => changes.push(['text_msg', value]), onDialogueChange: value => changes.push(['text_dialog', value]), onSend: value => sent.push(value), onInterrupt: () => interrupted++, ...extra };
  const tree = nodes(api.QuestionInputs(props));
  return { inputs: tree.filter(node => node.tag === 'input'), buttons: tree.filter(node => node.tag === 'button'), sent, changes, interrupted: () => interrupted };
}

test('independent message and dialogue inputs keep separate contents and send the selected protocol', () => {
  const p = mount();
  assert.equal(p.inputs.length, 2);
  assert.equal(p.inputs[0].props.value, '请挥挥手'); assert.equal(p.inputs[1].props.value, '今天过得怎么样');
  p.inputs[0].props.onChange({ target: { value: '文本消息草稿' } });
  p.inputs[1].props.onChange({ target: { value: '文本对话草稿' } });
  assert.deepEqual(p.changes, [['text_msg', '文本消息草稿'], ['text_dialog', '文本对话草稿']]);
  p.buttons[0].props.onClick(); p.buttons[1].props.onClick(); p.buttons[2].props.onClick();
  assert.deepEqual(p.sent, ['text_msg', 'text_dialog']); assert.equal(p.interrupted(), 1);
});

test('Enter sends only the focused nonempty input and respects readiness and IME composition', () => {
  const key = composing => ({ key: 'Enter', nativeEvent: { isComposing: composing }, preventDefault() {} });
  const p = mount(); p.inputs[1].props.onKeyDown(key(true)); assert.equal(p.sent.length, 0);
  p.inputs[1].props.onKeyDown(key(false)); assert.deepEqual(p.sent, ['text_dialog']);
  for (const extra of [{ canSend: false }, { question: ' ', dialogue: ' ' }]) {
    const blocked = mount(extra);
    for (const input of blocked.inputs) input.props.onKeyDown(key(false));
    assert.equal(blocked.sent.length, 0);
    assert.ok(blocked.buttons.slice(0, 2).every(button => button.props.disabled));
  }
});
