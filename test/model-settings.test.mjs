import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function mount(query, saved = {}) {
  const values = [];
  const effects = [];
  const timers = new Map();
  const requests = [];
  const storage = new Map([['openai-model-config', JSON.stringify(saved)], ['vidu-api-key', 'vidu-unchanged']]);
  let stateCursor = 0;
  let effectCursor = 0;
  let timerId = 0;
  let scheduledEffects = [];
  const modules = {
    react: {
      useState: initial => {
        const index = stateCursor++;
        if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
        return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
      },
      useEffect: (effect, deps) => {
        const index = effectCursor++;
        const previous = effects[index];
        if (!previous || deps.some((value, position) => !Object.is(previous.deps[position], value))) {
          scheduledEffects.push(() => {
            previous?.cleanup?.();
            effects[index] = { deps, cleanup: effect() };
          });
        }
      },
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    'lucide-react': { Cpu: 'cpu-icon', RefreshCw: 'refresh-icon', Save: 'save-icon' },
    '@tauri-apps/api/core': { invoke: (name, args) => { requests.push({ name, args }); return query(args); } },
  };
  const source = ts.transpileModule(fs.readFileSync('src/ui/ModelSettings.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const configExports = {};
  const configSource = ts.transpileModule(fs.readFileSync('src/modelConfig.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(configSource, { exports: configExports, localStorage });
  modules['../modelConfig'] = configExports;
  vm.runInNewContext(source, {
    exports, require: name => modules[name],
    localStorage,
    window: { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; } },
    clearTimeout: id => timers.delete(id),
  });
  function render() {
    stateCursor = 0; effectCursor = 0; scheduledEffects = [];
    const tree = exports.ModelSettings();
    scheduledEffects.forEach(effect => effect());
    return tree;
  }
  return {
    render, requests, storage,
    runTimers: async () => {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

const config = { baseUrl: 'https://example.test/v1', apiKey: 'test-key', selectedModel: '' };

test('model settings waits for a key and automatically queries after one is entered', async () => {
  const p = mount(async () => [{ id: 'model-one' }]);
  let tree = p.render();
  await p.runTimers();
  assert.equal(p.requests.length, 0);
  nodes(tree).find(node => node.tag === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'test-key' } });
  p.render();
  assert.equal(p.requests.length, 0);
  await p.runTimers();
  tree = p.render();
  assert.equal(p.requests[0].name, 'list_models');
  assert.equal(p.requests[0].args.baseUrl, 'https://api.openai.com/v1');
  assert.equal(p.requests[0].args.key, 'test-key');
  const option = nodes(tree).find(node => node.props?.className === 'model-option');
  assert.ok(option);
  option.props.onClick();
  tree = p.render();
  assert.equal(JSON.parse(p.storage.get('openai-model-config')).selectedModel, undefined);
  const save = nodes(tree).find(node => node.tag === 'button' && node.props.children?.includes(' 保存配置'));
  assert.ok(save);
  save.props.onClick();
  p.render();
  assert.equal(JSON.parse(p.storage.get('openai-model-config')).selectedModel, 'model-one');
  assert.equal(p.storage.get('vidu-api-key'), 'vidu-unchanged');
});

test('old query results cannot overwrite models from a new API configuration', async () => {
  let finishOld;
  const p = mount(args => args.key === 'test-key' ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve([{ id: 'new-model' }]), config);
  p.render();
  await p.runTimers();
  const tree = p.render();
  nodes(tree).find(node => node.tag === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'new-key' } });
  p.render();
  await p.runTimers();
  finishOld([{ id: 'old-model' }]);
  await new Promise(resolve => setImmediate(resolve));
  const rendered = JSON.stringify(p.render());
  assert.ok(rendered.includes('new-model'));
  assert.ok(!rendered.includes('old-model'));
});

test('query failures redact keys before appearing on the page', async () => {
  const p = mount(async () => { throw 'Invalid API key: test-key'; }, config);
  p.render();
  await p.runTimers();
  const alert = nodes(p.render()).find(node => node.props?.role === 'alert');
  assert.equal(alert.props.children, 'Invalid API key: ***');
});

test('saved model is visible on reentry before querying and survives an empty model list', async () => {
  const saved = { ...config, selectedModel: 'my-saved-model' };
  const p = mount(async () => [], saved);
  let tree = p.render();
  let summary = nodes(tree).find(node => node.props?.className === 'model-saved-summary');
  assert.ok(JSON.stringify(summary).includes('my-saved-model'));
  await p.runTimers();
  tree = p.render();
  summary = nodes(tree).find(node => node.props?.className === 'model-saved-summary');
  assert.ok(JSON.stringify(summary).includes('my-saved-model'));
  assert.equal(JSON.parse(p.storage.get('openai-model-config')).selectedModel, 'my-saved-model');
  assert.ok(JSON.stringify(tree).includes('已保留选择'));
});

test('unsaved model selections do not overwrite the saved choice', async () => {
  const saved = { ...config, selectedModel: 'saved-model' };
  const p = mount(async () => [{ id: 'saved-model' }, { id: 'new-model' }], saved);
  p.render();
  await p.runTimers();
  let tree = p.render();
  const newOption = nodes(tree).find(node => node.tag === 'button' && node.props.className === 'model-option');
  newOption.props.onClick();
  tree = p.render();
  assert.ok(JSON.stringify(tree).includes('有修改尚未保存'));
  const persisted = JSON.parse(p.storage.get('openai-model-config'));
  assert.equal(persisted.selectedModel, 'saved-model');
  const reopened = mount(async () => [], persisted);
  const summary = nodes(reopened.render()).find(node => node.props?.className === 'model-saved-summary');
  assert.ok(JSON.stringify(summary).includes('saved-model'));
});

test('fixed persona defaults to 晚晚 and is saved with the selected model', async () => {
  const p = mount(async () => [], { ...config, selectedModel: 'deepseek-chat' });
  let tree = p.render();
  const persona = nodes(tree).find(node => node.tag === 'textarea');
  assert.ok(persona.props.value.includes('你叫晚晚'));
  persona.props.onChange({ target: { value: '你是晚晚，只输出要说的话。' } });
  tree = p.render();
  nodes(tree).find(node => node.tag === 'button' && node.props.children?.includes(' 保存配置')).props.onClick();
  assert.equal(JSON.parse(p.storage.get('openai-model-config')).persona, '你是晚晚，只输出要说的话。');
});

test('the unchanged legacy default gains actions while custom personas are preserved', () => {
  const initial = mount(async () => [], config);
  const current = nodes(initial.render()).find(node => node.tag === 'textarea').props.value;
  assert.ok(current.includes('边说边做'));
  const legacy = current.replace(/8\. 台词与动作配合：[\s\S]*$/, '8. 只输出要说的话，不输出动作或解释。');
  const migrated = mount(async () => [], { ...config, persona: legacy });
  assert.equal(nodes(migrated.render()).find(node => node.tag === 'textarea').props.value, current);
  const custom = '你是晚晚，请按我的自定义风格互动。';
  const retained = mount(async () => [], { ...config, persona: custom });
  assert.equal(nodes(retained.render()).find(node => node.tag === 'textarea').props.value, custom);
});
