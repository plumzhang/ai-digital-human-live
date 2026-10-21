import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const recognitionExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/whisperRecognition.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recognitionExports, require: name => { assert.equal(name, 'pinyin-pro'); return pinyinPro; } });

async function player(options = {}) {
  const handlers = new Map();
  const rtcHandlers = new Map();
  const calls = [];
  const monitors = [];
  const refs = [];
  const states = [];
  let refCursor = 0;
  let stateCursor = 0;
  let effect;
  const video = { videoWidth: 1080, paused: false, currentTime: 1, play: async () => {}, srcObject: null };
  const rtc = new Proxy({
    on: (name, fn) => rtcHandlers.set(name, fn),
    off: name => rtcHandlers.delete(name),
    getAudioTrack: async uid => { calls.push(['getAudioTrack', uid]); return { kind: 'audio', id: uid }; },
  }, { get: (target, key) => target[key] ?? (async (...args) => {
    calls.push([key, ...args]);
    if (key === 'startAudioCapture' && options.captureError) throw new Error(options.captureError);
    if (key === 'startAudioCapture' && options.captureWait) await options.captureWait;
  }) });
  const snapshot = { live_id: '123', rtc: { token: 'test-token', user_id: 'client' } };
  const imports = {
    react: {
      useEffect: fn => { effect = fn; },
      useRef: value => { const index = refCursor++; return refs[index] ??= { current: index === 0 ? video : value }; },
      useState: initial => {
        const index = stateCursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '@tauri-apps/api/core': { invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'whisper_transcribe' && options.transcribe) return options.transcribe(args.request);
      return name === 'session_snapshot' ? snapshot : undefined;
    } },
    '@tauri-apps/api/event': {
      emit: async (name, payload) => calls.push([name, payload]),
      listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
    },
    'aliyun-rtc-sdk': { default: { getInstance: () => { if (options.engineError) throw new Error(options.engineError); return rtc; } }, AliRtcSdkChannelProfile: { AliRtcSdkCommunication: 0 } },
    '../whisperRecognition': recognitionExports,
    '../rtcVad': { monitorDownlinkAudio: async (track, receiving, activity, failed, pcm) => {
      const monitor = { track, receiving, activity, failed, pcm, disposed: false, dispose() { this.disposed = true; }, resume: async () => {} };
      monitors.push(monitor);
      return monitor;
    } },
  };
  const source = ts.transpileModule(fs.readFileSync('src/ui/ObsWindow.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => imports[name], Date });
  const render = () => { refCursor = 0; stateCursor = 0; return exports.ObsWindow(); };
  const tree = render();
  effect();
  await new Promise(resolve => setImmediate(resolve));
  return { handlers, rtcHandlers, calls, tree, video, snapshot, render, monitors };
}

test('OBS monitors only subscribed downlink audio and emits VAD events with transport health', async () => {
  const p = await player();
  const subscribe = p.rtcHandlers.get('audioSubscribeStateChanged');
  subscribe('client', 2, 3);
  subscribe('avatar', 2, 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.calls.filter(([name]) => name === 'getAudioTrack'), [['getAudioTrack', 'avatar']]);
  const monitor = p.monitors[0];
  assert.equal(monitor.receiving(), false);
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  assert.equal(monitor.receiving(), true);
  monitor.activity({ speaking: true, ended: false, healthy: true });
  monitor.activity({ speaking: false, ended: true, healthy: true });
  const end = p.calls.filter(([name]) => name === 'avatar-audio').at(-1)[1];
  assert.equal(end.source, 'pcm-vad');
  assert.equal(end.ended, true);
  assert.equal(end.live_id, '123');
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  assert.equal(monitor.receiving(), false);
  assert.equal(p.calls.filter(([name]) => name === 'avatar-audio').at(-1)[1].healthy, false);
  subscribe('avatar', 3, 0);
  assert.equal(monitor.disposed, true);
  const before = p.calls.length;
  monitor.activity({ speaking: false, ended: true, healthy: true });
  assert.equal(p.calls.length, before);
});

test('OBS binds Whisper PCM and recognition results to the current task and ignores another live', async () => {
  const p = await player({ transcribe: async request => ({ ...request, segments: [{ text: '大家晚上好', start_ms: 0, end_ms: 1000 }], inference_ms: 25 }) });
  p.rtcHandlers.get('audioSubscribeStateChanged')('avatar', 2, 3);
  await new Promise(resolve => setImmediate(resolve));
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  const target = { live_id: '123', task_id: 'task', capture_id: 'attempt', enabled: true };
  p.handlers.get('whisper-task')({ payload: { ...target, live_id: 'other-live' } });
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(p.calls.filter(([name]) => name === 'whisper_transcribe').length, 0);
  p.handlers.get('whisper-task')({ payload: target });
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  await new Promise(resolve => setImmediate(resolve));
  const result = p.calls.find(([name]) => name === 'whisper-recognition')[1];
  assert.equal(result.task_id, 'task'); assert.equal(result.capture_id, 'attempt');
  assert.equal(result.text, '大家晚上好');
  p.handlers.get('session-ended')({ payload: { live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  const count = p.calls.filter(([name]) => name === 'whisper_transcribe').length;
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(p.calls.filter(([name]) => name === 'whisper_transcribe').length, count);
});

test('ending a session closes the PCM observer and ignores late VAD results', async () => {
  const p = await player();
  p.rtcHandlers.get('audioSubscribeStateChanged')('avatar', 2, 3);
  await new Promise(resolve => setImmediate(resolve));
  const monitor = p.monitors[0];
  p.handlers.get('session-ended')({ payload: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.disposed, true);
  const before = p.calls.length;
  monitor.activity({ speaking: false, ended: true, healthy: true });
  assert.equal(p.calls.length, before);
});

test('OBS deduplicates session event and startup snapshot without rejoining', async () => {
  const p = await player();
  await p.handlers.get('session-changed')({ payload: p.snapshot });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'joinChannel').length, 1);
  assert.equal(p.calls.filter(([name]) => name === 'destroy').length, 0);
});

test('a delayed end from the old live cannot tear down the recovered RTC session', async () => {
  const p = await player();
  p.handlers.get('session-changed')({ payload: { ...p.snapshot, live_id: 'recovered-live' } });
  await new Promise(resolve => setImmediate(resolve));
  const before = p.calls.filter(([name]) => name === 'destroy').length;
  p.handlers.get('session-ended')({ payload: { live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'destroy').length, before);
  p.handlers.get('session-ended')({ payload: { live_id: 'recovered-live' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'destroy').length, before + 1);
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

test('microphone starts only on request and closing it releases local capture', async () => {
  const p = await player();
  assert.equal(p.calls.filter(([name]) => name === 'startAudioCapture').length, 0);
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'startAudioCapture').length, 1);
  assert.ok(p.calls.some(([name, enabled]) => name === 'publishLocalAudioStream' && enabled));
  assert.ok(p.calls.some(([name, state]) => name === 'mic-state' && state.enabled && state.live_id === '123'));
  p.calls.length = 0;
  p.handlers.get('mic-control')({ payload: { enabled: false, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(p.calls.some(([name, enabled]) => name === 'publishLocalAudioStream' && !enabled));
  assert.ok(p.calls.some(([name]) => name === 'stopAudioCapture'));
  assert.ok(p.calls.some(([name, state]) => name === 'mic-state' && !state.enabled && !state.error));
});

test('joining and enabling the microphone never captures or publishes local camera video', async () => {
  const p = await player();
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.handlers.has('camera-control'), false);
  assert.equal(p.calls.some(([name, enabled]) => name === 'enableLocalVideo' && enabled), false);
  assert.equal(p.calls.some(([name, enabled]) => name === 'publishLocalVideoStream' && enabled), false);
  assert.ok(p.calls.some(([name, enabled]) => name === 'setDefaultSubscribeAllRemoteVideoStreams' && enabled));
});

test('denied microphone permission reports failure and does not publish audio', async () => {
  const p = await player({ captureError: 'NotAllowedError' });
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name, enabled]) => name === 'publishLocalAudioStream' && enabled).length, 0);
  const failure = p.calls.find(([name, state]) => name === 'mic-state' && state.error);
  assert.equal(failure[1].enabled, false);
  assert.match(failure[1].error, /权限被拒绝/);
});

test('stale microphone requests cannot enable another session', async () => {
  const p = await player();
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: 'old-session' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'startAudioCapture').length, 0);
});

test('ending the session while permission is pending never publishes late audio', async () => {
  let finishCapture;
  const captureWait = new Promise(resolve => { finishCapture = resolve; });
  const p = await player({ captureWait });
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  p.handlers.get('session-ended')({ payload: {} });
  await new Promise(resolve => setImmediate(resolve));
  finishCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name, enabled]) => name === 'publishLocalAudioStream' && enabled).length, 0);
});

