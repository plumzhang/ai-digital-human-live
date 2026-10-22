import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Plus, Shield, Trash2 } from 'lucide-react';
import type { Rule } from '../domain';
import { MAX_RULE_FILE_BYTES, mergeFilterRules, parseFilterRuleFile, serializeFilterRules } from '../filterRuleFiles';

export function FilterRules({ rules, onChange, onError }: { rules: Rule[]; onChange: (rules: Rule[]) => void; onError: (message: string) => void }) {
  const [kind, setKind] = useState<Rule['kind']>('keyword');
  const [value, setValue] = useState('');
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rulesRef = useRef(rules);
  const alive = useRef(true);
  rulesRef.current = rules;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fail = (message: string) => { setNotice({ error: true, text: message }); onError(message); };
  const addRule = () => {
    const content = value.trim();
    if (!content) return;
    if (kind === 'regex') {
      try { new RegExp(content, 'iu'); }
      catch { fail('正则表达式无效'); return; }
    }
    onChange([...rulesRef.current, { id: crypto.randomUUID(), kind, value: content, enabled: true }]);
    setValue(''); setNotice(null);
  };
  const importFile = async (file: File) => {
    setImporting(true); setNotice(null);
    try {
      if (file.size > MAX_RULE_FILE_BYTES) throw new Error('规则文件不能超过 5 MB');
      const imported = parseFilterRuleFile(await file.text());
      if (!alive.current) return;
      const result = mergeFilterRules(rulesRef.current, imported);
      if (result.added) onChange(result.rules);
      setNotice({ error: false, text: `导入完成：新增 ${result.added} 条，跳过重复 ${result.skipped} 条${imported.length ? '' : '（文件中没有规则）'}` });
    } catch (error) {
      if (alive.current) fail(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { if (alive.current) setImporting(false); }
  };
  const exportFile = () => {
    let url: string | undefined;
    const link = document.createElement('a');
    try {
      url = URL.createObjectURL(new Blob([serializeFilterRules(rulesRef.current)], { type: 'application/json;charset=utf-8' }));
      link.href = url;
      const date = new Date();
      const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      link.download = `弹幕过滤规则-${stamp}.json`;
      document.body.appendChild(link); link.click();
      setNotice({ error: false, text: `已发起导出，共 ${rulesRef.current.length} 条规则（包含已停用规则）` });
    } catch (error) { fail(`导出失败：${error instanceof Error ? error.message : String(error)}`); }
    finally {
      link.remove();
      if (url) { const downloadUrl = url; setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000); }
    }
  };
  return <section className="card filter-rules-card">
    <div className="section-title filter-rules-heading"><div><h2>屏蔽规则</h2><p className="hint">共 {rules.length} 条 · 已启用 {rules.filter(rule => rule.enabled).length} 条</p></div><Shield size={19}/></div>
    <div className="filter-file-actions">
      <button disabled={importing} onClick={() => fileInput.current?.click()}><Upload size={15}/>{importing ? '正在导入…' : '导入规则'}</button>
      <button disabled={importing || !rules.length} onClick={exportFile}><Download size={15}/>导出规则</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="选择弹幕过滤规则文件" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file); }}/>
    </div>
    <p className="hint">支持 JSON 文件；导入会合并现有规则，重复项保留当前设置。导出包含关键词、正则及各自的启用状态。</p>
    {notice && <p className={notice.error ? 'filter-file-notice error' : 'filter-file-notice'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    <div className="rule-add"><select aria-label="过滤规则类型" disabled={importing} value={kind} onChange={event => setKind(event.target.value as Rule['kind'])}><option value="keyword">关键词</option><option value="regex">正则表达式</option></select><input aria-label="屏蔽内容" disabled={importing} value={value} onChange={event => setValue(event.target.value)} onKeyDown={event => event.key === 'Enter' && addRule()} placeholder="输入屏蔽内容"/><button className="primary" disabled={importing} onClick={addRule}><Plus size={16}/> 添加</button></div>
    <div className="rules-list">{rules.length ? rules.map(rule => <div className="rule-item" key={rule.id}><input type="checkbox" aria-label={`启用规则：${rule.value}`} disabled={importing} checked={rule.enabled} onChange={() => onChange(rules.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))}/><span className="tag">{rule.kind === 'keyword' ? '关键词' : '正则'}</span><code>{rule.value}</code><button className="icon-button" aria-label={`删除规则：${rule.value}`} disabled={importing} onClick={() => onChange(rules.filter(item => item.id !== rule.id))}><Trash2 size={16}/></button></div>) : <div className="empty">尚无屏蔽规则，可添加规则或导入 JSON 文件。</div>}</div>
  </section>;
}
