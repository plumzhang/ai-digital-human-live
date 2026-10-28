import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as pinyinPro from 'pinyin-pro';

const recognition = {}, microphone = {};
const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(compile('src/whisperRecognition.ts'), { exports: recognition, require: () => pinyinPro });
vm.runInNewContext(compile('src/microphoneInput.ts'), { exports: microphone, require: () => recognition, crypto, Date });
const flush = () => new Promise(resolve => setImmediate(resolve));
const voice = input => { input.push(new Float32Array(4800).fill(.2), 16000, 0); input.push(new Float32Array(14400), 16000, 900); };

test('local microphone waits for interruption before ASR and includes pre-roll with 16kHz PCM', async () => {
  const requests = [], answers = [];
  let interrupted;
  const input = new microphone.MicrophoneInput('live', async request => { requests.push(request); return { segments: [{ text: '你好' }] }; }, () => new Promise(resolve => { interrupted = resolve; }), text => answers.push(text), assert.fail);
  input.push(new Float32Array(1600), 16000, 200);
  voice(input); await flush(); assert.equal(requests.length, 0);
  interrupted(); await flush();
  assert.equal(requests.length, 1); assert.equal(requests[0].live_id, 'live');
  assert.equal(requests[0].samples.length, 19200);
  assert.ok(requests[0].samples.some(value => value > 0));
  assert.deepEqual(answers, ['你好']);
});

test('new utterances and microphone closure discard late recognition results', async () => {
  const pending = [], answers = [];
  const input = new microphone.MicrophoneInput('live', request => new Promise(resolve => pending.push({ request, resolve })), async () => {}, text => answers.push(text), assert.fail);
  voice(input); await flush(); voice(input); await flush();
  pending[0].resolve({ segments: [{ text: '旧内容' }] }); await flush(); assert.equal(answers.length, 0);
  input.stop(); pending[1].resolve({ segments: [{ text: '已关闭' }] }); await flush(); assert.equal(answers.length, 0);
});

test('silence and failed interruptions never become model requests', async () => {
  const errors = []; let recognized = 0;
  const input = new microphone.MicrophoneInput('live', async () => { recognized++; return { segments: [] }; }, async () => { throw Error('socket closed'); }, assert.fail, message => errors.push(message));
  for (let i = 0; i < 10; i++) input.push(new Float32Array(1600), 16000, 1000);
  await flush(); assert.equal(recognized, 0);
  voice(input); await flush(); assert.equal(recognized, 0); assert.ok(errors.some(error => error.includes('socket closed')));
});
