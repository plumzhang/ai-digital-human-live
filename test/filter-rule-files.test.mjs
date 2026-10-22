import test from 'node:test';
import assert from 'node:assert/strict';
import { blockReason } from '../src/domain.ts';
import { mergeFilterRules, parseFilterRuleFile, serializeFilterRules } from '../src/filterRuleFiles.ts';

test('filter rule backups preserve types, regex escapes and disabled states with fresh identities on import', () => {
  const original = [
    { id: 'original-keyword', kind: 'keyword', value: '后空翻', enabled: false },
    { id: 'original-regex', kind: 'regex', value: '后\\s*空\\s*翻', enabled: true },
  ];
  const text = serializeFilterRules(original);
  assert.equal(text.includes('original-keyword'), false);
  const imported = parseFilterRuleFile('\uFEFF' + text);
  assert.deepEqual(imported.map(({ id, ...rule }) => rule), original.map(({ id, ...rule }) => rule));
  assert.equal(new Set(imported.map(rule => rule.id)).size, 2);
  assert.notEqual(imported[0].id, original[0].id);
  assert.equal(blockReason('来个后 空 翻', imported), '命中正则「后\\s*空\\s*翻」');
});

test('import merges without changing existing rule states and removes duplicates within the file', () => {
  const existing = [{ id: 'keep', kind: 'keyword', value: 'SPAM', enabled: false }];
  const imported = parseFilterRuleFile(JSON.stringify([
    { kind: 'keyword', value: 'spam', enabled: true },
    { kind: 'keyword', value: '后空翻' },
    { kind: 'keyword', value: '后空翻', enabled: false },
    { kind: 'regex', value: '后空翻', enabled: false },
    { kind: 'regex', value: '\\d' },
    { kind: 'regex', value: '\\D' },
  ]));
  const result = mergeFilterRules(existing, imported);
  assert.equal(result.added, 4); assert.equal(result.skipped, 2);
  assert.equal(result.rules[0], existing[0]); assert.equal(result.rules[0].enabled, false);
  assert.equal(existing.length, 1);
  assert.equal(result.rules[1].enabled, true);
  assert.equal(result.rules[2].kind, 'regex'); assert.equal(result.rules[2].enabled, false);
});

test('a malformed import is rejected entirely with the offending row identified', () => {
  const valid = { kind: 'keyword', value: '有效规则' };
  for (const invalid of [null, { kind: 'other', value: '错误' }, { kind: 'keyword', value: ' ' }, { kind: 'keyword', value: '错误', enabled: 'false' }, { kind: 'regex', value: '[' }]) {
    assert.throws(() => parseFilterRuleFile(JSON.stringify({ version: 1, rules: [valid, invalid] })), /第 2 条规则/);
  }
  assert.throws(() => parseFilterRuleFile('{broken'), /有效的 JSON/);
  assert.throws(() => parseFilterRuleFile('null'), /规则列表/);
  assert.throws(() => parseFilterRuleFile('{"version":2,"rules":[]}'), /版本/);
  assert.throws(() => parseFilterRuleFile('{"type":"another-file","rules":[]}'), /不是弹幕过滤规则/);
  assert.throws(() => parseFilterRuleFile(JSON.stringify(Array.from({ length: 10001 }, () => valid))), /10000/);
  assert.deepEqual(parseFilterRuleFile('{"rules":[]}'), []);
});
