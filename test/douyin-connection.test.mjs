import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/douyinConnection.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { DouyinConnection } = exports;
function fixture(overrides = {}) {
  let sequence = 0;
  const calls = [], listeners = [], events = [], statuses = [];
  const adapter = {
    uuid: () => `connection-${++sequence}`,
    listen: async (channel, callback) => {
      const entry = { channel, callback, detached: false }; listeners.push(entry);
      return () => { entry.detached = true; };
    },
    invoke: async (command, args) => { calls.push({ command, args }); return { room_id: '123' }; },
    ...overrides,
  };
  const connection = new DouyinConnection(adapter, e => events.push(e), s => statuses.push(s));
  const send = (channel, payload) => listeners.filter(e => e.channel === channel).forEach(e => e.callback(payload));
  return { connection, calls, listeners, events, statuses, send, adapter };
}
test('listeners are ready before connect, including messages arriving before invoke returns', async () => {
  const f = fixture();
  f.adapter.invoke = async (command, args) => {
    assert.equal(f.listeners.length, 2);
    f.send('douyin-event', { connection_id: args.connectionId, event: { id: '18446744073709551614', type: 'chat', roomId: '123' } });
    return { room_id: '123' };
  };
  assert.equal(await f.connection.start('https://live.douyin.com/123'), '123');
  assert.equal(f.events[0].id, '18446744073709551614');
});
test('room offline and unknown are delivered without dropping the connection', async () => {
  const f = fixture(); await f.connection.start('123');
  for (const status of ['offline', 'unknown', 'online']) f.send('douyin-status', { connection_id: 'connection-1', status, terminal: false });
  assert.deepEqual(f.statuses.map(s => s.status), ['offline', 'unknown', 'online']);
  assert.equal(f.calls.length, 1); assert.ok(f.listeners.every(e => !e.detached));
});
test('stop ignores queued callbacks and disconnects only its own native session', async () => {
  const f = fixture(); await f.connection.start('123'); await f.connection.stop();
  f.send('douyin-event', { connection_id: 'connection-1', event: { id: 'old' } });
  f.send('douyin-status', { connection_id: 'connection-1', status: 'online' });
  assert.equal(f.events.length, 0); assert.equal(f.statuses.length, 0);
  assert.ok(f.listeners.every(e => e.detached));
  assert.equal(f.calls[1].command, 'douyin_disconnect'); assert.equal(f.calls[1].args.connectionId, 'connection-1');
});
test('reconnect discards previous room events even after new listeners attach', async () => {
  const f = fixture(); await f.connection.start('123'); await f.connection.start('456');
  f.send('douyin-event', { connection_id: 'connection-1', event: { id: 'old' } });
  f.send('douyin-event', { connection_id: 'connection-2', event: { id: 'new' } });
  assert.deepEqual(f.events.map(e => e.id), ['new']); assert.equal(f.calls[1].command, 'douyin_disconnect');
});
test('stop while listeners are registering never opens a room and detaches late listeners', async () => {
  const resolvers = [];
  const f = fixture({ listen: () => new Promise(resolve => resolvers.push(resolve)) });
  const start = f.connection.start('123'); await Promise.resolve();
  await f.connection.stop(); let detached = 0;
  resolvers.forEach(resolve => resolve(() => detached++)); await start;
  assert.equal(detached, 2); assert.ok(f.calls.every(c => c.command !== 'douyin_connect'));
});
test('immediate stop cancels a pending start before listener registration', async () => {
  const f = fixture(); const start = f.connection.start('123'); await f.connection.stop(); await start;
  assert.equal(f.calls.length, 0); assert.equal(f.listeners.length, 0);
});
test('failed native connect cleans up process and listeners before surfacing the error', async () => {
  const f = fixture();
  f.adapter.invoke = async (command, args) => { f.calls.push({ command, args }); if (command === 'douyin_connect') throw new Error('room failed'); };
  await assert.rejects(f.connection.start('123'), /room failed/);
  assert.ok(f.listeners.every(e => e.detached)); assert.equal(f.calls.at(-1).command, 'douyin_disconnect');
});
