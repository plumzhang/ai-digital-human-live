import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('src/ui/TtsLog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const entry = (id, at_ms, extra = {}) => ({ id, at_ms, live_id:'live-1', command:'text_tts', content:`歌词 ${id}`, msg_id:`tts-${id}`, seq_id:at_ms, status:'sent', error:null, ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(load) {
  const handlers = new Map(); const values = []; let cursor = 0; let effect;
  const modules = {
    react: { useEffect: fn => { effect = fn; }, useState: initial => {
      const index = cursor++; if (!(index in values)) values[index] = initial;
      return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    } },
    '@tauri-apps/api/core': { invoke: async name => { assert.equal(name,'tts_log_load'); return load(); } },
    '@tauri-apps/api/event': { listen: async (name, handler) => { handlers.set(name,handler); return () => handlers.delete(name); } },
    'react/jsx-runtime': { jsx: (tag,props) => ({ tag,props }), jsxs: (tag,props) => ({ tag,props }) },
  };
  const exports = {}; vm.runInNewContext(source, { exports, require: name => modules[name], Date });
  const render = () => { cursor=0; return exports.TtsLog(); };
  render(); const cleanup = effect();
  return { handlers, values, render, cleanup, merge:exports.mergeTtsLog };
}

test('TTS panel merges persisted history with live OBS lyrics without losing events or duplicating IDs', async () => {
  let finishLoad;
  const p = mount(() => new Promise(resolve => { finishLoad=resolve; })); await flush();
  const lyric = entry('live-lyric',200,{ content:'风吹过\n下一句歌词' });
  p.handlers.get('tts-log-entry')({ payload:lyric });
  finishLoad({ entries:[lyric,entry('history',100)], path:'C:/data/tts-log.jsonl' }); await flush();
  assert.deepEqual(Array.from(p.values[0], e => e.id),['live-lyric','history']);
  assert.equal(p.values[0][0].content,'风吹过\n下一句歌词'); assert.equal(p.values[1],'C:/data/tts-log.jsonl');
  const failed = entry('failed',300,{ status:'failed', error:'控制连接写入失败', command:'text_action', content:'目光注视前方' });
  p.handlers.get('tts-log-entry')({ payload:failed });
  const text = JSON.stringify(p.render());
  for (const expected of ['TTS 日志','目光注视前方','发送失败','控制连接写入失败','tts-failed']) assert.ok(text.includes(expected));
  p.cleanup(); assert.equal(p.handlers.size,0);
});

test('TTS history is bounded and late disk results cannot update an unmounted panel', async () => {
  let finishLoad;
  const p = mount(() => new Promise(resolve => { finishLoad=resolve; })); await flush();
  const history = Array.from({ length:400 }, (_,i) => entry(String(i),i));
  const merged = p.merge([],history);
  assert.equal(merged.length,300); assert.equal(merged[0].id,'399'); assert.equal(merged.at(-1).id,'100');
  p.cleanup(); finishLoad({ entries:history, path:'ignored' }); await flush();
  assert.equal(p.values[0].length,0); assert.equal(p.values[1],'');
});

test('song progress explains the next send and downlink observations never label video as generated', async () => {
  const visible = node => node == null ? '' : Array.isArray(node) ? node.map(visible).join('') : typeof node === 'object' ? visible(node.props?.children) : String(node);
  const p = mount(async () => ({entries:[],path:''})); await flush();
  p.handlers.get('song-sync-progress')({payload:{live_id:'live-1',task_id:'song',playback_token:'attempt',position_ms:42420,sent:8,total:51,next_send_ms:99700,next_text:'是我还爱着你'}});
  let text = visible(p.render());
  for (const expected of ['已发送 8/51','57.3','是我还爱着你','不代表 Vidu 已生成']) assert.ok(text.includes(expected), expected);
  p.handlers.get('tts-log-entry')({payload:entry('observe',300,{command:'song_sync',status:'audio_detected',detail:'提交至下行发声 800 ms；未验证视频口型'})});
  text=visible(p.render());
  assert.ok(text.includes('检测到下行发声')); assert.ok(text.includes('800 ms'));
  p.handlers.get('song-sync-progress')({payload:{ended:true}}); assert.equal(p.values[4],null);
  p.cleanup();
});
