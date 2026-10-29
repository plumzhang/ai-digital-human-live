import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const exports = {};
const diversityExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/replyDiversity.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: diversityExports });
const actionsExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/giftActions.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: actionsExports });
const { avatarActionFor } = actionsExports;
const outputExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/avatarOutput.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: outputExports });
const recognitionExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/whisperRecognition.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recognitionExports, require: name => { assert.equal(name, 'pinyin-pro'); return pinyinPro; } });
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/interactionQueue.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, structuredClone, crypto, Date, setTimeout, clearTimeout, require: name => {
    if (name === './whisperRecognition') return recognitionExports;
    if (name === './replyDiversity') return diversityExports;
    if (name === './avatarOutput') return outputExports;
    assert.equal(name, './giftActions');
    return actionsExports;
  } });
const { InteractionQueue, emptyQueue, normalizeInteraction } = exports;
const manualExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/manualQuestions.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: manualExports, Date });
const { ManualQuestions } = manualExports;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };
const reply = text => ({ speech: text, generation_mode: 'question', emotion: 'happy', segments: [] });

function setup(initial = emptyQueue(), persistError = false, extras = {}) {
  let now = 100_000;
  const jobs = new Map();
  const spoken = [];
  const saved = [];
  const errors = [];
  const { autoAnswer = true, ...adapterExtras } = extras;
  const engine = new InteractionQueue(initial, {
    persist: async state => { if (persistError) throw Error('disk full'); saved.push(structuredClone(state)); },
    generate: (task, history, diversity) => new Promise((resolve, reject) => jobs.set(task.event.event_id, { resolve, reject, task, history, diversity })),

    changed: () => {}, error: message => errors.push(message), now: () => now, ...adapterExtras,
    speak: async (task, liveId) => {
      if (adapterExtras.speak) await adapterExtras.speak(task, liveId);
      else spoken.push(task.event.event_id);
      if (autoAnswer && !task.song) await engine.observeOutput({ live_id: liveId, text: task.result.speech, received_at: now, msg_id: `tts-${task.id}` });
    },
  });
  const event = (id, type = 'chat', extra = {}) => ({ event_id: id, type, room_id: 'room', user_id: `user-${id}`, nickname: id, content: id, created_at: now, ...extra });
  const observe = async () => { engine.observeAudio(false, 'live'); engine.observeVideo('live'); await engine.tick(); await flush(); };
  return { engine, jobs, spoken, saved, errors, event, observe, advance: ms => { now += ms; }, now: () => now };
}

test('collected chat occupies a visible persisted slot before any avatar or automatic reply is enabled', async () => {
  const changes = [], prepared = [];
  const p = setup(emptyQueue(), false, { changed: snapshot => changes.push(snapshot), prepareAudio: async task => { prepared.push(task.id); return { state: 'ready' }; } });
  const event = normalizeInteraction({ id: '18446744073709551614', roomId: 'room', type: 'chat', ts: 1_000_000_000_000, user: { id: '9223372036854775806', nickname: '小宇' }, data: { content: '姐姐你好' } }, p.now());
  await p.engine.ingest(event); await flush();
  const task = p.engine.snapshot().tasks[0];
  assert.equal(task.event.content, '姐姐你好'); assert.equal(task.event.nickname, '小宇'); assert.equal(task.status, 'pending');
  assert.equal(task.event.event_id, '18446744073709551614'); assert.equal(task.event.user_id, '9223372036854775806');
  assert.equal(p.saved.at(-1).tasks[0].id, task.id); assert.equal(changes.at(-1).tasks[0].id, task.id);
  assert.equal(p.jobs.size, 0); assert.equal(prepared.length, 0); assert.equal(p.spoken.length, 0);
  await p.engine.setContext(false, 'live', true); assert.equal(p.jobs.size, 0);
  await p.engine.setContext(true, 'live', false); assert.equal(p.jobs.size, 0);
  await p.engine.setContext(true, 'live', true); assert.ok(p.jobs.has(event.event_id));
  assert.equal(p.engine.snapshot().tasks[0].id, task.id);
  p.engine.dispose();
});

test('a vacant slot immediately takes the newest overflow chat while no avatar is running', async () => {
  const p = setup();
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  await p.engine.ingest(p.event('older')); p.advance(1000); await p.engine.ingest(p.event('newest'));
  assert.equal(p.engine.snapshot().tasks.length, 3);
  await p.engine.skip(p.engine.snapshot().tasks[2].id);
  const state = p.engine.snapshot();
  assert.equal(state.tasks.length, 3); assert.equal(state.tasks.at(-1).event.event_id, 'newest');
  assert.equal(state.candidates[0].event_id, 'older'); assert.equal(p.jobs.size, 0); assert.equal(p.spoken.length, 0);
  p.engine.dispose();
});

test('chats with equal collector timestamps refill by latest receipt, while a full queue keeps occupied slots', async () => {
  const p = setup();
  for (const id of ['A', 'B', 'C', 'older', 'latest']) await p.engine.ingest(p.event(id));
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.event_id), ['A', 'B', 'C']);
  await p.engine.skip(p.engine.snapshot().tasks[0].id);
  assert.equal(p.engine.snapshot().tasks.at(-1).event.event_id, 'latest');
  await p.engine.skip(p.engine.snapshot().tasks[0].id);
  assert.equal(p.engine.snapshot().tasks.at(-1).event.event_id, 'older');
  assert.equal(p.engine.snapshot().tasks.length, 3); p.engine.dispose();
});

test('visible slots stay fixed beyond 30 seconds and gifts wait for a vacancy before fresh chats', async () => {
  const p = setup();
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  const original = p.engine.snapshot().tasks.map(t => t.id);
  p.advance(29_000); await p.engine.ingest(p.event('fresh'));
  p.advance(2000); await p.engine.tick();
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.id), original);
  await p.engine.ingest(p.event('gift', 'gift', { gift: { name: '玫瑰', count: 5, gift_id: 'rose', combo_id: 'group', is_final: true } }));
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.id), original);
  await p.engine.skip(original[0]);
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.event_id), ['B', 'C', 'gift']);
  assert.equal(p.engine.snapshot().tasks[2].event.gift.count, 5);
  await p.engine.skip(original[1]);
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.event_id), ['C', 'gift', 'fresh']);
  assert.equal(p.jobs.size, 0); assert.equal(p.spoken.length, 0); p.engine.dispose();
});

function operator(p, send) {
  const sent = [];
  let questions = [];
  const manual = new ManualQuestions({
    holdPlayback: held => p.engine.setPlaybackHeld(held),
    canStart: quietMs => p.engine.canInsertPlayback(quietMs),
    send: send || (async (content, liveId) => { sent.push({ content, liveId }); }),
    changed: value => { questions = value; }, error: message => p.errors.push(message), now: p.now,
  });
  const idle = async (ms = 1600) => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
    for (let elapsed = 0; elapsed < ms;) {
      const step = Math.min(200, ms - elapsed);
      elapsed += step; p.advance(step);
      p.engine.observeVideo('live');
      p.engine.observeVad({ speaking: false, ended: true, healthy: true }, 'live');
      await manual.tick('live', true);
      await p.engine.tick();
    }
  };
  const voice = () => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking: true, ended: false, healthy: true }, 'live');
    manual.observeSpeech('live');
  };
  return { manual, sent, idle, voice, questions: () => questions };
}

test('one test interaction replaces slot three without switching the live room or dropping real chat', async () => {
  const p=setup();for(const id of ['A','B','C'])await p.engine.ingest(p.event(id));
  const before=p.engine.snapshot().tasks;
  const position=await p.engine.insertTestInteraction({event:p.event('test-input','chat',{room_id:'test-isolated',nickname:'测试观众'})});
  assert.equal(position,3);let state=p.engine.snapshot();
  assert.equal(state.room_id,'room');assert.equal(state.tasks[2].event.room_id,'room');assert.equal(state.tasks[2].event.source,'test');
  assert.deepEqual(state.tasks.slice(0,2),before.slice(0,2));assert.equal(state.tasks[2].event.event_id,'test-input');
  assert.equal(state.history.at(-1).task.id,before[2].id);assert.ok(!state.candidates.some(e=>e.event_id==='C'));
  await p.engine.ingest(p.event('real-newest'));
  state=p.engine.snapshot();assert.deepEqual(state.tasks.map(t=>t.event.event_id),['A','B','test-input']);
  assert.equal(state.candidates[0].event_id,'real-newest');assert.equal(p.jobs.size,0);
  p.engine.dispose();
});

test('a single test can be inserted before avatar readiness and does not turn on automatic replies', async () => {
  const p=setup();
  await p.engine.insertTestInteraction({event:p.event('pending-test')});
  assert.equal(p.engine.snapshot().tasks[0].status,'pending');
  await p.engine.setContext(false,'live',false);await p.engine.tick();
  await p.engine.setContext(false,'live',true);await p.engine.tick();
  assert.equal(p.jobs.size,0);assert.equal(p.spoken.length,0);
  await p.engine.setContext(true,'live',true);assert.ok(p.jobs.has('pending-test'));p.engine.dispose();
});

test('single test insertion rejects arrays or invalid gifts without replacing any slot', async () => {
  const p=setup();for(const id of ['A','B','C'])await p.engine.ingest(p.event(id));
  const before=p.engine.snapshot();
  await assert.rejects(p.engine.insertTestInteraction([{event:p.event('one')},{event:p.event('two')}]),/只能插入1条/);
  await assert.rejects(p.engine.insertTestInteraction({event:p.event('gift','gift')}),/只能插入1条/);
  assert.deepEqual(p.engine.snapshot(),before);p.engine.dispose();
});

test('test insertion is allowed during current PCM transmission and cannot accept displaced late synthesis', async () => {
  const playback=deferred(),third=deferred(),retained=[];
  const p=setup(undefined,false,{
    prepareAudio:task=>task.event.event_id==='C'?third.promise:Promise.resolve({state:'ready',duration_ms:2000}),
    retainAudio:async(live,tokens)=>retained.push([...tokens]),speak:async()=>playback.promise,
  });
  try {
    await p.engine.importTestBatch(['A','B','C'].map(id=>({event:p.event(id),result:{...reply(id),generation_mode:'component',prepared_reply:'回答'+id,prepared_for_live:'live'}})));
    await p.engine.setContext(true,'live',true);await flush();
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true},'live');void p.engine.tick();await flush();
    const before=p.engine.snapshot().tasks;assert.equal(before[0].status,'playing');assert.equal(before[2].prepared_audio.state,'preparing');
    await p.engine.insertTestInteraction({event:p.event('new-test')});
    third.resolve({state:'ready',duration_ms:2000});await flush();
    const after=p.engine.snapshot().tasks;
    assert.deepEqual(after.slice(0,2),before.slice(0,2));assert.equal(after[2].event.event_id,'new-test');
    assert.ok(!retained.at(-1).includes(before[2].prepared_audio.token));assert.ok(p.jobs.has('new-test'));
    assert.ok(!after.some(t=>t.id===before[2].id));
  }finally{p.engine.dispose();playback.resolve();third.resolve({state:'cancelled'});await flush();}
});

test('ABC remains fixed during collection and only advances to BCF when A is skipped', async () => {
  const p = setup();
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  const original = p.engine.snapshot().tasks.map(t => t.id);
  p.advance(120_000); await p.engine.tick();
  for (const id of ['D', 'E', 'F']) { p.advance(1); await p.engine.ingest(p.event(id)); }
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.id), original);
  assert.equal(p.engine.snapshot().history.length, 0);
  await p.engine.skip(original[0]);
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.event_id), ['B', 'C', 'F']);
  assert.deepEqual(p.engine.snapshot().tasks.slice(0, 2).map(t => t.id), original.slice(1));
  assert.equal(p.engine.snapshot().history.length, 1); assert.equal(p.jobs.size, 0); assert.equal(p.spoken.length, 0);
  p.engine.dispose();
});

