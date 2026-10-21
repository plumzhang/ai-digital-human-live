import { avatarActionFor } from './giftActions';
import { matchReplyEnding, type RecognitionObservation, type WhisperSegment } from './whisperRecognition';

export type InteractionEvent = {
  event_id: string; type: 'chat' | 'gift'; room_id: string; user_id: string; nickname: string;
  content: string; created_at: number; source?: 'test'; gift?: { name: string; count: number; gift_id: string; combo_id: string; is_final: boolean };
};
export type GiftGesture = 'heart' | 'kiss' | 'flying_kiss';
export type GeneratedReply = { speech: string; emotion: string; intent?: 'question' | 'chat' | 'action_request' | 'gift'; gesture?: GiftGesture | 'none'; action_instruction?: string; segments: { text: string; action: string; intensity: string }[] };
export type InteractionTask = {
  id: string; event: InteractionEvent; status: 'pending' | 'generating' | 'ready' | 'playing' | 'uncertain' | 'failed';
  result?: GeneratedReply; error?: string; started_at?: number; live_id?: string; opening_style?: string;
  action_state?: 'submitted' | 'failed'; action_error?: string;
  playback_token?: string;
  recognition?: { text: string; matched: boolean; progress: number; method?: 'text' | 'phonetic'; scope?: 'full' | 'tail'; compared_chars?: number; captured_at: number; inference_ms: number; segments?: WhisperSegment[]; error?: string };
};
export type HistoryEntry = { task: InteractionTask; outcome: 'played' | 'skipped' | 'failed'; reason: string; at: number };
export type HandoffDirection = 'left_down' | 'right_down';
export type HandoffAction = { task_id: string; live_id: string; direction: HandoffDirection; status: 'pending' | 'submitted' | 'failed' | 'cancelled'; error?: string; resume_at?: number; wait_ms?: number; angle_deg?: number };
export type QueueSnapshot = {
  version: 1; room_id: string; tasks: InteractionTask[]; candidates: InteractionEvent[];
  combos: Record<string, { event: InteractionEvent; deadline: number }>;
  thanked_combos: Record<string, number>; history: HistoryEntry[];
  totals?: { played: number; skipped: number; failed: number };
  next_opening_style?: number;
  handoff?: { enabled: boolean; direction: HandoffDirection; wait_ms?: number; angle_deg?: number };
  handoff_action?: HandoffAction;
  recognition?: { enabled: boolean };
};
export type ReplyDiversity = { openingStyle: string; recentOpenings: string[] };
const OPENING_STYLES = [
  '先接住当前内容，直接表达真实感受。昵称可自然出现在句中或句尾，不要固定以昵称起头。',
  '用具体的反应或一句俏皮接话开场，称呼位置自由，不逐字复述弹幕，也不先叫人名。',
  '从礼物细节或观众提到的事情自然接话，感谢或关心融入句中，不按“人名＋复述＋感想”套模板。',
  '像正在直播聊天一样随口接话，先说回应，再酌情带上昵称，语气可以开心、温柔或轻松，不作开场解释。',
];
export const INTERACTION_SLOT_COUNT = 6;
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
  handoff?: (task: InteractionTask, liveId: string, direction: HandoffDirection, angleDeg: number) => Promise<void>;
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
  private finishing = false;
  private finishOverride?: { outcome: HistoryEntry['outcome']; reason: string };
  private importing = false;
  private batchNeedsSilence = false;
  private batchQuietSince?: number;
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private whisperQuietMs = 0;
  private lastActualVoiceAt = 0;

  constructor(snapshot: QueueSnapshot, private adapter: QueueAdapter) {
    this.state = structuredClone(snapshot);
    this.state.totals ||= { played: 0, skipped: 0, failed: 0 };
    this.state.handoff ||= { enabled: false, direction: 'left_down' };
    const waitMs = this.state.handoff.wait_ms;
    this.state.handoff.wait_ms = waitMs !== undefined && Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 3000 ? waitMs : 1000;
    const angle = this.state.handoff.angle_deg;
    this.state.handoff.angle_deg = angle !== undefined && Number.isInteger(angle) && angle >= 0 && angle <= 90 ? angle : 45;
    if (this.state.handoff_action?.status === 'pending') {
      this.state.handoff_action.status = 'cancelled';
      this.state.handoff_action.error = '客户端已重新打开，未自动重复发送承接动作';
    }
    // Never replay something that may already have been spoken before a crash.
    for (const task of this.state.tasks) {
      if (task.status === 'playing') task.status = 'uncertain';
      if (task.status === 'generating') task.status = 'pending';
      if (task.recognition && task.result && !task.recognition.error) Object.assign(task.recognition, matchReplyEnding(task.result.speech, task.recognition.text));
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
  async configureRecognition(enabled: boolean) {
    let configured = false;
    await this.mutate(next => {
      if (next.tasks.some(task => ['playing', 'uncertain'].includes(task.status))) return false;
      next.recognition = { enabled }; configured = true; return true;
    });
    if (!configured) throw new Error('请先确认完成或跳过当前播报，再切换结束检测方式');
  }
  async observeRecognition(observation: RecognitionObservation) {
    if (!this.state.recognition?.enabled || !this.activeLive || observation.live_id !== this.activeLive) return;
    await this.mutate(next => {
      const task = next.tasks.find(task => task.id === observation.task_id && task.status === 'playing' && task.live_id === observation.live_id && task.playback_token === observation.capture_id);
      if (!task?.result || !Number.isFinite(observation.captured_at) || observation.captured_at < (task.started_at || 0) || observation.captured_at > this.now() + 1000 || observation.captured_at < (task.recognition?.captured_at || 0)) return false;
      const match = observation.error ? { matched: false, progress: 0 } : matchReplyEnding(task.result.speech, observation.text);
      task.recognition = { text: observation.text.slice(0, 10000), ...match, captured_at: observation.captured_at, inference_ms: observation.inference_ms, segments: observation.segments?.slice(-500), error: observation.error };
      if (observation.error) { task.status = 'uncertain'; task.error = `Whisper 识别失败，需人工确认完成或跳过：${observation.error}`; clearTimeout(this.playbackTimer); }
      return true;
    });
    await this.tick();
  }
  async configureHandoff(enabled: boolean, direction: HandoffDirection, waitMs?: number, angleDeg?: number) {
    if (!['left_down', 'right_down'].includes(direction)) throw new Error('未知的承接动作方向');
    if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3000)) throw new Error('承接动作等待时间需为0–3000毫秒的整数');
    if (angleDeg !== undefined && (!Number.isInteger(angleDeg) || angleDeg < 0 || angleDeg > 90)) throw new Error('承接动作查看角度需为0–90度的整数');
    await this.mutate(next => { next.handoff = { enabled, direction, wait_ms: waitMs ?? next.handoff?.wait_ms ?? 1000, angle_deg: angleDeg ?? next.handoff?.angle_deg ?? 45 }; return true; });
  }
  async importTestBatch(items: { event: InteractionEvent; result?: GeneratedReply }[]) {
    if (items.length < 1 || items.length > INTERACTION_SLOT_COUNT || items.some(item => !['chat', 'gift'].includes(item.event.type) || (item.event.type === 'gift' && !item.event.gift))) throw new Error(`测试需导入 1～${INTERACTION_SLOT_COUNT} 条有效弹幕或礼物`);
    if (this.faulted || this.disposed) throw new Error('队列不可用，请重新打开中控台');
    if (this.importing || this.finishing || this.speaking) throw new Error('上一轮播报或动作仍在提交，请稍后再导入');
    this.importing = true;
    try {
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
    // A new round must not reuse the previous round's idle observation. In
    // particular, an empty task window does not acknowledge action completion.
    this.batchNeedsSilence = this.state.history.some(entry => entry.task.event.source === 'test' && entry.task.live_id === this.activeLive);
    this.batchQuietSince = undefined;
    this.heardSpeech = false; this.vadEndTask = undefined;
    this.audioAt = 0; this.vadIdle = false; this.quietSince = 0;
    } finally { this.importing = false; }
    await this.tick();
  }
  async setContext(enabled: boolean, liveId: string, available: boolean) {
    if (this.activeLive && this.activeLive !== liveId) {
      // Stop submissions immediately, before asynchronously persisting the old
      // task. Audio callbacks may tick while storage is still pending.
      this.enabled = false; this.available = false;
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
  async disconnectSession(liveId: string, reason: string) {
    if (this.activeLive && this.activeLive !== liveId) return;
    // Invalidate media callbacks and delayed speech/action submissions before
    // awaiting storage; no old-session evidence may complete another task.
    this.enabled = false; this.available = false; this.activeLive = '';
    clearTimeout(this.playbackTimer);
    await this.mutate(next => {
      const task = next.tasks.find(item => item.live_id === liveId && ['playing', 'uncertain'].includes(item.status));
      if (!task) return false;
      task.status = 'uncertain'; task.error = reason;
      return true;
    });
    await this.finish('failed', reason);
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
      while (next.candidates.some(event => event.type === 'gift') && next.tasks.length >= INTERACTION_SLOT_COUNT) {
        const displaced = [...next.tasks].reverse().find(task => task.event.type === 'chat' && !['playing', 'uncertain'].includes(task.status));
        if (!displaced) break;
        this.archive(next, displaced, 'skipped', '为礼物优先任务让位'); changed = true;
      }
      while (next.tasks.length < INTERACTION_SLOT_COUNT && next.candidates.length) {
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
    if (this.disposed || this.faulted || this.importing || !this.enabled || !this.available || !this.activeLive) return;
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
    const handoff = this.state.handoff_action;
    if (handoff?.status === 'submitted' && handoff.live_id === this.activeLive && this.now() < (handoff.resume_at || 0)) return;
    if (this.batchNeedsSilence && (this.batchQuietSince === undefined || this.now() - this.batchQuietSince < (this.vadMode ? 900 : PLAYBACK_SILENCE_MS))) return;
    if (this.finishing || this.speaking || this.current() || this.audioAt < this.now() - (this.vadMode ? 500 : 2000) || this.videoAt < this.now() - 2000 ||
      (this.vadMode ? !this.vadIdle : this.now() - this.quietSince < PLAYBACK_SILENCE_MS)) return;
    this.speaking = true;
    let selected: InteractionTask | undefined;
    const liveId = this.activeLive;
    await this.mutate(next => {
      const task = next.tasks[0];
      if (!task || task.status !== 'ready' || this.importing || !this.enabled || !this.available || this.activeLive !== liveId) return false;
      task.status = 'playing'; task.started_at = this.now(); task.live_id = liveId; task.playback_token = crypto.randomUUID(); delete task.recognition; selected = structuredClone(task); return true;
    });
    if (!selected) { this.speaking = false; return; }
    this.batchNeedsSilence = false; this.batchQuietSince = undefined;
    this.heardSpeech = false; this.lastSpeechAt = 0; this.vadEndTask = undefined;
    this.whisperQuietMs = 0; this.lastActualVoiceAt = 0;
    const selectedId = selected.id;
    this.playbackTimer = setTimeout(() => { void this.markUncertain('未收到足够的播放结束信号，请确认完成或跳过', selectedId).catch(() => {}); }, 60_000);
    try {
      await this.adapter.speak(selected, liveId);
      // Submit the reply's action alongside speech. Late
      // completions, interruption and crash recovery must never replay it.
      if (this.adapter.act && avatarActionFor(selected) && !this.disposed && this.activeLive === liveId && this.current()?.id === selectedId && this.current()?.status === 'playing') {
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
    if (this.batchNeedsSilence) {
      if (speaking || this.now() - this.audioAt >= (this.vadMode ? 500 : 2000)) this.batchQuietSince = undefined;
      if (!speaking) this.batchQuietSince ??= this.now();
    }
    this.audioAt = this.now();
    if (speaking) {
      this.quietSince = this.now();
      if (this.current()?.status === 'playing') { this.heardSpeech = true; this.lastSpeechAt = this.now(); }
    } else if (!this.quietSince) this.quietSince = this.now();
  }
  observeVad(state: { speaking: boolean; ended: boolean; healthy: boolean; quiet_ms?: number }, liveId: string, at = this.now()) {
    if (!liveId || liveId !== this.activeLive || !Number.isFinite(at) || this.now() - at > 500 || at > this.now() + 100) return;
    this.vadMode = true;
    if (!state.healthy) {
      this.whisperQuietMs = 0; this.lastActualVoiceAt = this.now();
      this.batchQuietSince = undefined;
      this.audioAt = 0; this.vadIdle = false; this.vadEndTask = undefined; this.heardSpeech = false;
      return;
    }
    this.observeAudio(state.speaking, liveId);
    this.whisperQuietMs = Math.max(0, Math.min(60000, state.quiet_ms ?? 0));
    if (state.speaking && this.whisperQuietMs === 0) this.lastActualVoiceAt = at;
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
    if (this.state.recognition?.enabled) {
      const evidence = task.recognition;
      const handoffEnabled = this.state.handoff?.enabled === true;
      if (this.heardSpeech && evidence?.matched && !evidence.error && evidence.captured_at >= this.lastActualVoiceAt && (handoffEnabled || this.whisperQuietMs >= 350) &&
          this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
        this.vadIdle = true;
        await this.finish('played', handoffEnabled
          ? 'Whisper 台词匹配度达到70%，立即提交承接动作，不等待静音；提交成功后按设置等待'
          : 'Whisper 台词匹配度达到70%，连续静音至少350毫秒；承接动作关闭，直接推进', true);
      }
      return;
    }
    if (this.vadMode) {
      if (this.vadEndTask === task.id && this.vadIdle && this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
        await this.finish('played', 'RTC 下行 PCM VAD：检测到语音活动后静音结束，检查承接动作开关；开启则先提交动作并按设置等待，关闭则直接推进下一条', true);
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
    const current = this.current();
    if (this.finishing) {
      if (current && outcome !== 'played') this.finishOverride = { outcome, reason };
      return;
    }
    if (!current) return;
    this.finishing = true;
    const taskId = current.id;
    const liveId = current.live_id || '';
    try {
      clearTimeout(this.playbackTimer);
      const direction = this.state.handoff?.direction || 'left_down';
      const waitMs = this.state.handoff?.wait_ms ?? 1000;
      const angleDeg = this.state.handoff?.angle_deg ?? 45;
      if (outcome === 'played' && this.state.handoff?.enabled && this.adapter.handoff && this.state.handoff_action?.task_id !== taskId &&
          liveId && liveId === this.activeLive && this.enabled && this.available && !this.disposed) {
        // Persist the attempt before sending. Retain this slot until submission
        // finishes so another tick cannot start the next reply first.
        await this.mutate(next => {
          next.handoff_action = { task_id: taskId, live_id: liveId, direction, status: 'pending', wait_ms: waitMs, angle_deg: angleDeg };
          return true;
        });
        let status: HandoffAction['status'] = 'cancelled';
        let error: string | undefined;
        let resumeAt: number | undefined;
        if (!this.finishOverride && this.state.handoff?.enabled && this.activeLive === liveId && this.enabled && this.available && !this.disposed && this.current()?.id === taskId) {
          try {
            await this.adapter.handoff(current, liveId, direction, angleDeg);
            status = 'submitted'; resumeAt = this.now() + waitMs;
          }
          catch (cause) { status = 'failed'; error = String(cause); }
        }
        await this.mutate(next => {
          if (next.handoff_action?.task_id !== taskId) return false;
          next.handoff_action.status = status; next.handoff_action.error = error; next.handoff_action.resume_at = resumeAt;
          return true;
        });
      }
      await this.mutate(next => {
        const task = next.tasks.find(item => item.id === taskId && ['playing', 'uncertain'].includes(item.status));
        if (!task) return false;
        this.archive(next, task, this.finishOverride?.outcome || outcome, this.finishOverride?.reason || reason); return true;
      });
      this.heardSpeech = false; this.vadEndTask = undefined;
      // The next task reuses the observed silence, without another cooldown.
      if (!preserveObservedSilence) { this.quietSince = this.now(); this.vadIdle = false; }
    } finally { this.finishing = false; this.finishOverride = undefined; }
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
      task.status = 'pending'; delete task.error; delete task.result; delete task.action_state; delete task.action_error; delete task.recognition; delete task.playback_token;
      return true;
    });
    await this.tick();
  }
  dispose() { this.disposed = true; this.enabled = false; clearTimeout(this.playbackTimer); }
}
