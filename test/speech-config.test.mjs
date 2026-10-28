import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(values) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ttsConfig.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, localStorage: { getItem: key => values[key] ?? null } });
  return JSON.parse(JSON.stringify(exports.loadTtsConfig()));
}
test('speech migration keeps clone reference and retires the legacy model and v1 route', () => {
  const config = load({ 'qwen3-tts-config': JSON.stringify({ base_url: 'http://127.0.0.1:8766/v1', model: 'Qwen/old', ref_audio: 'G:\\声音.wav', ref_text: '你好' }) });
  assert.equal(config.model, 'k2-fsa/OmniVoice');
  assert.equal(config.base_url, 'http://127.0.0.1:8766');
  assert.equal(config.ref_audio, 'G:\\声音.wav');
  assert.equal(config.ref_text, '你好');
});
test('saved unified service settings take precedence and malformed field types cannot enter requests', () => {
  const config = load({ 'speech-service-config-v1': JSON.stringify({ base_url: 'http://localhost:9999', ref_audio: 'G:\\current.wav', ref_text: 123 }),
    'qwen3-tts-config': JSON.stringify({ ref_audio: 'G:\\old.wav' }) });
  assert.equal(config.base_url, 'http://localhost:9999');
  assert.equal(config.ref_audio, 'G:\\current.wav');
  assert.equal(config.ref_text, '');
});