test('waiting candidates expire without removing or regenerating already prepared visible slots', async () => {
  const initial = emptyQueue();
  initial.tasks = ['A', 'B', 'C'].map(id => ({ id, status: 'ready', event: { event_id: id, type: 'chat', room_id: 'room', created_at: 100_000, content: id }, result: reply('answer '+id) }));
  const p = setup(initial);
  await p.engine.ingest(p.event('expired-overflow')); p.advance(31_000); await p.engine.tick();
  assert.equal(p.engine.snapshot().candidates.length, 0);
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.result.speech), ['answer A', 'answer B', 'answer C']);
  assert.ok(p.engine.snapshot().tasks.every(t => t.status === 'ready')); assert.equal(p.jobs.size, 0);
  await p.engine.ingest(p.event('latest'));
  await p.engine.skip('A');
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.event_id), ['B', 'C', 'latest']);
  p.engine.dispose();
});

test('six-slot migration preserves unfinished playback, deferred gifts and songs across reopening', async () => {
  const initial = emptyQueue();
  initial.tasks = ['A', 'B', 'C', 'gift', 'song', 'old-chat'].map((id, i) => ({ id, status: i === 0 ? 'playing' : 'pending', event: { event_id: id, type: i === 3 ? 'gift' : i === 4 ? 'song' : 'chat', room_id: 'room', created_at: 100_000, content: id, ...(i === 3 ? { gift: { name: '花', count: 5, is_final: true } } : {}) }, ...(i === 4 ? { status: 'ready', song: { id: 'saved-song', title: '歌', duration_ms: 1000 } } : {}) }));
  const p = setup(initial); await p.engine.restore();
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.id), ['A', 'B', 'C']);
  assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  assert.deepEqual(p.engine.snapshot().deferred_tasks.map(t => t.id), ['gift', 'song', 'old-chat']);
  assert.equal(p.saved[0].tasks.length, 3);
  const q = setup(p.engine.snapshot()); p.engine.dispose(); q.advance(120_000); await q.engine.tick();
  assert.deepEqual(q.engine.snapshot().deferred_tasks.map(t => t.id), ['gift', 'song']);
  await q.engine.skip('B'); assert.deepEqual(q.engine.snapshot().tasks.map(t => t.id), ['A', 'C', 'gift']);
  await q.engine.skip('C'); assert.deepEqual(q.engine.snapshot().tasks.map(t => t.id), ['A', 'gift', 'song']);
  assert.equal(q.engine.snapshot().tasks[2].song.id, 'saved-song'); assert.equal(q.jobs.size, 0);
  q.engine.dispose();
});

test('a legacy unfinished playback outside the first three slots stays visible for confirmation', () => {
  const initial = emptyQueue();
  initial.tasks = Array.from({ length: 6 }, (_, i) => ({ id: String(i), status: i === 5 ? 'playing' : 'pending', event: { event_id: String(i), type: 'chat', created_at: 100_000, content: String(i) } }));
  const p = setup(initial), state = p.engine.snapshot();
  assert.equal(state.tasks.length, 3); assert.equal(state.tasks[0].id, '5'); assert.equal(state.tasks[0].status, 'uncertain');
  assert.equal(state.deferred_tasks.length, 3); assert.equal(new Set([...state.tasks, ...state.deferred_tasks].map(t => t.id)).size, 6);
  p.engine.dispose();
});

test('operator question reserves the next turn during playback and restores all three interaction slots afterward', async () => {
  const p = setup();
  const m = operator(p);
  const ids = ['A', 'B', 'C'];
  await p.engine.importTestBatch(ids.map(id => ({ event: p.event(id), result: reply(id) })));
  await p.engine.setContext(true, 'live', true);
  await m.idle();
  assert.deepEqual(p.spoken, ['A']);
  m.manual.enqueue('  请挥挥手  ', 'live');
  await m.manual.tick('live', true);
  assert.equal(m.sent.length, 0);
  assert.equal(p.engine.snapshot().tasks.length, 3);
  await p.engine.finish('played', 'operator confirmation');
  await m.idle();
  assert.deepEqual(m.sent, [{ content: '请挥挥手', liveId: 'live' }]);
  assert.deepEqual(p.spoken, ['A']);
  await m.idle(4000); // Silence without observed speech cannot consume a question.
  assert.equal(m.questions()[0].status, 'playing');
  m.voice();
  await m.idle(2600);
  assert.equal(m.questions().length, 0);
  assert.deepEqual(p.spoken, ['A', 'B']);
  assert.deepEqual(p.engine.snapshot().tasks.map(task => task.event.event_id), ids.slice(1));
  p.engine.dispose();
});

test('operator question bypasses unfinished generation while generated replies wait for its answer', async () => {
  const p = setup();
  const m = operator(p);
  await p.engine.setContext(true, 'live', true);
  await p.engine.ingest(p.event('A'));
  m.manual.enqueue('手动问题', 'live');
  await m.idle();
  assert.equal(m.sent.length, 1);
  assert.ok(p.jobs.has('A'));
  p.jobs.get('A').resolve(reply('generated answer'));
  await flush(); await p.engine.tick();
  assert.equal(p.engine.snapshot().tasks[0].status, 'ready');
  assert.equal(p.spoken.length, 0);
  m.voice(); await m.idle(2600);
  assert.deepEqual(p.spoken, ['A']);
  p.engine.dispose();
});

test('multiple operator questions remain FIFO ahead of the next ready interaction', async () => {
  const p = setup(); const m = operator(p);
  await p.engine.importTestBatch([{ event: p.event('A'), result: reply('A') }]);
  await p.engine.setContext(true, 'live', true);
  m.manual.enqueue('first', 'live'); m.manual.enqueue('second', 'live');
  await m.idle();
  assert.equal(m.sent.length, 1);
  m.voice(); await m.idle(2600);
  assert.equal(m.questions().length, 1);
  assert.equal(p.spoken.length, 0);
  await m.manual.tick('live', true);
  assert.deepEqual(m.sent.map(item => item.content), ['first', 'second']);
  m.voice(); await m.idle(2600);
  assert.deepEqual(p.spoken, ['A']);
  p.engine.dispose();
});

test('operator questions run with automatic replies off without enabling paused interactions', async () => {
  const p = setup(); const m = operator(p);
  await p.engine.importTestBatch([{ event: p.event('A'), result: reply('A') }]);
  await p.engine.setContext(false, 'live', false);
  m.manual.enqueue('standalone question', 'live');
  await m.idle();
  assert.equal(m.sent.length, 1);
  m.voice(); await m.idle(2600);
  assert.equal(m.questions().length, 0);
  assert.equal(p.spoken.length, 0);
  assert.equal(p.jobs.size, 0);
  p.engine.dispose();
});

test('uncertain operator delivery blocks later playback until explicit confirmation', async () => {
  const p = setup(); const m = operator(p, async () => { throw Error('write timeout'); });
  await p.engine.importTestBatch([{ event: p.event('A'), result: reply('A') }]);
  await p.engine.setContext(true, 'live', true);
  m.manual.enqueue('question', 'live');
  await m.idle();
  assert.equal(m.questions()[0].status, 'uncertain');
  await m.idle(10000);
  assert.equal(p.spoken.length, 0);
  assert.equal(p.errors.length, 1);
  m.manual.confirm(); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']);
  p.engine.dispose();
});

test('operator answer requires fresh healthy media and a speech observation from the matching live', async () => {
  const p = setup(); const m = operator(p);
  await p.engine.setContext(false, 'live', false);
  m.manual.enqueue('question', 'live'); await m.idle();
  m.manual.observeSpeech('old-live'); await m.idle(3000);
  assert.equal(m.questions().length, 1);
  m.voice(); p.advance(3000);
  await m.manual.tick('live', true); // Stale audio/video must not release the turn.
  assert.equal(m.questions().length, 1);
  p.engine.observeVideo('live');
  p.engine.observeVad({ speaking: false, ended: true, healthy: false }, 'live');
  await m.manual.tick('live', true);
  assert.equal(m.questions().length, 1);
  await m.idle(1000);
  assert.equal(m.questions().length, 1);
  await m.idle(1600);
  assert.equal(m.questions().length, 0);
  p.engine.dispose();
});

test('a missing operator answer becomes uncertain instead of releasing queued interactions on a timer', async () => {
  const p = setup(); const m = operator(p);
  await p.engine.setContext(true, 'live', true);
  m.manual.enqueue('question', 'live'); await m.idle();
  await m.idle(60001);
  assert.equal(m.questions()[0].status, 'uncertain');
  m.voice(); await m.idle(3000);
  assert.equal(m.questions()[0].status, 'uncertain');
  m.manual.cancel(); assert.equal(m.questions().length, 0);
  p.engine.dispose();
});

test('session change cancels pending questions and ignores a late failure from the old submission', async () => {
  let rejectSend;
  const p = setup(); const m = operator(p, () => new Promise((_, reject) => { rejectSend = reject; }));
  await p.engine.setContext(false, 'live', false);
  m.manual.enqueue('first', 'live'); m.manual.enqueue('second', 'live');
  for (let i = 0; i < 9; i++) { p.engine.observeVideo('live'); p.engine.observeAudio(false, 'live'); p.advance(200); }
  p.engine.observeVideo('live'); p.engine.observeAudio(false, 'live');
  const sending = m.manual.tick('live', true);
  assert.equal(typeof rejectSend, 'function');
  await m.manual.tick('new-live', false);
  assert.equal(m.questions().length, 0);
  rejectSend(Error('old session closed')); await sending;
  assert.equal(p.errors.length, 0);
  assert.equal(m.questions().length, 0);
  p.engine.dispose();
});

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
  await assert.rejects(p.engine.importTestBatch([]), /1～3/);
  await assert.rejects(p.engine.importTestBatch(Array.from({ length: 4 }, (_, i) => ({ event: p.event(`overflow-${i}`) }))), /1～3/);
  await p.engine.ingest(p.event('existing'));
  await assert.rejects(p.engine.importTestBatch(batch), /待处理任务/);
  assert.equal(p.engine.snapshot().tasks[0].event.event_id, 'existing');
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

