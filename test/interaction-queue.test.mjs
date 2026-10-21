import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const exports = {};
const actionsExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/giftActions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: actionsExports });
const { avatarActionFor } = actionsExports;
const recognitionExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/whisperRecognition.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recognitionExports, require: name => { assert.equal(name, 'pinyin-pro'); return pinyinPro; } });
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/interactionQueue.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, structuredClone, crypto, Date, setTimeout, clearTimeout, require: name => {
    if (name === './whisperRecognition') return recognitionExports;
    assert.equal(name, './giftActions');
    return actionsExports;
  } });
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
  await assert.rejects(p.engine.importTestBatch([]), /1～6/);
  await assert.rejects(p.engine.importTestBatch(Array.from({ length: 7 }, (_, i) => ({ event: p.event(`overflow-${i}`) }))), /1～6/);
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

test('one through six imported tasks keep input order, fit the slots and remain durable while waiting', async () => {
  for (let size = 1; size <= 6; size++) {
    const p = setup();
    const ids = Array.from({ length: size }, (_, i) => `task-${i + 1}`);
    await p.engine.importTestBatch(ids.map(id => ({ event: p.event(id), result: reply(id) })));
    assert.equal(p.saved[0].tasks.length, size);
    p.advance(31000); await p.engine.tick();
    const tasks = p.engine.snapshot().tasks;
    assert.deepEqual(tasks.map(task => task.event.event_id), ids);
    assert.ok(tasks.every(task => task.event.source === 'test'));
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live'); await p.engine.tick();
    assert.deepEqual(p.spoken, [ids[0]]);
    p.engine.dispose();
  }
});

