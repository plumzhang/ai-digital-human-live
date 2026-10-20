import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/interactionQueue.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, structuredClone, crypto, Date, setTimeout, clearTimeout });
const { InteractionQueue, emptyQueue, normalizeInteraction } = exports;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = text => ({ speech: text, emotion: 'happy', segments: [] });

function setup(initial = emptyQueue(), persistError = false, extras = {}) {
  let now = 100_000;
  const jobs = new Map();
  const spoken = [];
  const saved = [];
  const errors = [];
  const engine = new InteractionQueue(initial, {
    persist: async state => { if (persistError) throw Error('disk full'); saved.push(structuredClone(state)); },
    generate: (task, history, diversity) => new Promise((resolve, reject) => jobs.set(task.event.event_id, { resolve, reject, task, history, diversity })),
    speak: async task => { spoken.push(task.event.event_id); },
    changed: () => {}, error: message => errors.push(message), now: () => now, ...extras,
  });
  const event = (id, type = 'chat', extra = {}) => ({ event_id: id, type, room_id: 'room', user_id: `user-${id}`, nickname: id, content: id, created_at: now, ...extra });
  const observe = async () => { engine.observeAudio(false, 'live'); engine.observeVideo('live'); await engine.tick(); await flush(); };
  return { engine, jobs, spoken, saved, errors, event, observe, advance: ms => { now += ms; }, now: () => now };
}

test('test batch is persisted in input order, retains supplied answers and does not expire while waiting', async () => {
  const p = setup();
  await p.engine.importTestBatch([
    { event: p.event('A'), result: reply('A supplied answer') },
    { event: p.event('B') },
    { event: p.event('C', 'gift', { content: '玫瑰×5', gift: { name: '玫瑰', count: 5, gift_id: '', combo_id: '', is_final: true } }), result: reply('C supplied answer') },
  ]);
  assert.equal(p.saved[0].tasks.length, 3);
  assert.equal(p.engine.snapshot().tasks.map(task => task.event.event_id).join(','), 'A,B,C');
  assert.equal(p.engine.snapshot().tasks[0].result.speech, 'A supplied answer');
  assert.equal(p.engine.snapshot().tasks[2].event.gift.count, 5);
  p.advance(31_000);
  await p.engine.setContext(true, 'live', true);
  await flush();
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.jobs.size, 1);
  assert.ok(p.jobs.has('B'));
  await p.observe(); p.advance(3500); await p.observe();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.finish('played', 'confirmed');
  await p.observe(); p.advance(3500); await p.observe();
  assert.deepEqual(p.spoken, ['A']);
  p.jobs.get('B').resolve(reply('B generated answer')); await flush();
  assert.deepEqual(p.spoken, ['A', 'B']);
  await p.engine.finish('played', 'confirmed');
  await p.observe(); p.advance(3500); await p.observe();
  assert.deepEqual(p.spoken, ['A', 'B', 'C']);
  p.engine.dispose();
});

test('test import never overwrites existing tasks or pending gifts and rejects invalid sizes', async () => {
  const p = setup();
  const batch = ['A', 'B', 'C'].map(id => ({ event: p.event(id) }));
  await assert.rejects(p.engine.importTestBatch(batch.slice(0, 2)), /3/);
  await p.engine.ingest(p.event('existing'));
  await assert.rejects(p.engine.importTestBatch(batch), /待处理任务/);
  assert.equal(p.engine.snapshot().candidates[0].event_id, 'existing');
  assert.equal(p.errors.length, 0);
  await p.engine.setContext(true, 'live', true);
  assert.ok(p.jobs.has('existing'));
  p.engine.dispose();
  const g = setup();
  await g.engine.ingest(g.event('gift', 'gift', { gift: { name: '玫瑰', count: 1, gift_id: 'rose', combo_id: '1', is_final: false } }));
  await assert.rejects(g.engine.importTestBatch(batch), /待处理任务/);
  assert.equal(Object.keys(g.engine.snapshot().combos).length, 1);
  g.engine.dispose();
});

test('three slots include current speech, only two generations run, and out-of-order results never reorder playback', async () => {
  const p = setup();
  await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.jobs.size, 2);
  p.jobs.get('B').resolve(reply('B answer')); await flush();
  assert.ok(p.jobs.has('C'));
  p.jobs.get('C').resolve(reply('C answer')); await flush();
  await p.observe(); p.advance(4000); await p.observe();
  assert.equal(p.spoken.length, 0);
  p.jobs.get('A').resolve(reply('A answer')); await flush();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.ingest(p.event('D'));
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.engine.snapshot().candidates.length, 1);
  await p.engine.finish('played', 'test confirmation');
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.ok(p.jobs.has('D'));
  p.advance(3500); await p.observe();
  assert.deepEqual(p.spoken, ['A', 'B']);
  p.engine.dispose();
});

