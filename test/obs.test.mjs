import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

async function player(options = {}) {
  const handlers = new Map();
  const rtcHandlers = new Map();
  const calls = [];
  const refs = [];
  let effect;
  const video = { videoWidth: 1080, paused: false, currentTime: 1, play: async () => {}, srcObject: null };
  const rtc = new Proxy({
    on: (name, fn) => rtcHandlers.set(name, fn),
    off: name => rtcHandlers.delete(name),
  }, { get: (target, key) => target[key] ?? (async (...args) => { calls.push([key, ...args]); }) });
  const snapshot = { live_id: '123', rtc: { token: 'test-token', user_id: 'client' } };
  const imports = {
    react: {
      useEffect: fn => { effect = fn; },
      useRef: value => { const ref = { current: refs.length === 0 ? video : value }; refs.push(ref); return ref; },
      useState: value => [value, () => {}],
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '@tauri-apps/api/core': { invoke: async (name, args) => { calls.push([name, args]); return name === 'session_snapshot' ? snapshot : undefined; } },
    '@tauri-apps/api/event': {
      emit: async (name, payload) => calls.push([name, payload]),
      listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
    },
    'aliyun-rtc-sdk': { default: { getInstance: () => { if (options.engineError) throw new Error(options.engineError); return rtc; } }, AliRtcSdkChannelProfile: { AliRtcSdkCommunication: 0 } },
  };
  const source = ts.transpileModule(fs.readFileSync('src/ui/ObsWindow.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => imports[name], Date });
  const tree = exports.ObsWindow();
  effect();
  await new Promise(resolve => setImmediate(resolve));
  return { handlers, rtcHandlers, calls, tree, video, snapshot };
}

test('OBS deduplicates session event and startup snapshot without rejoining', async () => {
  const p = await player();
  await p.handlers.get('session-changed')({ payload: p.snapshot });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'joinChannel').length, 1);
  assert.equal(p.calls.filter(([name]) => name === 'destroy').length, 0);
});

test('subscription alone does not report frames; advancing video reports a frame for the active live', async () => {
  const p = await player();
  p.rtcHandlers.get('videoSubscribeStateChanged')('render', 2, 3);
  assert.equal(p.calls.filter(([name]) => name === 'playback_frame').length, 0);
  const onTimeUpdate = p.tree.props.children[0].props.onTimeUpdate;
  p.video.videoWidth = 0;
  onTimeUpdate({ currentTarget: p.video });
  assert.equal(p.calls.filter(([name]) => name === 'playback_frame').length, 0);
  p.video.videoWidth = 1080;
  onTimeUpdate({ currentTarget: p.video });
  onTimeUpdate({ currentTarget: p.video });
  const frames = p.calls.filter(([name]) => name === 'playback_frame');
  assert.equal(frames.length, 1);
  assert.equal(frames[0][1].liveId, '123');
});


test('RTC initialization errors reach the console instead of leaving an unreported blank window', async () => {
  const p = await player({ engineError: 'RTC unavailable' });
  const failure = p.calls.find(([name, payload]) => name === 'rtc-status' && payload.error);
  assert.match(failure[1].error, /RTC unavailable/);
  assert.equal(failure[1].live_id, '123');
});

test('ending a session releases the engine and stops reporting playback frames', async () => {
  const p = await player();
  await p.handlers.get('session-ended')({ payload: {} });
  await new Promise(resolve => setImmediate(resolve));
  p.tree.props.children[0].props.onTimeUpdate({ currentTarget: p.video });
  assert.equal(p.calls.filter(([name]) => name === 'destroy').length, 1);
  assert.equal(p.calls.filter(([name]) => name === 'playback_frame').length, 0);
});