test('one through three imported tasks keep input order, fit the slots and remain durable while waiting', async () => {
  for (let size = 1; size <= 3; size++) {
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

test('three slots include current speech, a fourth waits, only two generations run, and out-of-order results never reorder playback', async () => {
  const p = setup();
  await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.jobs.size, 2);
  p.jobs.get('B').resolve(reply('B answer')); await flush();
  for (const id of ['C']) {
    assert.ok(p.jobs.has(id));
    assert.equal(p.engine.snapshot().tasks.filter(task => task.status === 'generating').length, 2);
    p.jobs.get(id).resolve(reply(`${id} answer`)); await flush();
  }
  await p.observe(); p.advance(4000); await p.observe();
  assert.equal(p.spoken.length, 0);
  p.jobs.get('A').resolve(reply('A answer')); await flush();
  assert.deepEqual(p.spoken, ['A']);
  await p.engine.ingest(p.event('G'));
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.engine.snapshot().candidates.length, 1);
  assert.equal(p.engine.snapshot().candidates[0].event_id, 'G');
  assert.ok(!p.jobs.has('G'));
  await p.engine.finish('played', 'test confirmation');
  assert.equal(p.engine.snapshot().tasks.length, 3);
  assert.equal(p.engine.snapshot().candidates.length, 0);
  assert.ok(p.jobs.has('G'));
  p.advance(3500); await p.observe();
  assert.deepEqual(p.spoken, ['A', 'B']);
  p.engine.dispose();
});

test('concurrent questions vary response style without treating pre-generated questions as answers', async () => {
  const p = setup();
  await p.engine.importTestBatch(['A', 'B', 'C'].map(id => ({ event: p.event(id) })));
  await p.engine.setContext(true, 'live', true);
  assert.notEqual(p.jobs.get('A').diversity.openingStyle, p.jobs.get('B').diversity.openingStyle);
  assert.equal(p.saved.at(-1).next_opening_style >= 2, true);
  p.jobs.get('A').resolve(reply('A，今天能来聊聊天就很好。')); await flush();
  const context = p.jobs.get('C').diversity;
  assert.notEqual(context.openingStyle, p.jobs.get('B').diversity.openingStyle);
  assert.deepEqual(Array.from(context.recentOpenings), []);
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
  for (const direction of ['left_down', 'right_down', 'left_up', 'right_up', 'left', 'right', 'up', 'down', 'front']) {
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
    assert.equal(p.saved.at(-1).handoff.wait_ms, 1699);
    assert.equal(p.saved.at(-1).handoff.angle_deg, 30);
    const reopened = setup(p.saved.at(-1));
    assert.equal(reopened.engine.snapshot().handoff.direction, direction);
    reopened.engine.dispose();
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
    assert.equal(p.engine.snapshot().handoff_action.resume_at, p.now() + 1699);
    assert.equal(p.engine.snapshot().history.length, 1);
    p.advance(1698); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true }, 'live');
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

test('gift combo merges once and has refill priority without displacing visible chats', async () => {
  const p = setup(); await p.engine.setContext(true, 'live', true);
  for (const id of ['A', 'B', 'C']) await p.engine.ingest(p.event(id));
  p.jobs.get('A').resolve(reply('A')); p.jobs.get('B').resolve(reply('B')); await flush();
  await p.observe(); p.advance(3500); await p.observe();
  const original = p.engine.snapshot().tasks.map(t => t.id);
  const gift = count => ({ name: '玫瑰', count, gift_id: 'rose', combo_id: 'combo1', is_final: count === 10 });
  for (const count of [1, 5, 10]) await p.engine.ingest(p.event('gift-'+count, 'gift', { user_id: 'giver', gift: gift(count), content: '玫瑰×'+count }));
  await p.engine.ingest(p.event('newest-chat'));
  await p.engine.ingest(p.event('repeat-final', 'gift', { user_id: 'giver', gift: gift(10) }));
  let snapshot = p.engine.snapshot();
  assert.deepEqual(snapshot.tasks.map(t => t.id), original); assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.candidates.filter(e => e.type === 'gift').length, 1);
  assert.equal(snapshot.candidates.find(e => e.type === 'gift').gift.count, 10);
  await p.engine.finish('played', 'confirmed'); snapshot = p.engine.snapshot();
  assert.deepEqual(snapshot.tasks.map(t => t.event.event_id), ['B', 'C', 'gift-1']);
  assert.equal(snapshot.tasks[2].event.gift.count, 10); assert.equal(snapshot.candidates[0].event_id, 'newest-chat');
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

test('occupied chats and gifts both remain durable beyond 30 seconds during collection only', async () => {
  const p = setup(); await p.engine.ingest(p.event('chat'));
  await p.engine.ingest(p.event('gift', 'gift', { gift: { name: '礼物', count: 1, gift_id: 'g', combo_id: 'c', is_final: true } }));
  const ids = p.engine.snapshot().tasks.map(t => t.id);
  p.advance(120_000); await p.engine.tick();
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.id), ids);
  assert.deepEqual(p.engine.snapshot().tasks.map(t => t.event.type), ['chat', 'gift']);
  assert.equal(p.engine.snapshot().history.length, 0); assert.equal(p.jobs.size, 0); p.engine.dispose();
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
  assert.equal(p.engine.snapshot().tasks.length, 1);
  assert.equal(p.engine.snapshot().tasks[0].event.gift.count, 10);
  assert.equal(p.engine.snapshot().candidates.length, 0);
  const normalized = normalizeInteraction({ type: 'gift', data: { groupId: '0', giftName: '心心' } });
  assert.equal(normalized.gift.combo_id, '');
  p.engine.dispose();
});

test('cumulative updates may reuse the same event ID before the combo finishes', async () => {
  const p = setup();
  for (const count of [1, 5, 10]) {
    await p.engine.ingest(p.event('same-gift-message', 'gift', { gift: { name: '礼物', count, gift_id: 'g', combo_id: 'same-group', is_final: count === 10 } }));
  }
  assert.equal(p.engine.snapshot().tasks.length, 1);
  assert.equal(p.engine.snapshot().tasks[0].event.gift.count, 10);
  assert.equal(p.engine.snapshot().candidates.length, 0);
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
  await p.engine.configureHandoff(true, 'left_down', 1000, undefined, 70);
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
    await p.engine.observeRecognition(enabled ? { ...observation, captured_at: task.started_at - 1 } : observation);
    assert.deepEqual(p.spoken, ['A']); // Invalid captures cannot complete the task; normal completion also requires the latest speech.
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
  await p.engine.importTestBatch(['A', 'B'].map(id => ({ event: p.event(id), result: reply('ABCDEFGHIJ') })));
  await p.engine.setContext(true, 'live', true);
  const vad = (quiet_ms, speaking = true) => {
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking, ended: false, healthy: true, quiet_ms }, 'live');
  };
  vad(1000, false); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  vad(0);
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: 'ABCDE', captured_at: p.now(), inference_ms: 20 });
  p.advance(350); vad(350); await p.engine.tick();
  assert.deepEqual(p.spoken, ['A']); // The handoff threshold does not lower the normal completion threshold.
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
    result: reply('我叫晚晚，晚上的晚，好记吧？'), answer: { text: '我叫晚晚，晚上的晚，好记吧？', received_at: 99400, message_ids: [] }, error: '会话已切换，需人工确认上一条是否已播报',
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
  await p.engine.configureRecognition(true); await p.engine.configureHandoff(true, 'left_down', 0, undefined, 70);
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

test('handoff recognition threshold defaults to 50 percent, persists independently and validates its range', async () => {
  const initial = emptyQueue(); initial.handoff = { enabled: true, direction: 'left_down', wait_ms: 800, angle_deg: 30 };
  const p = setup(initial);
  assert.equal(p.engine.snapshot().handoff.trigger_percent, 50);
  await p.engine.configureHandoff(true, 'left_down', undefined, undefined, 83);
  await p.engine.configureHandoff(false, 'right_down', 1200, 60);
  assert.equal(p.saved.at(-1).handoff.trigger_percent, 83);
  const reopened = setup(p.saved.at(-1));
  assert.equal(reopened.engine.snapshot().handoff.trigger_percent, 83);
  for (const value of [0, -1, 101, 1.5, NaN, Infinity]) {
    await assert.rejects(p.engine.configureHandoff(true, 'left_down', undefined, undefined, value), /1–100%/);
  }
  assert.equal(p.engine.snapshot().handoff.trigger_percent, 83);
  await p.engine.configureHandoff(true, 'left_down', undefined, undefined, 1);
  await p.engine.configureHandoff(true, 'left_down', undefined, undefined, 100);
  assert.equal(p.engine.snapshot().handoff.trigger_percent, 100);
  p.engine.dispose(); reopened.engine.dispose();
});

test('handoff uses the configured recognition percentage without requiring the fixed 70 percent match or silence', async () => {
  for (const [threshold, below, accepted] of [[undefined, 'ABCD', 'ABCDE'], [80, 'ABCDEFG', 'ABCDEFGH'], [100, 'ABCDEFGHI', 'ABCDEFGHIJ']]) {
    const order = [];
    const p = setup(undefined, false, {
      speak: async task => order.push(`speech:${task.event.event_id}`),
      handoff: async task => order.push(`handoff:${task.event.event_id}`),
    });
    await p.engine.configureRecognition(true, 95);
    await p.engine.configureHandoff(true, 'left_down', 0, undefined, threshold);
    await p.engine.importTestBatch(['A', 'B'].map(id => ({ event: p.event(id), result: reply('ABCDEFGHIJ') })));
    await p.engine.setContext(true, 'live', true);
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
    const task = p.engine.snapshot().tasks[0];
    const observation = text => ({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text, captured_at: p.now(), inference_ms: 20 });
    await p.engine.observeRecognition(observation(accepted));
    assert.deepEqual(order, ['speech:A']); // Matching without observed speech cannot submit an action.
    p.advance(10);
    p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
    await p.engine.observeRecognition(observation(below));
    assert.deepEqual(order, ['speech:A']);
    const recognizing = observation(accepted);
    p.advance(100);
    p.engine.observeVideo('live');
    p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
    await p.engine.observeRecognition(recognizing); // Speech may continue while this recognition request runs.
    assert.deepEqual(order, ['speech:A', 'handoff:A', 'speech:B']);
    const recognition = p.engine.snapshot().history[0].task.recognition;
    assert.equal(recognition.progress * 100, threshold ?? 50);
    if (threshold === undefined) assert.equal(recognition.matched, false);
    await p.engine.observeRecognition(observation(accepted)); await p.engine.tick();
    assert.deepEqual(order, ['speech:A', 'handoff:A', 'speech:B']);
    p.engine.dispose();
  }
});

test('normal recognition percentage defaults to 70, validates changes and survives disabling and reopening', async () => {
  const p = setup();
  await p.engine.configureRecognition(true);
  assert.equal(p.engine.snapshot().recognition.match_percent, 70);
  await p.engine.configureRecognition(true, 83);
  await p.engine.configureRecognition(false);
  assert.equal(p.saved.at(-1).recognition.match_percent, 83);
  const reopened = setup(p.saved.at(-1));
  assert.equal(reopened.engine.snapshot().recognition.match_percent, 83);
  await reopened.engine.configureRecognition(true);
  assert.equal(reopened.engine.snapshot().recognition.match_percent, 83);
  for (const value of [0, -1, 1, 49, 101, 50.5, NaN, Infinity]) {
    await assert.rejects(p.engine.configureRecognition(true, value), /50–100%/);
  }
  assert.equal(p.engine.snapshot().recognition.match_percent, 83);
  await p.engine.configureRecognition(true, 50);
  await p.engine.configureRecognition(true, 100);
  p.engine.dispose(); reopened.engine.dispose();
});

test('normal recognition uses the configured percentage and still waits for 350ms of silence', async () => {
  for (const [threshold, below, accepted] of [[50, 'ABCD', 'ABCDE'], [80, 'ABCDEFG', 'ABCDEFGH'], [100, 'ABCDEFGHI', 'ABCDEFGHIJ']]) {
    const p = setup();
    await p.engine.configureRecognition(true, threshold);
    await p.engine.importTestBatch(['A', 'B'].map(id => ({ event: p.event(id), result: reply('ABCDEFGHIJ') })));
    await p.engine.setContext(true, 'live', true);
    const vad = (quiet_ms, speaking = true) => {
      p.engine.observeVideo('live');
      p.engine.observeVad({ speaking, ended: false, healthy: true, quiet_ms }, 'live');
    };
    vad(1000, false); await p.engine.tick();
    const task = p.engine.snapshot().tasks[0];
    const observation = text => ({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text, captured_at: p.now(), inference_ms: 20 });
    await assert.rejects(p.engine.configureRecognition(true, 60), /当前播报/);
    assert.equal(p.engine.snapshot().recognition.match_percent, threshold);
    vad(0); await p.engine.observeRecognition(observation(below));
    p.advance(350); vad(350); await p.engine.tick();
    assert.deepEqual(p.spoken, ['A']);
    assert.equal(p.engine.snapshot().tasks[0].recognition.matched, false);
    vad(0); await p.engine.observeRecognition(observation(accepted));
    assert.equal(p.engine.snapshot().tasks[0].recognition.matched, true);
    assert.deepEqual(p.spoken, ['A']);
    p.advance(349); vad(349); await p.engine.tick();
    assert.deepEqual(p.spoken, ['A']);
    p.advance(1); vad(350); await p.engine.tick();
    assert.deepEqual(p.spoken, ['A', 'B']);
    assert.equal(p.engine.snapshot().history[0].task.recognition.progress * 100, threshold);
    assert.equal(p.engine.snapshot().handoff_action, undefined);
    p.engine.dispose();
  }
});

