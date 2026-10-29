import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const recognitionExports = {};
const captionSettingsExports = {};
const songDirectorExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/songDirector.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: songDirectorExports, setInterval: () => 1, clearInterval: () => {}, Date });
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/captionSettings.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: captionSettingsExports });
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/whisperRecognition.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: recognitionExports, require: name => { assert.equal(name, 'pinyin-pro'); return pinyinPro; } });

const microphoneExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/microphoneInput.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: microphoneExports, crypto, Date, require: () => recognitionExports });

async function player(options = {}) {
  const handlers = new Map();
  const rtcHandlers = new Map();
  const calls = [];
  const monitors = [];
  const songs = [];
  const bridges = [];
  const localPlayers = [];
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
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '@tauri-apps/api/core': { convertFileSrc: path => `asset://${path}`, invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'speech_transcribe' && options.transcribe) return options.transcribe(args.request);
      if (name === 'director_get') return options.getDirector ? options.getDirector() : { status:'ready', available:true, stems_ready:true, vocals_path:'vocals.wav', accompaniment_path:'accompaniment.wav', lyric_display_delay_ms:options.lyricDelay??1500, pcm_ready:true, pcm_segments:[{index:0,start_ms:0,end_ms:1000,sample_count:24000,pcm_path:'clip.pcm'}], audio_path:'song.mp3', cues:[{ start_ms:0, end_ms:1000, lead_ms:500, text:'原歌词' }] };
      return name === 'session_snapshot' ? snapshot : undefined;
    } },
    '@tauri-apps/api/event': {
      emit: async (name, payload) => calls.push([name, payload]),
      listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
    },
    'aliyun-rtc-sdk': { default: { getInstance: () => { if (options.engineError) throw new Error(options.engineError); return rtc; } }, AliRtcSdkChannelProfile: { AliRtcSdkCommunication: 0 } },
    './ObsCaption': { ObsCaption: 'ObsCaption' },
    '../captionSettings': captionSettingsExports,
    '../whisperRecognition': recognitionExports,
    '../microphoneInput': microphoneExports,
    '../ttsConfig': { loadTtsConfig: () => ({ base_url: 'http://127.0.0.1:8766', model: 'k2-fsa/OmniVoice' }) },
    '../songDirector': songDirectorExports,
    '../localPcmPlayback': { LocalPcmPlayback: class {
      track = { kind: 'audio', id: 'local-pcm' }; running = true; events = [];
      constructor() { localPlayers.push(this); }
      accept(event) { this.events.push(event); }
      dispose() { this.disposed = true; this.running = false; }
      async resume() { this.running = true; }
    } },
    '../songAudioBridge': { createSongAudioBridge: async (audio, segments, read, lead, send, failed, phase, cueSent) => { bridges.push({send,phase,cueSent});return { dispose: () => calls.push(['songBridgeDisposed']), resume: async () => {await phase?.(false,0);}, drain: async () => {} };} },
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
  vm.runInNewContext(source, { exports, require: name => imports[name], Date, navigator: { mediaDevices: { getUserMedia: async constraints => {
    calls.push(['getUserMedia', constraints]);
    if (options.captureError) throw new Error(options.captureError);
    if (options.captureWait) await options.captureWait;
    const track = { kind: 'audio', stop: () => calls.push(['stopMicrophoneTrack']) };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } }, Audio: class {
    constructor(src) { this.src = src; this.paused = true; this.currentTime = 0; songs.push(this); }
    set src(value) { this._src=value; if(value)calls.push(['songAudioSource',{src:value,crossOrigin:this.crossOrigin,muted:this.muted,volume:this.volume}]); }
    get src() { return this._src; }
    async play() {
      if (options.blockSongAutoplay && !this.tried) { this.tried=true; const error=new Error('user gesture required'); error.name='NotAllowedError'; throw error; }
      this.paused = false;
    }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  } });
  const render = () => { refCursor = 0; stateCursor = 0; return exports.ObsWindow(); };
  const tree = render();
  effect();
  await new Promise(resolve => setImmediate(resolve));
  return { handlers, rtcHandlers, calls, tree, video, snapshot, render, monitors, songs, bridges, localPlayers };
}

