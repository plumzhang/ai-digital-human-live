import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const media = {};
vm.runInNewContext(compile('src/songMedia.ts'), { exports: media });
function load() {
  const images = [];
  class Image {
    naturalWidth = 600; naturalHeight = 800;
    constructor() { images.push(this); }
  }
  const exports = {};
  vm.runInNewContext(compile('src/songAvatar.ts'), { exports, require: () => media, URL, Image, DOMException, setTimeout, clearTimeout });
  return { ...exports, images };
}
const profile = { id: 'avatar-one', name: '数字人一', config: { imageUri: 'https://images.example/face.png' }, image: { name: 'saved.png', data: 'data:image/png;base64,YWJj' } };

test('singing uses the selected profile local image first and supports URL-only profiles without modifying the profile', () => {
  const api = load();
  const local = api.songAvatarPortrait(profile);
  assert.equal(local.data, profile.image.data); assert.equal(local.name, 'saved.png');
  const remote = api.songAvatarPortrait({ ...profile, image: null });
  assert.equal(remote.data, profile.config.imageUri); assert.equal(remote.name, '数字人一的形象图片');
  assert.equal(profile.image.data, 'data:image/png;base64,YWJj');
});

test('missing, invalid, or unsafe avatar photos require correction and never fall back to a different image', () => {
  const api = load();
  assert.throws(() => api.songAvatarPortrait({ ...profile, image: null, config: { imageUri: '' } }), /尚未设置/);
  for (const imageUri of ['file:///C:/face.png', 'javascript:alert(1)', 'https://user:password@example.com/face.png', 'invalid']) {
    assert.throws(() => api.songAvatarPortrait({ ...profile, image: null, config: { imageUri } }));
  }
  assert.throws(() => api.songAvatarPortrait({ ...profile, image: { name: 'bad.svg', data: 'data:image/svg+xml;base64,YWJj' } }), /格式无效/);
  assert.throws(() => api.songAvatarPortrait({ ...profile, image: { name: 'bad.png', data: 'data:image/png;base64,%%%%' } }), /格式无效/);
});

test('auto-loaded photos are checked for portrait dimensions before they become ready to submit', async () => {
  const api = load();
  const ready = api.loadSongAvatarPortrait(profile, new AbortController().signal);
  api.images[0].onload();
  const loaded = await ready;
  assert.equal(loaded.data, profile.image.data);
  assert.equal(loaded.width, 600); assert.equal(loaded.height, 800);
  assert.equal(api.images[0].onload, null);
  const invalid = api.loadSongAvatarPortrait(profile, new AbortController().signal);
  api.images[1].naturalWidth = 5000; api.images[1].onload();
  await assert.rejects(invalid, /4096/);
});

test('switching avatars can cancel the previous image load and releases its handlers', async () => {
  const api = load();
  const controller = new AbortController();
  const previous = api.loadSongAvatarPortrait(profile, controller.signal);
  controller.abort();
  await assert.rejects(previous, error => error.name === 'AbortError');
  assert.equal(api.images[0].onload, null); assert.equal(api.images[0].onerror, null);
  const next = api.loadSongAvatarPortrait({ ...profile, id: 'avatar-two', image: null }, new AbortController().signal);
  api.images[1].onload();
  assert.equal((await next).data, profile.config.imageUri);
});