const songDirector = { stems_ready:true, vocals_path:'vocals.wav', accompaniment_path:'accompaniment.wav', pcm_ready: true, pcm_segments: [{index:0,start_ms:2000,end_ms:3000,sample_count:24000,pcm_path:'test.pcm'}], id: 'song-1', title: '测试歌曲', duration_ms: 240000, status: 'ready', available: true, cues: [{ start_ms: 2000, end_ms: 3000, text: '歌词', lead_ms: 500 }] };

async function startSong(p,active){
  await p.engine.enqueueSong(songDirector);await p.engine.setContext(false,'live',true);p.engine.observeVideo('live');await p.engine.tick();
  const song=p.engine.snapshot().tasks[0],identity={live_id:'live',task_id:song.id,playback_token:song.playback_token};
  await p.engine.observeSong({...identity,state:'started'});await p.engine.observeSongPhase({...identity,active});return identity;
}

test('song stays in slot one while lyrics discard no-action chat and execute explicit actions from slots two/three', async () => {
  const actions=[],audio=[];
  const p=setup(undefined,false,{act:async task=>actions.push(task.event.event_id),prepareAudio:async task=>{audio.push(task.id);return {state:'ready'};}});
  try{
    const song=await startSong(p,true);
    for(const id of ['A','B','C','D'])await p.engine.ingest(p.event(id));
    await p.engine.setContext(true,'live',true);
    assert.ok(p.jobs.get('A').task.action_only);assert.ok(p.jobs.get('B').task.action_only);
    p.jobs.get('A').resolve({...reply('问题A'),generation_mode:'component',intent:'question',action_instruction:'目光注视前方'});await flush();
    assert.deepEqual(p.engine.snapshot().tasks.map(t=>t.event.event_id),[p.engine.snapshot().tasks[0].event.event_id,'B','D']);
    assert.equal(actions.length,0);assert.equal(audio.length,0);
    p.jobs.get('B').resolve({...reply('问题B'),generation_mode:'component',intent:'action_request',action_instruction:'向镜头挥手'});await flush();
    assert.deepEqual(actions,['B']);assert.equal(audio.length,0);
    const state=p.engine.snapshot();assert.equal(state.tasks[0].id,song.task_id);assert.equal(state.tasks[0].status,'playing');
    assert.equal(state.tasks[1].event.event_id,'D');assert.equal(state.tasks[2].event.event_id,'C');
    assert.equal(state.history.find(h=>h.task.event.event_id==='A').outcome,'skipped');
    assert.match(state.history.find(h=>h.task.event.event_id==='B').reason,/仅执行弹幕动作/);
  }finally{p.engine.dispose();}
});

test('automatic replies off preserves the two child slots during lyrics without planning, TTS or actions', async () => {
  const actions=[],audio=[];const p=setup(undefined,false,{act:async t=>actions.push(t.id),prepareAudio:async()=>{audio.push(1);return {state:'ready'};}});
  try{
    await startSong(p,true);for(const id of ['A','B','C'])await p.engine.ingest(p.event(id));
    await p.engine.tick();assert.equal(p.jobs.size,0);assert.equal(actions.length,0);assert.equal(audio.length,0);
    assert.deepEqual(p.engine.snapshot().tasks.slice(1).map(t=>t.event.event_id),['A','B']);assert.equal(p.engine.snapshot().candidates[0].event_id,'C');
  }finally{p.engine.dispose();}
});

test('a lyric phase preempts gap speech immediately without stopping the song or sending another chat PCM', async () => {
  const speech=deferred(),spoken=[],interrupts=[],audio=[];
  const p=setup(undefined,false,{autoAnswer:false,
    speak:async task=>{if(task.song)return;spoken.push(task.event.event_id);await speech.promise;},
    interruptReply:async task=>{interrupts.push(task.id);speech.reject(new Error('播报已打断'));},
    prepareAudio:async task=>{audio.push(task.event.event_id);return {state:'ready',duration_ms:5000};},act:async()=>{},
  });
  try{
    const song=await startSong(p,false);
    for(const id of ['A','B','C','D'])await p.engine.ingest(p.event(id));
    await p.engine.setContext(true,'live',true);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true,quiet_ms:2000},'live');
    p.jobs.get('A').resolve({...reply('A'),generation_mode:'component',prepared_reply:'回答A',prepared_for_live:'live',intent:'question'});await flush();
    let state=p.engine.snapshot();assert.equal(state.tasks[1].status,'playing');assert.equal(state.tasks[1].song_parent.task_id,song.task_id);assert.deepEqual(spoken,['A']);
    const child=state.tasks[1],preparedCount=audio.length;
    await p.engine.observeSongPhase({...song,active:true});await flush();
    state=p.engine.snapshot();assert.deepEqual(interrupts,[child.id]);assert.equal(state.tasks[0].id,song.task_id);assert.equal(state.tasks[0].status,'playing');
    assert.ok(!state.tasks.some(t=>t.id===child.id));assert.equal(state.tasks[1].event.event_id,'B');assert.equal(state.tasks[2].event.event_id,'D');
    assert.equal(audio.length,preparedCount);assert.deepEqual(spoken,['A']);
  }finally{p.engine.dispose();speech.resolve();await flush();}
});

test('song ended during gap speech releases only the parent and lets its child continue as slot one', async () => {
  const speech=deferred(),stops=[],interrupted=[];
  const p=setup(undefined,false,{autoAnswer:false,speak:async t=>{if(!t.song)await speech.promise;},stopSong:async t=>stops.push(t.id),interruptReply:async t=>interrupted.push(t.id),prepareAudio:async()=>({state:'ready',duration_ms:5000})});
  try{
    const song=await startSong(p,false);await p.engine.ingest(p.event('chat'));await p.engine.setContext(true,'live',true);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true},'live');
    p.jobs.get('chat').resolve({...reply('chat'),generation_mode:'component',prepared_reply:'间奏回答',prepared_for_live:'live'});await flush();
    const child=p.engine.snapshot().tasks[1];assert.equal(child.status,'playing');
    await p.engine.observeSong({...song,state:'ended'});
    const state=p.engine.snapshot();assert.equal(state.tasks[0].id,child.id);assert.equal(state.tasks[0].status,'playing');assert.equal(state.tasks[0].song_parent,undefined);
    assert.deepEqual(stops,[song.task_id]);assert.equal(interrupted.length,0);assert.equal(state.history[0].task.id,song.task_id);
  }finally{p.engine.dispose();speech.resolve();await flush();}
});

test('FunASR completes a gap reply and advances child slots while the song stays pinned',async()=>{
  const spoken=[];
  const p=setup(undefined,false,{autoAnswer:false,prepareAudio:async()=>({state:'ready',duration_ms:2000}),speak:async task=>{
    if(task.song)return;spoken.push(task.event.event_id);
    await p.engine.observeOutput({live_id:'live',text:task.result.prepared_reply,received_at:p.now(),final:true,request_id:task.id,msg_id:'tts-'+task.id});
  }});
  try{
    await p.engine.configureRecognition(true);const song=await startSong(p,false);
    for(const id of ['A','B','C','D'])await p.engine.ingest(p.event(id));await p.engine.setContext(true,'live',true);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true},'live');
    const prepared=id=>({...reply(id),generation_mode:'component',prepared_reply:'今天一起聊聊天，祝大家开心。',prepared_for_live:'live'});
    p.jobs.get('A').resolve(prepared('A'));p.jobs.get('B').resolve(prepared('B'));await flush();
    const child=p.engine.snapshot().tasks[1];assert.equal(child.status,'playing');
    p.engine.observeVad({speaking:true,healthy:true,quiet_ms:0},'live');p.engine.observeVad({speaking:false,healthy:true,quiet_ms:0},'live');
    await p.engine.observeRecognition({live_id:'live',task_id:child.id,capture_id:child.playback_token,text:prepared('A').prepared_reply,captured_at:p.now(),inference_ms:10});await flush();
    const state=p.engine.snapshot();assert.equal(state.tasks[0].id,song.task_id);assert.equal(state.tasks[0].status,'playing');
    assert.equal(state.tasks[1].event.event_id,'B');assert.equal(state.tasks[2].event.event_id,'D');assert.equal(state.history[0].task.id,child.id);
    assert.deepEqual(spoken,['A','B']);
  }finally{p.engine.dispose();}
});

test('ending a song during an unconfirmed action never replays that action as a new spoken reply',async()=>{
  const action=deferred(),calls=[];const p=setup(undefined,false,{act:async t=>{calls.push(t.id);await action.promise;}});
  try{
    const song=await startSong(p,true);await p.engine.ingest(p.event('action'));await p.engine.setContext(true,'live',true);
    p.jobs.get('action').resolve({...reply('action'),generation_mode:'component',intent:'action_request',action_instruction:'挥手'});await flush();
    assert.equal(calls.length,1);await p.engine.observeSong({...song,state:'ended'});
    action.resolve();await flush();const state=p.engine.snapshot();assert.equal(state.tasks.length,0);assert.equal(state.history.at(-1).task.action_state,'submitted');
    assert.equal(calls.length,1);assert.equal(p.spoken.filter(id=>id==='action').length,0);
  }finally{p.engine.dispose();action.resolve();await flush();}
});

test('old song tokens cannot change the active lyric phase or discard current children', async () => {
  const p=setup();try{
    const song=await startSong(p,false);await p.engine.ingest(p.event('A'));const before=p.engine.snapshot();
    await p.engine.observeSongPhase({...song,playback_token:'old',active:true});assert.deepEqual(p.engine.snapshot(),before);
    await p.engine.observeSongPhase({...song,live_id:'old',active:true});assert.deepEqual(p.engine.snapshot(),before);
  }finally{p.engine.dispose();}
});

