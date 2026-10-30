import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const model = {};
vm.runInNewContext(compile('src/avatarProfiles.ts'), { exports: model, crypto: webcrypto });
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy avatar migration retains the local photo and every avatar setting without copying shared settings or keys', () => {
  const settings = { ...model.defaultAvatarConfig, persona: '你叫晚晚', voice: 'MyClone01', voiceSource: 'clone', roomId: 'room-1', rules: [{ value: 'ignore' }], apiKey: 'private-key', advanced: { ...model.initialAdvanced, temperature: 0.4, idleAction: true } };
  const image = { data: 'data:image/png;base64,bGVnYWN5', name: '晚晚.png' };
  const library = model.migrateAvatarLibrary(settings, image);
  assert.equal(library.profiles.length, 1);
  assert.equal(library.activeId, library.profiles[0].id);
  assert.equal(library.profiles[0].config.persona, settings.persona);
  assert.deepEqual(plain(library.profiles[0].image), image);
  assert.deepEqual(plain(library.profiles[0].config.advanced), settings.advanced);
  assert.equal(library.profiles[0].config.roomId, undefined);
  assert.equal(library.profiles[0].config.rules, undefined);
  assert.equal(JSON.stringify(library).includes('private-key'), false);
  settings.advanced.temperature = 0.9; image.name = 'changed';
  assert.equal(library.profiles[0].config.advanced.temperature, 0.4);
  assert.equal(library.profiles[0].image.name, '晚晚.png');
});

test('multiple profiles keep separate images and settings; editing does not duplicate or activate another card', () => {
  const original = model.migrateAvatarLibrary(model.defaultAvatarConfig, { data: 'photo-one', name: 'one.png' });
  const draft = model.newAvatarProfile({ ...model.defaultAvatarConfig, persona: '另一位主播', voice: 'voice-two' }, ' 第二位 ');
  draft.image = { data: 'photo-two', name: 'two.png' };
  const saved = model.saveProfileInLibrary(original, draft);
  assert.equal(saved.profiles.length, 2); assert.equal(saved.activeId, original.activeId);
  assert.equal(saved.profiles[1].name, '第二位');
  assert.equal(original.profiles.length, 1);
  draft.config.advanced.temperature = 0.8; draft.image.name = 'changed.png';
  assert.equal(saved.profiles[1].config.advanced.temperature, model.initialAdvanced.temperature);
  assert.equal(saved.profiles[1].image.name, 'two.png');
  const edited = model.saveProfileInLibrary(saved, { ...saved.profiles[1], name: '新名称' });
  assert.equal(edited.profiles.length, 2); assert.equal(edited.activeId, original.activeId);
  assert.equal(edited.profiles[0].image.data, 'photo-one');
  const selected = model.activateProfile(edited, draft.id);
  assert.equal(selected.profiles.find(profile => profile.id === selected.activeId).image.data, 'photo-two');
  assert.equal(model.parseAvatarLibrary(plain(selected)).activeId, draft.id);
  assert.throws(() => model.activateProfile(selected, 'missing'));
});

test('invalid stored profiles are rejected without falling back to destructive migration', () => {
  const library = model.migrateAvatarLibrary(model.defaultAvatarConfig, null);
  for (const value of [null, {}, { ...library, profiles: [] }, { ...library, activeId: 'unknown' }, { ...library, profiles: [...library.profiles, ...library.profiles] }]) assert.throws(() => model.parseAvatarLibrary(value));
  const invalid = plain(library); invalid.profiles[0].config.advanced.temperature = 99;
  assert.throws(() => model.parseAvatarLibrary(invalid));
});

test('each role persists its own reference voice with no shared mutable objects', () => {
  const voice = { ref_audio: 'one.wav', ref_text: '第一位角色' };
  const first = model.newAvatarProfile({ ...model.defaultAvatarConfig, referenceVoice: voice }, '第一位');
  let library = { version: 1, activeId: first.id, profiles: [first] };
  const second = model.newAvatarProfile({ ...model.defaultAvatarConfig, referenceVoice: { ref_audio: 'two.wav', ref_text: '第二位角色' } }, '第二位');
  library = model.saveProfileInLibrary(library, second);
  voice.ref_audio = 'mutated.wav'; second.config.referenceVoice.ref_text = 'mutated';
  assert.equal(library.profiles[0].config.referenceVoice.ref_audio, 'one.wav');
  assert.equal(library.profiles[1].config.referenceVoice.ref_text, '第二位角色');
  const selected = model.activateProfile(plain(library), second.id);
  assert.equal(selected.profiles.find(profile => profile.id === selected.activeId).config.referenceVoice.ref_audio, 'two.wav');
  const empty = model.newAvatarProfile();
  assert.equal(empty.config.referenceVoice.ref_audio, '');
  const invalid = plain(library); invalid.profiles[0].config.referenceVoice.ref_text = 123;
  assert.throws(() => model.parseAvatarLibrary(invalid), /音色配置/);
});

