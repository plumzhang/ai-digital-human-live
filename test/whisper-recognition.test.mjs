import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/whisperRecognition.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: name => { assert.equal(name, 'pinyin-pro'); return pinyinPro; } });
const { normalizeSpeech, matchReplyEnding, Pcm16Encoder, WhisperCapture, mergeWhisperTimeline } = exports;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const target = { live_id: 'live', task_id: 'task', capture_id: 'attempt-1', enabled: true };

test('matching normalizes punctuation and number readings and permits omissions above the 70 percent threshold', () => {
  assert.equal(normalizeSpeech('今年２６岁，一百零五朵花。'), normalizeSpeech('今年二十六岁，105朵花'));
  const text = '今天我们一起聊聊天，最后祝大家晚安。';
  assert.equal(matchReplyEnding(text, '今天我们一起聊聊天最后祝大家晚安').matched, true);
  assert.equal(matchReplyEnding(text, '最后祝大家晚安').matched, true); // Seven of the final ten syllables meet 70%.
  assert.equal(matchReplyEnding(text, '今天我们一起聊聊天').matched, false);
  assert.equal(matchReplyEnding(text, '今天我们一起聊聊天最后祝大家晚').matched, true);
  assert.equal(matchReplyEnding('晚安，我先讲个故事，讲完再和大家说晚安。', '晚安').matched, false);
  assert.equal(matchReplyEnding('好的', '好').matched, false);
  assert.equal(matchReplyEnding('好的', '好的').matched, true);
  assert.equal(matchReplyEnding('', '好的').matched, false);
});

test('homophone names use syllables and short whole-reply matching only rejects similarity below 70 percent', () => {
  const expected = '我叫晚晚，晚上的晚，好记吧？';
  const result = matchReplyEnding(expected, '我叫碗碗, 晚上的碗,好记吧!');
  assert.equal(result.matched, true);
  assert.equal(result.progress, 1);
  assert.equal(result.method, 'phonetic');
  assert.equal(matchReplyEnding(expected, '我叫晚晚，晚上的晚，好记吧').method, 'text');
  for (const incomplete of ['好记吧', '我叫碗碗，好记吧', '完全不同的一段话']) {
    assert.equal(matchReplyEnding(expected, incomplete).matched, false, incomplete);
  }
  assert.equal(matchReplyEnding(expected, '我叫碗碗，晚上的碗，好记').matched, true);
  assert.equal(matchReplyEnding('晚安', '碗鞍').matched, true);
  assert.equal(matchReplyEnding('西安', '先').matched, false); // Syllable boundaries must survive pinyin conversion.
  assert.equal(matchReplyEnding('model12', 'demo987').matched, false);
});

test('ten-character whole matching accepts exactly 70 percent including errors at the ending', () => {
  const expected = '甲乙丙丁戊己庚辛壬癸';
  const exactBoundary = matchReplyEnding(expected, '甲乙丙丁戊己庚花草树');
  assert.equal(exactBoundary.scope, 'full'); assert.equal(exactBoundary.compared_chars, 10);
  assert.equal(exactBoundary.progress, 0.7); assert.equal(exactBoundary.matched, true);
  assert.equal(matchReplyEnding(expected, '甲乙丙丁戊己花草树木').matched, false);
  assert.equal(matchReplyEnding(expected, '甲乙丙丁戊己庚').matched, true);
  assert.equal(matchReplyEnding(expected, '甲乙丙丁戊己').matched, false);
});

