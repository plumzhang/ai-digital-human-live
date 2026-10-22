import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
const storage = new Map();
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/captionSettings.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, localStorage: { getItem: key => storage.get(key) ?? null } });
const { CAPTION_SETTINGS_KEY, loadCaptionSettings, normalizeCaptionSettings, captionAnchorStyle, captionTextStyle } = exports;

test('caption settings survive reopening and malformed saved values cannot escape supported positions or styles', () => {
  storage.set(CAPTION_SETTINGS_KEY, JSON.stringify({ x: 80, y: 95, width: 75, color: '#ffd700', fontFamily: 'kai', entrance: 'slide', opacity: 65 }));
  const saved = loadCaptionSettings();
  assert.equal(saved.x, 80); assert.equal(saved.y, 95); assert.equal(saved.color, '#ffd700');
  assert.equal(saved.fontFamily, 'kai'); assert.equal(saved.entrance, 'slide'); assert.equal(saved.opacity, 65);
  const invalid = normalizeCaptionSettings({ x: -10, y: 500, width: 0, fontSize: NaN, color: 'url(https://example.test)', shadow: 'false', entrance: 'invalid' });
  assert.equal(invalid.x, 0); assert.equal(invalid.y, 100); assert.equal(invalid.width, 10);
  assert.equal(invalid.color, '#ffffff'); assert.equal(invalid.shadow, true); assert.equal(invalid.entrance, 'fade');
  storage.set(CAPTION_SETTINGS_KEY, '{broken');
  assert.equal(loadCaptionSettings().entrance, 'fade');
});

test('preview and OBS styles use relative video dimensions while background and overall opacity remain independent', () => {
  const settings = normalizeCaptionSettings({ x: 100, y: 100, fontSize: 54, opacity: 70, background: true, backgroundColor: '#102030', backgroundOpacity: 25, stroke: true, strokeWidth: 3 });
  const anchor = captionAnchorStyle(settings);
  const text = captionTextStyle(settings);
  assert.equal(anchor.left, '100%'); assert.equal(anchor.top, '100%'); assert.equal(anchor.transform, 'translate(-100%, -100%)');
  assert.equal(anchor.opacity, 0.7);
  assert.equal(text.fontSize, '5cqw');
  assert.equal(text.backgroundColor, 'rgba(16, 32, 48, 0.25)');
  assert.match(text.WebkitTextStroke, /cqw #000000$/);
  assert.equal(captionTextStyle(normalizeCaptionSettings({ background: false, shadow: false, stroke: false })).backgroundColor, 'transparent');
});
