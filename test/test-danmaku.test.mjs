import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/testDanmaku.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: name => { assert.equal(name, './interactionQueue'); return { INTERACTION_SLOT_COUNT: 3 }; } });
const { countTestDanmaku, parseTestDanmaku, defaultTestDanmaku } = exports;

test('default input has exactly one chat and requests model generation', () => {
  const [item] = parseTestDanmaku(defaultTestDanmaku);
  assert.equal(countTestDanmaku(defaultTestDanmaku), 1);
  assert.equal(item.nickname, '小杰');assert.equal(item.result, undefined);
});

test('single input preserves supplied speech and recognizes chat/gift placeholders', () => {
  const [item] = parseTestDanmaku('[弹幕][小杰] 你好//小杰你好呀！');
  assert.equal(item.result.speech, '小杰你好呀！');assert.equal(item.content, '你好');
  for (const suffix of ['生成中', '等待生成', '']) assert.equal(parseTestDanmaku('[弹幕][小宇] 晚上好//'+suffix)[0].result, undefined);
  const [gift] = parseTestDanmaku('[礼物][阿豪][玫瑰×5]//等待生成');
  assert.equal(gift.type, 'gift');assert.equal(gift.gift.name, '玫瑰');assert.equal(gift.gift.count, 5);assert.equal(gift.gift.is_final, true);
});

test('empty, multiple and malformed inputs are rejected before insertion', () => {
  assert.throws(() => parseTestDanmaku(''), /只能插入1条/);
  for (const count of [2, 3, 4]) assert.throws(() => parseTestDanmaku(Array(count).fill(defaultTestDanmaku).join('\n')), /只能插入1条/);
  for (const text of ['[弹幕][] 你好//等待生成', '[礼物][阿豪][玫瑰×0]//等待生成', '[礼物][阿豪][玫瑰×-1]//等待生成', '[礼物][阿豪][玫瑰×1.5]//等待生成', '[弹幕][小杰] 你好']) assert.throws(() => parseTestDanmaku(text), /第 1 行/);
});

test('blank lines around a single input do not count as extra interactions', () => {
  const parsed = parseTestDanmaku('\n\r\n'+defaultTestDanmaku+'\n\n');
  assert.equal(parsed.length, 1);assert.equal(countTestDanmaku('\n'+defaultTestDanmaku+'\n'), 1);
  assert.equal(countTestDanmaku(' \n\r\n'), 0);
});