test('11 through 14 characters match globally and 15 or more compare only the final ten', () => {
  const ending = '甲乙丙丁戊己庚辛壬癸';
  for (let length = 11; length <= 14; length++) {
    const text = '春夏秋冬东西南北天'.slice(0, length - 10) + ending;
    const result = matchReplyEnding(text, text);
    assert.equal(result.scope, 'full'); assert.equal(result.compared_chars, length);
  }
  const fourteen = matchReplyEnding('春夏秋冬' + ending, ending);
  assert.equal(fourteen.scope, 'full'); assert.equal(fourteen.compared_chars, 14);
  assert.equal(fourteen.progress, 1 - 4 / 14);
  for (const prefix of ['春夏秋冬东', '春夏秋冬东西南北天地', '此前的内容完全没有识别出来也不影响末尾匹配', '甲'.repeat(6100)]) {
    const result = matchReplyEnding(prefix + ending, '识别开头完全错误' + ending);
    assert.equal(result.scope, 'tail'); assert.equal(result.compared_chars, 10);
    assert.equal(result.progress, 1); assert.equal(result.matched, true);
    assert.equal(matchReplyEnding(prefix + ending, '甲乙丙丁戊己庚花草树').matched, true);
    assert.equal(matchReplyEnding(prefix + ending, '甲乙丙丁戊己花草树木').matched, false);
  }
});

test('PCM resampling is continuous across frames at 44.1kHz and preserves signed sample limits', () => {
  const encoder = new Pcm16Encoder(44100);
  let count = 0;
  for (let i = 0; i < 100; i++) count += encoder.encode(new Float32Array(441).fill(0.5)).length;
  assert.equal(count, 16000);
  assert.deepEqual(Array.from(new Pcm16Encoder(16000).encode(Float32Array.from([-1, 1, 0]))), [-32768, 32767, 0]);
  assert.throws(() => new Pcm16Encoder(0));
});

test('rolling recognition retains words before a window boundary even when it cuts through a segment', () => {
  const words = ['大家', '晚上好', '欢迎', '来到直播间'].map((text, i) => ({ text, start_ms: i * 1000, end_ms: (i + 1) * 1000, probability: 0.95 }));
  const merged = mergeWhisperTimeline([{ text: '大家晚上好欢迎来到直播间', start_ms: 0, end_ms: 4000, words }],
    [{ text: '欢迎来到直播间祝大家晚安', start_ms: 2000, end_ms: 6000 }], 2000);
  assert.equal(merged.map(segment => segment.text).join(''), '大家晚上好欢迎来到直播间祝大家晚安');
  assert.equal(merged[0].end_ms, 2000);
});

test('capture bounds its rolling audio window, serializes inference and discards old task results', async () => {
  const requests = [], results = [];
  let release;
  const capture = new WhisperCapture(request => {
    requests.push(request);
    return new Promise(resolve => { release = () => resolve({ ...request, segments: [{ text: '旧任务', start_ms: 0, end_ms: 500 }], inference_ms: 20 }); });
  }, result => results.push(result), () => 1000);
  capture.start(target);
  for (let i = 0; i < 500; i++) capture.push(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].samples.length <= 400000);
  capture.start({ ...target, task_id: 'new-task', capture_id: 'attempt-2' });
  release(); await flush();
  assert.equal(results.length, 0);
  for (let i = 0; i < 20; i++) capture.push(new Float32Array(1600).fill(0.1), 16000, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].task_id, 'new-task');
  capture.start(); release(); await flush();
  assert.equal(results.length, 0);
});

test('capture never recognizes pure silence and reports inference failures without submitting more audio', async () => {
  let calls = 0;
  const results = [];
  const capture = new WhisperCapture(async () => { calls++; throw Error('model unavailable'); }, result => results.push(result));
  capture.start(target);
  for (let i = 0; i < 30; i++) capture.push(new Float32Array(1600), 16000, i * 100 + 100);
  assert.equal(calls, 0);
  for (let i = 0; i < 20; i++) capture.push(new Float32Array(1600).fill(0.1), 16000, 0);
  await flush();
  assert.equal(calls, 1);
  assert.match(results[0].error, /model unavailable/);
  for (let i = 0; i < 20; i++) capture.push(new Float32Array(1600), 16000, 500);
  assert.equal(calls, 1);
});
