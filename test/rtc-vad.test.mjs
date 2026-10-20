import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('src/rtcVad.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(globals = {}) {
  const exports = {};
  vm.runInNewContext(source, { exports, ...globals });
  return exports;
}
const { DownlinkVad } = load();

test('PCM VAD rejects background noise and clicks, bridges word pauses and emits one end after 900ms', () => {
  const vad = new DownlinkVad();
  for (let i = 0; i < 100; i++) assert.equal(vad.frame(0.0004, 20).speaking, false);
  assert.equal(vad.frame(0.03, 20).speaking, false);
  assert.equal(vad.frame(0, 20).ended, false);
  for (let i = 0; i < 3; i++) vad.frame(0.03, 20);
  for (let i = 0; i < 25; i++) assert.equal(vad.frame(0, 20).speaking, true);
  assert.equal(vad.frame(0.0015, 20).speaking, true);
  for (let i = 0; i < 44; i++) assert.equal(vad.frame(0, 20).ended, false);
  assert.equal(vad.frame(0, 20).ended, true);
  assert.equal(vad.frame(0, 20).ended, false);
  assert.equal(vad.frame(0, 20).speaking, false);
});

test('invalid frames and resuming a reset detector cannot fabricate a speech end', () => {
  const vad = new DownlinkVad();
  for (let i = 0; i < 3; i++) vad.frame(0.03, 20);
  assert.equal(vad.frame(NaN, 20).healthy, false);
  for (let i = 0; i < 60; i++) assert.equal(vad.frame(0, 20).ended, false);
  assert.equal(vad.frame(0.03, 500).healthy, false);
});

test('analysis consumes remote PCM on a silent branch and releases analysis without stopping the RTC track', async () => {
  let processorSource;
  let meterClass;
  let workletNode;
  let context;
  const listeners = new Map();
  let stopped = false;
  const track = { kind: 'audio', readyState: 'live', muted: false, enabled: true, stop: () => { stopped = true; },
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  const states = [];
  const graph = [];
  let now = 100;
  const processorContext = { currentTime: 0, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => workletNode.port.onmessage?.({ data }) }; } },
    registerProcessor: (_name, Class) => { meterClass = Class; } };
  class FakeContext {
    constructor() { context = this; this.state = 'running'; this.currentTime = 0;
      this.audioWorklet = { addModule: async () => vm.runInNewContext(processorSource, processorContext) }; }
    createMediaStreamSource(stream) { assert.equal(stream.tracks[0], track); return { connect: node => graph.push(['source', node]), disconnect() {} }; }
    createGain() { this.gain = { gain: { value: 1 }, connect: () => {}, disconnect() {} }; return this.gain; }
    addEventListener() {} removeEventListener() {}
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
  }
  const { monitorDownlinkAudio } = load({
    AudioContext: FakeContext,
    AudioWorkletNode: class { constructor() { workletNode = this; this.port = { close() {} }; } connect() {} disconnect() {} },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    Blob: class { constructor(parts) { processorSource = parts.join(''); } },
    URL: { createObjectURL: () => 'blob:meter', revokeObjectURL() {} },
    performance: { now: () => now },
  });
  let receiving = true;
  const monitor = await monitorDownlinkAudio(track, () => receiving, state => states.push(state), assert.fail);
  assert.equal(context.gain.gain.value, 0);
  assert.equal(graph.length, 1);
  const meter = new meterClass();
  let phase = 0;
  const feed = (amplitude, blocks) => {
    for (let b = 0; b < blocks; b++) {
      const samples = Float32Array.from({ length: 128 }, () => amplitude * Math.sin(2 * Math.PI * 220 * phase++ / 48000));
      now += 128 / 48; context.currentTime += 128 / 48000; processorContext.currentTime = context.currentTime;
      meter.process([[samples]]);
    }
  };
  feed(0.05, 60);
  assert.ok(states.some(state => state.speaking));
  feed(0, 360);
  assert.equal(states.filter(state => state.ended).length, 1);
  receiving = false; feed(0, 50);
  assert.equal(states.at(-1).healthy, false);
  listeners.get('mute')();
  monitor.dispose();
  assert.equal(context.state, 'closed');
  assert.equal(listeners.size, 0);
  assert.equal(stopped, false);
});