test('six slots include current speech, a seventh waits, only two generations run, and out-of-order results never reorder playback', async () => {
  const p = setup();
  await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) await p.engine.ingest(p.event(id));
  assert.equal(p.engine.snapshot().tasks.length, 6);
  assert.equal(p.jobs.size, 2);
  p.jobs.get('B').resolve(reply('B answer')); await flush();
  for (const id of ['C', 'D', 'E', 'F']) {
    assert.ok(p.jobs.has(id));
    assert.equal(p.engine.snapshot().tasks.filter(task => task.status === 'generating').length, 2);
    p.jobs.get(id).resolve(reply(`${id} answer`)); await flush();
  }
  await p.observe(); p.advance(4000); await p.observe();
  assert.equal(p.spoken.length, 0);
  p.jobs.get('A').resolve(reply('A answer')); await flush();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.ingest(p.event('G'));
  assert.equal(p.engine.snapshot().tasks.length, 6);
  assert.equal(p.engine.snapshot().candidates.length, 1);
  assert.equal(p.engine.snapshot().candidates[0].event_id, 'G');
  assert.ok(!p.jobs.has('G'));
  await p.engine.finish('played', 'test confirmation');
  assert.equal(p.engine.snapshot().tasks.length, 6);
  assert.equal(p.engine.snapshot().candidates.length, 0);
  assert.ok(p.jobs.has('G'));
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

test('ordinary questions, chat and imported answers submit camera gaze once per reply', async () => {
  const actions = [];
  const p = setup(undefined, false, { act: async (task, liveId) => {
    assert.equal(p.spoken.at(-1), task.event.event_id);
    actions.push([task.event.event_id, avatarActionFor(task).instruction, liveId]);
  } });
  await p.engine.importTestBatch(['question', 'chat', undefined].map((intent, i) => ({
    event: p.event(`Q${i}`), result: { ...reply('自然聊天。'), intent, action_instruction: '微笑点头' },
  })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  for (let i = 0; i < 3; i++) {
    assert.equal(p.engine.snapshot().tasks[0].action_state, 'submitted');
    for (let j = 0; j < 3; j++) await p.engine.tick();
    assert.equal(actions.length, i + 1);
    await p.engine.finish('played', 'test completion');
    p.advance(1500);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
  }
  assert.deepEqual(actions, ['Q0', 'Q1', 'Q2'].map(id => [id, '目光注视前方，看向镜头。', 'live']));
  assert.deepEqual(p.spoken, ['Q0', 'Q1', 'Q2']);
  p.engine.dispose();
});

test('chat visual actions submit once alongside speech; failures do not replay speech', async () => {
  for (const fails of [false, true]) {
    const actions = [];
    const p = setup(undefined, false, { act: async (task, liveId) => {
      assert.deepEqual(p.spoken, ['A']);
      actions.push([task.result.action_instruction, liveId]);
      if (fails) throw Error('action unavailable');
    } });
    await p.engine.importTestBatch([
      { event: p.event('A'), result: { ...reply('这就扎起来。'), intent: 'action_request', action_instruction: '双手在脑后扎起马尾' } },
      ...['B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })),
    ]);
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].action_state, fails ? 'failed' : 'submitted');
    for (let i = 0; i < 3; i++) await p.engine.tick();
    assert.equal(actions.length, 1);
    assert.deepEqual(p.spoken, ['A']);
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

test('AI closure archives interrupted speech without replay and resumes only unplayed tasks on the new live', async () => {
  const actions = [];
  const p = setup(undefined, false, { act: async task => { actions.push(task.id); } });
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.disconnectSession('live', 'ai_output_closed：播放完成情况未知，未重播');
  assert.equal(p.engine.snapshot().history[0].outcome, 'failed');
  assert.equal(p.engine.snapshot().history[0].task.event.event_id, 'A');
  assert.deepEqual(p.engine.snapshot().tasks.map(task => task.event.event_id), ['B', 'C']);
  p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.setContext(true, 'new-live', true);
  p.engine.observeVideo('new-live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'new-live');
  p.advance(1500);
  p.engine.observeVideo('new-live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'new-live');
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.deepEqual(actions, [p.engine.snapshot().history[0].task.id, p.engine.snapshot().tasks[0].id]);
  p.engine.dispose();
});

test('disconnect during speech submission prevents delayed actions on the old live', async () => {
  let release;
  let actions = 0;
  const p = setup(undefined, false, {
    speak: () => new Promise(resolve => { release = resolve; }),
    act: async () => { actions++; },
  });
  await p.engine.importTestBatch([
    { event: p.event('A'), result: { ...reply('扎起来。'), intent: 'action_request', action_instruction: '扎马尾' } },
    ...['B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })),
  ]);
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  const dispatch = p.engine.tick(); await flush();
  await p.engine.disconnectSession('live', 'ai_output_closed');
  release(); await dispatch;
  assert.equal(actions, 0);
  assert.equal(p.engine.snapshot().history[0].outcome, 'failed');
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

test('handoff directions persist and submit exactly once between completed speech and the next reply', async () => {
  for (const direction of ['left_down', 'right_down']) {
    const order = [];
    let release;
    const p = setup(emptyQueue(), false, {
      speak: async task => { order.push(`speech:${task.event.event_id}`); },
      handoff: async (task, liveId, selected) => {
        assert.equal(liveId, 'live'); assert.equal(selected, direction);
        order.push(`handoff:${task.event.event_id}`);
        await new Promise(resolve => { release = resolve; });
      },
    });
    await p.engine.configureHandoff(true, direction);
    assert.equal(p.saved.at(-1).handoff.direction, direction);
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    p.engine.observeVad({ speaking: true, ended: false, healthy: true }, 'live');
    p.advance(900); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
    const end = p.engine.tick(); await flush();
    assert.deepEqual(order, ['speech:A', 'handoff:A']);
    assert.equal(p.engine.snapshot().handoff_action.status, 'pending');
    // More heartbeat/end events cannot overtake or duplicate the handoff.
    await p.engine.tick(); await p.engine.finish('played', 'duplicate end');
    assert.deepEqual(order, ['speech:A', 'handoff:A']);
    release(); await end;
    assert.deepEqual(order, ['speech:A', 'handoff:A']);
    assert.equal(p.engine.snapshot().handoff_action.status, 'submitted');
    assert.equal(p.engine.snapshot().handoff_action.resume_at, p.now() + 1000);
    assert.equal(p.engine.snapshot().history.length, 1);
    p.advance(999); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    assert.deepEqual(order, ['speech:A', 'handoff:A']);
    p.advance(1); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    assert.deepEqual(order, ['speech:A', 'handoff:A', 'speech:B']);
    p.engine.dispose();
  }
});

test('handoff wait accepts zero, custom milliseconds and the 3000ms maximum without early playback', async () => {
  for (const waitMs of [0, 1250, 3000]) {
    const p = setup(emptyQueue(), false, { handoff: async () => {} });
    await p.engine.configureHandoff(true, 'left_down', waitMs);
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
    await p.engine.setContext(true, 'live', true);
    const idle = () => { p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live'); };
    idle(); await p.engine.tick();
    p.engine.observeVad({ speaking: true, ended: false, healthy: true }, 'live');
    p.advance(900); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
    await p.engine.tick();
    assert.equal(p.engine.snapshot().handoff_action.wait_ms, waitMs);
    assert.equal(p.engine.snapshot().handoff_action.resume_at, p.now() + waitMs);
    if (waitMs) {
      assert.deepEqual(p.spoken, ['A']);
      p.advance(waitMs - 1); idle(); await p.engine.tick();
      assert.deepEqual(p.spoken, ['A']);
      p.advance(1); idle(); await p.engine.tick();
    }
    assert.deepEqual(p.spoken, ['A', 'B']);
    p.engine.dispose();
  }
});

test('handoff wait persists across direction changes and rejects values outside integer 0–3000ms', async () => {
  const p = setup();
  await Promise.all([p.engine.configureHandoff(true, 'left_down', 2300), p.engine.configureHandoff(false, 'right_down')]);
  assert.equal(p.engine.snapshot().handoff.wait_ms, 2300);
  for (const value of [-1, 3001, 1.5, NaN]) {
    await assert.rejects(p.engine.configureHandoff(true, 'left_down', value), /0–3000/);
  }
  assert.equal(p.engine.snapshot().handoff.wait_ms, 2300);
  assert.equal(p.errors.length, 0);
  const reopened = setup(p.engine.snapshot());
  assert.equal(reopened.engine.snapshot().handoff.wait_ms, 2300);
  p.engine.dispose(); reopened.engine.dispose();
});

test('handoff angle is saved, validated and passed to the action adapter instead of a fixed 45 degrees', async () => {
  const angles = [];
  const p = setup(emptyQueue(), false, { handoff: async (_task, _live, _direction, angle) => { angles.push(angle); } });
  await p.engine.configureHandoff(true, 'left_down', 0, 30);
  await p.engine.configureHandoff(true, 'right_down');
  assert.equal(p.engine.snapshot().handoff.angle_deg, 30);
  for (const value of [-1, 91, 1.5, NaN]) await assert.rejects(p.engine.configureHandoff(true, 'left_down', undefined, value), /0–90/);
  const reopened = setup(p.engine.snapshot());
  assert.equal(reopened.engine.snapshot().handoff.angle_deg, 30);
  reopened.engine.dispose();
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  await p.engine.finish('played', 'confirmed');
  assert.deepEqual(angles, [30]);
  assert.equal(p.engine.snapshot().handoff_action.angle_deg, 30);
  p.engine.dispose();
});

test('handoff is off by default and never triggers for skips, paused playback or an old live session', async () => {
  for (const scenario of ['disabled', 'skip', 'pause', 'session-changed']) {
    let commands = 0;
    const p = setup(emptyQueue(), false, { handoff: async () => { commands++; } });
    if (scenario !== 'disabled') await p.engine.configureHandoff(true, 'right_down');
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
    await p.engine.tick();
    if (scenario === 'pause') await p.engine.setContext(false, 'live', true);
    if (scenario === 'session-changed') await p.engine.setContext(true, 'new-live', true);
    await p.engine.finish(scenario === 'skip' ? 'skipped' : 'played', 'test completion');
    assert.equal(commands, 0);
    p.engine.dispose();
  }
});

test('a failed handoff keeps the played outcome and the next reply can continue', async () => {
  const p = setup(emptyQueue(), false, { handoff: async () => { throw Error('action rejected'); } });
  await p.engine.configureHandoff(true, 'left_down');
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  p.engine.observeVad({ speaking: true, ended: false, healthy: true }, 'live');
  p.advance(900); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
  await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.equal(p.engine.snapshot().handoff_action.status, 'failed');
  assert.ok(p.engine.snapshot().handoff_action.error.includes('action rejected'));
  assert.equal(p.engine.snapshot().history[0].outcome, 'played');
  p.engine.dispose();
});

test('reopening a queue never automatically resends a handoff already attempted before a crash', async () => {
  const initial = emptyQueue();
  initial.handoff = { enabled: true, direction: 'right_down' };
  initial.tasks = [{ id: 'A', event: { event_id: 'A', type: 'chat' }, status: 'playing', live_id: 'live', result: reply('A') }];
  initial.handoff_action = { task_id: 'A', live_id: 'live', direction: 'right_down', status: 'pending' };
  let commands = 0;
  const p = setup(initial, false, { handoff: async () => { commands++; } });
  await p.engine.restore(); await p.engine.setContext(true, 'live', true);
  assert.equal(p.engine.snapshot().handoff_action.status, 'cancelled');
  await p.engine.finish('played', 'operator confirmed');
  assert.equal(commands, 0);
  p.engine.dispose();
});

test('handoff storage failure prevents sending a command or starting the next reply', async () => {
  let commands = 0;
  const p = setup(emptyQueue(), false, {
    persist: async snapshot => { if (snapshot.handoff_action?.status === 'pending') throw Error('disk full'); },
    handoff: async () => { commands++; },
  });
  await p.engine.configureHandoff(true, 'left_down');
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  await assert.rejects(p.engine.finish('played', 'confirmed'), /disk full/);
  assert.equal(commands, 0);
  assert.deepEqual(p.spoken, ['A']);
  assert.equal(p.engine.snapshot().history.length, 0);
  p.engine.dispose();
});

test('interrupting during handoff submission preserves the operator skip and cannot start another reply', async () => {
  let release;
  const p = setup(emptyQueue(), false, { handoff: () => new Promise(resolve => { release = resolve; }) });
  await p.engine.configureHandoff(true, 'right_down');
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
  await p.engine.tick();
  const ending = p.engine.finish('played', 'confirmed'); await flush();
  await p.engine.finish('skipped', 'operator interrupted');
  await p.engine.setContext(false, 'live', true);
  release(); await ending;
  assert.equal(p.engine.snapshot().history[0].outcome, 'skipped');
  assert.equal(p.engine.snapshot().history[0].reason, 'operator interrupted');
  assert.deepEqual(p.spoken, ['A']);
  p.engine.dispose();
});

test('gift combo cumulative reports merge once and displace only unplayed chat', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) await p.engine.ingest(p.event(id));
  p.jobs.get('A').resolve(reply('A')); p.jobs.get('B').resolve(reply('B')); await flush();
  await p.observe(); p.advance(3500); await p.observe();
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  const gift = count => ({ name: '玫瑰', count, gift_id: 'rose', combo_id: 'combo1', is_final: count === 10 });
  for (const count of [1, 5, 10]) await p.engine.ingest(p.event(`gift-${count}`, 'gift', { user_id: 'giver', gift: gift(count), content: `玫瑰×${count}` }));
  let snapshot = p.engine.snapshot();
  assert.equal(snapshot.tasks.length, 6);
  assert.equal(snapshot.tasks[0].event.event_id, 'A');
  assert.equal(snapshot.tasks[1].event.type, 'gift');
  assert.equal(snapshot.tasks[1].event.gift.count, 10);
  assert.ok(snapshot.history.some(entry => entry.reason === '为礼物优先任务让位'));
  assert.ok(snapshot.history.some(entry => entry.task.event.event_id === 'F'));
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

test('a second test batch waits for fresh continuous healthy silence and retains the last handoff deadline', async () => {
  const actions = [];
  const p = setup(undefined, false, { handoff: async task => { actions.push(task.id); } });
  const vad = (speaking = false, healthy = true) => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking, ended: false, healthy }, 'live', p.now());
  };
  const batch = prefix => ['A', 'B', 'C'].map(id => ({ event: p.event(`${prefix}${id}`), result: reply(id) }));
  await p.engine.configureHandoff(true, 'left_down', 3000);
  await p.engine.importTestBatch(batch('1'));
  await p.engine.setContext(true, 'live', true);
  for (let i = 0; i < 3; i++) {
    vad(); await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
    await p.engine.finish('played', 'operator confirmed');
    if (i < 2) p.advance(3000);
  }
  assert.equal(actions.length, 3);
  assert.equal(p.engine.snapshot().tasks.length, 0);
  // Mimic the import button pausing the same session, then enabling it again.
  await p.engine.setContext(false, 'live', false);
  await p.engine.importTestBatch(batch('2'));
  await p.engine.setContext(true, 'live', true);
  assert.equal(p.spoken.length, 3);
  // Healthy silence alone cannot bypass the previous action's wait setting.
  for (let i = 0; i < 10; i++) { vad(); await p.engine.tick(); p.advance(100); }
  assert.equal(p.spoken.length, 3);
  p.advance(2000);
  // A gap in audio observations restarts the fresh silence window.
  vad(); await p.engine.tick();
  assert.equal(p.spoken.length, 3);
  for (let i = 0; i < 5; i++) { p.advance(100); vad(); await p.engine.tick(); }
  vad(true); await p.engine.tick();
  for (let i = 0; i < 5; i++) { p.advance(100); vad(); await p.engine.tick(); }
  vad(false, false); await p.engine.tick();
  for (let i = 0; i < 9; i++) { p.advance(100); vad(); await p.engine.tick(); }
  assert.equal(p.spoken.length, 3);
  p.advance(100); vad(); await p.engine.tick();
  assert.deepEqual(p.spoken, ['1A', '1B', '1C', '2A']);
  // Old end notifications cannot finish the newly submitted first reply.
  p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live', p.now());
  await p.engine.tick();
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  assert.equal(actions.length, 3);
  p.engine.dispose();
});

test('simultaneous test imports admit one batch and never submit duplicate speech', async () => {
  const p = setup();
  await p.engine.setContext(true, 'live', true);
  const batch = ['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(id) }));
  const results = await Promise.allSettled([p.engine.importTestBatch(batch), p.engine.importTestBatch(batch)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(p.engine.snapshot().tasks.length, 3);
  p.engine.observeVideo('live');
  p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live', p.now());
  await Promise.all([p.engine.tick(), p.engine.tick()]);
  assert.deepEqual(p.spoken, ['A']);
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

test('Whisper short-reply matching sends handoff without silence and waits from successful submission', async () => {
  const order = [];
  let release;
  const p = setup(undefined, false, {
    speak: async task => order.push(`speech:${task.event.event_id}`),
    handoff: task => { order.push(`handoff:${task.event.event_id}`); return new Promise(resolve => { release = resolve; }); },
  });
  await p.engine.configureRecognition(true);
  await p.engine.configureHandoff(true, 'left_down', 1000);
  const speech = '今天聊聊天，最后祝大家晚安。';
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(speech) })));
  await p.engine.setContext(true, 'live', true);
  const vad = (quiet_ms, speaking = true, healthy = true) => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking, ended: quiet_ms >= 900, healthy, quiet_ms }, 'live');
  };
  vad(0, false); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  const observation = text => ({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text, captured_at: p.now(), inference_ms: 20 });
  vad(0); p.advance(1000); vad(900, false); await p.engine.tick();
  assert.deepEqual(order, ['speech:A']); // VAD alone cannot finish.
  await p.engine.observeRecognition(observation('最后祝大家晚安'));
  assert.deepEqual(order, ['speech:A']); // A suffix alone cannot finish.
  vad(0);
  const completing = p.engine.observeRecognition(observation(speech));
  await flush();
  assert.deepEqual(order, ['speech:A', 'handoff:A']);
  assert.equal(p.engine.snapshot().handoff_action.status, 'pending');
  p.advance(200); vad(0); await p.engine.tick();
  assert.deepEqual(order, ['speech:A', 'handoff:A']);
  release(); await completing;
  assert.equal(p.engine.snapshot().handoff_action.resume_at, p.now() + 1000);
  assert.deepEqual(order, ['speech:A', 'handoff:A']);
  p.advance(999); vad(1349, false); await p.engine.tick();
  assert.deepEqual(order, ['speech:A', 'handoff:A']);
  p.advance(1); vad(1350, false); await p.engine.tick();
  assert.deepEqual(order, ['speech:A', 'handoff:A', 'speech:B']);
  await p.engine.observeRecognition(observation(speech));
  assert.equal(p.engine.snapshot().history.length, 1);
  p.engine.dispose();
});

test('Whisper rejects foreign attempts, late recognition before newer speech, stream outages and errors', async () => {
  for (const enabled of [false, true]) {
    let handoffs = 0;
    const p = setup(undefined, false, { handoff: async () => { handoffs++; } });
    await p.engine.configureRecognition(true); await p.engine.configureHandoff(enabled, 'left_down', 0);
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply('今天我们一起聊聊天，最后祝大家晚安。') })));
    await p.engine.setContext(true, 'live', true);
    const vad = (quiet_ms, healthy = true) => {
      p.engine.observeVideo('live'); p.engine.observeVad({ speaking: true, ended: false, healthy, quiet_ms }, 'live');
    };
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
    const task = p.engine.snapshot().tasks[0];
    const observation = { live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: task.result.speech, captured_at: p.now(), inference_ms: 20 };
    vad(0); p.advance(400); vad(400);
    await p.engine.observeRecognition({ ...observation, capture_id: 'old-attempt' });
    await p.engine.observeRecognition({ ...observation, live_id: 'old-live' });
    assert.equal(p.engine.snapshot().tasks[0].recognition, undefined);
    p.advance(10); vad(0); p.advance(400); vad(400);
    await p.engine.observeRecognition(observation);
    assert.deepEqual(p.spoken, ['A']); // Audio after this result still needs recognition.
    vad(400, false);
    await p.engine.observeRecognition({ ...observation, captured_at: p.now() });
    assert.deepEqual(p.spoken, ['A']);
    vad(400);
    await p.engine.observeRecognition({ ...observation, captured_at: p.now(), error: 'Whisper stopped' });
    assert.deepEqual(p.spoken, ['A']);
    assert.equal(p.engine.snapshot().tasks[0].recognition.matched, false);
    await assert.rejects(p.engine.configureRecognition(false), /当前播报/);
    assert.equal(handoffs, 0);
    assert.equal(p.errors.length, 0); // Rejected toggles must not fault storage.
    p.engine.dispose();
  }
});

test('Whisper with handoff disabled still requires 350ms of silence after matching', async () => {
  let handoffs = 0;
  const p = setup(undefined, false, { handoff: async () => { handoffs++; } });
  await p.engine.configureRecognition(true);
  await p.engine.importTestBatch(['A', 'B'].map(id => ({ event: p.event(id), result: reply('欢迎来到我们的直播间。') })));
  await p.engine.setContext(true, 'live', true);
  const vad = (quiet_ms, speaking = true) => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking, ended: false, healthy: true, quiet_ms }, 'live');
  };
  vad(1000, false); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  vad(0);
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: task.result.speech, captured_at: p.now(), inference_ms: 20 });
  assert.deepEqual(p.spoken, ['A']);
  p.advance(349); vad(349); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  p.advance(1); vad(350); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.equal(handoffs, 0);
  p.engine.dispose();
});

