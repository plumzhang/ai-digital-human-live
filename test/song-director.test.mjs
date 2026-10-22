import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const api = {};
let now = 10000;
class TestDate extends Date { static now() { return now; } }
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/songDirector.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: api, setInterval: () => 1, clearInterval: () => {}, Date: TestDate });

const cues = [
  { start_ms: 100, end_ms: 400, text: '开头', lead_ms: 500 },
  { start_ms: 1000, end_ms: 2000, text: '第一句', lead_ms: 500 },
  { start_ms: 4000, end_ms: 5000, text: '第二句', lead_ms: 700 },
];
function setup(extra = {}) {
  now = 10000;
  const calls = [];
  const audio = { paused: true, currentTime: 0, onended: null, onerror: null,
    play: async () => { audio.paused = false; }, pause: () => { audio.paused = true; calls.push(['pause']); },
    removeAttribute: () => {}, load: () => {} };
  const player = new api.SongDirectorPlayer(audio, cues, {
    mute: muted => calls.push(['mute', muted]),
    speak: async (text, index) => calls.push(['speak', text, index]),
    interrupt: async () => calls.push(['interrupt']), caption: text => calls.push(['caption', text]),
    state: (state, error) => calls.push(['state', state, error]), ...extra,
  });
  return { player, audio, calls, speaks: () => calls.filter(c => c[0] === 'speak') };
}
test('lyric cues follow audio time, clamp negative send times and honor each lead without duplicates', async () => {
  const p = setup();
  assert.equal(api.songCueSendAt(cues[0]), 0);
  await p.player.start();
  assert.deepEqual(p.speaks(), [['speak', '开头', 0]]);
  p.audio.currentTime = .499; await p.player.tick(); assert.equal(p.speaks().length, 1);
  p.audio.currentTime = .5; await p.player.tick(); assert.equal(p.speaks()[1][1], '第一句');
  await p.player.tick(); assert.equal(p.speaks().length, 2);
  p.audio.currentTime = 3.299; await p.player.tick(); assert.equal(p.speaks().length, 2);
  p.audio.currentTime = 3.3; await p.player.tick(); assert.equal(p.speaks()[2][1], '第二句');
  p.audio.currentTime = 4.2; await p.player.tick(); assert.deepEqual(p.calls.at(-1), ['caption', '第二句']);
  p.audio.currentTime = 8; await p.player.tick(); assert.deepEqual(p.calls.at(-1), ['caption', '']);
  assert.equal(p.calls.some(c => c[0] === 'state' && c[1] === 'ended'), false);
  await p.player.stop();
});

test('a 57-second missing lyric interval is exposed as a timeline gap and the next send remains visible', async () => {
  const timeline = [{start_ms:38940,end_ms:42420,text:'以为相爱就不会走散',lead_ms:200}, {start_ms:99900,end_ms:108500,text:'是我还爱着你',lead_ms:200}];
  assert.deepEqual(JSON.parse(JSON.stringify(api.songTimelineGaps(timeline))), [{start_ms:42420,end_ms:99900}]);
  const reports = [];
  const p = setup({ progress: report => reports.push(report) });
  await p.player.start();
  assert.equal(reports.at(-1).sent,1); assert.equal(reports.at(-1).next_send_ms,500);
  await p.player.stop(); assert.equal(reports.at(-1).ended,true);
});

test('only a healthy speech onset after silence estimates submission latency and lyric offset', async () => {
  const observed = [];
  const p = setup({ observe: result => observed.push(result) });
  p.player.observeAudio({healthy:true,speaking:false,quiet_ms:900});
  await p.player.start();
  now += 300; p.audio.currentTime = .3;
  p.player.observeAudio({healthy:true,speaking:true});
  assert.equal(observed.length,1);
  assert.equal(observed[0].status,'audio_detected'); assert.equal(observed[0].latency_ms,300);
  assert.equal(observed[0].offset_ms,200);
  p.player.observeAudio({healthy:true,speaking:true}); assert.equal(observed.length,1);
  await p.player.stop();
});

test('continuous speech and unhealthy monitoring never claim a per-lyric response time', async () => {
  for (const baseline of [{healthy:true,speaking:true}, {healthy:false,speaking:false}]) {
    const observed = [];
    const p = setup({ observe: result => observed.push(result) });
    p.player.observeAudio(baseline); await p.player.start();
    p.player.observeAudio({healthy:true,speaking:true});
    now += 5100; await p.player.tick();
    assert.equal(observed[0].status,'overlap'); assert.equal(observed[0].latency_ms,undefined);
    await p.player.stop();
  }
});