function caption(player) {
  return player.render().props.children[1].props.children[0];
}

test('queue chat and gift speech use the same centered overlay as microphone captions', async () => {
  const p = await player();
  assert.ok(p.calls.some(([name, payload]) => name === 'queue-caption-request' && payload.live_id === '123'));
  Object.assign(p.video, { videoHeight: 1920, clientWidth: 1920, clientHeight: 1080 });
  p.tree.props.children[0].props.onLoadedMetadata();
  const overlay = p.render().props.children[1];
  assert.equal(overlay.props.style.top, 540);
  assert.equal(overlay.props.style.left, (1920 - 1080 * 1080 / 1920) / 2);
  for (const content of ['[弹幕] 小杰: 姐姐今天好漂亮啊\n[回复] 小杰你真会夸人呀！', '[礼物] 阿豪: 玫瑰×5\n[回复] 谢谢阿豪送来的五朵玫瑰！']) {
    p.handlers.get('queue-caption')({ payload: { live_id: '123', content } });
    assert.equal(caption(p).props.className, 'obs-caption');
    assert.equal(caption(p).props.children, content);
  }
  p.handlers.get('queue-caption')({ payload: { live_id: 'old', content: '过期回答' } });
  assert.equal(caption(p).props.children, '[礼物] 阿豪: 玫瑰×5\n[回复] 谢谢阿豪送来的五朵玫瑰！');
  p.handlers.get('queue-caption')({ payload: { live_id: '123', content: '' } });
  assert.equal(caption(p), '');
});