function mount(storage) {
  const values = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, scheduled = [];
  const activations = [];
  const exports = {};
  const react = {
    useState: initial => { const i = stateIndex++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef: initial => refs[refIndex++] ||= { current: initial },
    useCallback: callback => callback,
    useEffect: (callback, deps) => { const i = effectIndex++; const old = effects[i]; if (!old || deps.some((value, index) => value !== old.deps[index])) scheduled.push(() => { old?.cleanup?.(); effects[i] = { deps, cleanup: callback() }; }); },
  };
  vm.runInNewContext(compile('src/useAvatarLibrary.ts'), { exports, require: name => name === 'react' ? react : name === './avatarProfiles' ? model : storage });
  return {
    activations,
    render() {
      stateIndex = 0; refIndex = 0; effectIndex = 0; scheduled = [];
      const result = exports.useAvatarLibrary(model.defaultAvatarConfig, profile => activations.push(profile));
      scheduled.forEach(callback => callback()); return result;
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('profile writes serialize using the latest library and failed saves do not replace the selected avatar', async () => {
  let disk = model.migrateAvatarLibrary(model.defaultAvatarConfig, null);
  let fail = false;
  const writes = [];
  const mounted = mount({ loadAvatarLibrary: async () => disk, saveAvatarLibrary: async library => { if (fail) throw new Error('disk full'); await flush(); disk = library; writes.push(library); } });
  mounted.render(); await flush();
  let state = mounted.render();
  const one = model.newAvatarProfile(model.defaultAvatarConfig, '第二位');
  const two = model.newAvatarProfile(model.defaultAvatarConfig, '第三位');
  await Promise.all([state.saveProfile(one), state.saveProfile(two)]);
  state = mounted.render();
  assert.equal(state.library.profiles.length, 3); assert.equal(writes.length, 2);
  assert.equal(mounted.activations.length, 1);
  fail = true;
  await assert.rejects(state.selectProfile(one.id), /disk full/);
  assert.equal(mounted.render().library.activeId, disk.activeId);
  assert.equal(mounted.activations.length, 1);
  fail = false;
  await state.selectProfile(two.id);
  assert.equal(mounted.render().library.activeId, two.id);
  assert.equal(mounted.activations.at(-1).id, two.id);
});

test('storage startup errors preserve the original library and can be retried without saving defaults', async () => {
  let broken = true, writes = 0;
  const library = model.migrateAvatarLibrary(model.defaultAvatarConfig, null);
  const mounted = mount({ loadAvatarLibrary: async () => { if (broken) throw new Error('corrupt storage'); return library; }, saveAvatarLibrary: async () => { writes++; } });
  mounted.render(); await flush();
  let state = mounted.render();
  assert.match(state.error, /corrupt storage/); assert.equal(state.library, null); assert.equal(writes, 0);
  broken = false; state.retry(); mounted.render(); await flush();
  state = mounted.render(); assert.equal(state.library.activeId, library.activeId); assert.equal(state.error, ''); assert.equal(writes, 0);
});

test('a delayed voice result updates its original profile after selection changes and preserves newer edits', async () => {
  let disk = model.migrateAvatarLibrary(model.defaultAvatarConfig, null);
  const originalId = disk.activeId;
  const second = model.newAvatarProfile(model.defaultAvatarConfig, '另一位');
  disk = model.saveProfileInLibrary(disk, second);
  const mounted = mount({ loadAvatarLibrary: async () => disk, saveAvatarLibrary: async library => { disk = library; } });
  mounted.render(); await flush();
  const state = mounted.render();
  await state.selectProfile(second.id);
  await state.patchProfile(originalId, { persona: '较新的人设' });
  await state.patchProfile(originalId, { voice: 'NewClone01', voiceSource: 'clone' });
  const current = mounted.render().library;
  assert.equal(current.activeId, second.id);
  assert.equal(current.profiles[1].config.voice, model.defaultAvatarConfig.voice);
  assert.equal(current.profiles[0].config.voice, 'NewClone01');
  assert.equal(current.profiles[0].config.persona, '较新的人设');
  assert.equal(mounted.activations.length, 2);
});
