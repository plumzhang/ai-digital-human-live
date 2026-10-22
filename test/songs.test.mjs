import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('src/songMedia.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const media = {};
vm.runInNewContext(source, { exports: media });

test('song uploads enforce formats and strict data URI size bounds', () => {
  assert.equal(media.validateSongFile({ name: '晚晚.MP3', size: 1 }, 'audio'), 'audio/mpeg');
  assert.equal(media.validateSongFile({ name: 'voice.m4a', size: 1 }, 'audio'), 'audio/mp4');
  assert.equal(media.validateSongFile({ name: 'face.bmp', size: 1 }, 'portrait'), 'image/bmp');
  assert.throws(() => media.validateSongFile({ name: 'scene.bmp', size: 1 }, 'scene'));
  for (const size of [0, 20 * 1024 * 1024]) assert.throws(() => media.validateSongFile({ name: 'song.mp3', size }, 'audio'));
  assert.throws(() => media.validateSongFile({ name: 'face.png', size: 10 * 1024 * 1024 }, 'portrait'));
  assert.throws(() => media.validateSongFile({ name: 'movie.mp4', size: 100 }, 'audio'));
  assert.throws(() => media.validateSongFile({ name: 'face.svg', size: 100 }, 'portrait'));
});

test('song audio accepts the documented duration endpoints and rejects unknown durations', () => {
  for (const value of [10, 60, 300]) assert.doesNotThrow(() => media.validateSongDuration(value));
  for (const value of [NaN, Infinity, 0, 9.99, 300.01]) assert.throws(() => media.validateSongDuration(value));
});

test('portrait and scene image dimensions follow their separate constraints', () => {
  assert.doesNotThrow(() => media.validateSongDimensions(2048, 4096, 'portrait'));
  assert.throws(() => media.validateSongDimensions(2048, 4097, 'portrait'));
  assert.throws(() => media.validateSongDimensions(1500, 400, 'portrait'));
  assert.doesNotThrow(() => media.validateSongDimensions(1500, 400, 'scene'));
  assert.throws(() => media.validateSongDimensions(1600, 400, 'scene'));
  assert.throws(() => media.validateSongDimensions(0, 400, 'scene'));
});

test('generation never fabricates progress and download uses only received bytes', () => {
  const song = { status: 'processing', progress: null, downloaded_bytes: 0, total_bytes: null };
  assert.equal(media.songProgress(song), undefined);
  assert.equal(media.songProgress({ ...song, progress: 42 }), 42);
  assert.equal(media.songProgress({ ...song, status: 'downloading', progress: 100 }), undefined);
  assert.equal(media.songProgress({ ...song, status: 'downloading', downloaded_bytes: 250, total_bytes: 1000 }), 25);
  assert.equal(media.songProgress({ ...song, status: 'failed', progress: 42 }), undefined);
  assert.equal(media.songProgress({ ...song, status: 'success', progress: 100 }), undefined);
});

test('video aspect follows the closest supported portrait, landscape or square image shape', () => {
  for (const [width, height, expected] of [
    [1080, 1920, '9:16'], [1920, 1080, '16:9'], [1000, 1000, '1:1'],
    [800, 600, '4:3'], [600, 800, '3:4'], [700, 1000, '3:4'],
    [1000, 700, '4:3'], [1000, 950, '1:1'], [500, 1000, '9:16'],
  ]) assert.equal(media.closestSongAspectRatio(width, height), expected);
  for (const [width, height] of [[0, 100], [100, -1], [NaN, 100], [100, Infinity]]) assert.throws(() => media.closestSongAspectRatio(width, height));
});