test('pending IPC cannot block lyrics forever and cancellation cannot send late cues', async () => {
  let release;
  const p = setup({ speak: () => new Promise(resolve => { release=resolve; }) });
  const starting = p.player.start(); await new Promise(resolve => setImmediate(resolve));
  now += 5100; p.audio.currentTime = .6; await p.player.tick();
  assert.equal(p.audio.paused,true);
  assert.match(p.calls.at(-1)[2], /发送超过5秒/);
  release(); await starting;
});

test('a delayed write rechecks the music clock and skips lyrics that expired while waiting', async () => {
  let release; const observed = []; const spoken = [];
  const p = setup({ observe: value => observed.push(value), speak: async (text,index) => {
    spoken.push(index); if (index === 0) await new Promise(resolve => { release=resolve; });
  } });
  const starting = p.player.start(); await new Promise(resolve => setImmediate(resolve));
  p.audio.currentTime=4.2; release(); await starting;
  assert.deepEqual(spoken,[0,2]);
  assert.ok(observed.some(value => value.index === 1 && value.status === 'skipped'));
  await p.player.stop();
});
test('buffering and pause cannot consume cues, and expired lyrics never burst after a clock jump', async () => {
  const p = setup(); await p.player.start();
  p.audio.paused = true; p.audio.currentTime = .5; await p.player.tick(); assert.equal(p.speaks().length, 1);
  p.audio.paused = false; p.audio.currentTime = 3.5; await p.player.tick();
  assert.deepEqual(p.speaks().map(c => c[1]), ['开头', '第二句']);
  await p.player.stop();
});
test('end and interruption stop audio and future instructions and interrupt before restoring RTC sound', async () => {
  let release;
  const p = setup({ interrupt: () => new Promise(resolve => { release = resolve; }) });
  await p.player.start(); const pending = p.player.stop('ended');
  assert.equal(p.audio.paused, true); assert.equal(p.audio.onended, null);
  assert.equal(p.calls.some(c => c[0] === 'mute' && c[1] === false), false);
  p.audio.currentTime = 3.5; await p.player.tick(); assert.equal(p.speaks().length, 1);
  release(); await pending;
  assert.deepEqual(p.calls.slice(-2).map(c => c.slice(0,2)), [['mute', false], ['state', 'ended']]);
  await p.player.stop(); assert.equal(p.calls.filter(c => c[0] === 'state' && c[1] === 'ended').length, 1);
});
test('send failure and autoplay rejection fail the song and restore sound after cleanup', async () => {
  const p = setup({ speak: async () => { throw Error('socket closed'); } });
  await p.player.start();
  assert.equal(p.audio.paused, true);
  assert.equal(p.calls.at(-1)[1], 'error'); assert.match(p.calls.at(-1)[2], /socket closed/);
  assert.deepEqual(p.calls.at(-2), ['mute', false]);
  const q = setup(); q.audio.play = async () => { throw Error('autoplay'); };
  await q.player.start(); assert.equal(q.calls.at(-1)[1], 'error'); assert.equal(q.speaks().length, 0);
});
test('cleanup failure never leaks the remaining synthetic voice', async () => {
  const p = setup({ interrupt: async () => { throw Error('disconnected'); } });
  await p.player.start(); await p.player.stop('ended');
  assert.equal(p.calls.some(c => c[0] === 'mute' && !c[1]), false);
  assert.equal(p.calls.at(-1)[1], 'error');
});

test('autoplay denial keeps original audio and cues ready for a direct user gesture retry', async () => {
  const p = setup(); let plays = 0;
  p.audio.play = async () => {
    if (++plays === 1) { const error = new Error('user gesture required'); error.name='NotAllowedError'; throw error; }
    p.audio.paused=false;
  };
  await p.player.start();
  assert.equal(p.calls.at(-1)[1], 'blocked'); assert.equal(p.speaks().length, 0);
  assert.equal(typeof p.audio.onended, 'function');
  await p.player.resume();
  assert.equal(plays,2); assert.equal(p.audio.paused,false); assert.equal(p.speaks().length,1);
  assert.ok(p.calls.some(c => c[0] === 'state' && c[1] === 'started'));
  await p.player.stop();
});

test('cancelling during initial AI interruption never starts original audio later', async () => {
  let finishPrepare; let played = false;
  const p = setup({ prepare: () => new Promise(resolve => { finishPrepare = resolve; }) });
  p.audio.play = async () => { played = true; };
  const starting = p.player.start(); await p.player.stop(); finishPrepare(); await starting;
  assert.equal(played,false); assert.equal(p.speaks().length,0);
});