test('disconnecting a song with a gap reply archives both active tasks and leaves no orphan parent',async()=>{
  const speech=deferred(),stops=[];const p=setup(undefined,false,{autoAnswer:false,prepareAudio:async()=>({state:'ready',duration_ms:5000}),speak:async t=>{if(!t.song)await speech.promise;},stopSong:async t=>stops.push(t.id)});
  try{
    const song=await startSong(p,false);await p.engine.ingest(p.event('child'));await p.engine.setContext(true,'live',true);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true},'live');
    p.jobs.get('child').resolve({...reply('child'),generation_mode:'component',prepared_reply:'间奏回复',prepared_for_live:'live'});await flush();
    assert.equal(p.engine.snapshot().tasks.filter(t=>t.status==='playing').length,2);
    await p.engine.disconnectSession('live','测试断开');
    const state=p.engine.snapshot();assert.equal(state.tasks.length,0);assert.deepEqual(stops,[song.task_id]);assert.equal(state.history.length,2);assert.ok(state.history.every(h=>h.outcome==='failed'));
  }finally{p.engine.dispose();speech.resolve();await flush();}
});
test('manually queued songs start with auto replies off and no remote audio, and never generate pending chat', async () => {
  const p = setup();
  await p.engine.configureRecognition(true);
  await p.engine.setContext(false, 'live', true);
  p.engine.observeVideo('live');
  await p.engine.enqueueSong(songDirector);
  const song = p.engine.snapshot().tasks[0];
  assert.equal(song.status, 'playing'); assert.equal(song.song_playback, 'starting');
  assert.equal(p.spoken.length, 1); assert.equal(p.jobs.size, 0);
  // Ready chat behind this song must stay paused when automatic replies are off.
  await p.engine.ingest(p.event('chat-waiting'));
  await p.engine.observeSong({ live_id:'live', task_id:song.id, playback_token:song.playback_token, state:'ended' });
  assert.equal(p.jobs.size, 0); assert.equal(p.spoken.length, 1);
  p.engine.dispose();
});
test('manual songs wait for live availability and video, and never bypass an earlier uncertain task', async () => {
  const p = setup();
  await p.engine.enqueueSong(songDirector);
  await p.engine.setContext(false, 'live', false); p.engine.observeVideo('live'); await p.engine.tick();
  assert.equal(p.spoken.length, 0);
  p.advance(3000); await p.engine.setContext(false, 'live', true);
  assert.equal(p.spoken.length, 0);
  p.engine.observeVideo('live'); await p.engine.tick(); assert.equal(p.spoken.length, 1);
  const song = p.engine.snapshot().tasks[0];
  await p.engine.observeSong({ live_id:'live', task_id:song.id, playback_token:song.playback_token, state:'error', error:'audio failed' });
  await p.engine.enqueueSong({ ...songDirector, id:'next-song' });
  assert.equal(p.engine.snapshot().tasks[0].status,'uncertain'); assert.equal(p.spoken.length, 1);
  p.engine.dispose();
});
test('a manual song does not generate or speak later chat slots while automatic replies are off', async () => {
  const initial = emptyQueue();
  initial.tasks = [
    { id:'manual-song', status:'ready', song:{ id:songDirector.id, title:songDirector.title, duration_ms:songDirector.duration_ms }, event:{ event_id:'manual-song-event', type:'song', room_id:'room', user_id:'', nickname:'歌曲导播', content:'测试歌曲', created_at:100000 } },
    { id:'pending-chat', status:'pending', event:{ event_id:'pending-chat-event', type:'chat', source:'test', room_id:'room', user_id:'viewer', nickname:'观众', content:'你好', created_at:100000 } },
  ];
  const p = setup(initial); await p.engine.setContext(false,'live',true); p.engine.observeVideo('live'); await p.engine.tick();
  assert.deepEqual(p.spoken,['manual-song-event']); assert.equal(p.jobs.size,0);
  const task = p.engine.snapshot().tasks[0];
  await p.engine.observeSong({ live_id:'live', task_id:task.id, playback_token:task.playback_token, state:'ended' });
  assert.equal(p.engine.snapshot().tasks[0].status,'pending'); assert.equal(p.jobs.size,0); assert.equal(p.spoken.length,1);
  p.engine.dispose();
});
test('blocked song remains in its slot and resumes only on a matching OBS started event', async () => {
  const p = setup(); await p.engine.setContext(false,'live',true); p.engine.observeVideo('live');
  await p.engine.enqueueSong(songDirector); const task = p.engine.snapshot().tasks[0];
  const identity = { live_id:'live', task_id:task.id, playback_token:task.playback_token };
  await p.engine.observeSong({ ...identity, state:'blocked' });
  assert.equal(p.engine.snapshot().tasks[0].song_playback,'blocked'); assert.equal(p.engine.snapshot().tasks[0].status,'playing');
  await p.engine.observeSong({ ...identity, playback_token:'old', state:'started' });
  assert.equal(p.engine.snapshot().tasks[0].song_playback,'blocked');
  await p.engine.observeSong({ ...identity, state:'started' });
  assert.equal(p.engine.snapshot().tasks[0].song_playback,'playing'); p.engine.dispose();
});
test('songs remain durable beyond 60 seconds and finish only on their own original audio ended identity', async () => {
  const stops = []; const actions = [];
  const p = setup(emptyQueue(), false, { stopSong: async task => stops.push(task.id), act: async task => actions.push(task.id), handoff: async task => actions.push(task.id) });
  await p.engine.enqueueSong(songDirector);
  await p.engine.configureRecognition(true);
  await p.engine.configureHandoff(true, 'left_down');
  p.advance(31000); await p.engine.setContext(true, 'live', true);
  await p.observe(); p.advance(1600); await p.observe();
  let task = p.engine.snapshot().tasks[0]; assert.equal(task.status, 'playing'); assert.equal(p.jobs.size, 0);
  p.advance(61000); await p.observe(); assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  const identity = { task_id: task.id, playback_token: task.playback_token, live_id: 'live', state: 'ended' };
  await p.engine.observeSong({ ...identity, live_id: 'old' });
  await p.engine.observeSong({ ...identity, playback_token: 'old' });
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, text: '歌词', captured_at: p.now(), error: 'must be ignored' });
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  await p.engine.observeSong(identity);
  assert.equal(p.engine.snapshot().tasks.length, 0); assert.equal(stops.length, 1); assert.equal(actions.length, 0);
  assert.equal(p.engine.snapshot().history[0].outcome, 'played'); p.engine.dispose();
});
test('a full song queue replaces only slot three and gifts cannot displace songs', async () => {
  const p = setup();
  for (let i=0;i<3;i++) await p.engine.enqueueSong({ ...songDirector, id: 'song-'+i });
  const previous=p.engine.snapshot().tasks.map(t=>t.id);
  await p.engine.enqueueSong(songDirector);
  let state=p.engine.snapshot();
  assert.equal(state.tasks.length,3); assert.deepEqual(state.tasks.slice(0,2).map(t=>t.id),previous.slice(0,2));
  assert.equal(state.tasks[2].song.id,songDirector.id); assert.equal(state.history.at(-1).task.id,previous[2]);
  assert.equal(state.history.at(-1).outcome,'skipped');
  await p.engine.ingest(p.event('gift', 'gift', { gift: { name:'花', count:1, gift_id:'flower', combo_id:'combo', is_final:true } }));
  await p.engine.setContext(true, 'live', true);
  state=p.engine.snapshot();assert.equal(state.tasks.length,3);assert.ok(state.tasks.every(t=>t.song));
  assert.equal(state.candidates.length,1);assert.equal(p.errors.length,0);p.engine.dispose();
});
test('song playback error retains the slot as uncertain and operator skip stops the original audio', async () => {
  const stopped = [];
  const p = setup(emptyQueue(), false, { stopSong: async task => stopped.push(task.id) });
  await p.engine.enqueueSong(songDirector); await p.engine.setContext(true,'live',true);
  await p.observe(); p.advance(1600); await p.observe();
  const task = p.engine.snapshot().tasks[0];
  await p.engine.observeSong({ task_id:task.id, playback_token:task.playback_token, live_id:'live', state:'error', error:'audio missing' });
  assert.equal(p.engine.snapshot().tasks[0].status,'uncertain'); assert.equal(stopped.length,1);
  await p.engine.finish('skipped','操作员跳过'); assert.equal(stopped.length,2); assert.equal(p.engine.snapshot().history[0].outcome,'skipped');
  p.engine.dispose();
});

test('inserting a song into prepared slot three releases only the displaced PCM and preserves slots one and two', async () => {
  const retained=[],prepared=[];
  const p=setup(undefined,false,{
    prepareAudio:async task=>{prepared.push(task.id);return {state:'ready',duration_ms:2000};},
    retainAudio:async(live,tokens)=>retained.push([...tokens]),
  });
  await p.engine.importTestBatch(['A','B','C'].map(id=>({event:p.event(id),result:{...reply(id),generation_mode:'component',prepared_reply:'回答'+id,prepared_for_live:'live'}})));
  await p.engine.setContext(true,'live',true);await flush();
  const before=p.engine.snapshot().tasks;
  assert.ok(before.every(t=>t.prepared_audio?.state==='ready'));
  await p.engine.enqueueSong(songDirector);await flush();
  const state=p.engine.snapshot();
  assert.deepEqual(state.tasks.slice(0,2),before.slice(0,2));
  assert.equal(state.tasks[2].song.id,songDirector.id);assert.equal(state.history.at(-1).task.id,before[2].id);
  assert.ok(!retained.at(-1).includes(before[2].prepared_audio.token));
  assert.ok(before.slice(0,2).every(t=>retained.at(-1).includes(t.prepared_audio.token)));
  assert.equal(prepared.length,3);assert.equal(p.jobs.size,0);assert.equal(p.spoken.length,0);
  assert.ok(!state.candidates.some(e=>e.event_id==='C'));
  p.engine.dispose();
});

test('a replaced generating slot cannot accept its late reply or displace the inserted song', async () => {
  const p=setup();await p.engine.setContext(true,'live',true);
  for(const id of ['A','B','C'])await p.engine.ingest(p.event(id));
  p.jobs.get('B').resolve(reply('B answer'));await flush();assert.ok(p.jobs.has('C'));
  const before=p.engine.snapshot().tasks;
  await p.engine.enqueueSong(songDirector);
  p.jobs.get('C').resolve(reply('discarded late answer'));await flush();
  const state=p.engine.snapshot();
  assert.deepEqual(state.tasks.slice(0,2).map(t=>t.id),before.slice(0,2).map(t=>t.id));
  assert.equal(state.tasks[2].song.id,songDirector.id);
  assert.ok(!state.tasks.some(t=>t.result?.speech==='discarded late answer'));
  assert.equal(state.history.at(-1).task.id,before[2].id);assert.equal(p.spoken.length,0);p.engine.dispose();
});

test('invalid songs never discard the original third slot', async () => {
  const p=setup();for(const id of ['A','B','C'])await p.engine.ingest(p.event(id));
  const before=p.engine.snapshot();
  await assert.rejects(p.engine.enqueueSong({...songDirector,pcm_ready:false}),/截取歌词PCM/);
  assert.deepEqual(p.engine.snapshot(),before);p.engine.dispose();
});


test('text_msg completion matches the type=10 answer instead of the sent prompt', async () => {
  const p = setup(undefined, false, { autoAnswer: false });
  await p.engine.configureRecognition(true, 100);
  await p.engine.importTestBatch([{ event: p.event('宝子'), result: reply('来，头发往上拢一拢，扎个高马尾给你看看，这样是不是精神多了？') }]);
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  const vad = (speaking, quiet_ms) => { p.engine.observeVideo('live'); p.engine.observeVad({ speaking, quiet_ms, ended: quiet_ms >= 900, healthy: true }, 'live'); };
  const heard = text => ({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text, captured_at: p.now(), inference_ms: 20 });
  vad(true, 0); await p.engine.observeRecognition(heard(task.result.speech));
  assert.equal(p.engine.snapshot().tasks[0].recognition.progress, 0);
  p.advance(350); vad(false, 350);
  const answer = '好呀，我已经扎好高马尾了，宝子觉得怎么样？';
  await p.engine.observeOutput(outputExports.parseAvatarOutput({ type: 10, live_id: 'live', received_at: p.now(), payload: { text_msg: { content: answer, msg_id: 'response-1' } } }));
  assert.equal(p.engine.snapshot().tasks[0].answer.text, answer);
  assert.ok(p.engine.snapshot().tasks[0].recognition.progress < 1);
  await p.engine.observeRecognition(heard(answer));
  assert.equal(p.engine.snapshot().tasks.length, 0);
  const completed = p.engine.snapshot().history[0].task;
  assert.equal(completed.result.speech, task.result.speech);
  assert.equal(completed.answer.text, answer);
  assert.equal(completed.recognition.progress, 1);
  assert.equal(p.saved.at(-1).history[0].task.answer.text, answer);
  p.engine.dispose();
});