test('OBS can report its existing join/subscriptions after console listeners reload without rejoining RTC', async () => {
  const p=await player();
  p.rtcHandlers.get('videoSubscribeStateChanged')('bot',0,3);
  p.rtcHandlers.get('audioSubscribeStateChanged')('bot',0,3);
  await new Promise(resolve=>setImmediate(resolve));
  const joins=p.calls.filter(([name])=>name==='joinChannel').length;
  const start=p.calls.length;
  await p.handlers.get('rtc-status-request')({payload:{live_id:'123',include_mic:true}});
  const replay=p.calls.slice(start);
  assert.ok(replay.some(([name,state])=>name==='rtc-status'&&state.live_id==='123'&&state.joined===true));
  for(const kind of ['video','audio']) assert.ok(replay.some(([name,state])=>name==='rtc-media-status'&&state.kind===kind&&state.subscribed===true));
  assert.ok(replay.some(([name,state])=>name==='mic-state'&&state.live_id==='123'&&state.enabled===false));
  assert.equal(p.calls.filter(([name])=>name==='joinChannel').length,joins);
  const before=p.calls.length;await p.handlers.get('rtc-status-request')({payload:{live_id:'old'}});assert.equal(p.calls.length,before);
});

async function readySongAudio(p) {
  p.rtcHandlers.get('audioSubscribeStateChanged')('avatar', 0, 3);
  await new Promise(resolve => setImmediate(resolve));
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid:'avatar', stats:{ bytesReceived:1000 } }]);
  p.monitors.find(m => m.track.id === 'avatar').activity({ healthy:true, speaking:false, ended:false, quiet_ms:2000 });
}

test('OBS song control plays accompaniment and RTC vocals, then restores local reply routing', async () => {
  const p = await player();
  await readySongAudio(p);
  const control = { action:'start', live_id:'123', task_id:'song-task', playback_token:'attempt', song_id:'song-id' };
  p.handlers.get('song-control')({ payload:control });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.songs.length,1); assert.equal(p.songs[0].src,'asset://accompaniment.wav'); assert.equal(p.songs[0].paused,false);
  const loaded=p.calls.find(([name])=>name==='songAudioSource')[1];
  assert.equal(loaded.crossOrigin,'anonymous');assert.equal(loaded.muted,false);assert.equal(loaded.volume,1);
  assert.ok(p.calls.some(([name, muted]) => name === 'muteAllRemoteAudioPlaying' && muted === true));
  const tts = p.calls.find(([name]) => name === 'component_transcription')[1];
  assert.equal(tts.content, '原歌词'); assert.equal(tts.taskId,'attempt-0');
  assert.equal(p.calls.filter(([name]) => name === 'speech_transcribe').length,0);
  p.songs[0].onended(); await new Promise(resolve => setImmediate(resolve));
  const interrupt = p.calls.findIndex(([name]) => name === 'interrupt_session');
  assert.ok(interrupt >= 0);
  assert.ok(p.calls.some(([name, muted]) => name === 'muteAllRemoteAudioPlaying' && muted === false));
  assert.deepEqual(p.calls.filter(([name]) => name === 'muteAllRemoteAudioPlaying').at(-1), ['muteAllRemoteAudioPlaying', true]);
  assert.ok(p.calls.some(([name, state]) => name === 'song-playback-state' && state.state === 'ended' && state.playback_token === 'attempt'));
});