test('concurrent replies use different opening styles and later generations avoid anonymized recent openings', async () => {
  const p = setup();
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id) })));
  await p.engine.setContext(true, 'live', true);
  assert.notEqual(p.jobs.get('A').diversity.openingStyle, p.jobs.get('B').diversity.openingStyle);
  assert.equal(p.saved.at(-1).next_opening_style >= 2, true);
  p.jobs.get('A').resolve(reply('A，今天能来聊聊天就很好。')); await flush();
  const context = p.jobs.get('C').diversity;
  assert.notEqual(context.openingStyle, p.jobs.get('B').diversity.openingStyle);
  assert.ok(context.recentOpenings[0].startsWith('观众，'));
  assert.equal(context.recentOpenings[0].includes('A'), false);
  // Stylistic fragments do not become another viewer's conversation history.
  assert.equal(p.jobs.get('C').history.length, 0);
  p.engine.dispose();
});

test('gift gestures submit once after speech and a gesture failure does not replay or pause the spoken reply', async () => {
  for (const fails of [false, true]) {
    const actions = [];
    const p = setup(emptyQueue(), false, { act: async (task, liveId) => {
      assert.deepEqual(p.spoken, ['gift']);
      actions.push([task.event.event_id, liveId]);
      if (fails) throw Error('gesture unavailable');
    } });
    const gift = p.event('gift', 'gift', { content: '玫瑰×5', gift: { name: '玫瑰', count: 5, is_final: true } });
    await p.engine.importTestBatch([{ event: gift, result: reply('谢谢你的玫瑰！') }, ...['A', 'B'].map(id => ({ event: p.event(id), result: reply(id) }))]);
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].action_state, fails ? 'failed' : 'submitted');
    for (let i = 0; i < 3; i++) await p.engine.tick();
    assert.equal(actions.length, 1);
    assert.equal(p.errors.length, 0);
    p.engine.observeVad({ speaking: true, ended: false, healthy: true }, 'live');
    p.advance(900); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
    await p.engine.tick();
    assert.deepEqual(p.spoken, ['gift', 'A']);
    assert.equal(actions.length, 1);
    p.engine.dispose();
  }
});

test('a delayed speech submission cannot trigger a gift action after interruption', async () => {
  let resolveSpeech;
  let actions = 0;
  const p = setup(emptyQueue(), false, {
    speak: () => new Promise(resolve => { resolveSpeech = resolve; }),
    act: async () => { actions++; },
  });
  await p.engine.importTestBatch([
    { event: p.event('gift', 'gift', { gift: { name: '玫瑰', count: 1, is_final: true } }), result: reply('谢谢') },
    ...['A', 'B'].map(id => ({ event: p.event(id), result: reply(id) })),
  ]);
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  const dispatch = p.engine.tick(); await flush();
  await p.engine.finish('skipped', 'interrupted');
  resolveSpeech(); await dispatch;
  assert.equal(actions, 0);
  p.engine.dispose();
});

test('ready replies can be regenerated without replaying another task or keeping an old gesture', async () => {
  const p = setup();
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(`old ${id}`) })));
  const id = p.engine.snapshot().tasks[1].id;
  await p.engine.retry(id);
  assert.equal(p.engine.snapshot().tasks[1].status, 'pending');
  assert.equal(p.engine.snapshot().tasks[1].result, undefined);
  await p.engine.setContext(true, 'live', true);
  assert.deepEqual([...p.jobs.keys()], ['B']);
  p.jobs.get('B').resolve(reply('a fresh reply')); await flush();
  assert.equal(p.engine.snapshot().tasks[1].result.speech, 'a fresh reply');
  assert.equal(p.engine.snapshot().tasks[0].result.speech, 'old A');
  p.engine.dispose();
});

test('gift combo cumulative reports merge once and displace only unplayed chat', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  p.jobs.get('A').resolve(reply('A')); p.jobs.get('B').resolve(reply('B')); await flush();
  await p.observe(); p.advance(3500); await p.observe();
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  const gift = count => ({ name: '玫瑰', count, gift_id: 'rose', combo_id: 'combo1', is_final: count === 10 });
  for (const count of [1, 5, 10]) await p.engine.ingest(p.event(`gift-${count}`, 'gift', { user_id: 'giver', gift: gift(count), content: `玫瑰×${count}` }));
  let snapshot = p.engine.snapshot();
  assert.equal(snapshot.tasks.length, 3);
  assert.equal(snapshot.tasks[0].event.event_id, 'A');
  assert.equal(snapshot.tasks[1].event.type, 'gift');
  assert.equal(snapshot.tasks[1].event.gift.count, 10);
  assert.ok(snapshot.history.some(entry => entry.reason === '为礼物优先任务让位'));
  await p.engine.ingest(p.event('repeat-final', 'gift', { user_id: 'giver', gift: gift(10) }));
  snapshot = p.engine.snapshot();
  assert.equal(snapshot.tasks.filter(task => task.event.type === 'gift').length, 1);
  p.engine.dispose();
});

