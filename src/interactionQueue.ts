export type InteractionEvent = {
  event_id: string; type: 'chat' | 'gift'; room_id: string; user_id: string; nickname: string;
  content: string; created_at: number; source?: 'test'; gift?: { name: string; count: number; gift_id: string; combo_id: string; is_final: boolean };
};
export type GiftGesture = 'heart' | 'kiss' | 'flying_kiss';
export type GeneratedReply = { speech: string; emotion: string; gesture?: GiftGesture | 'none'; segments: { text: string; action: string; intensity: string }[] };
export type InteractionTask = {
  id: string; event: InteractionEvent; status: 'pending' | 'generating' | 'ready' | 'playing' | 'uncertain' | 'failed';
  result?: GeneratedReply; error?: string; started_at?: number; live_id?: string; opening_style?: string;
  action_state?: 'submitted' | 'failed'; action_error?: string;
};
export type HistoryEntry = { task: InteractionTask; outcome: 'played' | 'skipped' | 'failed'; reason: string; at: number };
export type QueueSnapshot = {
  version: 1; room_id: string; tasks: InteractionTask[]; candidates: InteractionEvent[];
  combos: Record<string, { event: InteractionEvent; deadline: number }>;
  thanked_combos: Record<string, number>; history: HistoryEntry[];
  totals?: { played: number; skipped: number; failed: number };
  next_opening_style?: number;
};
export type ReplyDiversity = { openingStyle: string; recentOpenings: string[] };
const OPENING_STYLES = [
  '先接住当前内容，直接表达真实感受。昵称可自然出现在句中或句尾，不要固定以昵称起头。',
  '用具体的反应或一句俏皮接话开场，称呼位置自由，不逐字复述弹幕，也不先叫人名。',
  '从礼物细节或观众提到的事情自然接话，感谢或关心融入句中，不按“人名＋复述＋感想”套模板。',
  '像正在直播聊天一样随口接话，先说回应，再酌情带上昵称，语气可以开心、温柔或轻松，不作开场解释。',
];
export const emptyQueue = (): QueueSnapshot => ({ version: 1, room_id: '', tasks: [], candidates: [], combos: {}, thanked_combos: {}, history: [], totals: { played: 0, skipped: 0, failed: 0 } });
// text_tts has no completion acknowledgement. Use one RTC silence window,
// shared by completion detection and the next submission, without waiting twice.
const PLAYBACK_SILENCE_MS = 1500;

export function normalizeInteraction(raw: unknown, now = Date.now()): InteractionEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, any>;
  if (event.type !== 'chat' && event.type !== 'gift') return null;
  const data = event.data || {};
  let ts = Number(event.ts || now);
  if (ts < 1e12) ts *= 1000;
  const base = {
    event_id: String(event.id || crypto.randomUUID()), type: event.type as 'chat' | 'gift',
    room_id: String(event.roomId || ''), user_id: String(event.user?.id || ''),
    nickname: String(event.user?.nickname || '观众'), created_at: Math.min(Number.isFinite(ts) ? ts : now, now),
  };
  if (event.type === 'chat') {
    if (typeof data.content !== 'string' || !data.content.trim()) return null;
    return { ...base, content: data.content.trim() };
  }
  const gift = {
    name: String(data.giftName || '礼物'), count: Math.max(1, Number(data.repeatCount) || 0, Number(data.comboCount) || 0, Number(data.groupCount) || 0),
    gift_id: String(data.giftId || ''), combo_id: data.groupId && String(data.groupId) !== '0' ? String(data.groupId) : '', is_final: data.repeatEnd === true,
  };
  return { ...base, content: `${gift.name}×${gift.count}`, gift };
}

type QueueAdapter = {
  persist: (snapshot: QueueSnapshot) => Promise<void>;
  generate: (task: InteractionTask, history: HistoryEntry[], diversity: ReplyDiversity) => Promise<GeneratedReply>;
  speak: (task: InteractionTask, liveId: string) => Promise<void>;
  act?: (task: InteractionTask, liveId: string) => Promise<void>;
  changed: (snapshot: QueueSnapshot) => void;
  error: (message: string) => void;
  now?: () => number;
};

