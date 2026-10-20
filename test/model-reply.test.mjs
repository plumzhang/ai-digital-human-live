import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function workflow(config, invoke) {
  const shared = {};
  const transpile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(transpile('src/modelConfig.ts'), { exports: shared, localStorage: { getItem: () => JSON.stringify(config) } });
  const exports = {};
  vm.runInNewContext(transpile('src/modelReply.ts'), { exports, require: name => name === './modelConfig' ? shared : { invoke } });
  return exports.replyWithSavedModel;
}

const config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test-only-key', selectedModel: 'deepseek-chat', persona: '你叫晚晚，只输出要说的话。' };

test('saved model generates a personalized reply then sends that text for avatar speech', async () => {
  const requests = [];
  const reply = workflow(config, async (name, args) => { requests.push({ name, args }); return name === 'generate_reply' ? '小杰，谢谢你呀！' : undefined; });
  let logged;
  assert.equal(await reply({ liveId: 'live-1', nickname: '小杰', comment: '姐姐今天好漂亮啊', isCurrent: () => true, onReply: text => { logged = text; } }), true);
  assert.deepEqual(requests.map(request => request.name), ['generate_reply', 'speak_text']);
  assert.equal(requests[0].args.persona, config.persona);
  assert.equal(requests[0].args.model, 'deepseek-chat');
  assert.equal(requests[0].args.nickname, '小杰');
  assert.equal(requests[1].args.liveId, 'live-1');
  assert.equal(requests[1].args.content, '小杰，谢谢你呀！');
  assert.equal(logged, '小杰，谢谢你呀！');
});

test('a reply arriving after interruption or session change is never spoken', async () => {
  let current = true;
  const requests = [];
  const reply = workflow(config, async name => { requests.push(name); current = false; return '迟到的回答'; });
  assert.equal(await reply({ liveId: 'old-live', nickname: '观众', comment: '你好', isCurrent: () => current, onReply: () => assert.fail('must not log stale speech') }), false);
  assert.deepEqual(requests, ['generate_reply']);
});

test('missing configuration and empty responses do not fall back to the avatar chat model', async () => {
  const requests = [];
  const options = { liveId: 'live-1', nickname: '观众', comment: '你好', isCurrent: () => true, onReply: () => {} };
  const missing = workflow({ ...config, selectedModel: '' }, async name => { requests.push(name); });
  await assert.rejects(missing(options), /模型配置/);
  assert.equal(requests.length, 0);
  const empty = workflow(config, async name => { requests.push(name); return ''; });
  await assert.rejects(empty(options), /空回复/);
  assert.deepEqual(requests, ['generate_reply']);
});