test('audio recognition received before type=10 is rechecked against the actual output', async () => {
  const p = setup(undefined, false, { autoAnswer: false });
  await p.engine.configureRecognition(true, 100);
  await p.engine.importTestBatch([{ event: p.event('A'), result: reply('请介绍自己') }]);
  await p.engine.setContext(true, 'live', true);
  p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 1000 }, 'live'); await p.engine.tick();
  const task = p.engine.snapshot().tasks[0];
  const answer = '我是晚晚，欢迎来到直播间。';
  p.engine.observeVad({ speaking: true, ended: false, healthy: true, quiet_ms: 0 }, 'live');
  await p.engine.observeRecognition({ live_id: 'live', task_id: task.id, capture_id: task.playback_token, enabled: true, text: answer, captured_at: p.now(), inference_ms: 20 });
  assert.equal(p.engine.snapshot().tasks[0].recognition.matched, false);
  await p.engine.observeOutput({ live_id: 'live', text: answer, received_at: p.now(), final: false });
  assert.equal(p.engine.snapshot().tasks[0].recognition.progress, 1);
  p.advance(350); p.engine.observeVideo('live'); p.engine.observeVad({ speaking: false, ended: false, healthy: true, quiet_ms: 350 }, 'live'); await p.engine.tick();
  assert.equal(p.engine.snapshot().tasks.length, 1); // An explicitly partial transcript cannot confirm completion.
  await p.engine.observeOutput({ live_id: 'live', text: answer, received_at: p.now(), final: true });
  assert.equal(p.engine.snapshot().history[0].task.recognition.matched, true);
  p.engine.dispose();
});

test('output fragments persist once and late old replies cannot contaminate the next slot or session', async () => {
  const p = setup(undefined, false, { autoAnswer: false });
  await p.engine.configureRecognition(true);
  await p.engine.importTestBatch(['A', 'B'].map(id => ({ event: p.event(id), result: reply('发送内容') })));
  await p.engine.setContext(true, 'live', true);
  await p.observe(); p.advance(1600); await p.observe();
  const first = p.engine.snapshot().tasks[0];
  const output = extra => ({ live_id: 'live', text: '你好', received_at: p.now(), msg_id: 'response-a', ...extra });
  for (const rejected of [{ live_id: 'old' }, { received_at: first.started_at - 1 }, { received_at: p.now() + 1001 }, { request_id: 'wrong-task' }, { msg_id: 'tts-wrong-task' }]) await p.engine.observeOutput(output(rejected));
  assert.equal(p.engine.snapshot().tasks[0].answer, undefined);
  await p.engine.observeOutput(output({}));
  const writes = p.saved.length;
  await p.engine.observeOutput(output({}));
  assert.equal(p.saved.length, writes);
  p.advance(1);
  await p.engine.observeOutput(output({ text: '你好，欢迎来到直播间。' }));
  p.advance(1); await p.engine.observeOutput(output({ text: '欢迎来到直播间。' }));
  assert.equal(p.engine.snapshot().tasks[0].answer.text, '你好，欢迎来到直播间。');
  await p.engine.finish('played', '人工确认');
  p.advance(1600); await p.observe(); p.advance(1600); await p.observe();
  const second = p.engine.snapshot().tasks[0];
  assert.equal(second.event.event_id, 'B'); assert.equal(second.status, 'playing');
  await p.engine.observeOutput(output({ text: '上一条回答的迟到结果' }));
  await p.engine.observeOutput(output({ msg_id: 'tts-' + first.id }));
  assert.equal(p.engine.snapshot().tasks[0].answer, undefined);
  await p.engine.observeOutput(output({ msg_id: 'response-b', text: '这是第二条回答' }));
  await p.engine.setContext(true, 'new-live', true);
  await p.engine.observeOutput({ live_id: 'new-live', text: '新会话的声音', received_at: p.now() });
  assert.equal(p.engine.snapshot().tasks[0].answer.text, '这是第二条回答');
  assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  assert.equal(p.engine.snapshot().history.length, 1);
  const restored = setup(p.engine.snapshot());
  assert.equal(restored.engine.snapshot().tasks[0].answer.text, '这是第二条回答');
  assert.equal(restored.engine.snapshot().tasks[0].status, 'uncertain');
  p.engine.dispose(); restored.engine.dispose();
});


test('manual text messages share FIFO priority and interruption', async () => {
  const p = setup(); const sent = [];
  const m = operator(p, async (content, liveId) => sent.push({ content, liveId }));
  await p.engine.importTestBatch([{ event: p.event('A'), result: reply('自动回复') }]);
  await p.engine.setContext(true, 'live', true);
  m.manual.enqueue('文本消息草稿', 'live');
  m.manual.enqueue('只聊聊天', 'live');
  assert.equal(m.questions().length, 2);
  await m.idle();
  assert.deepEqual(sent, [{ content: '文本消息草稿', liveId: 'live' }]);
  m.voice(); await m.idle(2600); await m.manual.tick('live', true);
  assert.equal(sent[1].content, '只聊聊天');
  assert.equal(p.spoken.length, 0);
  m.manual.enqueue('下一条文本消息', 'live');
  m.manual.cancel();
  await m.idle(); assert.equal(sent.length, 2); assert.equal(m.questions().length, 0);
  p.engine.dispose();
});


test('restoring old prepared answers regenerates only unsent interactions', () => {
  const initial = emptyQueue();
  const event = type => ({ event_id: type, type, nickname: '观众', content: '你好' });
  const old = { speech: '没有哦，一个人挺自在。', emotion: 'happy', segments: [] };
  initial.tasks = [
    { id: 'old-chat', event: event('chat'), status: 'ready', result: old, answer: { text: '旧残留' }, action_state: 'failed', error: '旧错误' },
    { id: 'old-gift', event: event('gift'), status: 'ready', result: old },
    { id: 'sent', event: event('gift'), status: 'playing', result: old, answer: { text: '已收到礼物' } },
    { id: 'new', event: event('chat'), status: 'ready', result: reply('小宇问你有没有男朋友，你该如何回答？') },
    { id: 'song', event: event('song'), status: 'ready', song: { id: 'song', title: '测试', duration_ms: 1000 } },
  ];
  initial.history = [{ task: { id: 'history', event: event('chat'), result: old }, outcome: 'played' }];
  const p = setup(initial);
  const state = p.engine.snapshot();
  for (const task of state.tasks.slice(0, 2)) {
    assert.equal(task.status, 'pending'); assert.equal(task.result, undefined);
    assert.equal(task.answer, undefined); assert.equal(task.action_state, undefined); assert.equal(task.error, undefined);
  }
  assert.equal(state.tasks[2].status, 'uncertain'); assert.equal(state.tasks[2].answer.text, '已收到礼物');
  assert.equal(state.deferred_tasks[0].status, 'ready'); assert.equal(state.deferred_tasks[0].result.generation_mode, 'question');
  assert.equal(state.deferred_tasks[1].status, 'ready'); assert.equal(state.history[0].task.result.speech, old.speech);
  p.engine.dispose();
});

test('response style context uses actual avatar answers and excludes archived questions or old drafts', async () => {
  const initial = emptyQueue();
  initial.history = ['actual', 'question-only', 'old-answer-draft'].map((id, index) => ({
    task: { id, event: { user_id: id, nickname: '阿豪' }, result: reply(index === 1 ? '阿豪送了礼物，你如何谢谢他？' : '旧模型生成内容'), ...(index === 0 ? { answer: { text: '阿豪，谢谢你的心意。' } } : {}) },
    outcome: 'played',
  }));
  const p = setup(initial);
  await p.engine.importTestBatch([{ event: p.event('new') }]);
  await p.engine.setContext(true, 'live', true);
  assert.deepEqual(Array.from(p.jobs.get('new').diversity.recentOpenings), ['观众，谢谢你的心意。']);
  assert.equal(p.jobs.get('new').history.length, 0);
  p.engine.dispose();
});


test('component replies survive sentence pauses and finish only after all PCM plus healthy downlink silence', async () => {
  let sent;
  const p = setup(emptyQueue(), false, { autoAnswer: false, speak: () => new Promise(resolve => { sent = resolve; }) });
  await p.engine.importTestBatch([{ event: p.event('component'), result: { ...reply('原始问题'), generation_mode: 'component', request: '{}' } }]);
  await p.engine.setContext(true, 'live', true);
  await p.observe(); p.advance(1600); const playing = p.observe(); await flush();
  let task = p.engine.snapshot().tasks[0]; assert.equal(task.status, 'playing');
  await p.engine.observeOutput({ live_id: 'live', text: '第一句。', received_at: p.now(), request_id: task.id, final: false });
  p.engine.observeVad({ speaking: true, healthy: true, ended: false, quiet_ms: 0 }, 'live');
  p.advance(2500); p.engine.observeVideo('live');
  p.engine.observeVad({ speaking: false, healthy: true, ended: true, quiet_ms: 2500 }, 'live');
  await p.engine.tick(); assert.equal(p.engine.snapshot().history.length, 0);
  await p.engine.observeOutput({ live_id: 'live', text: '第一句。第二句。', received_at: p.now(), request_id: task.id, final: true });
  await p.engine.tick(); assert.equal(p.engine.snapshot().history.length, 0);
  sent(); await playing; await flush();
  assert.ok(p.engine.snapshot().tasks[0].audio_sent_at);
  p.advance(1700); p.engine.observeVideo('live');
  p.engine.observeVad({ speaking: false, healthy: false, ended: true, quiet_ms: 1700 }, 'live');
  await p.engine.tick(); assert.equal(p.engine.snapshot().history.length, 0);
  p.engine.observeVad({ speaking: true, healthy: true, ended: false, quiet_ms: 0 }, 'live');
  p.advance(1300); p.engine.observeVideo('live');
  p.engine.observeVad({ speaking: false, healthy: true, ended: true, quiet_ms: 1300 }, 'live');
  await p.engine.tick(); assert.equal(p.engine.snapshot().history[0].outcome, 'played');
  p.engine.dispose();
});


test('closing TTS preserves the current speech for confirmation and pauses later replies', async () => {
  const p = setup();
  await p.engine.importTestBatch([{ event:p.event('tts-current'), result:reply('第一条') }, { event:p.event('tts-next'), result:reply('第二条') }]);
  await p.engine.setContext(true, 'live', true);
  await p.observe(); p.advance(1600); await p.observe();
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
  await p.engine.speechUnavailable('服务已关闭');
  assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  assert.equal(p.engine.snapshot().tasks[0].error, '服务已关闭');
  assert.equal(p.engine.snapshot().history.length, 0);
  await p.engine.finish('skipped', '人工确认跳过');
  await p.observe(); p.advance(1600); await p.observe();
  assert.equal(p.spoken.length, 1); assert.equal(p.engine.snapshot().tasks[0].event.event_id, 'tts-next');
  p.engine.dispose();
});

test('closing TTS leaves original song PCM playback running', async () => {
  let stopped = 0;
  const p = setup(emptyQueue(), false, { stopSong: async () => { stopped++; } });
  await p.engine.setContext(false, 'live', true);
  await p.engine.enqueueSong(songDirector); p.engine.observeVideo('live'); await p.engine.tick();
  const before = p.engine.snapshot().tasks[0]; assert.equal(before.status, 'playing');
  await p.engine.speechUnavailable('服务已关闭');
  assert.equal(p.engine.snapshot().tasks[0].status, 'playing'); assert.equal(stopped, 0);
  p.engine.dispose();
});

