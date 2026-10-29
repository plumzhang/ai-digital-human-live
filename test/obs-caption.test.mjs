import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function caption() {
  let state, effect, cleanup;
  const timers = new Map();
  let serial = 0;
  const settings = { entrance: 'fade', entranceMs: 280 };
  const exports = {};
  const imports = {
    react: {
      useState: initial => { state ??= initial; return [state, value => { state = value; }]; },
      useEffect: next => { effect = next; },
    },
    'react/jsx-runtime': { jsx: (tag, props) => ({ tag, props }), jsxs: (tag, props) => ({ tag, props }) },
    '../captionSettings': { defaultCaptionSettings: settings, captionAnchorStyle: () => ({}), captionTextStyle: () => ({}) },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ui/ObsCaption.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: name => imports[name],
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return {
    timers,
    render: props => exports.ObsCaption(props),
    commit: () => { cleanup?.(); cleanup = effect(); },
    elapse: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.fn()); },
  };
}

test('song current row changes immediately without outgoing or entrance animation', () => {
  const c = caption();
  const first = { content: '第一句', following: ['第二句'] };
  c.render(first); c.commit();
  const second = { content: '第二句', previous: '第一句', following: ['第三句'] };
  const node = c.render(second).props.children;
  const rows = node.props.children.props.children;
  assert.equal(rows[1].props.children, '第二句');
  assert.equal(rows[0].props.children, '第一句');
  assert.equal(rows[2].props.children, '第三句');
  assert.equal(node.props['data-entrance'], 'none');
  assert.equal(node.props['data-exiting'], undefined);
  c.commit(); assert.equal(c.timers.size, 0);
  assert.equal(c.render(second).props.children.props.children.props.children[1].props.children, '第二句');
  c.commit();
  assert.equal(c.render({ content: '' }), null);
});

test('song start cancels a pending ordinary caption exit and keeps the last song row immediate', () => {
  const c = caption();
  c.render({ content: '弹幕回复' }); c.commit();
  c.render({ content: '另一条回复' }); c.commit();
  assert.equal(c.timers.size, 1);
  const song = { content: '最后一句', previous: '前一句', following: [] };
  const node = c.render(song).props.children;
  assert.equal(node.props.children.props.children[1].props.children, '最后一句');
  assert.equal(node.props['data-entrance'], 'none');
  c.commit(); assert.equal(c.timers.size, 0);
  c.elapse();
  assert.equal(c.render(song).props.children.props.children.props.children[1].props.children, '最后一句');
});

test('ordinary captions retain their configured outgoing and entrance animation', () => {
  const c = caption();
  c.render({ content: '原回复' }); c.commit();
  const node = c.render({ content: '新回复' }).props.children;
  assert.equal(node.props.children, '原回复');
  assert.equal(node.props['data-exiting'], true);
  assert.equal(node.props['data-entrance'], 'fade');
  c.commit(); assert.equal([...c.timers.values()][0].ms, 180);
  c.elapse();
  const updated = c.render({ content: '新回复' }).props.children;
  assert.equal(updated.props.children, '新回复');
  assert.equal(updated.props['data-exiting'], undefined);
});