export class InteractionQueue {
  private state: QueueSnapshot;
  private serial = Promise.resolve();
  private running = new Set<string>();
  private enabled = false;
  private activeLive = '';
  private available = false;
  private faulted = false;
  private disposed = false;
  private speaking = false;
  private pumping = false;
  private heardSpeech = false;
  private audioAt = 0;
  private lastSpeechAt = 0;
  private videoAt = 0;
  private quietSince = 0;
  private vadMode = false;
  private vadIdle = false;
  private vadEndTask?: string;
  private playbackTimer?: ReturnType<typeof setTimeout>;

  constructor(snapshot: QueueSnapshot, private adapter: QueueAdapter) {
    this.state = structuredClone(snapshot);
    this.state.totals ||= { played: 0, skipped: 0, failed: 0 };
    // Never replay something that may already have been spoken before a crash.
    for (const task of this.state.tasks) {
      if (task.status === 'playing') task.status = 'uncertain';
      if (task.status === 'generating') task.status = 'pending';
    }
  }
  snapshot() { return structuredClone(this.state); }
  isGenerating() { return this.running.size > 0; }
  private now() { return this.adapter.now?.() ?? Date.now(); }
  private current() { return this.state.tasks.find(task => task.status === 'playing' || task.status === 'uncertain'); }
  private mutate(change: (next: QueueSnapshot) => boolean): Promise<void> {
    const operation = this.serial.then(async () => {
      if (this.disposed || this.faulted) return;
      const next = structuredClone(this.state);
      if (!change(next)) return;
      next.history = next.history.slice(-100);
      await this.adapter.persist(next);
      this.state = next;
      this.adapter.changed(this.snapshot());
    });
    this.serial = operation.catch(error => {
      this.faulted = true; this.enabled = false;
      this.adapter.error(`队列存储失败，已暂停调度：${String(error)}`);
    });
    return operation;
  }
  private archive(next: QueueSnapshot, task: InteractionTask, outcome: HistoryEntry['outcome'], reason: string) {
    next.history.push({ task, outcome, reason, at: this.now() });
    next.totals ||= { played: 0, skipped: 0, failed: 0 };
    next.totals[outcome] += 1;
    next.tasks = next.tasks.filter(item => item.id !== task.id);
  }
  async restore() { await this.mutate(() => true); }
  async importTestBatch(items: { event: InteractionEvent; result?: GeneratedReply }[]) {
    if (items.length !== 3 || items.some(item => !['chat', 'gift'].includes(item.event.type) || (item.event.type === 'gift' && !item.event.gift))) throw new Error('测试必须刚好导入 3 条弹幕或礼物');
    if (this.faulted || this.disposed) throw new Error('队列不可用，请重新打开中控台');
    let imported = false;
    await this.mutate(next => {
      if (next.tasks.length || next.candidates.length || Object.keys(next.combos).length) return false;
      next.room_id = items[0].event.room_id;
      next.tasks = items.map(item => ({
        id: crypto.randomUUID(), event: { ...structuredClone(item.event), source: 'test' },
        status: item.result ? 'ready' : 'pending',
        ...(item.result ? { result: structuredClone(item.result) } : {}),
      }));
      imported = true;
      return true;
    });
    if (!imported) throw new Error('队列还有待处理任务，请先完成或跳过后再导入测试弹幕');
    await this.tick();
  }
  async setContext(enabled: boolean, liveId: string, available: boolean) {
    if (this.activeLive && this.activeLive !== liveId) {
      await this.mutate(next => {
        const task = next.tasks.find(item => item.status === 'playing');
        if (task) { task.status = 'uncertain'; task.error = '会话已切换，需人工确认上一条是否已播报'; return true; }
        return false;
      });
    }
    if (this.activeLive !== liveId) {
      this.audioAt = 0; this.videoAt = 0; this.quietSince = 0;
      this.heardSpeech = false; this.vadMode = false; this.vadIdle = false; this.vadEndTask = undefined;
    }
    this.enabled = enabled; this.activeLive = liveId; this.available = available;
    await this.tick();
  }
  async ingest(event: InteractionEvent) {
    if (this.faulted || this.disposed) throw new Error('队列不可用，事件仍保留在数据库待恢复');
    await this.mutate(next => {
      if (next.room_id && event.room_id && next.room_id !== event.room_id) {
        next.candidates = next.candidates.filter(item => item.type === 'gift');
        for (const task of [...next.tasks]) {
          if (task.event.type === 'chat' && !['playing', 'uncertain'].includes(task.status)) this.archive(next, task, 'skipped', '直播间已切换');
        }
      }
      next.room_id = event.room_id || next.room_id;
      if ([...next.candidates, ...next.tasks.map(task => task.event), ...next.history.map(entry => entry.task.event)].some(item => item.event_id === event.event_id && item.room_id === event.room_id)) return false;
      if (event.type === 'chat') {
        if (this.now() - event.created_at > 30_000) return false;
        next.candidates.push(event);
        const chats = next.candidates.filter(item => item.type === 'chat').sort((a, b) => b.created_at - a.created_at).slice(0, 200);
        next.candidates = [...next.candidates.filter(item => item.type === 'gift'), ...chats];
      } else {
        const gift = event.gift!;
        const base = `${event.room_id}:${event.user_id || event.nickname}:${gift.gift_id || gift.name}`;
        const existing = Object.entries(next.combos).find(([key, value]) => !gift.combo_id && key.startsWith(`${base}:window:`) && value.deadline >= this.now());
        const key = gift.combo_id ? `${base}:group:${gift.combo_id}` : existing?.[0] || `${base}:window:${event.event_id}`;
        if (key in next.thanked_combos) return false;
        const previous = next.combos[key]?.event;
        const combined = structuredClone(previous || event);
        combined.gift!.count = Math.max(previous?.gift?.count || 0, gift.count);
        combined.gift!.is_final = gift.is_final;
        combined.content = `${gift.name}×${combined.gift!.count}`;
        next.combos[key] = { event: combined, deadline: gift.is_final ? this.now() : this.now() + 2000 };
      }
      return true;
    });
    await this.tick();
    if (this.faulted || this.disposed) throw new Error('队列已暂停，事件保留在数据库待恢复');
  }
  async tick() {
    await this.mutate(next => {
      let changed = false;
      for (const [key, combo] of Object.entries(next.combos)) {
        if (combo.deadline > this.now()) continue;
        next.candidates.push(combo.event); next.thanked_combos[key] = this.now(); delete next.combos[key]; changed = true;
      }
      for (const task of [...next.tasks]) {
        if (task.event.type === 'chat' && task.event.source !== 'test' && !['playing', 'uncertain'].includes(task.status) && this.now() - task.event.created_at > 30_000) {
          this.archive(next, task, 'skipped', '弹幕已超过 30 秒'); changed = true;
        }
      }
      const fresh = next.candidates.filter(event => event.type === 'gift' || this.now() - event.created_at <= 30_000);
      if (fresh.length !== next.candidates.length) { next.candidates = fresh; changed = true; }
      if (!this.enabled || !this.available || !this.activeLive) return changed;
      // Make room for gifts without touching the current speech or other gifts.
      while (next.candidates.some(event => event.type === 'gift') && next.tasks.length >= 3) {
        const displaced = [...next.tasks].reverse().find(task => task.event.type === 'chat' && !['playing', 'uncertain'].includes(task.status));
        if (!displaced) break;
        this.archive(next, displaced, 'skipped', '为礼物优先任务让位'); changed = true;
      }
      while (next.tasks.length < 3 && next.candidates.length) {
        next.candidates.sort((a, b) => a.type !== b.type ? a.type === 'gift' ? -1 : 1 : a.type === 'chat' ? b.created_at - a.created_at : a.created_at - b.created_at);
        const event = next.candidates.shift()!;
        const task: InteractionTask = { id: crypto.randomUUID(), event, status: 'pending' };
        if (event.type === 'gift') {
          const index = next.tasks.findIndex(item => item.event.type === 'chat' && !['playing', 'uncertain'].includes(item.status));
          if (index >= 0) next.tasks.splice(index, 0, task); else next.tasks.push(task);
        } else next.tasks.push(task);
        changed = true;
      }
      return changed;
    });
    await this.pump();
    await this.observeCompletion();
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
    if (this.disposed || this.faulted || !this.enabled || !this.available || !this.activeLive) return;
    const jobs: InteractionTask[] = [];
    await this.mutate(next => {
      for (const task of next.tasks) {
        if (this.running.size + jobs.length >= 2) break;
        if (task.status !== 'pending' || this.running.has(task.id)) continue;
        next.next_opening_style ??= parseInt(crypto.randomUUID().slice(0, 2), 16) % OPENING_STYLES.length;
        task.opening_style = OPENING_STYLES[next.next_opening_style % OPENING_STYLES.length];
        next.next_opening_style += 1;
        task.status = 'generating'; jobs.push(structuredClone(task));
      }
      return jobs.length > 0;
    });
    if (this.disposed || this.faulted) return;
    for (const task of jobs) {
      this.running.add(task.id);
      const history = this.state.history.filter(entry => entry.outcome === 'played' && task.event.user_id && entry.task.event.user_id === task.event.user_id && entry.task.event.room_id === task.event.room_id).slice(-3);
      const recent = [...this.state.history.filter(entry => entry.outcome === 'played').slice(-6).map(entry => entry.task), ...this.state.tasks.filter(item => item.id !== task.id && item.result)];
      const recentOpenings = [...new Set(recent.map(item => (item.result?.speech || '').split(item.event.nickname).join('观众').replace(/[\r\n]+/g, ' ').trim().slice(0, 18)).filter(Boolean))].slice(-8);
      void this.adapter.generate(task, history, { openingStyle: task.opening_style!, recentOpenings }).then(async result => {
        if (!result.speech.trim()) throw new Error('模型返回空台词');
        await this.mutate(next => {
          const target = next.tasks.find(item => item.id === task.id && item.status === 'generating');
          if (!target) return false;
          target.result = result; target.status = 'ready'; return true;
        });
      }).catch(async error => {
        await this.mutate(next => {
          const target = next.tasks.find(item => item.id === task.id && item.status === 'generating');
          if (!target) return false;
          target.status = 'failed'; target.error = String(error); return true;
        });
      }).finally(() => { this.running.delete(task.id); void this.tick(); });
    }
    if (this.speaking || this.current() || this.audioAt < this.now() - (this.vadMode ? 500 : 2000) || this.videoAt < this.now() - 2000 ||
      (this.vadMode ? !this.vadIdle : this.now() - this.quietSince < PLAYBACK_SILENCE_MS)) return;
    this.speaking = true;
    let selected: InteractionTask | undefined;
    const liveId = this.activeLive;
    await this.mutate(next => {
      const task = next.tasks[0];
      if (!task || task.status !== 'ready' || !this.enabled || !this.available || this.activeLive !== liveId) return false;
      task.status = 'playing'; task.started_at = this.now(); task.live_id = liveId; selected = structuredClone(task); return true;
    });
    if (!selected) { this.speaking = false; return; }
    this.heardSpeech = false; this.lastSpeechAt = 0; this.vadEndTask = undefined;
    const selectedId = selected.id;
    this.playbackTimer = setTimeout(() => { void this.markUncertain('未收到足够的播放结束信号，请确认完成或跳过', selectedId).catch(() => {}); }, 60_000);
    try {
      await this.adapter.speak(selected, liveId);
      // Send one gesture for this gift only after speech submission. Late
      // completions, interruption and crash recovery must never replay it.
      if (this.adapter.act && selected.event.type === 'gift' && !this.disposed && this.activeLive === liveId && this.current()?.id === selectedId && this.current()?.status === 'playing') {
        let actionError: string | undefined;
        try { await this.adapter.act(selected, liveId); }
        catch (error) { actionError = String(error); }
        await this.mutate(next => {
          const task = next.tasks.find(item => item.id === selectedId);
          if (!task) return false;
          task.action_state = actionError ? 'failed' : 'submitted';
          task.action_error = actionError;
          return true;
        });
      }
    }
    catch (error) { await this.markUncertain(`播报提交未确认：${String(error)}`, selectedId); }
    finally { this.speaking = false; }
    } finally { this.pumping = false; }
  }
  observeAudio(speaking: boolean, liveId: string) {
    if (!liveId || liveId !== this.activeLive) return;
    this.audioAt = this.now();
    if (speaking) {
      this.quietSince = this.now();
      if (this.current()?.status === 'playing') { this.heardSpeech = true; this.lastSpeechAt = this.now(); }
    } else if (!this.quietSince) this.quietSince = this.now();
  }
  observeVad(state: { speaking: boolean; ended: boolean; healthy: boolean }, liveId: string, at = this.now()) {
    if (!liveId || liveId !== this.activeLive || !Number.isFinite(at) || this.now() - at > 500 || at > this.now() + 100) return;
    this.vadMode = true;
    if (!state.healthy) {
      this.audioAt = 0; this.vadIdle = false; this.vadEndTask = undefined; this.heardSpeech = false;
      return;
    }
    this.observeAudio(state.speaking, liveId);
    this.vadIdle = !state.speaking;
    if (state.speaking) this.vadEndTask = undefined;
    else if (state.ended && this.heardSpeech && this.current()?.status === 'playing') this.vadEndTask = this.current()!.id;
  }
  observeVideo(liveId: string) { if (liveId === this.activeLive) this.videoAt = this.now(); }
  private async observeCompletion() {
    const task = this.current();
    if (!task || task.status !== 'playing') return;
    if (this.now() - task.started_at! >= 60_000) {
      await this.markUncertain('60 秒内未确认播放结束，已保留任务并暂停后续播报');
      return;
    }
    if (this.vadMode) {
      if (this.vadEndTask === task.id && this.vadIdle && this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
        await this.finish('played', 'RTC 下行 PCM VAD：检测到语音活动后静音结束，立即调度下一条', true);
      }
      return;
    }
    // This is an explicit local observation, not a provider acknowledgement.
    if (this.heardSpeech && this.now() - this.lastSpeechAt >= PLAYBACK_SILENCE_MS && this.now() - this.audioAt < 2000 && this.now() - this.videoAt < 2000) {
      await this.finish('played', 'RTC 播放观测：收到语音后连续静音 1.5 秒，画面与音频回调持续正常', true);
    }
  }
  private async markUncertain(reason: string, taskId?: string) {
    await this.mutate(next => {
      const task = next.tasks.find(item => item.status === 'playing' && (!taskId || item.id === taskId));
      if (!task) return false;
      task.status = 'uncertain'; task.error = reason; return true;
    });
  }
  async finish(outcome: HistoryEntry['outcome'], reason: string, preserveObservedSilence = false) {
    clearTimeout(this.playbackTimer);
    await this.mutate(next => {
      const task = next.tasks.find(item => ['playing', 'uncertain'].includes(item.status));
      if (!task) return false;
      this.archive(next, task, outcome, reason); return true;
    });
    this.heardSpeech = false; this.vadEndTask = undefined;
    // A confirmed quiet period already preceded automatic completion. Resetting
    // it here would add the entire wait a second time before the next task.
    if (!preserveObservedSilence) { this.quietSince = this.now(); this.vadIdle = false; }
    await this.tick();
  }
  async skip(id: string) {
    await this.mutate(next => {
      const task = next.tasks.find(item => item.id === id);
      if (!task || ['playing', 'uncertain'].includes(task.status)) return false;
      this.archive(next, task, task.status === 'failed' ? 'failed' : 'skipped', '操作员跳过'); return true;
    });
    await this.tick();
  }
  async retry(id: string) {
    await this.mutate(next => {
      const task = next.tasks.find(item => item.id === id && ['failed', 'ready'].includes(item.status));
      if (!task) return false;
      task.status = 'pending'; delete task.error; delete task.result; delete task.action_state; delete task.action_error;
      return true;
    });
    await this.tick();
  }
  dispose() { this.disposed = true; this.enabled = false; clearTimeout(this.playbackTimer); }
}