test('OBS fits its native window to decoded video dimensions and updates when the stream resolution changes', async () => {
  const p = await player();
  const videoProps = p.tree.props.children[0].props;
  p.video.videoWidth = 0;
  videoProps.onLoadedMetadata();
  assert.equal(p.calls.filter(([name]) => name === 'fit_obs_video').length, 0);
  Object.assign(p.video, { videoWidth: 872, videoHeight: 1192, clientWidth: 580, clientHeight: 793 });
  videoProps.onLoadedMetadata();
  videoProps.onResize();
  videoProps.onTimeUpdate({ currentTarget: p.video });
  let fits = p.calls.filter(([name]) => name === 'fit_obs_video');
  assert.equal(fits.length, 1);
  assert.equal(fits[0][1].videoWidth, 872);
  assert.equal(fits[0][1].videoHeight, 1192);
  Object.assign(p.video, { videoWidth: 1920, videoHeight: 1080 });
  videoProps.onResize();
  fits = p.calls.filter(([name]) => name === 'fit_obs_video');
  assert.equal(fits.length, 2);
  assert.equal(fits[1][1].videoWidth, 1920);
  assert.equal(fits[1][1].videoHeight, 1080);
});

test('queue captions clear on microphone takeover, disconnect and session end', async () => {
  const p = await player();
  const show = () => p.handlers.get('queue-caption')({ payload: { live_id: '123', content: '谢谢礼物' } });
  show();
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(caption(p), '');
  show();
  assert.equal(caption(p), '');
  p.handlers.get('mic-control')({ payload: { enabled: false, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  show();
  p.handlers.get('vidu-disconnected')({ payload: { live_id: '123' } });
  assert.equal(caption(p), '');
  show();
  p.handlers.get('session-ended')({ payload: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(caption(p), '');
  show();
  assert.equal(caption(p), '');
});

test('OBS displays server microphone transcription as 我：内容 and replaces it with the latest phrase', async () => {
  const p = await player();
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  p.handlers.get('vidu-signal')({ payload: { type: 9, live_id: '123', payload: { text_msg: { content: ' 你好，数字人。 ' } } } });
  assert.equal(caption(p).props.className, 'obs-caption');
  assert.equal(caption(p).props.children, '我：你好，数字人。');
  p.handlers.get('vidu-signal')({ payload: { type: 9, live_id: '123', payload: { text_msg: { content: '第二句话' } } } });
  assert.equal(caption(p).props.children, '我：第二句话');
});

test('OBS ignores avatar replies, foreign sessions, empty results, and results while the microphone is off', async () => {
  const p = await player();
  const signal = { type: 9, live_id: '123', payload: { text_msg: { content: '你好' } } };
  p.handlers.get('vidu-signal')({ payload: signal });
  assert.equal(caption(p), '');
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  for (const payload of [{ ...signal, type: 10 }, { ...signal, live_id: 'old' }, { ...signal, payload: { text_msg: { content: ' ' } } }]) {
    p.handlers.get('vidu-signal')({ payload });
    assert.equal(caption(p), '');
  }
});

test('OBS clears microphone subtitles when the microphone is closed or the session ends', async () => {
  const p = await player();
  for (const endSession of [false, true]) {
    p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
    await new Promise(resolve => setImmediate(resolve));
    p.handlers.get('vidu-signal')({ payload: { type: 9, live_id: '123', payload: { text_msg: { content: '你好' } } } });
    assert.ok(caption(p));
    if (endSession) p.handlers.get('session-ended')({ payload: {} });
    else p.handlers.get('mic-control')({ payload: { enabled: false, live_id: '123' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(caption(p), '');
  }
});
