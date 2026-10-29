import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function player(readDelayMs) {
  const sources = [], buffers = [], track = { stop() { this.stopped = true; } };
  let context;
  class AudioContext {
    state = 'running'; currentTime = 1; destination = {};
    constructor() { context = this; }
    createGain() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } }; }
    createConstantSource() { return { offset: {}, connect() {}, start() {}, stop() {}, disconnect() {} }; }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = { channels, rate, data, duration: length / rate, getChannelData: () => data };
      buffers.push(buffer); return buffer;
    }
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  const settings = {}, exports = {};
  const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compile('src/localPcmSettings.ts'), { exports: settings, localStorage: { getItem: () => null } });
  vm.runInNewContext(compile('src/localPcmPlayback.ts'), { exports, AudioContext, require: name => { assert.equal(name, './localPcmSettings'); return settings; } });
  return { playback: new exports.LocalPcmPlayback(readDelayMs), sources, buffers, get context() { return context; }, track };
}
const frame = (epoch = 1, pcm = new Array(960).fill(0)) => ({ state: 'frame', live_id: 'live', epoch, pcm });

test('plays signed little endian mono PCM at 24kHz and schedules consecutive frames without overlap', () => {
  const p = player();
  p.playback.accept(frame(1, [0, 128, 255, 127, 0, 0]));
  assert.deepEqual(Array.from(p.buffers[0].data), [-1, 32767 / 32768, 0]);
  assert.equal(p.buffers[0].rate, 24000); assert.equal(p.buffers[0].channels, 1);
  p.playback.accept(frame());
  assert.equal(p.sources[1].at, p.sources[0].at + p.buffers[0].duration);
});
test('interrupt stops scheduled audio and discards late receipts while protecting a newer reply', () => {
  const p = player(); p.playback.accept(frame(1));
  p.playback.accept({ state: 'stop', epoch: 1 });
  assert.equal(p.sources[0].stopped, true);
  p.playback.accept(frame(1)); assert.equal(p.sources.length, 1);
  p.playback.accept(frame(3));
  p.playback.accept({ state: 'stop', epoch: 2 });
  assert.equal(p.sources[1].stopped, undefined);
  p.playback.accept(frame(2)); assert.equal(p.sources.length, 2);
  p.playback.dispose(); assert.equal(p.sources[1].stopped, true); assert.equal(p.track.stopped, true);
  p.playback.accept(frame(4)); assert.equal(p.sources.length, 2);
});
test('blocked playback fails without accumulating audio and can resume with a new generation', async () => {
  const p = player(); p.context.state = 'suspended';
  assert.throws(() => p.playback.accept(frame()), /恢复播放/);
  assert.equal(p.sources.length, 0);
  await p.playback.resume(); p.playback.accept(frame(2)); assert.equal(p.sources.length, 1);
  assert.throws(() => p.playback.accept(frame(2, [1])), /格式/);
});
test('excess queued audio is stopped instead of playing a delayed reply', () => {
  const p = player();
  assert.throws(() => { for (let i = 0; i < 40; i++) p.playback.accept(frame()); }, /积压/);
  assert.ok(p.sources.length < 40); assert.ok(p.sources.every(source => source.stopped));
});

test('reply delay is sampled once and applies to every frame; the next reply reads the saved change', () => {
  let delay = 500;
  const p = player(() => delay);
  p.playback.accept(frame()); assert.equal(p.sources[0].at, 1.53);
  delay = 1000; p.context.currentTime += 0.02;
  p.playback.accept(frame()); assert.equal(p.sources[1].at, 1.55);
  p.context.currentTime = 2;
  p.playback.accept(frame(2)); assert.equal(p.sources[2].at, 3.03);
  assert.equal(p.sources[0].stopped, true);
});

test('maximum configured delay does not count as backlog and interruption removes all waiting audio', () => {
  const p = player(() => 10000);
  for (let i = 0; i < 600; i++) {
    p.playback.accept(frame()); p.context.currentTime += 0.02;
  }
  assert.equal(p.sources.length, 600);
  assert.equal(p.sources[0].at, 11.03);
  p.playback.accept({ state: 'stop', epoch: 1 });
  assert.ok(p.sources.every(source => source.stopped));
  p.playback.accept(frame()); assert.equal(p.sources.length, 600);
});

test('manual and microphone replies retain immediate local playback', () => {
  for (const task_id of ['manual-id', 'microphone-id']) {
    const p = player(() => 500);
    p.playback.accept({ ...frame(), task_id });
    assert.equal(p.sources[0].at, 1.03);
  }
});
