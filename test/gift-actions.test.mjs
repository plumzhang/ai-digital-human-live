import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/giftActions.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { giftActionFor } = exports;

test('only gifts receive a gesture; legacy and imported answers have a stable fallback', () => {
  const task = { event: { event_id: 'gift-1', type: 'gift' }, result: { gesture: 'heart' } };
  assert.equal(giftActionFor(task).label, '比心');
  assert.equal(giftActionFor({ ...task, result: { gesture: 'kiss' } }).label, '亲吻手势');
  assert.equal(giftActionFor({ ...task, result: { gesture: 'flying_kiss' } }).label, '飞吻');
  const legacy = { ...task, result: {} };
  assert.equal(giftActionFor(legacy).kind, giftActionFor(legacy).kind);
  assert.equal(giftActionFor({ ...task, event: { ...task.event, type: 'chat' } }), null);
});
