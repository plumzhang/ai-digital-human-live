import { mergeAvatarText, type AvatarOutput } from './avatarOutput';
import { avatarActionFor } from './giftActions';
import { matchReplyEnding, matchPlaybackEnding, type RecognitionObservation, type WhisperSegment } from './whisperRecognition';
import type { SongDirector, SongPlaybackState, SongPcmPhase } from './songDirector';
import { replyOpening, repeatedOpening } from './replyDiversity';

export type InteractionEvent = {
  event_id: string; type: 'chat' | 'gift' | 'song'; room_id: string; user_id: string; nickname: string;
  content: string; created_at: number; source?: 'test'; gift?: { name: string; count: number; gift_id: string; combo_id: string; is_final: boolean };
};
export type GiftGesture = 'heart' | 'kiss' | 'flying_kiss';
// Component tasks keep the input in speech; answer contains the synthesized reply.
export type GeneratedReply = { speech: string; generation_mode?: 'question' | 'component'; prepared_reply?: string; prepared_for_live?: string; request?: string; emotion: string; intent?: 'question' | 'chat' | 'action_request' | 'gift'; gesture?: GiftGesture | 'none'; action_instruction?: string; segments: { text: string; action: string; intensity: string }[] };
export type InteractionTask = {
  id: string; event: InteractionEvent; status: 'pending' | 'generating' | 'ready' | 'playing' | 'uncertain' | 'failed';
  result?: GeneratedReply; error?: string; started_at?: number; live_id?: string; opening_style?: string;
  action_state?: 'pending' | 'submitted' | 'failed' | 'cancelled'; action_error?: string;
  handoff_action?: { direction: HandoffDirection; angle_deg: number; status: 'waiting' | 'pending' | 'submitted' | 'failed' | 'cancelled'; error?: string };
  reply_action_delay_ms?: number;
  playback_token?: string;
  generation_token?: string;
  generation_note?: string;
  prepared_audio?: { token: string; live_id: string; state: 'preparing' | 'ready'; duration_ms?: number };
  audio_sent_at?: number;
  answer?: { text: string; received_at: number; message_ids: string[]; final?: boolean };
  song?: { id: string; title: string; duration_ms: number };
  song_playback?: 'starting' | 'blocked' | 'playing';
  song_pcm_active?: boolean;
  song_parent?: { task_id: string; playback_token: string };
  action_only?: boolean;
  recognition?: { text: string; matched: boolean; progress: number; ending_matched?: boolean; method?: 'text' | 'phonetic'; scope?: 'full' | 'tail'; compared_chars?: number; captured_at: number; inference_ms: number; segments?: WhisperSegment[]; error?: string };
};
export type HistoryEntry = { task: InteractionTask; outcome: 'played' | 'skipped' | 'failed'; reason: string; at: number };
function matchTaskReply(task: InteractionTask, text: string, percent: number) {
  const component = task.result?.generation_mode === 'component';
  const expected = component ? task.result?.prepared_reply || (task.answer?.final === true ? task.answer.text : '') : task.answer?.text || '';
  const match = component ? matchPlaybackEnding(expected, text) : matchReplyEnding(expected, text);
  return { ...match, matched: match.progress * 100 + 1e-9 >= percent && (!('ending_matched' in match) || match.ending_matched === true) };
}
export const HANDOFF_DIRECTIONS = [
  { value: 'left_down', label: '向左下角查看' },
  { value: 'right_down', label: '向右下角查看' },
  { value: 'left_up', label: '向左上角查看' },
  { value: 'right_up', label: '向右上角查看' },
  { value: 'left', label: '向左侧查看' },
  { value: 'right', label: '向右侧查看' },
  { value: 'up', label: '向上方查看' },
  { value: 'down', label: '向下方查看' },
  { value: 'front', label: '平视前方' },
] as const;
export type HandoffDirection = typeof HANDOFF_DIRECTIONS[number]['value'];
export function handoffActionLabel(direction: HandoffDirection, angleDeg = 30): string {
  const label = HANDOFF_DIRECTIONS.find(item => item.value === direction)?.label || '未知方向';
  return direction === 'front' ? label : `${label}（${angleDeg}度）`;
}
export type HandoffAction = { task_id: string; live_id: string; direction: HandoffDirection; status: 'pending' | 'submitted' | 'failed' | 'cancelled'; error?: string; resume_at?: number; wait_ms?: number; angle_deg?: number };
export type QueueSnapshot = {
  version: 1; room_id: string; tasks: InteractionTask[]; candidates: InteractionEvent[];
  deferred_tasks?: InteractionTask[];
  combos: Record<string, { event: InteractionEvent; deadline: number }>;
  thanked_combos: Record<string, number>; history: HistoryEntry[];
  totals?: { played: number; skipped: number; failed: number };
  next_opening_style?: number;
  handoff?: { enabled: boolean; direction: HandoffDirection; wait_ms?: number; angle_deg?: number; trigger_percent?: number };
  handoff_action?: HandoffAction;
  reply_action_delay_ms?: number;
  recognition?: { enabled: boolean; match_percent?: number };
};
export type ReplyDiversity = { openingStyle: string; recentOpenings: string[] };
const OPENING_STYLES = [
  '先接住当前内容，直接表达真实感受。昵称可自然出现在句中或句尾，不要固定以昵称起头。',
  '用具体的反应或一句俏皮接话开场，称呼位置自由，不逐字复述弹幕，也不先叫人名。',
  '从礼物细节或观众提到的事情自然接话，感谢或关心融入句中，不按“人名＋复述＋感想”套模板。',
  '像正在直播聊天一样随口接话，先说回应，再酌情带上昵称，语气可以开心、温柔或轻松，不作开场解释。',
];
export const INTERACTION_SLOT_COUNT = 3;
export const emptyQueue = (): QueueSnapshot => ({ version: 1, room_id: '', tasks: [], candidates: [], combos: {}, thanked_combos: {}, history: [], totals: { played: 0, skipped: 0, failed: 0 } });
// text_msg has no completion acknowledgement. Use one RTC silence window,
// shared by completion detection and the next submission, without waiting twice.
const PLAYBACK_SILENCE_MS = 1500;
const SONG_ENDING_ACTION='歌曲结束时动作仍在提交，请稍候…';

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
  generate: (task: InteractionTask, history: HistoryEntry[], diversity: ReplyDiversity, liveId: string) => Promise<GeneratedReply>;
  rewriteReply?: (task: InteractionTask, draft: GeneratedReply, history: HistoryEntry[], diversity: ReplyDiversity, liveId: string) => Promise<GeneratedReply>;
  prepareAudio?: (task: InteractionTask, liveId: string) => Promise<{ state: 'ready' | 'busy' | 'cancelled'; duration_ms?: number }>;
  retainAudio?: (liveId: string, tokens: string[]) => Promise<void>;
  speak: (task: InteractionTask, liveId: string) => Promise<void>;
  stopSong?: (task: InteractionTask) => Promise<void>;
  act?: (task: InteractionTask, liveId: string) => Promise<void>;
  interruptReply?: (task: InteractionTask) => Promise<void>;
  handoff?: (task: InteractionTask, liveId: string, direction: HandoffDirection, angleDeg: number) => Promise<void>;
  changed: (snapshot: QueueSnapshot) => void;
  error: (message: string) => void;
  now?: () => number;
};

