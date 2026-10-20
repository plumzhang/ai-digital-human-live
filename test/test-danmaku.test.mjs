import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/testDanmaku.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { parseTestDanmaku, defaultTestDanmaku } = exports;

test('default batch has exactly three viewers and requests model generation', () => {
  const batch = parseTestDanmaku(defaultTestDanmaku.replaceAll('\n', '\r\n'));
  assert.equal(batch.length, 3);
  assert.equal(batch[0].nickname, '小杰');
  assert.equal(batch[1].type, 'gift');
  assert.equal(batch[1].gift.name, '玫瑰');
  assert.equal(batch[1].gift.count, 5);
  assert.equal(batch[2].nickname, '小宇');
  assert.ok(batch.every(item => !item.result));
});

test('queue snapshot format preserves supplied speech and treats placeholders as pending', () => {
  const batch = parseTestDanmaku('[弹幕][小杰] 你好//小杰你好呀！\n[弹幕][阿豪] 累了//生成中\n[弹幕][小宇] 晚上好//');
  assert.equal(batch[0].result.speech, '小杰你好呀！');
  assert.equal(batch[0].content, '你好');
  assert.equal(batch[1].result, undefined);
  assert.equal(batch[2].result, undefined);
  const gifts = parseTestDanmaku('[礼物][小杰][小心心×10]//谢谢小杰的十个小心心！\n[礼物][阿豪][玫瑰×5]//生成中\n[礼物][小宇][棒棒糖×1]//等待生成');
  assert.equal(gifts[0].result.speech, '谢谢小杰的十个小心心！');
  assert.equal(gifts[0].gift.count, 10);
  assert.equal(gifts[1].result, undefined);
  assert.ok(gifts.every(item => item.type === 'gift' && item.gift.is_final));
});

test('invalid batch sizes and malformed entries fail before anything is imported', () => {
  assert.throws(() => parseTestDanmaku(''), /3/);
  assert.throws(() => parseTestDanmaku(`${defaultTestDanmaku}\n[弹幕][四] 多了//等待生成`), /3/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('[阿豪]', '[]')), /第 2 行/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('玫瑰×5', '玫瑰×0')), /第 2 行/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('玫瑰×5', '玫瑰×-1')), /第 2 行/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('玫瑰×5', '玫瑰×1.5')), /第 2 行/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('玫瑰×5', ' ×5')), /第 2 行/);
  assert.throws(() => parseTestDanmaku(defaultTestDanmaku.replace('//等待生成', '')), /第 1 行/);
});