test('Whisper completion without a handoff skips the old 900ms hangover and cannot consume the next reply', async () => {
  for (const enabled of [false, true]) {
    let handoffs = 0;
    const p = setup(undefined, false, { handoff: async () => { handoffs++; } });
    await p.engine.configureRecognition(true); await p.engine.configureHandoff(enabled, 'left_down', 0);
    await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply('欢迎来到我们的直播间。') })));
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
    const task = p.engine.snapshot().tasks[0];
    p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
    p.advance(350); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 350 }, 'live');
    const result = { live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: task.result.speech, captured_at: p.now(), inference_ms: 20 };
    await p.engine.observeRecognition(result);
    assert.deepEqual(p.spoken, ['A', 'B']); assert.equal(handoffs, Number(enabled));
    await p.engine.observeRecognition(result);
    assert.equal(p.engine.snapshot().history.length, 1);
    p.engine.dispose();
  }
});

test('the reported Wanwan homophone transcript completes the active task after healthy short silence', async () => {
  const p = setup(); await p.engine.configureRecognition(true);
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply('我叫晚晚，晚上的晚，好记吧？') })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
  p.advance(350); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 350 }, 'live');
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: '我叫碗碗, 晚上的碗,好记吧!', captured_at: p.now(), inference_ms: 98 });
  assert.deepEqual(p.spoken, ['A', 'B']);
  const completed = p.engine.snapshot().history[0].task.recognition;
  assert.equal(completed.progress, 1); assert.equal(completed.method, 'phonetic');
  p.engine.dispose();
});