test('generation results for preempted tasks are ignored and cannot exceed concurrency two', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  await p.engine.skip(p.engine.snapshot().tasks[0].id);
  p.jobs.get('A').resolve(reply('old')); await flush();
  assert.ok(!p.engine.snapshot().tasks.some(task => task.result?.speech === 'old'));
  assert.ok(p.engine.snapshot().tasks.filter(task => task.status === 'generating').length <= 2);
  p.engine.dispose();
});

test('chat expires after 30 seconds but pending gifts remain durable', async () => {
  const p = setup();
  await p.engine.ingest(p.event('chat'));
  await p.engine.ingest(p.event('gift', 'gift', { gift: { name: '礼物', count: 1, gift_id: 'g', combo_id: 'c', is_final: true } }));
  p.advance(31_000); await p.engine.tick();
  assert.equal(p.engine.snapshot().candidates.length, 1);
  assert.equal(p.engine.snapshot().candidates[0].type, 'gift');
  p.engine.dispose();
});

test('without playback evidence a spoken task is retained as uncertain instead of consumed by a timeout', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  await p.engine.ingest(p.event('A')); p.jobs.get('A').resolve(reply('A')); await flush();
  await p.observe(); p.advance(3500); await p.observe();
  p.advance(61_000); await p.engine.tick();
  assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  assert.equal(p.engine.snapshot().history.length, 0);
  await p.engine.finish('played', 'operator confirmation');
  assert.equal(p.engine.snapshot().history[0].outcome, 'played');
  p.engine.dispose();
});

test('silence completion requires observed speech and continuing audio/video callbacks', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  await p.engine.ingest(p.event('A')); p.jobs.get('A').resolve(reply('A')); await flush();
  await p.observe(); p.advance(3500); await p.observe();
  p.engine.observeAudio(true, 'live'); p.advance(4500); await p.observe();
  assert.equal(p.engine.snapshot().tasks.length, 0);
  assert.equal(p.engine.snapshot().history[0].outcome, 'played');
  p.engine.dispose();
});

test('ready speech follows after one 1.5 second silence window, without a second cooldown or four-second floor', async () => {
  const p = setup();
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  await p.observe(); p.advance(1500); await p.observe();
  assert.deepEqual(p.spoken, ['A']);
  p.engine.observeAudio(true, 'live');
  p.advance(1000); await p.observe();
  assert.deepEqual(p.spoken, ['A']);
  // A short pause in a sentence must not release the slot.
  p.engine.observeAudio(true, 'live');
  p.advance(500); await p.observe();
  p.advance(500); await p.observe();
  assert.deepEqual(p.spoken, ['A']);
  p.advance(500); await p.observe();
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.equal(p.engine.snapshot().history.length, 1);
  p.engine.observeAudio(true, 'live');
  p.advance(500); await p.observe();
  p.advance(500); await p.observe();
  p.advance(500); await p.observe();
  assert.deepEqual(p.spoken, ['A', 'B', 'C']);
  p.engine.dispose();
});

test('silence cannot complete speech while audio or video callbacks are stale', async () => {
  for (const missing of ['audio', 'video']) {
    const p = setup();
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
    await p.engine.setContext(true, 'live', true);
    await p.observe(); p.advance(1500); await p.observe();
    p.engine.observeAudio(true, 'live');
    p.advance(2100);
    if (missing === 'audio') p.engine.observeVideo('live');
    else p.engine.observeAudio(false, 'live');
    await p.engine.tick();
    assert.deepEqual(p.spoken, ['A']);
    assert.equal(p.engine.snapshot().history.length, 0);
    p.engine.dispose();
  }
});

test('PCM VAD end immediately advances only the task that actually spoke', async () => {
  const p = setup();
  const vad = (speaking, ended = false, healthy = true, live = 'live', at = p.now()) => p.engine.observeVad({ speaking, ended, healthy }, live, at);
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); vad(false); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  vad(false, true); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  vad(true); p.advance(900); p.engine.observeVideo('live'); vad(false, true);
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.equal(p.engine.snapshot().history[0].outcome, 'played');
  // A repeated end cannot consume B before B has spoken.
  vad(false, true); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B']);
  vad(true); p.advance(900); p.engine.observeVideo('live'); vad(false, true);
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B', 'C']);
  p.engine.dispose();
});

