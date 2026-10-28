import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = name => ts.transpileModule(fs.readFileSync(name, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const actions = {}, exports = {};
vm.runInNewContext(compile('src/giftActions.ts'), { exports: actions });
vm.runInNewContext(compile('src/componentInteraction.ts'), { exports, require: name => { assert.equal(name, './giftActions'); return actions; } });
const config = { baseUrl: 'https://model.test', apiKey: 'local-key', selectedModel: 'deepseek-flash', persona: '主播人设' };
const diversity = { openingStyle: '自然回答', recentOpenings: [] };
const task = content => ({ id: 'slot', event: { event_id: 'event', type: 'chat', nickname: '小宇', content } });

test('every chat reaches intent planning, including a typo and actions outside the old keyword filter', async () => {
  for (const content of ['札一下马尾', '笑一下', '眨眨眼', '涂一下口红']) {
    const calls = [];
    const result = await exports.planComponentInteraction(task(content), [], diversity, config, async (name, args) => {
      calls.push({ name, args });
      if (name === 'component_prepare_reply') return '小宇，这就给你扎起来。';
      return { speech: '优化的提问', intent: 'action_request', action_instruction: '执行对应的具体动作', emotion: 'happy', segments: [] };
    }, 'live');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].name, 'component_prepare_reply');
    assert.equal(result.prepared_reply, '小宇，这就给你扎起来。');
    assert.equal(result.prepared_for_live, 'live'); assert.equal(calls[0].args.comment, content);
    assert.equal(result.action_instruction, '执行对应的具体动作');
    assert.equal(result.generation_mode, 'component'); assert.equal(result.speech, content);
    assert.equal(JSON.parse(result.request).current_event.content, content);
  }
});
test('ordinary questions retain camera gaze and gifts retain their chosen gesture', async () => {
  const result = await exports.planComponentInteraction(task('你会扎马尾吗？'), [], diversity, config,
    async name => name === 'component_prepare_reply' ? '我会呀。' : ({ speech: '提问', intent: 'question', emotion: 'neutral', action_instruction: actions.DEFAULT_GAZE_INSTRUCTION, segments: [] }), 'live');
  assert.equal(actions.avatarActionFor({ ...task('你会扎马尾吗？'), result }).instruction, actions.DEFAULT_GAZE_INSTRUCTION);
  const gift = { ...task('玫瑰×5'), event: { ...task('').event, type: 'gift', content: '玫瑰×5' } };
  const plan = await exports.planComponentInteraction(gift, [], diversity, config, async name => { assert.equal(name, 'component_prepare_reply'); return '谢谢你的玫瑰。'; }, 'live');
  assert.equal(plan.intent, 'gift'); assert.equal(plan.gesture, actions.giftActionFor(gift).kind);
});
test('a missing action instruction fails visibly instead of silently submitting only speech', async () => {
  await assert.rejects(exports.planComponentInteraction(task('札一下马尾'), [], diversity, config,
    async () => ({ speech: '提问', intent: 'action_request', action_instruction: ' ', emotion: 'happy', segments: [] }), 'live'), /没有返回动作描述/);
});