test('all three answers keep generating and PCM prepares while the first slot is still transmitting', async () => {
  const audio = new Map(), retained = [], started = [], playback = deferred();
  const p = setup(undefined, false, {
    prepareAudio: task => { const job=deferred();audio.set(task.event.event_id,{...job,token:task.prepared_audio.token});return job.promise; },
    retainAudio: async (live,tokens) => retained.push({live,tokens:[...tokens]}),
    speak: async task => { started.push(task.event.event_id); assert.ok(task.result.prepared_reply);assert.equal(task.prepared_audio.state,'ready');await playback.promise; },
  });
  const ids=['A','B','C'];
  const prepared=id=>({...reply(id),generation_mode:'component',prepared_reply:`回答${id}。`,prepared_for_live:'live'});
  try {
    await p.engine.importTestBatch(ids.map(id=>({event:p.event(id)})));
    await p.engine.setContext(true,'live',true);
    assert.equal(p.jobs.size,2);
    p.jobs.get('A').resolve(prepared('A'));p.jobs.get('B').resolve(prepared('B'));await flush();
    assert.equal(audio.size,1);assert.ok(audio.has('A'));assert.equal(started.length,0);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true,quiet_ms:2000},'live');
    audio.get('A').resolve({state:'ready',duration_ms:3000});await flush();
    assert.deepEqual(started,['A']);assert.ok(audio.has('B'));
    // This must run despite the first native PCM send still awaiting completion.
    p.jobs.get('C').resolve(prepared('C'));await flush();
    const state=p.engine.snapshot();assert.equal(state.tasks[0].status,'playing');
    for(const task of state.tasks){assert.ok(task.result.prepared_reply);assert.equal(task.answer,undefined);}
    for(const id of ['D','E','F']) await p.engine.ingest(p.event(id));
    const after=p.engine.snapshot();
    assert.deepEqual(after.tasks.map(t=>t.id),state.tasks.map(t=>t.id));
    assert.deepEqual(after.tasks.map(t=>t.prepared_audio?.token),state.tasks.map(t=>t.prepared_audio?.token));
    assert.deepEqual(after.tasks.map(t=>t.result.prepared_reply),state.tasks.map(t=>t.result.prepared_reply));
    assert.equal(p.jobs.size,3);
    assert.deepEqual(started,['A']);assert.ok(retained.some(r=>r.tokens.includes(audio.get('B').token)));
  } finally { p.engine.dispose();playback.resolve();for(const job of audio.values())job.resolve({state:'cancelled'});await flush(); }
});

test('busy TTS leaves prepared text visible, retries only when idle, and never regenerates on playback', async () => {
  const tokens=[],spoken=[];
  const p=setup(undefined,false,{
    prepareAudio: async task=>{tokens.push(task.prepared_audio.token);return tokens.length===1?{state:'busy'}:{state:'ready',duration_ms:2000};},
    retainAudio: async()=>{}, speak:async task=>spoken.push(task.result.prepared_reply),
  });
  try {
    await p.engine.importTestBatch([{event:p.event('A')}]);await p.engine.setContext(true,'live',true);
    p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true},'live');
    p.jobs.get('A').resolve({...reply('原问题'),generation_mode:'component',prepared_reply:'预先生成的答案。',prepared_for_live:'live'});await flush();
    assert.equal(tokens.length,1);assert.equal(p.engine.snapshot().tasks[0].result.prepared_reply,'预先生成的答案。');assert.equal(spoken.length,0);
    p.advance(200);await p.engine.tick();assert.equal(tokens.length,1);
    p.advance(100);await p.engine.tick();await flush();
    assert.equal(tokens.length,2);assert.notEqual(tokens[0],tokens[1]);assert.equal(p.jobs.size,1);
    assert.deepEqual(spoken,['预先生成的答案。']);
  } finally {p.engine.dispose();}
});

test('skipping and regenerating drop cache handles and reject late prepared PCM', async () => {
  const audio=new Map(),retained=[],spoken=[];
  const p=setup(undefined,false,{
    prepareAudio:task=>{const job=deferred();audio.set(task.event.event_id,{...job,token:task.prepared_audio.token});return job.promise;},
    retainAudio:async(live,tokens)=>retained.push([...tokens]),speak:async task=>spoken.push(task.event.event_id),
  });
  try {
    await p.engine.importTestBatch(['A','B'].map(id=>({event:p.event(id)})));await p.engine.setContext(true,'live',true);
    for(const id of ['A','B'])p.jobs.get(id).resolve({...reply(id),generation_mode:'component',prepared_reply:`回答${id}。`,prepared_for_live:'live'});
    await flush();const oldA=audio.get('A');
    await p.engine.skip(p.engine.snapshot().tasks[0].id);await flush();
    assert.ok(!retained.at(-1).includes(oldA.token));
    oldA.resolve({state:'ready'});await flush();assert.ok(audio.has('B'));
    const oldB=audio.get('B');await p.engine.retry(p.engine.snapshot().tasks[0].id);await flush();
    assert.ok(!retained.at(-1).includes(oldB.token));oldB.resolve({state:'ready'});await flush();
    assert.equal(p.engine.snapshot().tasks[0].prepared_audio,undefined);assert.equal(p.engine.snapshot().tasks[0].result,undefined);assert.deepEqual(spoken,[]);
  } finally {p.engine.dispose();for(const job of audio.values())job.resolve({state:'cancelled'});await flush();}
});

test('an old live cannot overwrite new background answers and restored PCM handles are not reused', async () => {
  const p=setup(undefined,false,{prepareAudio:async()=>({state:'busy'}),retainAudio:async()=>{}});
  try {
    await p.engine.importTestBatch(['A','B'].map(id=>({event:p.event(id)})));await p.engine.setContext(true,'live',true);
    const oldA=p.jobs.get('A'),oldB=p.jobs.get('B');await p.engine.setContext(true,'new-live',true);
    oldA.resolve({...reply('wrong'),generation_mode:'component',prepared_reply:'旧会话错误答案',prepared_for_live:'live'});
    oldB.resolve({...reply('wrong'),generation_mode:'component',prepared_reply:'旧会话错误答案',prepared_for_live:'live'});await flush();
    assert.notEqual(p.jobs.get('A'),oldA);assert.equal(p.engine.snapshot().tasks[0].result,undefined);
    const snapshot=emptyQueue();snapshot.tasks=[{id:'restored',event:p.event('A'),status:'ready',result:{...reply('A'),generation_mode:'component',prepared_reply:'已生成台词',prepared_for_live:'live'},prepared_audio:{token:'obsolete-native-handle',state:'ready',live_id:'live'}}];
    const restored=setup(snapshot,false,{prepareAudio:async()=>({state:'busy'}),retainAudio:async()=>{}});
    assert.equal(restored.engine.snapshot().tasks[0].prepared_audio,undefined);restored.engine.dispose();
  } finally {p.engine.dispose();}
});

test('changing voice discards late PCM and reuses the prepared answer without another model request', async () => {
  const audio=[],retained=[];
  const p=setup(undefined,false,{
    prepareAudio:task=>{const job=deferred();audio.push({...job,token:task.prepared_audio.token,text:task.result.prepared_reply});return job.promise;},
    retainAudio:async(live,tokens)=>retained.push([...tokens]),
  });
  try {
    await p.engine.importTestBatch([{event:p.event('A')}]);await p.engine.setContext(true,'live',true);
    p.jobs.get('A').resolve({...reply('原问题'),generation_mode:'component',prepared_reply:'同一句话换个音色。',prepared_for_live:'live'});await flush();
    assert.equal(audio.length,1);const obsolete=audio[0];
    await p.engine.invalidatePreparedAudio();await flush();
    assert.ok(!retained.at(-1).includes(obsolete.token));
    obsolete.resolve({state:'ready',duration_ms:1000});await flush();
    assert.equal(audio.length,2);assert.notEqual(audio[1].token,obsolete.token);assert.equal(audio[1].text,obsolete.text);
    assert.equal(p.jobs.size,1);assert.equal(p.engine.snapshot().tasks[0].prepared_audio.state,'preparing');
    audio[1].resolve({state:'ready',duration_ms:2000});await flush();
    assert.equal(p.engine.snapshot().tasks[0].prepared_audio.token,audio[1].token);
    assert.equal(p.engine.snapshot().tasks[0].prepared_audio.duration_ms,2000);
    assert.equal(p.spoken.length,0);
  } finally {p.engine.dispose();for(const job of audio)job.resolve({state:'cancelled'});await flush();}
});

async function startRecognizedComponent(text, extras={}) {
  const p=setup(undefined,false,{autoAnswer:false,...extras});
  await p.engine.configureRecognition(true,70);
  await p.engine.importTestBatch([{event:p.event('component'),result:{...reply('原问题'),generation_mode:'component',prepared_reply:text,prepared_for_live:'live'}}]);
  await p.engine.setContext(true,'live',true);
  p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:false,healthy:true,quiet_ms:0},'live');
  const sending=p.engine.tick();await flush();
  const task=p.engine.snapshot().tasks[0];
  const output=(speech,final=true)=>p.engine.observeOutput({live_id:'live',request_id:task.id,text:speech,received_at:p.now(),final});
  const heard=(speech,extra={})=>p.engine.observeRecognition({live_id:'live',task_id:task.id,capture_id:task.playback_token,enabled:true,text:speech,captured_at:p.now(),inference_ms:20,...extra});
  const media=(speaking=true,healthy=true)=>{p.engine.observeVideo('live');p.engine.observeVad({speaking,ended:false,healthy,quiet_ms:0},'live');};
  return {...p,task,sending,output,heard,media};
}

test('slot timeout includes the configured PCM delay instead of expiring during the scheduled playback window', async () => {
  const pending = deferred();
  const p = await startRecognizedComponent('这是一段等待播放的回答。', {
    playbackTiming: () => ({ send_delay_ms: 5000, play_delay_ms: 10000 }),
    speak: () => pending.promise,
  });
  try {
    p.advance(61000); p.media(false); await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].status, 'playing');
    p.advance(9001); p.media(false); await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].status, 'uncertain');
  } finally { pending.resolve(); await p.sending; p.engine.dispose(); }
});

test('FunASR confirms a component ending without waiting for 1.5 seconds or the silence window', async () => {
  const text='欢迎大家来到直播间，今天一起轻松聊聊天。';
  const p=await startRecognizedComponent(text);
  try {
    await p.sending;await p.output(text);p.media();
    await p.heard(text);
    const state=p.engine.snapshot();assert.equal(state.tasks.length,0);assert.equal(state.history[0].outcome,'played');
    assert.match(state.history[0].reason,/FunASR/);assert.equal(state.history[0].task.recognition.ending_matched,true);
    assert.equal(p.now()-state.history[0].task.audio_sent_at,0);
  } finally {p.engine.dispose();}
});

test('a component cannot complete from a first-sentence match, omitted final words or VAD silence alone', async () => {
  const text='先跟你打个招呼。接下来甲乙丙丁戊己庚辛壬癸。';
  const p=await startRecognizedComponent(text);
  try {
    await p.sending;p.media();await p.output('先跟你打个招呼。',false);await p.heard('先跟你打个招呼。');
    assert.equal(p.engine.snapshot().tasks[0].status,'playing');assert.equal(p.engine.snapshot().tasks[0].recognition.matched,false);
    await p.output(text);await p.heard('甲乙丙丁戊己庚');
    assert.equal(p.engine.snapshot().tasks[0].recognition.progress,0.7);assert.equal(p.engine.snapshot().tasks[0].recognition.ending_matched,false);
    p.advance(2000);p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:true,healthy:true,quiet_ms:2000},'live');await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].status,'playing');
    await p.heard('甲乙丙丁戊己庚辛壬癸');assert.equal(p.engine.snapshot().history[0].outcome,'played');
  } finally {p.engine.dispose();}
});

