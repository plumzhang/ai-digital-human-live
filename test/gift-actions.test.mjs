import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/giftActions.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { giftActionFor, avatarActionFor } = exports;

test('questions, chat and legacy answers use the default camera gaze instead of stray instructions', () => {
  for (const intent of ['question', 'chat', undefined]) {
    const action = avatarActionFor({ event: { type: 'chat' }, result: { intent, action_instruction: '微笑点头', gesture: 'heart' } });
    assert.equal(action.instruction, '目光注视前方，看向镜头。');
    assert.ok(action.label.includes('看向镜头'));
    assert.equal(action.kind, undefined);
  }
});

test('chat actions use the generated visual instruction without a gift fallback', () => {
  for (const instruction of ['双手在脑后扎起马尾', '拿起口红轻涂双唇', '拿起厨房菜刀，刀尖朝下']) {
    const task = { event: { type: 'chat' }, result: { intent: 'action_request', action_instruction: instruction, gesture: 'none' } };
    assert.equal(avatarActionFor(task).instruction, instruction);
    assert.equal(avatarActionFor(task).label, instruction);
    assert.equal(avatarActionFor(task).kind, undefined);
  }
  assert.equal(avatarActionFor({ event: { type: 'chat' }, result: { intent: 'action_request', action_instruction: '  ' } }), null);
  assert.equal(avatarActionFor({ event: { type: 'chat' }, result: { segments: [{ action: 'smile' }] } }).instruction, '目光注视前方，看向镜头。');
});

test('only gifts receive a gesture; legacy and imported answers have a stable fallback', () => {
  const task = { event: { event_id: 'gift-1', type: 'gift' }, result: { gesture: 'heart' } };
  assert.equal(giftActionFor(task).label, '比心');
  assert.equal(giftActionFor({ ...task, result: { gesture: 'kiss' } }).label, '亲吻手势');
  assert.equal(giftActionFor({ ...task, result: { gesture: 'flying_kiss' } }).label, '飞吻');
  const legacy = { ...task, result: {} };
  assert.equal(giftActionFor(legacy).kind, giftActionFor(legacy).kind);
  assert.equal(giftActionFor({ ...task, event: { ...task.event, type: 'chat' } }), null);
});
