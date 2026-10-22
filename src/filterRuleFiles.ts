import type { Rule } from './domain';

export const MAX_RULE_FILE_BYTES = 5 * 1024 * 1024;
const FILE_TYPE = 'danmaku-filter-rules';

export function parseFilterRuleFile(text: string): Rule[] {
  let document: unknown;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件不是有效的 JSON，请选择导出的弹幕过滤规则文件'); }
  let entries: unknown;
  if (Array.isArray(document)) entries = document;
  else if (document && typeof document === 'object') {
    const file = document as Record<string, unknown>;
    if (file.version !== undefined && file.version !== 1) throw new Error('不支持此规则文件版本');
    if (file.type !== undefined && file.type !== FILE_TYPE) throw new Error('这不是弹幕过滤规则文件');
    entries = file.rules;
  }
  if (!Array.isArray(entries)) throw new Error('文件需包含 rules 规则列表');
  if (entries.length > 10000) throw new Error('单个文件最多支持 10000 条规则');
  return entries.map((entry: unknown, index: number) => {
    const prefix = `第 ${index + 1} 条规则`;
    if (!entry || typeof entry !== 'object') throw new Error(`${prefix}格式无效`);
    const rule = entry as Record<string, unknown>;
    if (rule.kind !== 'keyword' && rule.kind !== 'regex') throw new Error(`${prefix}类型需为 keyword 或 regex`);
    if (typeof rule.value !== 'string' || !rule.value.trim()) throw new Error(`${prefix}内容不能为空`);
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw new Error(`${prefix}启用状态需为 true 或 false`);
    const value = rule.value.trim();
    if (rule.kind === 'regex') {
      try { new RegExp(value, 'iu'); }
      catch { throw new Error(`${prefix}正则表达式无效：${value}`); }
    }
    return { id: crypto.randomUUID(), kind: rule.kind, value, enabled: rule.enabled !== false };
  });
}

export function mergeFilterRules(existing: Rule[], incoming: Rule[]) {
  const key = (rule: Rule) => JSON.stringify([rule.kind, rule.kind === 'keyword' ? rule.value.toLocaleLowerCase() : rule.value]);
  const known = new Set(existing.map(key));
  const added: Rule[] = [];
  for (const rule of incoming) {
    const identity = key(rule);
    if (known.has(identity)) continue;
    known.add(identity); added.push(rule);
  }
  return { rules: [...existing, ...added], added: added.length, skipped: incoming.length - added.length };
}

export function serializeFilterRules(rules: Rule[]): string {
  return JSON.stringify({ version: 1, type: FILE_TYPE, rules: rules.map(({ kind, value, enabled }) => ({ kind, value, enabled })) }, null, 2) + '\n';
}
