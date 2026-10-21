type RecoveryAdapter<T extends { live_id: string }> = {
  prepare: (liveId: string) => Promise<void>;
  ended: (liveId: string) => Promise<boolean>;
  create: () => Promise<T>;
  abandon: (session: T) => Promise<void>;
  restored: (session: T) => void;
  progress: (message: string) => void;
  failed: (message: string) => void;
  settled: () => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};

// A forced AI-output closure ends the live itself. Reconnecting its WebSocket
// cannot restore it; create a fresh live only after its final state is known.
export class SessionRecovery<T extends { live_id: string }> {
  private active = false;
  private generation = 0;
  private handled = new Set<string>();
  private attempts: number[] = [];
  constructor(private adapter: RecoveryAdapter<T>) {}
  get pending() { return this.active; }
  cancel() { this.generation++; }
  async recover(liveId: string, reason: string, expected = false): Promise<boolean> {
    if (reason !== 'ai_output_closed' || expected || !liveId || this.handled.has(liveId) || this.active) return false;
    this.handled.add(liveId);
    if (this.handled.size > 100) this.handled.delete(this.handled.values().next().value!);
    const now = this.adapter.now?.() ?? Date.now();
    this.attempts = this.attempts.filter(at => now - at < 600_000);
    if (this.attempts.length >= 3) {
      this.adapter.failed('10 分钟内已自动重建 3 次，已停止恢复；请检查 Vidu 服务或手动重新创建。');
      return false;
    }
    this.attempts.push(now);
    this.active = true;
    const token = ++this.generation;
    const current = () => token === this.generation;
    const wait = this.adapter.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    try {
      this.adapter.progress('AI 输出通道关闭，正在暂停队列并确认旧会话结束…');
      await this.adapter.prepare(liveId);
      await wait(1000 * 2 ** (this.attempts.length - 1));
      if (!current()) return false;
      let ended = false;
      for (let i = 0; i < 10 && current(); i++) {
        ended = await this.adapter.ended(liveId);
        if (ended) break;
        await wait(1000);
      }
      if (!current()) return false;
      if (!ended) throw new Error('Vidu 尚未确认旧会话 ended，已停止重建，避免并行计费');
      this.adapter.progress('旧会话已结束，正在按原配置创建新会话…');
      const session = await this.adapter.create();
      if (!current()) {
        try { await this.adapter.abandon(session); }
        catch (error) { this.adapter.failed(`取消恢复后结束新会话失败，请重试结束会话：${String(error)}`); }
        return false;
      }
      this.adapter.restored(session);
      return true;
    } catch (error) {
      if (current()) this.adapter.failed(`自动恢复失败：${String(error)}`);
      return false;
    } finally { this.active = false; this.adapter.settled(); }
  }
}