test('component ending evidence must follow all PCM writes and belong to the current healthy capture', async () => {
  const sent=deferred(),text='这是完整回答，最后祝你每天都开开心心。';
  const p=await startRecognizedComponent(text,{speak:()=>sent.promise});
  try {
    p.media();await p.output(text);await p.heard(text);assert.equal(p.engine.snapshot().tasks[0].status,'playing');
    p.advance(1);sent.resolve();await p.sending;await flush();
    assert.equal(p.engine.snapshot().tasks[0].status,'playing'); // The earlier capture cannot finish after a late send acknowledgement.
    p.media();
    for(const extra of [{live_id:'other'},{task_id:'other'},{capture_id:'other'},{captured_at:p.task.started_at-1}]) await p.heard(text,extra);
    assert.equal(p.engine.snapshot().tasks[0].status,'playing');
    p.media(true,false);await p.heard(text);assert.equal(p.engine.snapshot().tasks[0].status,'playing');
    p.media();p.advance(2100);await p.heard(text);assert.equal(p.engine.snapshot().tasks[0].status,'playing'); // Media is stale.
    p.media();await p.heard(text);assert.equal(p.engine.snapshot().history[0].outcome,'played');
  } finally {p.engine.dispose();sent.resolve();await p.sending;}
});

test('FunASR failure keeps the component slot for confirmation instead of falling back to silence', async () => {
  const p=await startRecognizedComponent('欢迎来到直播间，祝大家晚上开心。');
  try {
    await p.sending;p.media();await p.output(p.task.result.prepared_reply);
    await p.heard('',{error:'FunASR unavailable'});
    assert.equal(p.engine.snapshot().tasks[0].status,'uncertain');assert.equal(p.engine.snapshot().history.length,0);
    p.advance(3000);p.engine.observeVideo('live');p.engine.observeVad({speaking:false,ended:true,healthy:true,quiet_ms:3000},'live');await p.engine.tick();
    assert.equal(p.engine.snapshot().tasks[0].status,'uncertain');
  } finally {p.engine.dispose();}
});

test('each component slot owns its handoff and reply delay, with no end-of-previous-slot wait', async () => {
  const starts=[],legacyHandoffs=[];
  let timing={send_delay_ms:500,play_delay_ms:800};
  const p=setup(undefined,false,{
    playbackTiming:()=>({...timing}),
    autoAnswer:false,prepareAudio:async()=>({state:'ready',duration_ms:2000}),retainAudio:async()=>{},
    speak:async(task,live)=>{
      starts.push(structuredClone(task));
      await p.engine.observeOutput({live_id:live,request_id:task.id,text:task.result.prepared_reply,received_at:p.now(),final:true});
    },
    handoff:async task=>legacyHandoffs.push(task.id),
  });
  const media=(speaking=false)=>{p.engine.observeVideo('live');p.engine.observeVad({speaking,ended:false,healthy:true,quiet_ms:0},'live');};
  try {
    await p.engine.configureRecognition(true,70);await p.engine.configureHandoff(true,'right_down',3000,35);
    await p.engine.configureHandoffActionDelay(300);
    await p.engine.configureReplyActionDelay(500);
    const prepared=id=>({...reply('原问题'+id),generation_mode:'component',prepared_for_live:'live',prepared_reply:'这是给观众'+id+'的回答，最后祝你每天都开开心心。'});
    await p.engine.importTestBatch(['A','B'].map(id=>({event:p.event(id),result:prepared(id)})));
    await p.engine.setContext(true,'live',true);await flush();media();await p.engine.tick();await flush();
    assert.equal(starts.length,1);const first=starts[0];
    assert.equal(first.handoff_action.direction,'right_down');assert.equal(first.handoff_action.angle_deg,35);assert.equal(first.reply_action_delay_ms,500);
    assert.equal(first.handoff_action_delay_ms,300);
    assert.equal(first.pcm_timing.send_delay_ms,500);assert.equal(first.pcm_timing.play_delay_ms,800);
    const second=p.engine.snapshot().tasks[1];assert.equal(second.handoff_action.status,'waiting');assert.equal(second.prepared_audio.state,'ready');
    // Settings affect future slots, never the active slot's frozen action schedule.
    await p.engine.configureReplyActionDelay(0);
    await p.engine.configureHandoffActionDelay(900);
    assert.equal(p.engine.snapshot().tasks[0].handoff_action_delay_ms,300);
    assert.equal(p.engine.snapshot().tasks[1].handoff_action_delay_ms,900);
    timing={send_delay_ms:1000,play_delay_ms:1500};
    assert.equal(p.engine.snapshot().tasks[0].pcm_timing.play_delay_ms,800);
    assert.equal(p.engine.snapshot().tasks[0].reply_action_delay_ms,500);assert.equal(p.engine.snapshot().tasks[1].reply_action_delay_ms,0);
    media(true);
    const heard={live_id:'live',task_id:first.id,capture_id:first.playback_token,enabled:true,text:first.result.prepared_reply,captured_at:p.now(),inference_ms:20};
    await p.engine.observeRecognition(heard);await flush();
    assert.equal(starts.length,2);assert.equal(starts[1].event.event_id,'B');assert.equal(starts[1].reply_action_delay_ms,0);
    assert.equal(starts[1].handoff_action_delay_ms,900);
    assert.equal(starts[1].pcm_timing.send_delay_ms,1000);assert.equal(starts[1].pcm_timing.play_delay_ms,1500);
    assert.equal(starts[1].started_at,first.audio_sent_at ?? first.started_at); // No 3000ms legacy cooldown.
    assert.equal(starts[1].handoff_action.status,'pending');assert.deepEqual(legacyHandoffs,[]);
    assert.equal(p.engine.snapshot().history.length,1);assert.equal(p.engine.snapshot().handoff_action,undefined);
    await p.engine.observeRecognition(heard);assert.equal(starts.length,2);
  } finally {p.engine.dispose();}
});

test('per-slot action observations reject late callbacks and persist delay across reopening', async () => {
  const p=await startRecognizedComponent('这是完整回答，祝你天天开开心心。');
  try {
    await p.sending;
    await p.engine.configureReplyActionDelay(500);
    await p.engine.configureHandoffActionDelay(300);
    const reopened=setup(p.engine.snapshot());assert.equal(reopened.engine.snapshot().reply_action_delay_ms,500);assert.equal(reopened.engine.snapshot().handoff_action_delay_ms,300);reopened.engine.dispose();
    for(const delay of [-1,60001,0.5,NaN]) {
      await assert.rejects(p.engine.configureReplyActionDelay(delay),/0–60000/);
      await assert.rejects(p.engine.configureHandoffActionDelay(delay),/0–60000/);
    }
    const update={live_id:'live',task_id:p.task.id,playback_token:p.task.playback_token,kind:'reply',state:'submitted'};
    for(const extra of [{live_id:'old'},{task_id:'old'},{playback_token:'old'}]) await p.engine.observeSlotAction({...update,...extra});
    assert.equal(p.engine.snapshot().tasks[0].action_state,'pending');
    await p.engine.observeSlotAction(update);assert.equal(p.engine.snapshot().tasks[0].action_state,'submitted');
    await p.engine.finish('skipped','操作员跳过');
    await p.engine.observeSlotAction({...update,state:'failed',error:'late'});
    assert.equal(p.engine.snapshot().history[0].task.action_state,'submitted');
  } finally {p.engine.dispose();}
});


test('concurrent component replies are checked at commit time and duplicates never reach TTS before rewriting', async () => {
  const rewrites=[],tts=[];
  const p=setup(undefined,false,{
    autoAnswer:false,prepareAudio:async task=>{tts.push(task.result.prepared_reply);return {state:'ready'};},retainAudio:async()=>{},
    rewriteReply:(task,draft,history,diversity)=>{const job=deferred();rewrites.push({...job,task,draft,history,diversity});return job.promise;},
  });
  const prepared=(id,text)=>({...reply(id),generation_mode:'component',prepared_reply:text,prepared_for_live:'live',gesture:'heart'});
  try {
    await p.engine.importTestBatch(['A','B'].map(id=>({event:p.event(id)})));await p.engine.setContext(true,'live',true);
    assert.deepEqual(Array.from(p.jobs.get('A').diversity.recentOpenings),[]);assert.deepEqual(Array.from(p.jobs.get('B').diversity.recentOpenings),[]);
    p.jobs.get('A').resolve(prepared('A','哎呀，这五朵玫瑰一送过来，直播间都香起来啦。'));
    p.jobs.get('B').resolve(prepared('B','哎呀，怎么啦，这是来打听姐姐的感情八卦呀？'));await flush();
    assert.equal(rewrites.length,1);assert.equal(p.engine.snapshot().tasks[1].status,'generating');assert.match(p.engine.snapshot().tasks[1].generation_note,/开头重复/);
    assert.equal(tts.length,1);assert.equal(rewrites[0].history.length,0);assert.match(rewrites[0].diversity.recentOpenings[0],/^哎呀/);
    rewrites[0].resolve({...rewrites[0].draft,prepared_reply:'专门来打听姐姐的感情八卦啦？'});await flush();
    assert.equal(p.engine.snapshot().tasks[1].status,'ready');assert.equal(p.engine.snapshot().tasks[1].generation_note,undefined);
    assert.equal(tts.length,2);assert.match(tts[1],/^专门/);assert.equal(p.engine.snapshot().tasks[1].result.gesture,'heart');
  } finally {p.engine.dispose();for(const job of rewrites)job.resolve({...job.draft,prepared_reply:'迟到结果'});await flush();}
});

test('restored duplicate ready replies are rewritten before synthesis and repeated rewrite failures stay visible', async () => {
  const initial=emptyQueue();initial.tasks=['A','B'].map((id,i)=>({id,event:{event_id:id,type:'chat',nickname:id,user_id:id,content:id,created_at:100000,source:'test'},status:i?'ready':'uncertain',live_id:'live',
    result:{...reply(id),generation_mode:'component',prepared_reply:'哎呀，这个问题很有意思。',prepared_for_live:'live'},prepared_audio:{token:'obsolete',live_id:'live',state:'ready'}}));
  const tts=[],rewrites=[];
  const p=setup(initial,false,{prepareAudio:async task=>{tts.push(task.id);return {state:'ready'};},retainAudio:async()=>{},rewriteReply:async(task,draft)=>{rewrites.push(task.id);return {...draft,prepared_reply:'哎哟，这个问题很有意思。'};}});
  try {
    await p.engine.setContext(true,'live',true);await flush();
    assert.equal(rewrites.length,3);assert.deepEqual(tts,[]);const task=p.engine.snapshot().tasks[1];
    assert.equal(task.status,'failed');assert.match(task.error,/开头连续重复/);assert.equal(task.prepared_audio,undefined);
    assert.equal(p.engine.snapshot().tasks[0].status,'uncertain');
  } finally {p.engine.dispose();}
});

test('a skipped slot cannot accept a late rewritten reply or synthesize its discarded PCM', async () => {
  const initial=emptyQueue();initial.history=[{outcome:'played',task:{id:'previous',event:{nickname:'之前的观众'},answer:{text:'哎呀，礼物收到了。'}}}];
  const rewrite=deferred(),tts=[];
  const p=setup(initial,false,{prepareAudio:async task=>{tts.push(task.id);return {state:'ready'};},retainAudio:async()=>{},rewriteReply:()=>rewrite.promise});
  try {
    await p.engine.importTestBatch([{event:p.event('A')}]);await p.engine.setContext(true,'live',true);
    p.jobs.get('A').resolve({...reply('A'),generation_mode:'component',prepared_reply:'哎呀，这个问题真有意思。',prepared_for_live:'live'});await flush();
    const id=p.engine.snapshot().tasks[0].id;assert.equal(p.engine.snapshot().tasks[0].status,'generating');await p.engine.skip(id);
    rewrite.resolve({...reply('A'),generation_mode:'component',prepared_reply:'专门来关心姐姐呀。',prepared_for_live:'live'});await flush();
    assert.equal(p.engine.snapshot().tasks.length,0);assert.deepEqual(tts,[]);
  } finally {p.engine.dispose();rewrite.resolve({...reply('A'),prepared_reply:'迟到'});await flush();}
});
