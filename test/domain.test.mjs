import test from 'node:test';
import assert from 'node:assert/strict';
import { blockReason, parseDyhubEvent, selectQuestion } from '../src/domain.ts';

test('dyhub chat is normalized and non-chat events are ignored', () => {
  assert.equal(parseDyhubEvent(JSON.stringify({ type: 'gift', data: {} })), null);
  assert.deepEqual(parseDyhubEvent(JSON.stringify({ id: '42', type: 'chat', ts: 100, user: { nickname: '观众' }, data: { content: ' 你好 ' } })), {
    id: '42', ts: 100, nickname: '观众', content: '你好', blocked: null
  });
});

test('keyword and regex rules show the matching reason', () => {
  const rules = [
    { id: 'a', kind: 'keyword', value: '违规', enabled: true },
    { id: 'b', kind: 'regex', value: '^退款\\d+$', enabled: true }
  ];
  assert.equal(blockReason('这里有违规指令', rules), '命中关键词「违规」');
  assert.equal(blockReason('退款123', rules), '命中正则「^退款\\d+$」');
  assert.equal(blockReason('正常问题', rules), null);
});

test('random selection only considers the latest 20 eligible messages', () => {
  const pool = Array.from({ length: 30 }, (_, i) => ({ id: String(i), ts: i, nickname: '观众', content: String(i), blocked: null }));
  assert.equal(selectQuestion(pool, () => 0)?.id, '10');
  assert.equal(selectQuestion(pool, () => 0.999)?.id, '29');
  assert.equal(selectQuestion(pool.map(m => ({ ...m, blocked: '过滤' }))), null);
});
