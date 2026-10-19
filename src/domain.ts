export type Rule = { id: string; kind: 'keyword' | 'regex'; value: string; enabled: boolean };
export type Danmaku = {
  id: string;
  ts: number;
  nickname: string;
  content: string;
  blocked: string | null;
};

export function blockReason(content: string, rules: Rule[]): string | null {
  for (const rule of rules) {
    if (!rule.enabled || !rule.value) continue;
    if (rule.kind === 'keyword' && content.toLocaleLowerCase().includes(rule.value.toLocaleLowerCase())) return `命中关键词「${rule.value}」`;
    if (rule.kind === 'regex') {
      try { if (new RegExp(rule.value, 'iu').test(content)) return `命中正则「${rule.value}」`; }
      catch { return `规则正则无效「${rule.value}」`; }
    }
  }
  return null;
}

export function selectQuestion(pool: Danmaku[], random = Math.random): Danmaku | null {
  const latest = pool.filter(item => !item.blocked).slice(-20);
  return latest.length ? latest[Math.min(latest.length - 1, Math.floor(random() * latest.length))] : null;
}

export function parseDyhubEvent(raw: string): Danmaku | null {
  try {
    const event = JSON.parse(raw);
    if (event.type !== 'chat' || typeof event.data?.content !== 'string') return null;
    const content = event.data.content.trim();
    if (!content) return null;
    return { id: String(event.id || crypto.randomUUID()), ts: Number(event.ts || Date.now()), nickname: String(event.user?.nickname || '观众'), content, blocked: null };
  } catch { return null; }
}