export class InteractionQueue {
  private state: QueueSnapshot;
  private serial = Promise.resolve();
  private running = new Set<string>();
  private preparingAudio = false;
  private audioRetryAt = 0;
  private audioSerial = Promise.resolve();
  private audioRetained = '';
  private enabled = false;
  private activeLive = '';
  private available = false;
  private faulted = false;
  private disposed = false;
  private speaking = false;
  private playbackHeld = false;
  private pumping = false;
  private scheduling = false;
  private heardSpeech = false;
  private audioAt = 0;
  private lastSpeechAt = 0;
  private videoAt = 0;
  private quietSince = 0;
  private insertionQuietSince = 0;
  private vadMode = false;
  private vadIdle = false;
  private vadEndTask?: string;
  private finishing = false;
  private finishOverride?: { outcome: HistoryEntry['outcome']; reason: string };
  private importing = false;
  private batchNeedsSilence = false;
  private batchQuietSince?: number;
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private songTimer?: ReturnType<typeof setTimeout>;
  private songConsuming=new Set<string>();
  private songActions=new Map<string,Promise<void>>();
  private songPhaseSeen='';
  private whisperQuietMs = 0;
  private lastActualVoiceAt = 0;

  constructor(snapshot: QueueSnapshot, private adapter: QueueAdapter) {
    this.state = structuredClone(snapshot);
    // Preserve tasks from the previous six-slot version without hiding an
    // unfinished playback or dropping queued gifts/songs during migration.
    const legacy = this.state.tasks;
    const visible = legacy.slice(0, INTERACTION_SLOT_COUNT);
    const active = legacy.find(task => ['playing', 'uncertain'].includes(task.status));
    if (active && !visible.includes(active)) visible.splice(0, visible.length, active, ...legacy.filter(task => task !== active).slice(0, INTERACTION_SLOT_COUNT - 1));
    this.state.tasks = visible;
    this.state.deferred_tasks = [...legacy.filter(task => !visible.includes(task)), ...(this.state.deferred_tasks || [])];
    this.state.totals ||= { played: 0, skipped: 0, failed: 0 };
    if (this.state.recognition) {
      const matchPercent = this.state.recognition.match_percent;
      this.state.recognition.match_percent = matchPercent !== undefined && Number.isInteger(matchPercent) && matchPercent >= 50 && matchPercent <= 100 ? matchPercent : 70;
    }
    this.state.handoff ||= { enabled: false, direction: 'left_down' };
    if (!Number.isInteger(this.state.reply_action_delay_ms) || this.state.reply_action_delay_ms! < 0 || this.state.reply_action_delay_ms! > 60000) this.state.reply_action_delay_ms = 0;
    if (!HANDOFF_DIRECTIONS.some(item => item.value === this.state.handoff?.direction)) this.state.handoff.direction = 'left_down';
    const waitMs = this.state.handoff.wait_ms;
    this.state.handoff.wait_ms = waitMs !== undefined && Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 3000 ? waitMs : 1699;
    const angle = this.state.handoff.angle_deg;
    this.state.handoff.angle_deg = angle !== undefined && Number.isInteger(angle) && angle >= 0 && angle <= 90 ? angle : 30;
    const triggerPercent = this.state.handoff.trigger_percent;
    this.state.handoff.trigger_percent = triggerPercent !== undefined && Number.isInteger(triggerPercent) && triggerPercent >= 1 && triggerPercent <= 100 ? triggerPercent : 50;
    if (this.state.handoff_action?.status === 'pending') {
      this.state.handoff_action.status = 'cancelled';
      this.state.handoff_action.error = '客户端已重新打开，未自动重复发送承接动作';
    }
    // Never replay something that may already have been spoken before a crash.
    for (const task of [...this.state.tasks, ...this.state.deferred_tasks]) {
      // PCM handles belong to the native process, never to a restored JSON file.
      delete task.prepared_audio;
      delete task.generation_token;
      if (task.status === 'playing') task.status = 'uncertain';
      if (task.handoff_action?.status === 'pending') { task.handoff_action.status = 'cancelled'; task.handoff_action.error = '客户端已重新打开，未重复发送承接动作'; }
      if (task.action_state === 'pending') { task.action_state = 'cancelled'; task.action_error = '客户端已重新打开，未重复发送回复动作'; }
      if (task.status === 'generating') task.status = 'pending';
      if (!task.song && task.status === 'ready' && task.result?.generation_mode !== 'question' && task.result?.generation_mode !== 'component') {
        task.status = 'pending';
        delete task.result; delete task.error; delete task.answer;
        delete task.action_state; delete task.action_error; delete task.recognition;
      }
      if (task.recognition && task.result && !task.recognition.error) {
        Object.assign(task.recognition, matchTaskReply(task, task.recognition.text, this.state.recognition?.match_percent ?? 70));
      }
    }
  }
  snapshot() { return structuredClone(this.state); }
  isGenerating() { return this.running.size > 0; }
  setPlaybackHeld(held: boolean) { this.playbackHeld = held; void this.syncAudio().catch(error => this.adapter.error(String(error))); }
  canInsertPlayback(quietMs = PLAYBACK_SILENCE_MS) {
    return !this.disposed && !this.faulted && !this.importing && !this.finishing && !this.speaking && !this.current() && !!this.activeLive &&
      this.now() - this.videoAt < 2000 && this.now() - this.audioAt < (this.vadMode ? 500 : 2000) &&
      (this.vadMode ? this.vadIdle : true) && !!this.insertionQuietSince && this.now() - this.insertionQuietSince >= quietMs;
  }
  private now() { return this.adapter.now?.() ?? Date.now(); }
  private recentOpenings(snapshot: QueueSnapshot, task: InteractionTask, precedingOnly = false) {
    const index = snapshot.tasks.findIndex(item => item.id === task.id);
    const candidates = precedingOnly ? snapshot.tasks.slice(0, index) : snapshot.tasks;
    const recent = [...snapshot.history.filter(entry => entry.outcome === 'played').slice(-6).map(entry => entry.task),
      ...candidates.filter(item => item.id !== task.id && ['ready','playing','uncertain'].includes(item.status))];
    return [...new Set(recent.map(item => replyOpening(item.result?.prepared_reply || item.answer?.text || '', item.event.nickname || '')).filter(Boolean))].slice(-8);
  }
  private current() { return this.state.tasks.find(task => !task.song && ['playing','uncertain'].includes(task.status)) || this.state.tasks.find(task => ['playing','uncertain'].includes(task.status)); }
  private activeSong() { const task=this.state.tasks[0];return task?.song && task.status==='playing' ? task : undefined; }
  private singing() { const song=this.activeSong();return !!song&&song.song_pcm_active!==false; }
  private mutate(change: (next: QueueSnapshot) => boolean): Promise<void> {
    const operation = this.serial.then(async () => {
      if (this.disposed || this.faulted) return;
      const next = structuredClone(this.state);
      if (!change(next)) return;
      for (const task of next.tasks) {
        if (task.song || ['playing','uncertain'].includes(task.status) || (!this.adapter.prepareAudio && task.result?.generation_mode !== 'component')) continue;
        task.reply_action_delay_ms = next.reply_action_delay_ms ?? 0;
        if (next.handoff?.enabled) task.handoff_action = { direction: next.handoff.direction, angle_deg: next.handoff.angle_deg ?? 30, status: 'waiting' };
        else delete task.handoff_action;
      }
      next.history = next.history.slice(-100);
      await this.adapter.persist(next);
      this.state = next;
      this.adapter.changed(this.snapshot());
      void this.syncAudio().catch(error => this.adapter.error(String(error)));
    });
    this.serial = operation.catch(error => {
      this.faulted = true; this.enabled = false;
      this.adapter.error(`队列存储失败，已暂停调度：${String(error)}`);
    });
    return operation;
  }
  private syncAudio(): Promise<void> {
    const sync = this.audioSerial.catch(() => {}).then(async () => {
      if (!this.adapter.retainAudio) return;
      const live = this.disposed ? '' : this.activeLive;
      const preparing = this.enabled && this.available && !this.playbackHeld && !this.disposed;
      const tokens = live ? this.state.tasks.flatMap(task => task.prepared_audio?.live_id === live && (task.prepared_audio.state === 'ready' || preparing) ? [task.prepared_audio.token] : []) : [];
      const key = JSON.stringify([live, tokens]);
      if (key === this.audioRetained) return;
      await this.adapter.retainAudio(live, tokens); this.audioRetained = key;
    });
    this.audioSerial = sync; return sync;
  }
  async invalidatePreparedAudio() {
    await this.mutate(next => { for (const task of next.tasks) if (!['playing','uncertain'].includes(task.status)) delete task.prepared_audio; return true; });
    this.audioRetryAt = 0; await this.syncAudio(); await this.tick();
  }
  private async prepareNextAudio() {
    if (!this.adapter.prepareAudio || this.preparingAudio || this.playbackHeld || this.singing() || this.now() < this.audioRetryAt) return;
    let selected: InteractionTask | undefined;
    await this.mutate(next => {
      if (!this.enabled || !this.available || this.disposed) return false;
      const task = next.tasks.find(t => t.status === 'ready' && !t.song && !t.action_only && t.result?.prepared_reply && !t.prepared_audio);
      if (!task) return false;
      task.prepared_audio = { token: crypto.randomUUID(), live_id: this.activeLive, state: 'preparing' };
      selected = structuredClone(task); return true;
    });
    if (!selected) return;
    this.preparingAudio = true;
    const task = selected, live = this.activeLive, token = task.prepared_audio!.token;
    void (async () => {
      await this.syncAudio();
      const result = await this.adapter.prepareAudio!(task, live);
      await this.mutate(next => {
        const current = next.tasks.find(t => t.id === task.id && t.prepared_audio?.token === token && t.status === 'ready');
        if (!current) return false;
        if (result.state === 'ready' && this.activeLive === live) current.prepared_audio = { token, live_id: live, state: 'ready', duration_ms: result.duration_ms };
        else { delete current.prepared_audio; this.audioRetryAt = this.now() + 250; }
        return true;
      });
    })().catch(async error => {
      await this.mutate(next => {
        const current = next.tasks.find(t => t.id === task.id && t.prepared_audio?.token === token && t.status === 'ready');
        if (!current) return false;
        delete current.prepared_audio; current.status = 'failed'; current.error = '语音预合成失败：' + String(error); return true;
      });
    }).finally(() => { this.preparingAudio = false; void this.tick().catch(error => this.adapter.error(String(error))); });
  }
  private archive(next: QueueSnapshot, task: InteractionTask, outcome: HistoryEntry['outcome'], reason: string) {
    next.history.push({ task, outcome, reason, at: this.now() });
    next.totals ||= { played: 0, skipped: 0, failed: 0 };
    next.totals[outcome] += 1;
    next.tasks = next.tasks.filter(item => item.id !== task.id);
    next.deferred_tasks = next.deferred_tasks?.filter(item => item.id !== task.id);
  }
  async restore() { await this.mutate(() => true); }
  async configureRecognition(enabled: boolean, matchPercent?: number) {
    if (matchPercent !== undefined && (!Number.isInteger(matchPercent) || matchPercent < 50 || matchPercent > 100)) throw new Error('台词匹配度需为50–100%的整数');
    let configured = false;
    await this.mutate(next => {
      if (next.tasks.some(task => ['playing', 'uncertain'].includes(task.status))) return false;
      next.recognition = { enabled, match_percent: matchPercent ?? next.recognition?.match_percent ?? 70 }; configured = true; return true;
    });
    if (!configured) throw new Error('请先确认完成或跳过当前播报，再调整语音识别设置');
  }
  async observeOutput(output: AvatarOutput) {
    const current = this.current();
    if (!current || current.song || !['playing', 'uncertain'].includes(current.status) || !this.activeLive || output.live_id !== this.activeLive) return;
    const taskId = current.id, captureId = current.playback_token;
    await this.mutate(next => {
      const task = next.tasks.find(item => item.id === taskId && item.playback_token === captureId && ['playing', 'uncertain'].includes(item.status) && item.live_id === output.live_id);
      if (!task || task.song || !task.result || output.live_id !== this.activeLive || !output.text.trim() || !Number.isFinite(output.received_at)
          || output.received_at < (task.started_at || 0) || output.received_at > this.now() + 1000 || output.received_at < (task.answer?.received_at || 0)) return false;
      const requestId = output.request_id || (output.msg_id?.startsWith('tts-') ? output.msg_id : undefined);
      if (requestId && requestId !== task.id && requestId !== `tts-${task.id}`) return false;
      if (output.msg_id && next.history.some(entry => entry.task.live_id === output.live_id && entry.task.answer?.message_ids.includes(output.msg_id!))) return false;
      const previous = task.answer;
      const text = mergeAvatarText(previous?.text || '', output.text.trim());
      const final = output.final ?? (text === previous?.text ? previous.final : undefined);
      const ids = [...new Set([...(previous?.message_ids || []), ...(output.msg_id ? [output.msg_id] : [])])].slice(-100);
      if (previous?.text === text && previous.final === final && ids.length === previous.message_ids.length) return false;
      task.answer = { text, received_at: output.received_at, message_ids: ids, final };
      if (task.recognition && !task.recognition.error) {
        Object.assign(task.recognition, matchTaskReply(task, task.recognition.text, next.recognition?.match_percent ?? 70));
      }
      return true;
    });
    await this.tick();
  }
  async observeAction(taskId: string, captureId: string, liveId: string, error?: string) {
    await this.mutate(next => {
      const task = next.tasks.find(item => item.id === taskId && item.playback_token === captureId && item.live_id === liveId && item.status === 'playing');
      if (!task || this.activeLive !== liveId) return false;
      task.action_state = error ? 'failed' : 'submitted'; task.action_error = error; return true;
    });
  }
  async observeSlotAction(event: { task_id: string; playback_token: string; live_id: string; kind: 'handoff' | 'reply'; state: 'pending' | 'submitted' | 'failed' | 'cancelled'; error?: string }) {
    await this.mutate(next => {
      const task = next.tasks.find(t => t.id === event.task_id && t.playback_token === event.playback_token && t.live_id === event.live_id && t.status === 'playing');
      if (!task || this.activeLive !== event.live_id) return false;
      if (event.kind === 'handoff') {
        if (!task.handoff_action) return false;
        task.handoff_action.status = event.state; task.handoff_action.error = event.error;
      } else { task.action_state = event.state; task.action_error = event.error; }
      return true;
    });
  }
  async configureReplyActionDelay(delayMs: number) {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('回复动作延迟需为0–60000毫秒的整数');
    await this.mutate(next => { next.reply_action_delay_ms = delayMs; return true; });
  }
  async observeRecognition(observation: RecognitionObservation) {
    if (!this.state.recognition?.enabled || !this.activeLive || observation.live_id !== this.activeLive) return;
    await this.mutate(next => {
      const task = next.tasks.find(task => task.id === observation.task_id && task.status === 'playing' && task.live_id === observation.live_id && task.playback_token === observation.capture_id);
      if (task?.song || !task?.result || !Number.isFinite(observation.captured_at) || observation.captured_at < (task.started_at || 0) || observation.captured_at > this.now() + 1000 || observation.captured_at < (task.recognition?.captured_at || 0)) return false;
      const match = observation.error ? { matched: false, progress: 0 } : matchTaskReply(task, observation.text, next.recognition?.match_percent ?? 70);
      task.recognition = { text: observation.text.slice(0, 10000), ...match, captured_at: observation.captured_at, inference_ms: observation.inference_ms, segments: observation.segments?.slice(-500), error: observation.error };
      if (observation.error) { task.status = 'uncertain'; task.error = `语音识别失败，需人工确认完成或跳过：${observation.error}`; clearTimeout(this.playbackTimer); }
      return true;
    });
    await this.tick();
  }
  async configureHandoff(enabled: boolean, direction: HandoffDirection, waitMs?: number, angleDeg?: number, triggerPercent?: number) {
    if (!HANDOFF_DIRECTIONS.some(item => item.value === direction)) throw new Error('未知的承接动作方向');
    if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3000)) throw new Error('承接动作等待时间需为0–3000毫秒的整数');
    if (angleDeg !== undefined && (!Number.isInteger(angleDeg) || angleDeg < 0 || angleDeg > 90)) throw new Error('承接动作查看角度需为0–90度的整数');
    if (triggerPercent !== undefined && (!Number.isInteger(triggerPercent) || triggerPercent < 1 || triggerPercent > 100)) throw new Error('承接动作触发匹配度需为1–100%的整数');
    await this.mutate(next => { next.handoff = { enabled, direction, wait_ms: waitMs ?? next.handoff?.wait_ms ?? 1699, angle_deg: angleDeg ?? next.handoff?.angle_deg ?? 30, trigger_percent: triggerPercent ?? next.handoff?.trigger_percent ?? 50 }; return true; });
  }
  async importTestBatch(items: { event: InteractionEvent; result?: GeneratedReply }[]) {
    if (items.length < 1 || items.length > INTERACTION_SLOT_COUNT || items.some(item => !['chat', 'gift'].includes(item.event.type) || (item.event.type === 'gift' && !item.event.gift))) throw new Error(`测试需导入 1～${INTERACTION_SLOT_COUNT} 条有效弹幕或礼物`);
    if (this.faulted || this.disposed) throw new Error('队列不可用，请重新打开中控台');
    if (this.importing || this.finishing || this.speaking) throw new Error('上一轮播报或动作仍在提交，请稍后再导入');
    this.importing = true;
    try {
    let imported = false;
    await this.mutate(next => {
      if (next.tasks.length || next.deferred_tasks?.length || next.candidates.length || Object.keys(next.combos).length) return false;
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
      const current = this.current(),song=this.activeSong();
      if(current?.song_parent)await this.adapter.interruptReply?.(current);
      if (song) await this.adapter.stopSong?.(song);
      await this.mutate(next => {
        const tasks = next.tasks.filter(item => item.status === 'playing');
        for(const task of tasks){task.status='uncertain';task.error='会话已切换，需人工确认上一条是否已播报';}
        return tasks.length>0;
      });
    }
    if (this.activeLive !== liveId) {
      this.audioAt = 0; this.videoAt = 0; this.quietSince = 0;
      this.insertionQuietSince = 0;
      this.heardSpeech = false; this.vadMode = false; this.vadIdle = false; this.vadEndTask = undefined;
    }
    const changedLive = this.activeLive !== liveId;
    this.enabled = enabled; this.activeLive = liveId; this.available = available;
    if (changedLive) await this.mutate(next => {
      let changed = false;
      for (const task of next.tasks) {
        if (task.song || ['playing','uncertain'].includes(task.status)) continue;
        if (task.prepared_audio) { delete task.prepared_audio; changed = true; }
        if (task.status === 'generating' || (this.adapter.prepareAudio && task.result?.prepared_for_live !== liveId)) {
          task.status = 'pending'; delete task.result; delete task.generation_token; delete task.answer; changed = true;
        }
      }
      return changed;
    });
    await this.syncAudio();
    await this.tick();
  }
  async enqueueSong(song: SongDirector) {
    if (!song.pcm_ready || !song.pcm_segments?.length) throw new Error('请先在唱歌模块截取歌词PCM');
    if (song.status !== 'ready' || !song.available || !song.cues.length || !Number.isFinite(song.duration_ms) || song.duration_ms <= 0) throw new Error('请先生成并保存有效的歌曲导播');
    if (this.disposed || this.faulted) throw new Error('队列不可用，请重新打开中控台');
    return this.replaceTailSlot({ id: crypto.randomUUID(), status: 'ready', song: { id: song.id, title: song.title, duration_ms: song.duration_ms },
      event: { event_id: crypto.randomUUID(), type: 'song', room_id: this.state.room_id, user_id: '', nickname: '歌曲导播', content: song.title, created_at: this.now() } }, '歌曲插入槽位3，移除原待播任务');
  }
  async insertTestInteraction(item: { event: InteractionEvent; result?: GeneratedReply }) {
    if (!item?.event || !['chat', 'gift'].includes(item.event.type) || !item.event.content?.trim() || (item.event.type === 'gift' && !item.event.gift)) throw new Error('每次只能插入1条有效的测试弹幕或礼物');
    const task: InteractionTask = { id: crypto.randomUUID(), event: { ...structuredClone(item.event), source: 'test' }, status: item.result ? 'ready' : 'pending', ...(item.result ? { result: structuredClone(item.result) } : {}) };
    return this.replaceTailSlot(task, '测试弹幕插入槽位3，移除原待播任务');
  }
  private async replaceTailSlot(task: InteractionTask, reason: string) {
    if (this.disposed || this.faulted) throw new Error('队列不可用，请重新打开中控台');
    let position = 0;
    await this.mutate(next => {
      const replaced = next.tasks[INTERACTION_SLOT_COUNT - 1];
      if (replaced && ['playing', 'uncertain'].includes(replaced.status)) return false;
      if (replaced) this.archive(next, replaced, 'skipped', reason);
      task.event.room_id = next.room_id || task.event.room_id;
      next.tasks.push(task);
      position = next.tasks.length; return true;
    });
    if (!position) throw new Error('槽位3正在播报或等待人工确认，请先完成或跳过该任务');
    await this.syncAudio();
    await this.tick();
    return position;
  }
  async observeSong(state: SongPlaybackState) {
    const task = this.state.tasks.find(t=>t.song&&t.id===state.task_id);
    if (!task?.song || task.status !== 'playing' || task.id !== state.task_id || task.playback_token !== state.playback_token || task.live_id !== state.live_id || this.activeLive !== state.live_id) return;
    if (state.state === 'ended') await this.finishSong(task, 'played', '原歌曲播放结束');
    else if (state.state === 'error') await this.markUncertain(state.error || '歌曲播放失败', task.id);
    else if (state.state === 'started' || state.state === 'blocked') await this.mutate(next => {
      const current = next.tasks.find(item => item.id === state.task_id && item.status === 'playing' && item.playback_token === state.playback_token);
      if (!current) return false;
      current.song_playback = state.state === 'blocked' ? 'blocked' : 'playing';
      return true;
    });
  }
  async observeSongPhase(state: SongPcmPhase) {
    const parent=this.activeSong();
    if(!parent||parent.id!==state.task_id||parent.playback_token!==state.playback_token||parent.live_id!==state.live_id||this.activeLive!==state.live_id)return;
    const phaseKey=`${state.live_id}:${state.playback_token}:${state.active}`;
    if(this.songPhaseSeen===phaseKey)return;this.songPhaseSeen=phaseKey;
    await this.mutate(next=>{
      const song=next.tasks.find(t=>t.id===state.task_id&&t.playback_token===state.playback_token&&t.status==='playing');
      if(!song)return false;song.song_pcm_active=state.active;
      if(state.active)for(const task of next.tasks)if(!task.song){delete task.prepared_audio;task.action_only=true;}
      return true;
    });
    if(state.active){
      const child=this.state.tasks.find(t=>!t.song&&['playing','uncertain'].includes(t.status)&&t.song_parent?.task_id===parent.id);
      if(child){await this.adapter.interruptReply?.(child);await this.consumeSongTask(child,parent);}
    }
    await this.tick();
  }
  private hasSongAction(task:InteractionTask){return task.event.type==='gift'||(task.result?.intent==='action_request'&&!!task.result.action_instruction?.trim());}
  private async songAction(task:InteractionTask){
    const existing=this.songActions.get(task.id);if(existing)return existing;
    const current=this.state.tasks.find(t=>t.id===task.id);
    if(!current||!this.hasSongAction(current)||current.action_state==='submitted')return;
    const live=this.activeLive;
    const action=(async()=>{
      if(!this.adapter.act)throw new Error('唱歌动作通道不可用');
      await this.mutate(next=>{const current=next.tasks.find(t=>t.id===task.id);if(!current)return false;current.action_state='pending';const parent=this.activeSong();if(parent)current.song_parent={task_id:parent.id,playback_token:parent.playback_token!};return true;});
      await this.adapter.act(task,live);
      await this.mutate(next=>{const current=next.tasks.find(t=>t.id===task.id);if(!current)return false;current.action_state='submitted';if(current.status==='uncertain'&&current.error===SONG_ENDING_ACTION)this.archive(next,current,'played','歌曲已结束，弹幕动作已确认提交，不重复播报');return true;});
    })();
    this.songActions.set(task.id,action);
    try{await action;}finally{this.songActions.delete(task.id);}
  }
  private async consumeSongTask(task:InteractionTask,parent:InteractionTask){
    if(this.songConsuming.has(task.id)||this.activeSong()?.id!==parent.id||!this.state.tasks.some(t=>t.id===task.id))return;
    this.songConsuming.add(task.id);
    try{
    if(['playing','uncertain'].includes(task.status))clearTimeout(this.playbackTimer);
    let outcome:HistoryEntry['outcome']=this.hasSongAction(task)?'played':'skipped';
    let reason=this.hasSongAction(task)?'歌曲唱词期间仅执行弹幕动作，不发送弹幕PCM':'歌曲唱词期间无动作，立即释放弹幕';
    try{if(this.enabled)await this.songAction(task);else{outcome='skipped';reason='歌曲唱词打断弹幕，自动回答已关闭';}}catch(error){outcome='failed';reason='唱歌动作提交失败：'+String(error);}
    if(this.activeSong()?.playback_token!==parent.playback_token){
      if(outcome==='failed')await this.mutate(next=>{const current=next.tasks.find(t=>t.id===task.id);if(!current)return false;current.error=reason;return true;});
      return;
    }
    await this.mutate(next=>{const current=next.tasks.find(t=>t.id===task.id);if(!current)return false;this.archive(next,current,outcome,reason);return true;});
    await this.tick();
    }finally{this.songConsuming.delete(task.id);}
  }
  private async finishSong(task:InteractionTask,outcome:HistoryEntry['outcome'],reason:string){
    clearTimeout(this.songTimer);
    await this.adapter.stopSong?.(task);
    await this.mutate(next=>{
      const song=next.tasks.find(t=>t.id===task.id&&t.playback_token===task.playback_token);if(!song)return false;
      this.archive(next,song,outcome,reason);
      for(const child of [...next.tasks])if(child.song_parent?.task_id===task.id){
        if(child.action_only&&child.action_state==='submitted')this.archive(next,child,'played','歌曲结束，已执行的弹幕动作不重复播报');
        else if(child.action_only&&child.action_state==='pending'){child.status='uncertain';child.error=SONG_ENDING_ACTION;delete child.song_parent;}
        else delete child.song_parent;
      }
      return true;
    });
    await this.tick();
  }
  private async pumpSongInteraction(parent:InteractionTask){
    if(!this.enabled||!this.available||parent.song_playback!=='playing')return;
    for(let step=0;step<INTERACTION_SLOT_COUNT;step++){
      if(this.activeSong()?.id!==parent.id||this.playbackHeld||!this.enabled)return;
      const task=this.state.tasks[1];if(!task||task.song||['playing','uncertain','pending','generating'].includes(task.status))return;
      if(this.singing()){
        if(task.status==='failed')await this.mutate(next=>{const t=next.tasks.find(t=>t.id===task.id);if(!t)return false;this.archive(next,t,'failed',t.error||'唱歌期间动作解析失败');return true;}).then(()=>this.tick());
        else await this.consumeSongTask(task,parent);
        continue;
      }
      if(task.status!=='ready'||task.action_only||this.speaking||this.videoAt<this.now()-2000||this.audioAt<this.now()-(this.vadMode?500:2000)||(this.vadMode?!this.vadIdle:this.now()-this.quietSince<PLAYBACK_SILENCE_MS))return;
      if(this.adapter.prepareAudio&&task.prepared_audio?.state!=='ready')return;
      try{await this.songAction(task);}catch(error){await this.mutate(next=>{const t=next.tasks.find(t=>t.id===task.id);if(!t)return false;t.status='failed';t.error=String(error);return true;});return;}
      let selected:InteractionTask|undefined;
      await this.mutate(next=>{
        const song=next.tasks[0],child=next.tasks[1];
        if(song?.id!==parent.id||song.song_pcm_active!==false||child?.id!==task.id||child.status!=='ready'||!this.enabled||!this.available)return false;
        child.status='playing';child.started_at=this.now();child.live_id=this.activeLive;child.playback_token=crypto.randomUUID();
        child.song_parent={task_id:parent.id,playback_token:parent.playback_token!};
        delete child.audio_sent_at;delete child.recognition;delete child.answer;selected=structuredClone(child);return true;
      });
      if(selected){this.speaking=true;await this.submitPlayback(selected,this.activeLive);}return;
    }
  }
  async disconnectSession(liveId: string, reason: string) {
    if (this.activeLive && this.activeLive !== liveId) return;
    // Invalidate media callbacks and delayed speech/action submissions before
    // awaiting storage; no old-session evidence may complete another task.
    this.enabled = false; this.available = false; this.activeLive = '';
    clearTimeout(this.playbackTimer);clearTimeout(this.songTimer);
    await this.mutate(next => {
      const tasks = next.tasks.filter(item => item.live_id === liveId && ['playing', 'uncertain'].includes(item.status));
      for(const task of tasks){task.status='uncertain';task.error=reason;}return tasks.length>0;
    });
    for(const task of [...this.state.tasks].filter(t=>['playing','uncertain'].includes(t.status)))await this.finish('failed',reason,false,task.id);
  }
  async ingest(event: InteractionEvent) {
    if (this.faulted || this.disposed) throw new Error('队列不可用，事件仍保留在数据库待恢复');
    await this.mutate(next => {
      if (next.room_id && event.room_id && next.room_id !== event.room_id) {
        next.candidates = next.candidates.filter(item => item.type === 'gift');
        for (const task of [...next.tasks, ...(next.deferred_tasks || [])]) {
          if (task.event.type === 'chat' && !['playing', 'uncertain'].includes(task.status)) this.archive(next, task, 'skipped', '直播间已切换');
        }
      }
      next.room_id = event.room_id || next.room_id;
      if ([...next.candidates, ...next.tasks.map(task => task.event), ...(next.deferred_tasks || []).map(task => task.event), ...next.history.map(entry => entry.task.event)].some(item => item.event_id === event.event_id && item.room_id === event.room_id)) return false;
      if (event.type === 'chat') {
        if (this.now() - event.created_at > 30_000) return false;
        // Protobuf timestamps have second precision. For ties, the latest
        // received chat must be the first candidate for a newly vacant slot.
        next.candidates.unshift(event);
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
      // Only waiting candidates expire. Once visible, a slot stays fixed until
      // completion or an explicit operator action, including collection-only mode.
      for (const task of [...(next.deferred_tasks || [])]) {
        if (task.event.type === 'chat' && task.event.source !== 'test' && !['playing', 'uncertain'].includes(task.status) && this.now() - task.event.created_at > 30_000) {
          this.archive(next, task, 'skipped', '弹幕已超过 30 秒'); changed = true;
        }
      }
      const fresh = next.candidates.filter(event => event.type === 'gift' || this.now() - event.created_at <= 30_000);
      if (fresh.length !== next.candidates.length) { next.candidates = fresh; changed = true; }
      // Collection and visible slot allocation work before an avatar exists.
      // Generation, TTS and playback keep their own readiness gates below.
      // Fill only vacant slots. Gifts retain priority among candidates, without
      // preempting or reordering any already prepared visible slot.
      while (next.tasks.length < INTERACTION_SLOT_COUNT && (next.candidates.length || next.deferred_tasks?.length)) {
        const pending = [
          ...next.candidates.map(event => ({ event, task: undefined as InteractionTask | undefined })),
          ...(next.deferred_tasks || []).map(task => ({ event: task.event, task })),
        ];
        const rank = (event: InteractionEvent) => event.type === 'gift' ? 0 : event.type === 'song' ? 1 : 2;
        pending.sort((a, b) => rank(a.event) - rank(b.event) || (a.event.type === 'chat' ? b.event.created_at - a.event.created_at : a.event.created_at - b.event.created_at));
        const { event, task: deferred } = pending[0];
        let task: InteractionTask;
        if (deferred) {
          next.deferred_tasks = next.deferred_tasks!.filter(item => item.id !== deferred.id);
          task = deferred;
          if (!task.song && task.status !== 'failed') { task.status = 'pending'; delete task.result; delete task.answer; }
        } else {
          next.candidates = next.candidates.filter(item => item !== event);
          task = { id: crypto.randomUUID(), event, status: 'pending' };
        }
        next.tasks.push(task);
        changed = true;
      }
      return changed;
    });
    await this.preparePending();
    await this.pump();
    await this.observeCompletion();
  }
  private async preparePending() {
    if (this.scheduling || this.disposed || this.faulted || this.importing || !this.enabled || !this.available || !this.activeLive) return;
    this.scheduling = true;
    try {
    const jobs: InteractionTask[] = [];
    await this.mutate(next => {
      if (!this.enabled) return false;
      let repaired = false;
      for (const task of next.tasks) {
        if (this.adapter.rewriteReply && task.status === 'ready' && task.result?.prepared_reply &&
            repeatedOpening(task.result.prepared_reply, task.event.nickname, this.recentOpenings(next, task, true))) {
          task.status = 'pending'; delete task.prepared_audio; task.generation_note = '开头重复，正在重写回答…'; repaired = true;
        }
      }
      for (const task of next.tasks) {
        if(task.song_parent&&next.tasks.some(parent=>parent.id===task.song_parent!.task_id&&parent.song&&parent.status==='uncertain'))continue;
        if (task.action_only&&!this.singing()&&task.status==='ready'){if(!task.result?.prepared_reply){task.status='pending';delete task.result;}delete task.action_only;}
        if (this.adapter.prepareAudio && !task.song && !task.action_only && task.status === 'ready' && !task.result?.prepared_reply) { task.status = 'pending'; delete task.result; }
        if (this.running.size + jobs.length >= 2) break;
        if (task.status !== 'pending') continue;
        task.action_only=this.singing();
        next.next_opening_style ??= parseInt(crypto.randomUUID().slice(0, 2), 16) % OPENING_STYLES.length;
        task.opening_style = OPENING_STYLES[next.next_opening_style % OPENING_STYLES.length];
        next.next_opening_style += 1;
        task.status = 'generating'; task.generation_token = crypto.randomUUID(); jobs.push(structuredClone(task));
      }
      return repaired || jobs.length > 0;
    });
    if (this.disposed || this.faulted) return;
    for (const task of jobs) {
      const generation = task.generation_token!; const generationLive = this.activeLive;
      this.running.add(generation);
      const history = this.state.history.filter(entry => entry.outcome === 'played' && task.event.user_id && entry.task.event.user_id === task.event.user_id && entry.task.event.room_id === task.event.room_id).slice(-3);
      const diversity = { openingStyle: task.opening_style!, recentOpenings: this.recentOpenings(this.state, task) };
      void (async () => {
        let result = task.result?.prepared_reply && this.adapter.rewriteReply
          ? await this.adapter.rewriteReply(task, task.result, history, diversity, generationLive)
          : await this.adapter.generate(task, history, diversity, generationLive);
        for (let attempt = 0; ; attempt++) {
          if (!result.speech.trim() || (this.adapter.prepareAudio && !task.action_only && !result.prepared_reply?.trim())) throw new Error('模型未返回有效的主播回答');
          let revise: ReplyDiversity | undefined;
          await this.mutate(next => {
            const target = next.tasks.find(item => item.id === task.id && item.status === 'generating' && item.generation_token === generation && this.activeLive === generationLive);
            if (!target) return false;
            const recentOpenings = this.recentOpenings(next, target);
            if (this.adapter.rewriteReply && result.prepared_reply && repeatedOpening(result.prepared_reply, task.event.nickname, recentOpenings)) {
              revise = { openingStyle: task.opening_style!, recentOpenings };
              target.generation_note = '开头重复，正在重写回答…'; return true;
            }
            target.result = result; target.status = 'ready'; delete target.generation_note; return true;
          });
          if (!revise) return;
          if (attempt >= 2) throw new Error('回答开头连续重复，已停止语音预合成，请重新生成');
          result = await this.adapter.rewriteReply!(task, result, history, revise, generationLive);
        }
      })().catch(async error => {
        await this.mutate(next => {
          const target = next.tasks.find(item => item.id === task.id && item.status === 'generating' && item.generation_token === generation && this.activeLive === generationLive);
          if (!target) return false;
          target.status = 'failed'; target.error = String(error); delete target.generation_note; return true;
        });
      }).finally(() => { this.running.delete(generation); void this.tick(); });
    }
    await this.prepareNextAudio();
    } finally { this.scheduling = false; }
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
    // Songs are explicitly queued by the operator. They can play with automatic
    // chat replies off, while chat/gift generation and playback stay paused.
    if (this.disposed || this.faulted || this.importing || (!this.enabled && !this.state.tasks[0]?.song) || !this.available || !this.activeLive) return;
    const handoff = this.state.handoff_action;
    if (this.playbackHeld) return;
    const parent=this.activeSong();
    if(parent){await this.pumpSongInteraction(parent);return;}
    if (this.state.tasks[0]?.result?.generation_mode !== 'component' && handoff?.status === 'submitted' && handoff.live_id === this.activeLive && this.now() < (handoff.resume_at || 0)) return;
    const nextIsSong = !!this.state.tasks[0]?.song;
    if (!nextIsSong && this.batchNeedsSilence && (this.batchQuietSince === undefined || this.now() - this.batchQuietSince < (this.vadMode ? 900 : PLAYBACK_SILENCE_MS))) return;
    if (this.finishing || this.speaking || this.current() || this.videoAt < this.now() - 2000) return;
    // Original song audio does not depend on the avatar publishing fresh PCM or
    // silence. OBS interrupts old AI output before starting the song instead.
    if (!nextIsSong && (this.audioAt < this.now() - (this.vadMode ? 500 : 2000) ||
      (this.vadMode ? !this.vadIdle : this.now() - this.quietSince < PLAYBACK_SILENCE_MS))) return;
    this.speaking = true;
    let selected: InteractionTask | undefined;
    const liveId = this.activeLive;
    await this.mutate(next => {
      const task = next.tasks[0];
      if (!task || task.status !== 'ready' || (this.adapter.prepareAudio && !task.song && task.prepared_audio?.state !== 'ready') || this.playbackHeld || this.importing || (!this.enabled && !task.song) || !this.available || this.activeLive !== liveId) return false;
      task.status = 'playing'; task.started_at = this.now(); task.live_id = liveId; task.playback_token = crypto.randomUUID();
      if (!task.song && task.result?.generation_mode === 'component') {
        if (task.handoff_action) task.handoff_action.status = 'pending';
        task.action_state = 'pending'; delete task.action_error;
      }
      if (task.song) {task.song_playback = 'starting';task.song_pcm_active=true;}
      delete task.audio_sent_at; delete task.recognition; delete task.answer; selected = structuredClone(task); return true;
    });
    if (!selected) { this.speaking = false; return; }
    await this.submitPlayback(selected, liveId);
    } finally { this.pumping = false; }
  }
  private async submitPlayback(selected: InteractionTask, liveId: string) {
    this.batchNeedsSilence = false; this.batchQuietSince = undefined;
    this.heardSpeech = false; this.lastSpeechAt = 0; this.vadEndTask = undefined;
    this.whisperQuietMs = 0; this.lastActualVoiceAt = 0;
    const selectedId = selected.id;
    const timer = setTimeout(() => { void this.markUncertain('未收到足够的播放结束信号，请确认完成或跳过', selectedId).catch(() => {}); }, selected.song ? selected.song.duration_ms + 60_000 : 60_000);
    if(selected.song)this.songTimer=timer;else this.playbackTimer=timer;
    try {
      await this.adapter.speak(selected, liveId);
      if (selected.result?.generation_mode === 'component') await this.mutate(next => {
        const task = next.tasks.find(item => item.id === selectedId && item.playback_token === selected!.playback_token && item.status === 'playing');
        if (!task) return false; task.audio_sent_at = this.now(); return true;
      });
      // Submit the reply's action alongside speech. Late
      // completions, interruption and crash recovery must never replay it.
      if (!selected.song && !selected.song_parent && selected.result?.generation_mode !== 'component' && this.adapter.act && avatarActionFor(selected) && !this.disposed && this.activeLive === liveId && this.current()?.id === selectedId && this.current()?.status === 'playing') {
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
    catch (error) {
      const parent=this.activeSong(),child=this.state.tasks.find(t=>t.id===selectedId);
      if(selected.song_parent&&parent&&child&&(this.singing()||String(error).includes('歌曲唱词')))await this.consumeSongTask(child,parent);
      else await this.markUncertain(`播报提交未确认：${String(error)}`, selectedId);
    }
    finally { this.speaking = false; }
  }
  observeAudio(speaking: boolean, liveId: string) {
    if (!liveId || liveId !== this.activeLive) return;
    if (speaking || !this.insertionQuietSince || this.now() - this.audioAt >= (this.vadMode ? 500 : 2000)) this.insertionQuietSince = this.now();
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
      this.insertionQuietSince = 0;
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
    if (task.song) return; // Only the original audio's ended event completes a song.
    if (this.now() - task.started_at! >= 60_000) {
      await this.markUncertain('60 秒内未确认播放结束，已保留任务并暂停后续播报');
      return;
    }
    if (task.result?.generation_mode === 'component') {
      if (this.state.recognition?.enabled) {
        const evidence = task.recognition;
        if (!this.speaking && task.audio_sent_at && task.answer?.final === true && this.heardSpeech && evidence?.matched && !evidence.error &&
            evidence.captured_at >= task.audio_sent_at && evidence.captured_at >= this.lastActualVoiceAt &&
            this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
          this.vadIdle = true;
          await this.finish('played', `FunASR 实际本地播放回答末尾匹配达到${this.state.recognition.match_percent ?? 70}%，最后3字已确认，全部PCM已发送`, true);
        }
        return;
      }
      if (this.speaking || !task.audio_sent_at || this.now() - task.audio_sent_at < 1500 || task.answer?.final !== true) return;
      if (this.heardSpeech && this.vadIdle && this.whisperQuietMs >= 1200 && this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
        await this.finish('played', '全部句子 PCM 已发送，本地实际播放语音后持续静音且画面健康', true);
      }
      return;
    }
    if (this.state.recognition?.enabled) {
      if (!task.answer?.text || task.answer.final === false) return;
      const evidence = task.recognition;
      const handoffEnabled = this.state.handoff?.enabled === true;
      const triggerPercent = this.state.handoff?.trigger_percent ?? 50;
      const matched = evidence && (handoffEnabled ? evidence.progress * 100 + 1e-9 >= triggerPercent : evidence.matched);
      if (this.heardSpeech && evidence && matched && !evidence.error && (handoffEnabled || evidence.captured_at >= this.lastActualVoiceAt) && (handoffEnabled || this.whisperQuietMs >= 350) &&
          this.now() - this.audioAt < 500 && this.now() - this.videoAt < 2000) {
        this.vadIdle = true;
        await this.finish('played', handoffEnabled
          ? `语音台词匹配度达到${triggerPercent}%，立即提交承接动作，不等待静音；提交成功后按设置等待`
          : `语音台词匹配度达到${this.state.recognition?.match_percent ?? 70}%，连续静音至少350毫秒；承接动作关闭，直接推进`, true);
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
  async speechUnavailable(reason: string) {
    this.enabled = false;
    await this.mutate(next => { for (const task of next.tasks) delete task.prepared_audio; return true; });
    const task = this.current();
    if (task && !task.song) { clearTimeout(this.playbackTimer); await this.markUncertain(reason, task.id); }
  }
  private async markUncertain(reason: string, taskId?: string) {
    const current = taskId?this.state.tasks.find(t=>t.id===taskId):this.current();
    if (current?.song && (!taskId || taskId === current.id)) {
      clearTimeout(this.songTimer);
      const child=this.state.tasks.find(t=>t.song_parent?.task_id===current.id&&t.status==='playing');
      if(child){clearTimeout(this.playbackTimer);await this.adapter.interruptReply?.(child);}
      try { await this.adapter.stopSong?.(current); }
      catch (error) { reason += `；停止歌曲失败：${String(error)}`; }
      await this.mutate(next=>{const child=next.tasks.find(t=>t.song_parent?.task_id===current.id&&t.status==='playing');if(!child)return false;child.status='uncertain';child.error=reason;return true;});
    }
    await this.mutate(next => {
      const task = next.tasks.find(item => item.status === 'playing' && (!taskId || item.id === taskId));
      if (!task) return false;
      task.status = 'uncertain'; task.error = reason; return true;
    });
  }
  async finish(outcome: HistoryEntry['outcome'], reason: string, preserveObservedSilence = false, targetId?:string) {
    const current = targetId?this.state.tasks.find(t=>t.id===targetId&&['playing','uncertain'].includes(t.status)):this.current();
    if(current?.song){await this.finishSong(current,outcome,reason);return;}
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
      if (current.song) await this.adapter.stopSong?.(current);
      const direction = this.state.handoff?.direction || 'left_down';
      const waitMs = this.state.handoff?.wait_ms ?? 1699;
      const angleDeg = this.state.handoff?.angle_deg ?? 30;
      if (!current.song && current.result?.generation_mode !== 'component' && outcome === 'played' && this.state.handoff?.enabled && this.adapter.handoff && this.state.handoff_action?.task_id !== taskId &&
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
        if (task.handoff_action?.status === 'pending') task.handoff_action.status = 'cancelled';
        if (task.action_state === 'pending') task.action_state = 'cancelled';
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
      task.status = task.song ? 'ready' : 'pending'; delete task.error; delete task.result; delete task.action_state; delete task.action_error; delete task.recognition; delete task.answer; delete task.playback_token; delete task.song_playback; delete task.prepared_audio; delete task.generation_token; delete task.generation_note;
      return true;
    });
    await this.tick();
  }
  dispose() { const song=this.activeSong();this.disposed = true; void this.syncAudio().catch(() => {}); this.enabled = false; clearTimeout(this.playbackTimer);clearTimeout(this.songTimer);if(song)void this.adapter.stopSong?.(song).catch(()=>{}); const task=this.current();if(task?.song_parent)void this.adapter.interruptReply?.(task).catch(()=>{}); }
}