test('PCM VAD never falls back to a silence timer or consumes interrupted, foreign or delayed activity', async () => {
  const p = setup();
  const vad = (speaking, ended = false, healthy = true, live = 'live', at = p.now()) => p.engine.observeVad({ speaking, ended, healthy }, live, at);
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); vad(false); await p.engine.tick();
  vad(true);
  p.advance(5000); p.engine.observeVideo('live'); vad(false); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  vad(false, true, true, 'old');
  vad(false, true, true, 'live', p.now() - 1000);
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  vad(false, false, false); vad(false, true); await p.engine.tick();
  assert.equal(p.engine.snapshot().history.length, 0);
  assert.deepEqual(p.spoken, ['A']);
  p.engine.dispose();
});

test('crash recovery does not replay a possibly spoken gift', async () => {
  const initial = emptyQueue();
  initial.tasks = [{ id: 'task1', event: { event_id: 'gift', type: 'gift' }, status: 'playing', result: reply('谢谢') }];
  const p = setup(initial); await p.engine.restore(); await p.engine.setContext(true, 'new-live', true);
  assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  assert.equal(p.spoken.length, 0);
  p.engine.dispose();
});

test('failed persistence prevents generation and playback', async () => {
  const p = setup(emptyQueue(), true); await p.engine.setContext(true, 'live', true);
  await assert.rejects(p.engine.ingest(p.event('A')), /disk full/);
  assert.equal(p.jobs.size, 0);
  assert.equal(p.spoken.length, 0);
  assert.ok(p.errors[0].includes('存储失败'));
  p.engine.dispose();
});

test('collector gift fields normalize group ID, cumulative count, and finish flag', () => {
  const event = normalizeInteraction({ id: '1', type: 'gift', roomId: 'room', ts: 100000, user: { id: 'user', nickname: '小杰' }, data: { giftName: '小心心', giftId: 'heart', groupId: 'combo', repeatCount: 10, repeatEnd: true } }, 100000);
  assert.equal(event.gift.count, 10);
  assert.equal(event.gift.combo_id, 'combo');
  assert.equal(event.gift.is_final, true);
  assert.equal(event.content, '小心心×10');
});

test('gift reports without a group ID use the two-second merge window', async () => {
  const p = setup();
  const gift = count => ({ name: '心心', count, gift_id: 'heart', combo_id: '', is_final: false });
  await p.engine.ingest(p.event('g1', 'gift', { user_id: 'sender', gift: gift(2) }));
  p.advance(1000);
  await p.engine.ingest(p.event('g2', 'gift', { user_id: 'sender', gift: gift(10) }));
  assert.equal(p.engine.snapshot().candidates.length, 0);
  p.advance(2100); await p.engine.tick();
  assert.equal(p.engine.snapshot().candidates.length, 1);
  assert.equal(p.engine.snapshot().candidates[0].gift.count, 10);
  const normalized = normalizeInteraction({ type: 'gift', data: { groupId: '0', giftName: '心心' } });
  assert.equal(normalized.gift.combo_id, '');
  p.engine.dispose();
});

test('cumulative updates may reuse the same event ID before the combo finishes', async () => {
  const p = setup();
  for (const count of [1, 5, 10]) {
    await p.engine.ingest(p.event('same-gift-message', 'gift', { gift: { name: '礼物', count, gift_id: 'g', combo_id: 'same-group', is_final: count === 10 } }));
  }
  assert.equal(p.engine.snapshot().candidates.length, 1);
  assert.equal(p.engine.snapshot().candidates[0].gift.count, 10);
  p.engine.dispose();
});

test('per-viewer history uses stable user IDs rather than shared nicknames', async () => {
  const initial = emptyQueue();
  initial.history = ['viewer-a', 'viewer-b'].map(id => ({ task: { id, event: { user_id: id, nickname: '同名观众', room_id: 'room', content: id }, result: reply(id) }, outcome: 'played', reason: 'test', at: 1 }));
  const p = setup(initial); await p.engine.setContext(true, 'live', true);
  await p.engine.ingest(p.event('new', 'chat', { user_id: 'viewer-a', nickname: '同名观众' }));
  assert.equal(p.jobs.get('new').history.length, 1);
  assert.equal(p.jobs.get('new').history[0].task.event.user_id, 'viewer-a');
  p.engine.dispose();
});

test('failed model calls stay in their own slots until retried or skipped', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  await p.engine.ingest(p.event('A')); p.jobs.get('A').reject(Error('quota exceeded')); await flush();
  assert.equal(p.engine.snapshot().tasks[0].status, 'failed');
  assert.equal(p.spoken.length, 0);
  const id = p.engine.snapshot().tasks[0].id;
  await p.engine.retry(id);
  p.jobs.get('A').resolve(reply('retry succeeded')); await flush();
  assert.equal(p.engine.snapshot().tasks[0].status, 'ready');
  p.engine.dispose();
});
