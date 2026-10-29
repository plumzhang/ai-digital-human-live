import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/sessionReadiness.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { SessionSnapshotSync, queueWaitingReason } = exports;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('native snapshot restores readiness when initialization happened before the window listener attached', async () => {
  const applied = [], errors = [];
  const sync = new SessionSnapshotSync(async () => ({ live_id: 'live', ready: true }), s => applied.push(s), e => errors.push(e));
  await sync.refresh(); assert.equal(applied[0].ready, true); assert.equal(errors.length, 0);
  sync.dispose();
});

test('a newer ack or disconnect invalidates an in-flight native snapshot', async () => {
  for (const ready of [true, false]) {
    const job = deferred(), applied = [];
    const sync = new SessionSnapshotSync(() => job.promise, s => applied.push(s), () => {});
    const read = sync.refresh(); sync.invalidate(); job.resolve({ live_id: 'old', ready }); await read;
    assert.equal(applied.length, 0); sync.dispose();
  }
});

test('snapshot reads coalesce, recover from errors and cannot update an unmounted console', async () => {
  const job=deferred(), applied=[], errors=[]; let reads=0;
  const sync=new SessionSnapshotSync(()=>{reads++;return job.promise;}, s=>applied.push(s), e=>errors.push(e));
  const pending=sync.refresh(); await sync.refresh(); assert.equal(reads,1);
  job.reject(new Error('IPC unavailable'));await pending;assert.equal(errors.length,1);
  await sync.refresh();assert.equal(reads,2);
  sync.dispose();await sync.refresh();assert.equal(reads,2);assert.equal(applied.length,0);
  const late=deferred();const closed=new SessionSnapshotSync(()=>late.promise,s=>applied.push(s),e=>errors.push(e));
  const read=closed.refresh();closed.dispose();late.resolve({live_id:'late',ready:true});await read;assert.equal(applied.length,0);
});

test('readiness explains control initialization, RTC join and the independent automatic reply switch', () => {
  const ready={hasSession:true,creating:false,controlReady:true,rtcJoined:true,auto:true,micEnabled:false,micPending:false,occupied:false};
  assert.equal(queueWaitingReason(ready),undefined);
  assert.match(queueWaitingReason({...ready,hasSession:false}),/等待启动数字人/);
  assert.match(queueWaitingReason({...ready,hasSession:false,creating:true}),/正在创建数字人会话/);
  assert.match(queueWaitingReason({...ready,controlReady:false}),/控制连接初始化确认/);
  assert.match(queueWaitingReason({...ready,rtcJoined:false}),/OBS.*加入实时会话/);
  assert.match(queueWaitingReason({...ready,auto:false}),/开启“自动回答弹幕”/);
  assert.match(queueWaitingReason({...ready,micEnabled:true}),/麦克风识别已开启/);
  assert.match(queueWaitingReason({...ready,micPending:true}),/麦克风切换/);
  assert.match(queueWaitingReason({...ready,occupied:true}),/手动提问/);
});