test('restored homophone evidence is recalculated but never overrides manual confirmation after a session change', async () => {
  const initial = emptyQueue(); initial.recognition = { enabled: true };
  initial.tasks = [{ id: 'old-task', status: 'uncertain', live_id: 'old-live', playback_token: 'old-attempt', started_at: 99000,
    event: { event_id: 'A', type: 'chat', room_id: 'room', user_id: 'viewer', nickname: '观众', content: '你叫什么', created_at: 99000 },
    result: reply('我叫晚晚，晚上的晚，好记吧？'), error: '会话已切换，需人工确认上一条是否已播报',
    recognition: { text: '我叫碗碗, 晚上的碗,好记吧!', matched: false, progress: 0.73, captured_at: 99500, inference_ms: 98 } }];
  const p = setup(initial);
  const restored = p.engine.snapshot().tasks[0];
  assert.equal(restored.recognition.progress, 1); assert.equal(restored.recognition.matched, true);
  assert.equal(restored.status, 'uncertain'); assert.match(restored.error, /会话已切换/);
  await p.engine.setContext(true, 'new-live', true);
  await p.engine.observeRecognition({ live_id: 'old-live', task_id: 'old-task', capture_id: 'old-attempt', enabled: true, text: restored.recognition.text, captured_at: p.now(), inference_ms: 98 });
  assert.equal(p.engine.snapshot().history.length, 0); assert.equal(p.spoken.length, 0);
  p.engine.dispose();
});

test('long-reply tail matching at exactly 70 percent sends handoff with zero silence', async () => {
  const order = [];
  const p = setup(undefined, false, { speak: async task => order.push(`speech:${task.event.event_id}`), handoff: async task => order.push(`handoff:${task.event.event_id}`) });
  await p.engine.configureRecognition(true); await p.engine.configureHandoff(true, 'left_down', 0);
  const speech = '春夏秋冬东西南北天地甲乙丙丁戊己庚辛壬癸';
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id), result: reply(speech) })));
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: '前面完全不同甲乙丙丁戊己花草树木', captured_at: p.now(), inference_ms: 30 });
  assert.deepEqual(order, ['speech:A']);
  assert.ok(p.engine.snapshot().tasks[0].recognition.progress < 0.7);
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: '前面完全不同甲乙丙丁戊己庚花草树', captured_at: p.now(), inference_ms: 30 });
  assert.deepEqual(order, ['speech:A', 'handoff:A', 'speech:B']);
  assert.equal(p.engine.snapshot().history[0].task.recognition.progress, 0.7);
  assert.equal(p.engine.snapshot().history[0].task.recognition.scope, 'tail');
  p.engine.dispose();
});
