import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/sessionRecovery.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, setTimeout });
const { SessionRecovery } = exports;

function setup(overrides = {}) {
  const calls = [];
  let now = 0;
  const recovery = new SessionRecovery({
    prepare: async id => calls.push(['prepare', id]),
    ended: async id => { calls.push(['ended', id]); return true; },
    create: async () => { calls.push(['create']); return { live_id: 'new-live', rtc: 'fresh-token' }; },
    abandon: async session => calls.push(['abandon', session.live_id]),
    restored: session => calls.push(['restored', session.live_id]),
    progress: message => calls.push(['progress', message]),
    failed: message => calls.push(['failed', message]),
    settled: () => calls.push(['settled']),
    wait: async ms => calls.push(['wait', ms]), now: () => now, ...overrides,
  });
  return { recovery, calls, advance: ms => { now += ms; } };
}

test('AI closure pauses tasks, confirms ended, then creates and restores with fresh credentials', async () => {
  const p = setup();
  assert.equal(await p.recovery.recover('old-live', 'ai_output_closed'), true);
  assert.deepEqual(p.calls.filter(([name]) => !['progress', 'wait', 'settled'].includes(name)), [
    ['prepare', 'old-live'], ['ended', 'old-live'], ['create'], ['restored', 'new-live'],
  ]);
  assert.equal(p.recovery.pending, false);
});

test('account, audit, normal hangups and explicit stops never auto-recreate', async () => {
  const p = setup();
  for (const reason of ['user_end', 'timeout', 'audit_violation', 'credit_insufficient', 'external', '']) {
    assert.equal(await p.recovery.recover(reason || 'id', reason), false);
  }
  assert.equal(await p.recovery.recover('stopped', 'ai_output_closed', true), false);
  assert.equal(p.calls.length, 0);
});

test('duplicate signals and concurrent events cannot create parallel lives', async () => {
  let release;
  const p = setup({ wait: () => new Promise(resolve => { release = resolve; }) });
  const run = p.recovery.recover('old', 'ai_output_closed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.recovery.pending, true);
  assert.equal(await p.recovery.recover('old', 'ai_output_closed'), false);
  assert.equal(await p.recovery.recover('other', 'ai_output_closed'), false);
  release();
  await run;
  assert.equal(await p.recovery.recover('old', 'ai_output_closed'), false);
  assert.equal(p.calls.filter(([name]) => name === 'create').length, 1);
});

test('unknown old-session status prevents recreation and query failures surface', async () => {
  for (const throws of [false, true]) {
    const p = setup({ ended: async () => { if (throws) throw Error('query unavailable'); return false; } });
    assert.equal(await p.recovery.recover('old', 'ai_output_closed'), false);
    assert.equal(p.calls.some(([name]) => name === 'create'), false);
    assert.equal(p.calls.filter(([name]) => name === 'failed').length, 1);
  }
});

test('old sessions may take several polls to end before recreation', async () => {
  let queries = 0;
  const p = setup({ ended: async () => ++queries >= 3 });
  assert.equal(await p.recovery.recover('old', 'ai_output_closed'), true);
  assert.equal(queries, 3);
});

test('repeated server faults stop after three recreations per ten minutes', async () => {
  const p = setup();
  for (let i = 0; i < 3; i++) assert.equal(await p.recovery.recover(`old-${i}`, 'ai_output_closed'), true);
  assert.equal(await p.recovery.recover('fourth', 'ai_output_closed'), false);
  assert.equal(p.calls.filter(([name]) => name === 'create').length, 3);
  assert.deepEqual(p.calls.filter(([name]) => name === 'wait').map(([, ms]) => ms), [1000, 2000, 4000]);
  p.advance(600_001);
  assert.equal(await p.recovery.recover('later', 'ai_output_closed'), true);
});

test('stop during backoff prevents creation; stop during creation cleans up the late live', async () => {
  for (const phase of ['wait', 'create']) {
    let release;
    const p = setup({ [phase]: () => new Promise(resolve => { release = resolve; }) });
    const run = p.recovery.recover('old', 'ai_output_closed');
    await new Promise(resolve => setImmediate(resolve));
    p.recovery.cancel();
    release(phase === 'create' ? { live_id: 'cancelled-live' } : undefined);
    assert.equal(await run, false);
    assert.equal(p.calls.some(([name]) => name === 'restored'), false);
    assert.equal(p.calls.some(([name]) => name === 'abandon'), phase === 'create');
  }
});

test('creation failures settle without an automatic retry loop', async () => {
  let creates = 0;
  const p = setup({ create: async () => { creates++; throw Error('Vidu unavailable'); } });
  assert.equal(await p.recovery.recover('old', 'ai_output_closed'), false);
  assert.equal(creates, 1);
  assert.equal(p.recovery.pending, false);
  assert.ok(p.calls.find(([name]) => name === 'failed')[1].includes('Vidu unavailable'));
});