test('OBS displays a PCM-triggered lyric even in a gap, protects it from queue captions and clears it on stop',async()=>{
  const p=await player({lyricDelay:0});await readySongAudio(p);
  const control={action:'start',live_id:'123',task_id:'song',playback_token:'token',song_id:'saved'};
  p.handlers.get('song-control')({payload:control});await new Promise(resolve=>setImmediate(resolve));
  const caption=()=>p.render().props.children[1].props.children[0].props.content;
  assert.equal(caption(),'');
  p.bridges[0].cueSent(0,Date.now());assert.equal(caption(),'原歌词');
  await p.bridges[0].phase(false,1);assert.equal(caption(),'原歌词');
  p.handlers.get('queue-caption')({payload:{live_id:'123',content:'弹幕'}});assert.equal(caption(),'原歌词');
  p.handlers.get('song-control')({payload:{...control,action:'stop'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(caption(),'');p.bridges[0].cueSent(0,Date.now());assert.equal(caption(),'');
});

test('OBS switches native song priority before vocal PCM and gap replies share RTC without local duplicates',async()=>{
  const p=await player();
  await readySongAudio(p);
  const control={action:'start',live_id:'123',task_id:'song-task',playback_token:'attempt',song_id:'song-id'};
  p.handlers.get('song-control')({payload:control});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.bridges.length,1);assert.ok(p.calls.some(([name])=>name==='component_song_open'));
  assert.equal(p.calls.filter(([name])=>name==='component_audio_begin').length,0);
  const globalStops=p.calls.filter(([name])=>name==='interrupt_session').length;
  await p.bridges[0].phase(true,0);await p.bridges[0].send(Array(480).fill(100),0);
  const phase=p.calls.findIndex(([name,args])=>name==='component_song_phase'&&args.active===true);
  const pcm=p.calls.findIndex(([name])=>name==='component_audio_push');assert.ok(phase>=0&&pcm>phase);
  await p.bridges[0].phase(false,1);
  assert.deepEqual(p.calls.filter(([name])=>name==='muteAllRemoteAudioPlaying').at(-1),['muteAllRemoteAudioPlaying',false]);
  p.handlers.get('whisper-task')({payload:{live_id:'123',task_id:'gap-chat',capture_id:'gap-capture',enabled:true}});
  assert.deepEqual(p.calls.filter(([name])=>name==='muteAllRemoteAudioPlaying').at(-1),['muteAllRemoteAudioPlaying',false]);
  const local=p.localPlayers[0], count=local.events.length;
  p.handlers.get('component-pcm')({payload:{live_id:'123',epoch:2,state:'frame',task_id:'gap-chat',pcm:[0,1]}});
  assert.equal(local.events.length,count);
  const remote=p.monitors.find(m=>m.track.id==='avatar');
  remote.activity({healthy:true,speaking:true,ended:false,quiet_ms:0});
  assert.equal(p.calls.filter(([name])=>name==='avatar-audio').at(-1)[1].playback_source,'rtc-song');
  assert.equal(p.calls.filter(([name])=>name==='interrupt_session').length,globalStops);
  p.songs[0].onended();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(p.calls.some(([name])=>name==='component_song_close'));
  assert.equal(p.calls.filter(([name])=>name==='interrupt_session').length,globalStops);
  assert.deepEqual(p.calls.filter(([name])=>name==='muteAllRemoteAudioPlaying').at(-1),['muteAllRemoteAudioPlaying',false]);
  p.handlers.get('whisper-task')({payload:{live_id:'123',task_id:'next-task',capture_id:'next',enabled:true}});
  assert.deepEqual(p.calls.filter(([name])=>name==='muteAllRemoteAudioPlaying').at(-1),['muteAllRemoteAudioPlaying',true]);
});

test('OBS ignores stale song commands and cancelling a pending load never starts late playback', async () => {
  let resolveDirector;
  const p = await player({ getDirector: () => new Promise(resolve => { resolveDirector=resolve; }) });
  const control = { action:'start', live_id:'123', task_id:'song-task', playback_token:'attempt', song_id:'song-id' };
  p.handlers.get('song-control')({ payload:{ ...control, live_id:'old' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.calls.filter(([name]) => name === 'director_get').length,0);
  p.handlers.get('song-control')({ payload:control }); await new Promise(resolve => setImmediate(resolve));
  p.handlers.get('song-control')({ payload:{ ...control, action:'stop' } });
  resolveDirector({ status:'ready', available:true, audio_path:'song.mp3', cues:[{ start_ms:0,end_ms:1000,lead_ms:500,text:'不要发送' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.songs.length,0); assert.equal(p.calls.filter(([name]) => name === 'component_transcription').length,0);
  assert.ok(p.calls.some(([name, state]) => name === 'song-playback-state' && state.state === 'stopped'));
});

test('songs require a real RTC audio subscription and never fall back to the mixed original',async()=>{
  const p=await player();
  p.handlers.get('song-control')({payload:{action:'start',live_id:'123',task_id:'song',playback_token:'token',song_id:'saved'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.songs.length,0);
  assert.ok(p.calls.some(([name,value])=>name==='song-playback-state'&&value.state==='error'&&value.error.includes('下行人声')));
});

test('gap reply recognition consumes remote PCM while the local copy is suppressed',async()=>{
  const p=await player({transcribe:async request=>({...request,segments:[{text:'欢迎来到直播间',start_ms:0,end_ms:1000}],inference_ms:10})});
  await readySongAudio(p);
  p.handlers.get('song-control')({payload:{action:'start',live_id:'123',task_id:'song',playback_token:'token',song_id:'saved'}});
  await new Promise(resolve=>setImmediate(resolve));
  await p.bridges[0].phase(false,0);
  p.handlers.get('whisper-task')({payload:{live_id:'123',task_id:'gap',capture_id:'gap-capture',enabled:true}});
  for(let i=0;i<20;i++)p.monitors.find(m=>m.track.id==='local-pcm').pcm(new Float32Array(1600).fill(.1),16000,0);
  assert.equal(p.calls.filter(([name])=>name==='speech_transcribe').length,0);
  for(let i=0;i<20;i++)p.monitors.find(m=>m.track.id==='avatar').pcm(new Float32Array(1600).fill(.1),16000,0);
  await new Promise(resolve=>setImmediate(resolve));
  const result=p.calls.find(([name])=>name==='whisper-recognition')?.[1];
  assert.equal(result?.task_id,'gap');assert.equal(result?.text,'欢迎来到直播间');
  p.handlers.get('song-control')({payload:{action:'stop',live_id:'123',task_id:'song',playback_token:'token'}});
  await new Promise(resolve=>setImmediate(resolve));
});

test('song VAD observations are logged under the matching lyric id and Vidu rejection stops local music', async () => {
  const p = await player();
  p.rtcHandlers.get('audioSubscribeStateChanged')('avatar',2,3);
  await new Promise(resolve => setImmediate(resolve));
  const control={action:'start',live_id:'123',task_id:'song-task',playback_token:'attempt',song_id:'song-id'};
  p.handlers.get('song-control')({payload:control}); await new Promise(resolve => setImmediate(resolve));
  p.handlers.get('vidu-signal')({payload:{type:103,live_id:'old',payload:{error:{msg_id:'tts-attempt-0',message:'old rejection'}}}});
  assert.equal(p.songs[0].paused,false);
  p.handlers.get('vidu-signal')({payload:{type:103,live_id:'123',payload:{error:{msg_id:'tts-other-0',message:'other request'}}}});
  assert.equal(p.songs[0].paused,false);
  p.handlers.get('vidu-signal')({payload:{type:103,live_id:'123',payload:{error:{msg_id:'tts-attempt-0',message:'not ready'}}}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.songs[0].paused,true);
  const report=p.calls.find(([name])=>name==='tts_log_song_observation')[1];
  assert.equal(report.liveId,'123'); assert.equal(report.msgId,'tts-attempt-0');
  assert.ok(p.calls.some(([name,value])=>name==='song-playback-state' && value.state==='error' && value.error.includes('not ready')));
});

test('OBS retains the song resume button across video frames and resumes the original audio on click', async () => {
  const p = await player({ blockSongAutoplay:true });
  await readySongAudio(p);
  const control = { action:'start', live_id:'123', task_id:'song-task', playback_token:'attempt', song_id:'song-id' };
  p.handlers.get('song-control')({ payload:control }); await new Promise(resolve => setImmediate(resolve));
  assert.ok(p.calls.some(([name,state]) => name === 'song-playback-state' && state.state === 'blocked'));
  assert.equal(p.calls.filter(([name]) => name === 'component_transcription').length,0);
  const frame = p.render().props.children[0]; frame.props.onTimeUpdate({ currentTarget:p.video });
  const overlay = p.render().props.children[1];
  const button = overlay.props.children.find(child => child && child.tag === 'button');
  assert.ok(button); button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.songs[0].paused,false);
  assert.equal(p.calls.filter(([name]) => name === 'component_transcription').length,1);
  assert.ok(p.calls.some(([name,state]) => name === 'song-playback-state' && state.state === 'started'));
  p.songs[0].onended(); await new Promise(resolve => setImmediate(resolve));
});

test('local playback drives VAD without a remote audio publisher; optional remote silence cannot block it', async () => {
  const p = await player();
  const local = p.monitors[0];
  assert.equal(local.track.id, 'local-pcm'); assert.equal(local.receiving(), true);
  local.activity({ speaking: false, ended: false, healthy: true, quiet_ms: 2000 });
  assert.equal(p.calls.filter(([name]) => name === 'avatar-audio').at(-1)[1].healthy, true);
  const subscribe = p.rtcHandlers.get('audioSubscribeStateChanged');
  subscribe('client', 2, 3);
  subscribe('avatar', 2, 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.calls.filter(([name]) => name === 'getAudioTrack'), [['getAudioTrack', 'avatar']]);
  const monitor = p.monitors.find(item => item.track.id === 'avatar');
  assert.equal(monitor.receiving(), false);
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  assert.equal(monitor.receiving(), true);
  local.activity({ speaking: true, ended: false, healthy: true });
  local.activity({ speaking: false, ended: true, healthy: true });
  const end = p.calls.filter(([name]) => name === 'avatar-audio').at(-1)[1];
  assert.equal(end.source, 'pcm-vad');
  assert.equal(end.playback_source, 'local-pcm');
  assert.equal(end.ended, true);
  assert.equal(end.live_id, '123');
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  assert.equal(monitor.receiving(), false);
  assert.equal(p.calls.filter(([name]) => name === 'avatar-audio').at(-1)[1].healthy, true);
  subscribe('avatar', 3, 0);
  assert.equal(monitor.disposed, true);
  const before = p.calls.length;
  monitor.activity({ speaking: false, ended: true, healthy: true });
  assert.equal(p.calls.length, before);
});

test('OBS routes only current-session PCM to its speaker and disposes it on disconnect', async () => {
  const p = await player(); const local = p.localPlayers[0];
  const event = { live_id: '123', epoch: 1, state: 'frame', pcm: [0, 1] };
  p.handlers.get('component-pcm')({ payload: { ...event, live_id: 'old' } });
  assert.equal(local.events.length, 0);
  p.handlers.get('component-pcm')({ payload: event });
  p.handlers.get('component-pcm')({ payload: { ...event, state: 'stop' } });
  assert.equal(local.events.length, 2);
  p.handlers.get('vidu-disconnected')({ payload: { live_id: 'old' } });
  assert.equal(local.disposed, undefined);
  p.handlers.get('vidu-disconnected')({ payload: { live_id: '123' } });
  assert.equal(local.disposed, true);
  p.handlers.get('component-pcm')({ payload: event });
  assert.equal(local.events.length, 2);
});

test('OBS binds Whisper PCM and recognition results to the current task and ignores another live', async () => {
  const p = await player({ transcribe: async request => ({ ...request, segments: [{ text: '大家晚上好', start_ms: 0, end_ms: 1000 }], inference_ms: 25 }) });
  p.rtcHandlers.get('audioSubscribeStateChanged')('avatar', 2, 3);
  await new Promise(resolve => setImmediate(resolve));
  p.rtcHandlers.get('rtcRemoteAudioStats')([{ uid: 'avatar', stats: { bytesReceived: 1000 } }]);
  const target = { live_id: '123', task_id: 'task', capture_id: 'attempt', enabled: true };
  p.handlers.get('whisper-task')({ payload: { ...target, live_id: 'other-live' } });
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(p.calls.filter(([name]) => name === 'speech_transcribe').length, 0);
  p.handlers.get('whisper-task')({ payload: target });
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  await new Promise(resolve => setImmediate(resolve));
  const result = p.calls.find(([name]) => name === 'whisper-recognition')[1];
  assert.equal(result.task_id, 'task'); assert.equal(result.capture_id, 'attempt');
  assert.equal(result.text, '大家晚上好');
  p.handlers.get('session-ended')({ payload: { live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  const count = p.calls.filter(([name]) => name === 'speech_transcribe').length;
  for (let i = 0; i < 20; i++) p.monitors[0].pcm(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(p.calls.filter(([name]) => name === 'speech_transcribe').length, count);
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
  assert.equal(p.calls.filter(([name]) => name === 'getUserMedia').length, 1);
  assert.equal(p.calls.some(([name, enabled]) => name === 'publishLocalAudioStream' && enabled), false);
  assert.ok(p.calls.some(([name, state]) => name === 'mic-state' && state.enabled && state.live_id === '123'));
  p.calls.length = 0;
  p.handlers.get('mic-control')({ payload: { enabled: false, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(p.calls.some(([name]) => name === 'stopMicrophoneTrack'));
  assert.ok(p.monitors.some(monitor => monitor.disposed));
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
  const node = player.render().props.children[1].props.children[0];
  assert.equal(node.tag, 'ObsCaption');
  return node.props.content;
}

test('queue chat and gift speech share the video-relative overlay with microphone captions', async () => {
  const p = await player();
  assert.ok(p.calls.some(([name, payload]) => name === 'queue-caption-request' && payload.live_id === '123'));
  Object.assign(p.video, { videoHeight: 1920, clientWidth: 1920, clientHeight: 1080 });
  p.tree.props.children[0].props.onLoadedMetadata();
  const overlay = p.render().props.children[1];
  assert.equal(overlay.props.style.top, 0);
  assert.equal(overlay.props.style.height, 1080);
  assert.equal(overlay.props.style.left, (1920 - 1080 * 1080 / 1920) / 2);
  for (const content of ['[弹幕] 小杰: 姐姐今天好漂亮啊\n[回复] 小杰你真会夸人呀！', '[礼物] 阿豪: 玫瑰×5\n[回复] 谢谢阿豪送来的五朵玫瑰！']) {
    p.handlers.get('queue-caption')({ payload: { live_id: '123', content } });
    assert.equal(caption(p), content);
  }
  p.handlers.get('queue-caption')({ payload: { live_id: 'old', content: '过期回答' } });
  assert.equal(caption(p), '[礼物] 阿豪: 玫瑰×5\n[回复] 谢谢阿豪送来的五朵玫瑰！');
  p.handlers.get('queue-caption')({ payload: { live_id: '123', content: '' } });
  assert.equal(caption(p), '');
});

test('OBS requests caption settings on startup and applies validated live changes without replacing the text', async () => {
  const p = await player();
  assert.ok(p.calls.some(([name]) => name === 'caption-settings-request'));
  p.handlers.get('queue-caption')({ payload: { live_id: '123', content: '正在播报的弹幕' } });
  p.handlers.get('caption-settings-changed')({ payload: { x: 15, y: 90, color: '#ffd700', entrance: 'zoom' } });
  const node = p.render().props.children[1].props.children[0];
  assert.equal(node.props.content, '正在播报的弹幕');
  assert.equal(node.props.settings.x, 15); assert.equal(node.props.settings.y, 90);
  assert.equal(node.props.settings.color, '#ffd700'); assert.equal(node.props.settings.entrance, 'zoom');
  Object.assign(p.video, { videoWidth: 1920, videoHeight: 1080, clientWidth: 1000, clientHeight: 1000 });
  p.tree.props.children[0].props.onLoadedMetadata();
  const overlay = p.render().props.children[1];
  assert.equal(overlay.props.style.top, 218.75);
  assert.equal(overlay.props.style.height, 562.5);
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
  assert.equal(caption(p), '我：你好，数字人。');
  p.handlers.get('vidu-signal')({ payload: { type: 9, live_id: '123', payload: { text_msg: { content: '第二句话' } } } });
  assert.equal(caption(p), '我：第二句话');
});

test('OBS ignores foreign sessions, empty results, and results while the microphone is off', async () => {
  const p = await player();
  const signal = { type: 9, live_id: '123', payload: { text_msg: { content: '你好' } } };
  p.handlers.get('vidu-signal')({ payload: signal });
  assert.equal(caption(p), '');
  p.handlers.get('mic-control')({ payload: { enabled: true, live_id: '123' } });
  await new Promise(resolve => setImmediate(resolve));
  for (const payload of [{ ...signal, live_id: 'old' }, { ...signal, payload: { text_msg: { content: ' ' } } }]) {
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
