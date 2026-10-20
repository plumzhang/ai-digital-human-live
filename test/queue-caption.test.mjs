import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/queueCaption.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { formatQueueCaption } = exports;

test('queue captions bind original viewer, event type and answer into two lines', () => {
  assert.equal(formatQueueCaption({ event: { type: 'chat', nickname: '小宇', content: '姐姐你有男朋友吗？' }, result: { speech: '先保密，留点神秘感。' } }),
    '[弹幕] 小宇: 姐姐你有男朋友吗？\n[回复] 先保密，留点神秘感。');
  assert.equal(formatQueueCaption({ event: { type: 'gift', nickname: '阿豪', content: '玫瑰×5' }, result: { speech: '谢谢阿豪的五朵玫瑰！', gesture: 'heart', segments: [{ action: '比心', text: '谢谢阿豪的五朵玫瑰！' }] }, action_state: 'submitted' }),
    '[礼物] 阿豪: 玫瑰×5\n[回复] 谢谢阿豪的五朵玫瑰！');
  assert.equal(formatQueueCaption(), '');
  assert.equal(formatQueueCaption({ event: {}, result: { speech: '  ' } }), '');
});
