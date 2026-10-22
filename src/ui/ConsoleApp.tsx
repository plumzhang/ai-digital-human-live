import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { Activity, Cpu, CircleStop, Clapperboard, Mic2, MicOff, Music2, Play, Plus, Radio, Send, Settings2, Shield, Square, Trash2, Video } from 'lucide-react';
import { blockReason, parseDyhubEvent, type Danmaku, type Rule } from '../domain';
import { defaultAvatarConfig, initialAdvanced, validateAdvanced, type AvatarConfig, type AvatarProfile } from '../avatarProfiles';
import { useAvatarLibrary } from '../useAvatarLibrary';
import { AvatarSettings } from './AvatarSettings';
import { ModelConfiguration, type ModelSettingsTab } from './ModelConfiguration';
import { DanmakuSettings } from './DanmakuSettings';
import { SingingModule } from './SingingModule';
import { parseAvatarOutput } from '../avatarOutput';
import { QuestionInputs } from './QuestionInputs';
import { TaskDialogue } from './TaskDialogue';
import { TtsLog } from './TtsLog';
import { FilterRules } from './FilterRules';
import { loadCaptionSettings } from '../captionSettings';
import { loadModelConfig } from '../modelConfig';
import { ManualQuestions, type ManualQuestion, type ManualMessageType } from '../manualQuestions';
import { HANDOFF_DIRECTIONS, handoffActionLabel, INTERACTION_SLOT_COUNT, InteractionQueue, emptyQueue, normalizeInteraction, type HandoffDirection, type QueueSnapshot, type GeneratedReply } from '../interactionQueue';
import { countTestDanmaku, defaultTestDanmaku, parseTestDanmaku } from '../testDanmaku';
import { formatQueueCaption } from '../queueCaption';
import { avatarActionFor, giftActionFor } from '../giftActions';
import { builtinVoices } from '../voiceCatalog';
import { normalizeStoredVoice, validateVoiceSelection, qwenClonedVoices, type ClonedVoice } from '../voiceSelection';
import { SessionRecovery } from '../sessionRecovery';
import type { RecognitionObservation } from '../whisperRecognition';
import type { SongPlaybackState, SongPlaybackIdentity } from '../songDirector';

async function controlSong(control: SongPlaybackIdentity & { action: 'start' | 'stop'; song_id?: string }): Promise<void> {
  let detach: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('OBS 歌曲播放窗口未响应，请检查播放窗口')), 15000);
      void listen<SongPlaybackState>('song-playback-state', event => {
        const state = event.payload;
        if (state.live_id !== control.live_id || state.task_id !== control.task_id || state.playback_token !== control.playback_token) return;
        if (state.state === 'error') reject(new Error(state.error || '歌曲播放失败'));
        else if (state.state === (control.action === 'start' ? 'started' : 'stopped') || (control.action === 'start' && state.state === 'blocked')) resolve();
      }).then(unlisten => { detach = unlisten; return emit('song-control', control); }).catch(reject);
    });
  } finally { clearTimeout(timer); detach?.(); }
}

type Settings = AvatarConfig & { roomId: string; rules: Rule[] };

type CreditItem = { type?: string; credit_remain?: number; concurrency_limit?: number; current_concurrency?: number; queue_count?: number };
type CreditPackage = { id?: string; name?: string; type?: string; credit_remain?: number; valid_to?: string };
type Credits = { remains?: CreditItem[]; remaining_credits?: CreditItem[]; packages?: CreditPackage[]; queue_count?: number };
type ErrorEntry = { id: string; message: string; at: number };
type Session = { live_id: string; rtc: unknown; voice_provider?: string };
type SessionCreation = { key: string; region: string; avatar: Record<string, unknown> };
type LiveState = { live_id: string; status: string; trace_id?: string; billed_seconds?: string | number; credits_cost?: string | number; refreshed_at?: number };
type LiveResponse = { live?: { id?: string; status?: string; trace_id?: string; billed_seconds?: string | number; credits_cost?: string | number } };
function liveStatusText(status: string): string {
  const labels: Record<string, string> = {
    waiting: '等待服务准备（尚未就绪）', prepared: '渲染服务已准备，等待连接',
    queueing: '服务端排队中', on_live: '直播中', ending: '正在结束', ended: '已结束'
  };
  return `${status} · ${labels[status] || '未知状态'}`;
}
const initialSettings: Settings = { ...defaultAvatarConfig, roomId: '', rules: [] };
function loadSettings(): Settings { try { const saved = JSON.parse(localStorage.getItem('live-settings') || '{}'); const links = loadVoiceLinks(); const region = saved.region === 'global' ? 'global' : 'cn'; const link = links[voiceLinkKey(region, saved.voice || '')]; const voiceProvider = saved.voiceProvider === 'doubao' || saved.voiceProvider === 'qwen_omni' ? saved.voiceProvider : link ? link.provider || 'doubao' : builtinVoices.find(item => item.id === saved.voice)?.provider || (saved.voice ? 'qwen_omni' : initialSettings.voiceProvider); const voiceSource = saved.voiceSource === 'builtin' || saved.voiceSource === 'clone' ? saved.voiceSource : builtinVoices.some(item => item.id === (saved.voice || initialSettings.voice) && item.provider === voiceProvider) ? 'builtin' : 'clone'; return { ...initialSettings, ...saved, avatarModel: saved.avatarModel === 'vidu-s1' ? 'vidu-s1' : 'vidu-s2', ...normalizeStoredVoice({ voice: typeof saved.voice === 'string' ? saved.voice : initialSettings.voice, voiceProvider, voiceSource }), advanced: { ...initialAdvanced, ...saved.advanced } }; } catch { return initialSettings; } }
function loadApiKey(): string { try { return localStorage.getItem('vidu-api-key') || ''; } catch { return ''; } }
function loadErrorEntries(): ErrorEntry[] { try { const saved = JSON.parse(localStorage.getItem('app-error-log') || '[]'); return Array.isArray(saved) ? saved.filter((item): item is ErrorEntry => !!item && typeof item.id === 'string' && typeof item.message === 'string' && typeof item.at === 'number' && !/^摄像头(?:推流|操作)失败：/.test(item.message)) : []; } catch { return []; } }
type VoiceLink = { ttsVoiceId: string; audioUrl: string; provider?: 'qwen_omni' | 'doubao' };
function loadVoiceLinks(): Record<string, VoiceLink> { try { return JSON.parse(localStorage.getItem('vidu-voice-links') || '{}'); } catch { return {}; } }
function voiceLinkKey(region: Settings['region'], voice: string): string { return `${region}:${voice}`; }
function errorText(error: unknown): string { return (typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)).replace(/whisper/gi, '语音识别'); }
function hangupReasonText(reason: string): string {
  const reasons: Record<string, string> = {
    timeout: '会话超时', audit_violation: '触发风控', credit_insufficient: '账户积分不足',
    sip_closed: '语音或视频服务连接关闭', provider_closed: '语音或视频服务主动关闭',
    sip_reconnect_timeout: '语音或视频服务重连超时', client_reconnect_timeout: '客户端重连超时',
    prepared_sip_disconnected: '数字人准备期间服务连接断开', owner_taken_over: '服务节点已切换',
    owner_lease_lost: '服务节点连接丢失', ai_output_closed: '数字人输出通道关闭',
    external: '服务端关闭会话', user_end: '会话已结束'
  };
  return reasons[reason] || reason || '服务端未提供原因';
}
function avatarConfigOfProfile(profile: AvatarProfile): AvatarConfig {
  return { ...profile.config, ...normalizeStoredVoice(profile.config), advanced: { ...profile.config.advanced } };
}
const call = <T,>(name: string, args?: Record<string, unknown>) => invoke<T>(name, args);

export function ConsoleApp() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [apiKey, setApiKey] = useState(loadApiKey);
  const [keyStorageError, setKeyStorageError] = useState(false);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [creditsError, setCreditsError] = useState('');
  const [errorEntries, setErrorEntries] = useState<ErrorEntry[]>(loadErrorEntries);
  const [showCreditDetails, setShowCreditDetails] = useState(false);
  const [imageFileData, setImageFileData] = useState('');
  const avatars = useAvatarLibrary(settings, profile => {
    setSettings(old => ({ ...old, ...avatarConfigOfProfile(profile) }));
    setImageFileData(profile.image?.data || '');
  });
  const [cloneTarget, setCloneTarget] = useState<{ region: AvatarConfig['region']; select: (voice: string) => void } | null>(null);
  const [tab, setTab] = useState<'live' | 'rules' | 'songs' | 'settings' | 'voice' | 'models'>('live');
  const [modelTab, setModelTab] = useState<ModelSettingsTab>('reply');
  const openViduSettings = () => { setModelTab('vidu'); setTab('models'); };
  const voiceRegion = tab === 'voice' && cloneTarget ? cloneTarget.region : settings.region;
  const [roomConnected, setRoomConnected] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [liveStatusError, setLiveStatusError] = useState('');
  const [initStage, setInitStage] = useState('');
  const [creatingAvatar, setCreatingAvatar] = useState(false);
  const creatingAvatarRef = useRef(false);
  const [recoveringSession, setRecoveringSession] = useState(false);
  const recoveryRef = useRef<SessionRecovery<Session> | null>(null);
  const sessionCreationRef = useRef<SessionCreation | null>(null);
  const recoveryAutoRef = useRef(false);
  const resumeRecoveredRef = useRef<string | null>(null);
  const [avatarNotice, setAvatarNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [rtcJoined, setRtcJoined] = useState(false);
  const [rtcAudioSubscribed, setRtcAudioSubscribed] = useState(false);
  const [rtcVideoSubscribed, setRtcVideoSubscribed] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const lastPlaybackRef = useRef(0);
  const mediaLogRef = useRef<{ liveId?: string; states: Record<string, string> }>({ states: {} });
  const [micEnabled, setMicEnabled] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [micError, setMicError] = useState('');
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [question, setQuestion] = useState('');
  const [dialogue, setDialogue] = useState('');
  const [messages, setMessages] = useState<Danmaku[]>([]);
  const [showTestDanmaku, setShowTestDanmaku] = useState(false);
  const [testDanmakuInput, setTestDanmakuInput] = useState(defaultTestDanmaku);
  const testDanmakuCount = countTestDanmaku(testDanmakuInput);
  const [logs, setLogs] = useState<string[]>([]);
  const [interactionState, setInteractionState] = useState<QueueSnapshot>(emptyQueue);
  const [queueDirectory, setQueueDirectory] = useState('');
  const interactionQueueRef = useRef<InteractionQueue | null>(null);
  const [whisperStatus, setWhisperStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [whisperMessage, setWhisperMessage] = useState('');
  const whisperEnabled = interactionState.recognition?.enabled === true;
  const loadWhisper = async (reload = false) => {
    setWhisperStatus('loading'); setWhisperMessage('正在加载语音识别模型…');
    try {
      const info = await call<{ ready: boolean; device: string; model: string }>('whisper_prepare', { reload });
      if (!info.ready) throw new Error('语音识别模型未就绪');
      setWhisperStatus('ready'); setWhisperMessage('语音识别已就绪');
    } catch (error) { setWhisperStatus('error'); setWhisperMessage(errorText(error)); }
  };
  useEffect(() => { if (whisperEnabled) void loadWhisper(); }, [whisperEnabled]);
  const [voiceName, setVoiceName] = useState('');
  const [voiceUrl, setVoiceUrl] = useState('');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voices, setVoices] = useState<string[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState('');
  const [voiceLinks, setVoiceLinks] = useState<Record<string, VoiceLink>>(loadVoiceLinks);
  const cloneProvider = (voice: string, region: Settings['region']): 'qwen_omni' | 'doubao' => {
    const link = voiceLinks[voiceLinkKey(region, voice)];
    return link ? link.provider || 'doubao' : 'qwen_omni';
  };
  const [voiceNotice, setVoiceNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [voiceSampleText, setVoiceSampleText] = useState('你好，欢迎来到直播间。');
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [voicePreviewUrl, setVoicePreviewUrl] = useState('');
  const [voicePreviewName, setVoicePreviewName] = useState('');
  const [voicePreviewError, setVoicePreviewError] = useState('');
  const audioPreviewRef = useRef<HTMLAudioElement>(null);
  const playRequestedRef = useRef(false);
  const voicePreviewCache = useRef(new Map<string, string>());
  const activePreviewCacheKey = useRef('');
  const [pending, setPending] = useState(false);
  const busyRef = useRef(false);
  const manualQuestionsRef = useRef<ManualQuestions | null>(null);
  const [manualQuestions, setManualQuestions] = useState<ManualQuestion[]>([]);
  const modelRequestRef = useRef(0);
  const generatingReplyRef = useRef(false);
  const readyRef = useRef(false);
  const expectedDisconnectRef = useRef(false);
  const activeLiveIdRef = useRef<string | null>(null);
  const endedLiveIdsRef = useRef(new Set<string>());
  const disconnectedLiveIdsRef = useRef(new Set<string>());
  const autoRef = useRef(false);
  const micRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const log = (message: string) => setLogs(old => [`${new Date().toLocaleTimeString()}  ${message}`, ...old].slice(0, 80));
  const reportError = (message: string) => {
    const safeMessage = message.replace(/vda_[A-Za-z0-9_-]+/g, 'vda_***');
    setErrorEntries(old => old[0]?.message === safeMessage && Date.now() - old[0].at < 30000 ? old : [{ id: crypto.randomUUID(), message: safeMessage, at: Date.now() }, ...old]);
  };
  const update = (patch: Partial<Settings>) => setSettings(old => ({ ...old, ...patch }));
  const setBusyState = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const previewSrc = imageFileData || settings.imageUri.trim();
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    void call<{ snapshot: QueueSnapshot | null; directory: string; pending_events: { event_id: string; raw: unknown }[] }>('queue_load').then(async saved => {
      if (disposed) return;
      const initial = saved.snapshot || emptyQueue();
      initial.recognition ??= { enabled: true };
      const queue = new InteractionQueue(initial, {
        persist: snapshot => call('queue_commit', { snapshot }),
        generate: async (task, history, diversity) => {
          const config = loadModelConfig();
          if (!config.apiKey.trim() || !config.selectedModel || !config.persona.trim()) throw new Error('请先在“模型配置 → 大语言模型”保存有效的模型配置和固定人设');
          const context = history.map(entry => ({ comment: entry.task.event.content, question: entry.task.result?.generation_mode === 'question' ? entry.task.result.speech : undefined, answer: entry.task.answer?.text }));
          return call<GeneratedReply>('generate_interaction', {
            baseUrl: config.baseUrl, key: config.apiKey, model: config.selectedModel, persona: config.persona,
            nickname: task.event.nickname, comment: task.event.content, history: context,
            openingStyle: diversity.openingStyle, recentOpenings: diversity.recentOpenings,
            eventType: task.event.type, suggestedGesture: giftActionFor(task)?.kind,
          });
        },
        speak: async (task, liveId) => {
          if (task.song) {
            await controlSong({ action: 'start', live_id: liveId, task_id: task.id, playback_token: task.playback_token!, song_id: task.song.id });
            log(`歌曲导播 · ${task.song.title}`); return;
          }
          await emit('whisper-task', { live_id: liveId, task_id: task.id, capture_id: task.playback_token, enabled: queue.snapshot().recognition?.enabled === true });
          await call('speak_text', { liveId, taskId: task.id, content: task.result!.speech });
          log(`队列提问已发送 · ${task.event.nickname}：${task.result!.speech}`);
        },
        stopSong: async task => {
          const control = { action: 'stop' as const, live_id: task.live_id!, task_id: task.id, playback_token: task.playback_token! };
          if (!readyRef.current || activeLiveIdRef.current !== task.live_id) await emit('song-control', control);
          else await controlSong(control);
        },
        act: async (task, liveId) => {
          const gesture = avatarActionFor(task);
          if (!gesture) return;
          try {
            await call('send_avatar_action', { liveId, taskId: task.id, gesture: gesture.kind, instruction: gesture.instruction });
            log(`互动动作已提交 · ${task.event.nickname} · ${gesture.label}`);
          } catch (error) {
            log(`互动动作发送失败 · ${task.event.nickname}：${errorText(error)}`);
            throw error;
          }
        },
        handoff: async (task, liveId, direction, angleDeg) => {
          const label = handoffActionLabel(direction, angleDeg);
          try {
            await call('send_handoff_action', { liveId, taskId: task.id, direction, angleDeg });
            log(`承接动作已提交 · ${task.event.nickname} · ${label}`);
          } catch (error) {
            log(`承接动作发送失败：${errorText(error)}`);
            throw error;
          }
        },
        changed: snapshot => { if (!disposed) setInteractionState(snapshot); },
        error: message => { if (!disposed) { setAuto(false); reportError(message); log(message); } },
      });
      interactionQueueRef.current = queue;
      const manual = new ManualQuestions({
        holdPlayback: held => queue.setPlaybackHeld(held),
        canStart: quietMs => queue.canInsertPlayback(quietMs),
        send: async (content, liveId, messageType) => {
          if (!readyRef.current || activeLiveIdRef.current !== liveId) throw new Error('原会话已结束，已取消手动提问');
          await call('send_question', { content, liveId, messageType });
          log(`手动提问（${messageType}）已发送：${content}`);
        },
        changed: questions => { if (!disposed) setManualQuestions(questions); },
        error: message => { if (!disposed) { reportError(message); log(message); } },
      });
      manualQuestionsRef.current = manual;
      setQueueDirectory(saved.directory);
      await queue.restore();
      for (const pendingEvent of saved.pending_events || []) {
        if (disposed) break;
        const event = normalizeInteraction(pendingEvent.raw);
        if (event && (event.type === 'gift' || !blockReason(event.content, settings.rules))) await queue.ingest(event);
        if (disposed) break;
        await call('queue_ack_event', { eventId: pendingEvent.event_id });
      }
      if (disposed) { queue.dispose(); return; }
      timer = window.setInterval(() => {
        void (async () => {
          await manual.tick(activeLiveIdRef.current || '', readyRef.current);
          await queue.tick();
        })().catch(error => reportError(`队列调度失败：${errorText(error)}`));
      }, 250);
    }).catch(error => reportError(`初始化互动队列失败：${errorText(error)}`));
    return () => { disposed = true; if (timer !== undefined) clearInterval(timer); manualQuestionsRef.current?.cancel(); manualQuestionsRef.current = null; interactionQueueRef.current?.dispose(); interactionQueueRef.current = null; };
  }, []);
  const queuePlaying = interactionState.tasks.some(task => task.status === 'playing' || task.status === 'uncertain');
  const manualPlaying = !!manualQuestions[0] && manualQuestions[0].status !== 'waiting';
  const captionTask = interactionState.tasks.find(task => task.status === 'playing' && interactionState.handoff_action?.task_id !== task.id);
  const handoff = interactionState.handoff || { enabled: false, direction: 'left_down' as const };
  const recognitionMatchPercent = interactionState.recognition?.match_percent ?? 70;
  const [recognitionMatchDraft, setRecognitionMatchDraft] = useState('70');
  useEffect(() => { setRecognitionMatchDraft(String(recognitionMatchPercent)); }, [recognitionMatchPercent]);
  const saveRecognitionMatch = () => {
    const matchPercent = recognitionMatchDraft.trim() ? Number(recognitionMatchDraft) : NaN;
    if (!Number.isInteger(matchPercent) || matchPercent < 50 || matchPercent > 100) {
      setRecognitionMatchDraft(String(recognitionMatchPercent));
      reportError('台词匹配度需为50–100%的整数');
      return;
    }
    void manageQueue(() => interactionQueueRef.current?.configureRecognition(whisperEnabled, matchPercent));
  };
  const [handoffWaitDraft, setHandoffWaitDraft] = useState('1699');
  const [handoffAngleDraft, setHandoffAngleDraft] = useState('30');
  const [handoffTriggerDraft, setHandoffTriggerDraft] = useState('50');
  useEffect(() => { setHandoffTriggerDraft(String(handoff.trigger_percent ?? 50)); }, [handoff.trigger_percent]);
  const saveHandoffTrigger = () => {
    const triggerPercent = handoffTriggerDraft.trim() ? Number(handoffTriggerDraft) : NaN;
    if (!Number.isInteger(triggerPercent) || triggerPercent < 1 || triggerPercent > 100) {
      setHandoffTriggerDraft(String(handoff.trigger_percent ?? 50));
      reportError('承接动作触发匹配度需为1–100%的整数');
      return;
    }
    void manageQueue(() => interactionQueueRef.current?.configureHandoff(handoff.enabled, handoff.direction, undefined, undefined, triggerPercent));
  };
  useEffect(() => { setHandoffAngleDraft(String(handoff.angle_deg ?? 30)); }, [handoff.angle_deg]);
  const saveHandoffAngle = () => {
    const angle = handoffAngleDraft.trim() ? Number(handoffAngleDraft) : NaN;
    if (!Number.isInteger(angle) || angle < 0 || angle > 90) {
      setHandoffAngleDraft(String(handoff.angle_deg ?? 30));
      reportError('承接动作查看角度需为0–90度的整数');
      return;
    }
    void manageQueue(() => interactionQueueRef.current?.configureHandoff(handoff.enabled, handoff.direction, undefined, angle));
  };
  useEffect(() => { setHandoffWaitDraft(String(handoff.wait_ms ?? 1699)); }, [handoff.wait_ms]);
  const saveHandoffWait = () => {
    const waitMs = handoffWaitDraft.trim() ? Number(handoffWaitDraft) : NaN;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 3000) {
      setHandoffWaitDraft(String(handoff.wait_ms ?? 1699));
      reportError('承接动作等待时间需为0–3000毫秒的整数');
      return;
    }
    void manageQueue(() => interactionQueueRef.current?.configureHandoff(handoff.enabled, handoff.direction, waitMs));
  };
  const lastHandoff = interactionState.handoff_action;
  useEffect(() => {
    const liveId = session?.live_id;
    if (!liveId) return;
    const task = captionTask?.status === 'playing' && captionTask.live_id === liveId ? captionTask : undefined;
    void emit('whisper-task', { live_id: liveId, task_id: task?.id || '', capture_id: task?.playback_token || '', enabled: whisperEnabled && !!task && !task.song });
  }, [session?.live_id, captionTask?.id, captionTask?.status, captionTask?.playback_token, whisperEnabled]);
  useEffect(() => {
    const liveId = session?.live_id;
    if (!liveId) return;
    void emit('queue-caption', {
      live_id: liveId,
      content: captionTask?.live_id === liveId ? formatQueueCaption(captionTask) : '',
    }).catch(error => log(`OBS 字幕同步失败：${errorText(error)}`));
  }, [session?.live_id, captionTask?.id, captionTask?.live_id, captionTask?.event.type, captionTask?.event.nickname, captionTask?.event.content, captionTask?.result?.speech, captionTask?.answer?.text]);
  useEffect(() => {
    setBusyState(queuePlaying || manualPlaying);
  }, [queuePlaying, manualPlaying]);
  useEffect(() => {
    void interactionQueueRef.current?.setContext(auto, session?.live_id || '', ready && rtcJoined && !micEnabled && !micPending && (!busy || queuePlaying || manualPlaying) && (!!interactionState.tasks[0]?.song || !whisperEnabled || whisperStatus === 'ready')).catch(error => reportError(`更新队列状态失败：${errorText(error)}`));
  }, [auto, session?.live_id, ready, rtcJoined, micEnabled, micPending, busy, queuePlaying, manualPlaying, queueDirectory, whisperEnabled, whisperStatus, interactionState.tasks[0]?.id]);
  useEffect(() => {
    const states: Record<string, string> = {
      'RTC 入会': rtcJoined ? '已入会' : session ? '等待播放窗口入会' : '未入会',
      '远端音频': rtcAudioSubscribed ? '已订阅' : rtcJoined ? '等待订阅' : '未连接',
      '远端视频': rtcVideoSubscribed ? '已订阅' : rtcJoined ? '等待订阅' : '未连接',
      '实际画面': videoPlaying ? '播放中' : session ? '等待视频画面' : '未播放',
      '本地麦克风': micPending ? '正在切换…' : micEnabled ? '推流中' : '未推流',
    };
    const liveId = liveState?.live_id;
    const previous = mediaLogRef.current.liveId === liveId ? mediaLogRef.current.states : {};
    const changes = Object.entries(states).filter(([name, value]) => previous[name] !== value);
    mediaLogRef.current = { liveId, states };
    if (changes.length) log(`播放状态${liveId ? ` · ${liveId}` : ''} · ${changes.map(([name, value]) => `${name}：${value}`).join('；')}`);
  }, [liveState?.live_id, session?.live_id, rtcJoined, rtcAudioSubscribed, rtcVideoSubscribed, videoPlaying, micPending, micEnabled]);
  useEffect(() => {
    const refreshedAt = liveState?.refreshed_at;
    log(`状态刷新：${refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : '等待查询'}${liveState ? `；会话 ID：${liveState.live_id}` : ''}；计费时长：${liveState?.billed_seconds != null ? `${liveState.billed_seconds} 秒` : '未返回'}；本次积分：${liveState?.credits_cost ?? '未返回'}`);
  }, [liveState?.live_id, liveState?.refreshed_at, liveState?.billed_seconds, liveState?.credits_cost]);
  useEffect(() => { try { localStorage.setItem('live-settings', JSON.stringify(settings)); } catch { /* 保存按钮会提示存储错误 */ } }, [settings]);
  useEffect(() => { try { localStorage.setItem('app-error-log', JSON.stringify(errorEntries)); } catch { /* 当前会话中仍可查看 */ } }, [errorEntries]);
  useEffect(() => {
    setErrorEntries(old => old.filter(entry => !/^摄像头(?:推流|操作)失败：/.test(entry.message)));
  }, []);
  useEffect(() => {
    try {
      if (apiKey.trim()) localStorage.setItem('vidu-api-key', apiKey.trim());
      else localStorage.removeItem('vidu-api-key');
      setKeyStorageError(false);
    } catch { setKeyStorageError(true); if (!keyStorageError) reportError('本机保存 API Key 失败，请检查应用存储权限。'); }
  }, [apiKey]);
  useEffect(() => { autoRef.current = auto; }, [auto]);
  useEffect(() => { readyRef.current = ready; }, [ready]);
  useEffect(() => {
    if (!ready || !rtcJoined || !videoPlaying || resumeRecoveredRef.current !== session?.live_id) return;
    resumeRecoveredRef.current = null;
    setAuto(recoveryAutoRef.current);
    const message = '数字人已自动恢复；中断台词未重播，未播任务将继续。';
    setAvatarNotice({ kind: 'success', message }); log(message);
  }, [ready, rtcJoined, videoPlaying, session?.live_id]);
  useEffect(() => {
    if (tab !== 'voice') return;
    setVoices([]); setVoicesError('');
    if (!apiKey.trim().startsWith('vda_')) { setVoicesLoading(false); setVoicesError('请先在“模型配置 → Vidu数字人”填写 Vidu API Key，再查询已创建的克隆音色。'); return; }
    setVoicesLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void call<{ voices?: ClonedVoice[] }>('list_voices', { key: apiKey, region: voiceRegion })
        .then(result => { if (!cancelled) setVoices(qwenClonedVoices(result.voices || [], voice => cloneProvider(voice, voiceRegion))); })
        .catch(error => { if (!cancelled) { setVoices([]); setVoicesError(errorText(error)); reportError(`读取音色列表失败：${errorText(error)}`); } })
        .finally(() => { if (!cancelled) setVoicesLoading(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, apiKey, voiceRegion]);
  useEffect(() => {
    setCredits(null);
    setCreditsError('');
    if (!apiKey.trim().startsWith('vda_')) { setCreditsLoading(false); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCreditsLoading(true);
      void call<Credits>('account_credits', { key: apiKey, region: settings.region })
        .then(result => { if (!cancelled) setCredits(result); })
        .catch(error => { if (!cancelled) { const message = `查询账户积分失败：${errorText(error)}`; setCreditsError(errorText(error)); reportError(message); } })
        .finally(() => { if (!cancelled) setCreditsLoading(false); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiKey, settings.region]);
  useEffect(() => {
    if (!liveState?.live_id || liveState.status === 'ended' || !apiKey.trim()) return;
    let cancelled = false;
    let fetching = false;
    const fetchStatus = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await call<LiveResponse>('live_status', { key: apiKey, region: settings.region, liveId: liveState.live_id });
        if (cancelled) return;
        const live = result.live;
        if (!live?.status) throw new Error('响应缺少 live.status');
        setLiveState(old => old?.live_id === liveState.live_id ? {
          live_id: old.live_id, status: live.status!, trace_id: live.trace_id,
          billed_seconds: live.billed_seconds, credits_cost: live.credits_cost, refreshed_at: Date.now()
        } : old);
        if (live.status === 'ended') {
          setReady(false);
          setBusyState(false);
          setInitStage('Vidu 已确认会话结束');
          void call('end_session', { liveId: liveState.live_id }).catch(error => reportError(`清理已结束会话失败：${errorText(error)}`));
        }
        setLiveStatusError('');
      } catch (error) { if (!cancelled) setLiveStatusError(errorText(error)); }
      finally { fetching = false; }
    };
    void fetchStatus();
    const timer = window.setInterval(() => void fetchStatus(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [liveState?.live_id, liveState?.status === 'ended', apiKey, settings.region]);
  useEffect(() => {
    if (!creatingAvatar && (!liveState?.live_id || liveState.status === 'ended')) return;
    const timer = window.setInterval(() => {
      if (!apiKey.trim()) return;
      void call<Credits>('account_credits', { key: apiKey, region: settings.region }).then(setCredits).catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [creatingAvatar, liveState?.live_id, liveState?.status === 'ended', apiKey, settings.region]);
  useEffect(() => {
    if (!showCreditDetails) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setShowCreditDetails(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showCreditDetails]);
  useEffect(() => {
    if (!playRequestedRef.current || !voicePreviewUrl) return;
    playRequestedRef.current = false;
    void audioPreviewRef.current?.play().catch(() => {});
  }, [voicePreviewUrl, tab]);
  useEffect(() => {
    const cleanup: Array<() => void> = [];
    recoveryRef.current = new SessionRecovery<Session>({
      prepare: async liveId => {
        await interactionQueueRef.current?.disconnectSession(liveId, 'ai_output_closed：会话中断，播放完成情况未知；自动恢复时不重复播报');
      },
      ended: async liveId => {
        const config = sessionCreationRef.current;
        if (!config) throw new Error('缺少原会话配置');
        const result = await call<LiveResponse>('live_status', { key: config.key, region: config.region, liveId });
        if (result.live?.status === 'ended') setLiveState(old => old?.live_id === liveId ? { ...old, ...result.live, status: 'ended', refreshed_at: Date.now() } : old);
        return result.live?.status === 'ended';
      },
      create: async () => {
        const config = sessionCreationRef.current;
        if (!config) throw new Error('缺少原会话配置');
        const result = await call<Session>('create_session', config);
        if (endedLiveIdsRef.current.has(result.live_id)) throw new Error('新会话在恢复期间已结束');
        try { await call('open_obs_window'); }
        catch (error) { await call('end_session', { liveId: result.live_id }); throw error; }
        return result;
      },
      abandon: async result => { await call('end_session', { liveId: result.live_id }); },
      restored: result => {
        resumeRecoveredRef.current = result.live_id;
        setSession(result);
        setAvatarNotice({ kind: 'success', message: '新会话已创建，等待控制连接与播放画面就绪后恢复队列。' });
        log(`自动恢复已创建新会话：${result.live_id}，等待实际画面`);
      },
      progress: message => { setRecoveringSession(true); setInitStage(message); setAvatarNotice({ kind: 'success', message }); log(message); },
      failed: message => { resumeRecoveredRef.current = null; setAuto(false); setAvatarNotice({ kind: 'error', message }); reportError(message); log(message); },
      settled: () => setRecoveringSession(false),
    });
    void (async () => {
      cleanup.push(await listen<{ live_id: string; status?: string }>('live-created', event => {
        setLiveState({ live_id: event.payload.live_id, status: event.payload.status || 'waiting' });
        setLiveStatusError('');
        setInitStage('正在建立控制连接');
        log(`Vidu 已分配会话：${event.payload.live_id}`);
      }));
      cleanup.push(await listen<Session>('session-changed', event => {
        modelRequestRef.current += 1; generatingReplyRef.current = false;
        const liveId = event.payload.live_id;
        activeLiveIdRef.current = liveId;
        endedLiveIdsRef.current.delete(liveId);
        disconnectedLiveIdsRef.current.delete(liveId);
        setSession(event.payload);
        setVideoPlaying(false);
        lastPlaybackRef.current = 0;
        setLiveState(old => old?.live_id === liveId ? old : { live_id: liveId, status: 'waiting' });
        setInitStage('控制连接已建立，等待初始化确认');
      }));
      cleanup.push(await listen<any>('vidu-signal', event => {
        const signal = event.payload;
        const liveId = String(signal.live_id || '');
        if (liveId && activeLiveIdRef.current && liveId !== activeLiveIdRef.current) return;
        if (signal.type === 2) {
          const ack = signal.payload?.conn_init_ack;
          if (endedLiveIdsRef.current.has(liveId) || disconnectedLiveIdsRef.current.has(liveId) || expectedDisconnectRef.current) return;
          if (ack?.success) { setReady(true); setInitStage('控制连接就绪，等待播放窗口确认画面'); setAvatarNotice({ kind: 'success', message: '控制连接已就绪，正在连接视频画面。' }); log('Vidu 控制连接就绪'); }
          else if (ack?.error_code === 'NOT_READY') setInitStage('渲染端尚未就绪，正在重试初始化');
          else if (ack?.error_code !== 'NOT_READY') { const message = `Vidu 初始化失败：${ack?.error_code || '未知原因'} ${ack?.error_msg || ''}`; setAvatarNotice({ kind: 'error', message }); reportError(message); log(message); }
        }
        if (signal.type === 10) {
          const output = parseAvatarOutput(signal);
          if (output && output.live_id === activeLiveIdRef.current && !micRef.current) {
            void interactionQueueRef.current?.observeOutput(output).catch(error => reportError(`保存数字人回答失败：${errorText(error)}`));
          }
        }
        if (signal.type === 6) {
          if (endedLiveIdsRef.current.has(liveId)) return;
          const reason = String(signal.payload?.hangup?.hangup_reason || '');
          const shouldRecover = reason === 'ai_output_closed' && !expectedDisconnectRef.current && !!sessionCreationRef.current;
          const resumeAuto = autoRef.current;
          modelRequestRef.current += 1; generatingReplyRef.current = false;
          endedLiveIdsRef.current.add(liveId); activeLiveIdRef.current = null;
          readyRef.current = false; autoRef.current = false;
          setReady(false); setAuto(false); setSession(null);
          setLiveState(old => old?.live_id === liveId ? { ...old, status: 'ended' } : old);
          setInitStage('控制连接已结束'); setBusyState(false); setRtcJoined(false);
          setMicEnabled(false); micRef.current = false;
          const message = `数字人会话已结束：${hangupReasonText(reason)}${reason ? `（${reason}）` : ''}`;
          setAvatarNotice({ kind: 'error', message }); reportError(message); log(message);
          if (shouldRecover) {
            recoveryAutoRef.current = resumeAuto;
            void recoveryRef.current?.recover(liveId, reason);
          }
        }
        if (signal.type === 103) {
          const detail = signal.payload?.error || signal.payload || {};
          const code = detail.error_code || detail.code || '';
          const reason = detail.error_msg || detail.message || '服务端拒绝了文本或动作指令';
          const message = `Vidu 指令错误${code ? `（${code}）` : ''}：${reason}`;
          reportError(message); log(message);
        }
      }));
      cleanup.push(await listen<{ live_id: string; forced: boolean }>('vidu-disconnected', event => { const liveId = event.payload.live_id; if (activeLiveIdRef.current && liveId !== activeLiveIdRef.current) return; disconnectedLiveIdsRef.current.add(liveId); modelRequestRef.current += 1; generatingReplyRef.current = false; setReady(false); setBusyState(false); setRtcJoined(false); setMicEnabled(false); micRef.current = false; if (!expectedDisconnectRef.current && !event.payload.forced && !endedLiveIdsRef.current.has(liveId)) { const message = 'Vidu 控制连接断开，请点击“结束会话”清理当前会话。'; setAvatarNotice({ kind: 'error', message }); reportError(message); } expectedDisconnectRef.current = false; log('Vidu 控制连接断开'); }));
      cleanup.push(await listen<RecognitionObservation>('whisper-recognition', event => {
        if (event.payload.live_id !== activeLiveIdRef.current) return;
        void interactionQueueRef.current?.observeRecognition(event.payload).catch(error => reportError(`语音识别匹配失败：${errorText(error)}`));
      }));
      cleanup.push(await listen<SongPlaybackState>('song-playback-state', event => {
        void interactionQueueRef.current?.observeSong(event.payload).catch(error => reportError(`歌曲导播调度失败：${errorText(error)}`));
      }));
      cleanup.push(await listen<{ speaking: boolean; at: number; live_id?: string; source?: string; healthy?: boolean; ended?: boolean; quiet_ms?: number }>('avatar-audio', event => {
        if (event.payload.live_id !== activeLiveIdRef.current) return;
        if (event.payload.speaking && event.payload.healthy === true && event.payload.live_id) manualQuestionsRef.current?.observeSpeech(event.payload.live_id);
        if (event.payload.live_id && event.payload.source === 'pcm-vad') {
          interactionQueueRef.current?.observeVad({ speaking: event.payload.speaking, healthy: event.payload.healthy === true, ended: event.payload.ended === true, quiet_ms: event.payload.quiet_ms }, event.payload.live_id, event.payload.at);
          void interactionQueueRef.current?.tick().catch(error => reportError(`语音检测调度失败：${errorText(error)}`));
        }
      }));
      cleanup.push(await listen<{ live_id: string; message?: string; error?: string }>('rtc-vad-status', event => {
        if (event.payload.live_id !== activeLiveIdRef.current) return;
        log(event.payload.error ? `下行语音活动检测：${event.payload.error}` : event.payload.message || '下行语音活动检测状态已更新');
      }));
      cleanup.push(await listen('caption-settings-request', () => {
        void emit('caption-settings-changed', loadCaptionSettings()).catch(error => log(`OBS 弹幕设置同步失败：${errorText(error)}`));
      }));
      cleanup.push(await listen<{ live_id: string }>('queue-caption-request', event => {
        const liveId = event.payload.live_id;
        if (liveId !== activeLiveIdRef.current) return;
        const task = interactionQueueRef.current?.snapshot().tasks.find(item => item.status === 'playing' && item.live_id === liveId);
        void emit('queue-caption', { live_id: liveId, content: formatQueueCaption(task) }).catch(error => log(`OBS 字幕同步失败：${errorText(error)}`));
        void emit('whisper-task', { live_id: liveId, task_id: task?.id || '', capture_id: task?.playback_token || '', enabled: interactionQueueRef.current?.snapshot().recognition?.enabled === true && !!task && !task.song });
      }));
      cleanup.push(await listen<{ live_id?: string; joined: boolean; error?: string }>('rtc-status', event => {
        if (event.payload.live_id && event.payload.live_id !== activeLiveIdRef.current) return;
        setRtcJoined(event.payload.joined);
        if (!event.payload.joined) { setRtcAudioSubscribed(false); setRtcVideoSubscribed(false); setMicEnabled(false); micRef.current = false; setMicPending(false); }
        if (event.payload.error) { const message = `播放窗口连接失败：${event.payload.error}`; setAvatarNotice({ kind: 'error', message }); reportError(message); log(message); }
      }));
      cleanup.push(await listen<{ live_id?: string; kind: 'audio' | 'video'; subscribed: boolean }>('rtc-media-status', event => {
        if (event.payload.live_id && event.payload.live_id !== activeLiveIdRef.current) return;
        if (event.payload.kind === 'audio') setRtcAudioSubscribed(event.payload.subscribed);
        else setRtcVideoSubscribed(event.payload.subscribed);
      }));
      cleanup.push(await listen<{ live_id: string; playing: boolean }>('rtc-playback', event => {
        if (event.payload.live_id !== activeLiveIdRef.current) return;
        lastPlaybackRef.current = Date.now();
        interactionQueueRef.current?.observeVideo(event.payload.live_id);
        setVideoPlaying(event.payload.playing);
        if (event.payload.playing) {
          setInitStage('数字人画面正在播放');
          setAvatarNotice(old => old?.kind === 'error' ? old : { kind: 'success', message: '数字人画面已连接，可以开始提问。' });
        }
      }));
      cleanup.push(await listen<string>('session-cleanup-error', event => {
        const message = `自动挂断未确认：${event.payload}。请点击“结束会话”重试。`;
        setAvatarNotice({ kind: 'error', message }); reportError(message);
      }));
      cleanup.push(await listen<{ live_id?: string; live?: NonNullable<LiveResponse['live']> }>('session-ended', event => {
        if (event.payload?.live_id && activeLiveIdRef.current && event.payload.live_id !== activeLiveIdRef.current) return;
        const live = event.payload?.live;
        if (live?.status) setLiveState(old => old && old.live_id === event.payload.live_id ? { ...old, ...live, status: live.status!, refreshed_at: Date.now() } : old);
        modelRequestRef.current += 1; generatingReplyRef.current = false;
        const endedId = event.payload?.live_id || activeLiveIdRef.current;
        if (endedId) endedLiveIdsRef.current.add(endedId);
        activeLiveIdRef.current = null;
        setSession(null); setReady(false); setVideoPlaying(false); setRtcJoined(false);
        setRtcAudioSubscribed(false); setRtcVideoSubscribed(false);
        setMicEnabled(false); micRef.current = false;
        setMicPending(false); setMicError('');
        setAuto(false); setBusyState(false);
        setInitStage(live?.status === 'ended' ? 'Vidu 已确认会话结束，最终账单已刷新' : '挂断已完成，正在刷新最终状态与账单');
        // Keep polling until the API reports ended, including final billing fields.
      }));
      cleanup.push(await listen<{ live_id?: string; enabled: boolean; error?: string }>('mic-state', event => {
        if (event.payload.live_id && event.payload.live_id !== activeLiveIdRef.current) return;
        setMicEnabled(event.payload.enabled);
        micRef.current = event.payload.enabled;
        setMicPending(false);
        setMicError(event.payload.error || '');
        if (event.payload.error) { reportError(event.payload.error); log(event.payload.error); }
        else log(event.payload.enabled ? '麦克风推流已开启，自动弹幕提问已暂停' : '麦克风推流已关闭');
      }));
    })().catch(error => reportError(`注册实时事件失败：${errorText(error)}`));
    return () => { recoveryRef.current?.cancel(); cleanup.forEach(fn => fn()); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - lastPlaybackRef.current > 5000) setVideoPlaying(false);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!roomConnected || !settings.roomId) return;
    let disposed = false;
    const ws = new WebSocket(`ws://127.0.0.1:8757/ws?roomId=${encodeURIComponent(settings.roomId)}&types=chat,gift,follow,like,member`);
    wsRef.current = ws;
    ws.onopen = () => log('弹幕流已连接');
    ws.onclose = () => { log('弹幕流断开'); if (!disposed) reportError('弹幕流意外断开，请检查弹幕采集服务。'); };
    ws.onmessage = event => {
      try {
        const raw = JSON.parse(String(event.data));
        const normalized = normalizeInteraction(raw);
        const giftUpdate = normalized?.gift ? `:${normalized.gift.combo_id}:${normalized.gift.count}:${normalized.gift.is_final}` : '';
        const eventId = `${raw.roomId || settings.roomId}:${raw.id || normalized?.event_id || crypto.randomUUID()}${giftUpdate}`;
        void call<boolean>('queue_archive_event', { eventId, raw }).then(async fresh => {
          if (!fresh || disposed || !interactionQueueRef.current) return;
          if (normalized && (normalized.type === 'gift' || !blockReason(normalized.content, settings.rules))) await interactionQueueRef.current.ingest(normalized);
          if (disposed) return;
          await call('queue_ack_event', { eventId });
        }).catch(error => { const message = `保存直播事件失败：${errorText(error)}`; setAuto(false); reportError(message); });
      } catch { log('忽略无法解析的直播事件'); }
      const item = parseDyhubEvent(event.data);
      if (!item) return;
      item.blocked = blockReason(item.content, settings.rules);
      setMessages(old => [item, ...old].slice(0, 100));
    };
    return () => { disposed = true; ws.close(); wsRef.current = null; };
  }, [roomConnected, settings.roomId, settings.rules]);

  async function action(task: () => Promise<void>) {
    setPending(true);
    try { await task(); } catch (error) { const message = `操作失败：${errorText(error)}`; reportError(message); log(message); }
    finally { setPending(false); }
  }
  const runtimeBusy = !!session || creatingAvatar || recoveringSession || !!recoveryRef.current?.pending;
  async function saveProfile(profile: AvatarProfile) {
    if ((runtimeBusy || creatingAvatarRef.current || recoveryRef.current?.pending) && profile.id === avatars.library?.activeId) throw new Error('请先结束当前数字人会话，再保存修改');
    await avatars.saveProfile(profile);
  }
  async function selectProfile(id: string) {
    if (runtimeBusy || creatingAvatarRef.current || recoveryRef.current?.pending) throw new Error('请先结束当前数字人会话，再切换数字人');
    await avatars.selectProfile(id);
  }
  async function selectClonedVoice(voice: string) {
    if (!voices.includes(voice)) throw new Error('请选择列表中的千问 qwen_omni 克隆音色');
    if (cloneTarget) cloneTarget.select(voice);
    else await avatars.patchActive({ voice, voiceProvider: 'qwen_omni', voiceSource: 'clone' });
  }
  const startDanmaku = () => action(async () => {
    if (!settings.roomId.trim()) throw new Error('请先输入直播间号');
    await call('start_dyhub');
    await call('dyhub_connect', { roomId: settings.roomId });
    setRoomConnected(true);
    log(`开始获取直播间 ${settings.roomId} 的弹幕`);
  });
  const stopDanmaku = () => action(async () => {
    try { if (roomConnected) await call('dyhub_disconnect', { roomId: settings.roomId }); }
    catch (error) { const message = `断开直播间失败：${errorText(error)}`; reportError(message); log(message); }
    finally { await call('stop_dyhub'); }
    setRoomConnected(false);
    log('已停止获取弹幕');
  });
  const startAvatar = async () => {
    if (creatingAvatarRef.current || recoveryRef.current?.pending || session || avatars.loading || avatars.saving || !avatars.library) return;
    creatingAvatarRef.current = true;
    expectedDisconnectRef.current = false;
    setLiveState(null);
    setLiveStatusError('');
    setInitStage('正在请求 Vidu 创建会话，尚无会话 ID');
    setRtcAudioSubscribed(false);
    setRtcVideoSubscribed(false);
    setMicEnabled(false);
    setAvatarNotice({ kind: 'success', message: '正在向 Vidu 提交创建请求…' });
    setCreatingAvatar(true);
    setPending(true);
    try {
      if (!apiKey.trim()) throw new Error('请先在“模型配置 → Vidu数字人”填写 Vidu API Key');
      if (!(imageFileData || settings.imageUri.trim())) throw new Error('请先在“形象设定”设置形象图片');
      if (!settings.persona.trim()) throw new Error('请先在“形象设定”填写人设');
      let confirmedClones: string[] = [];
      if (settings.voiceSource === 'clone') {
        const data = await call<{ voices?: ClonedVoice[] }>('list_voices', { key: apiKey, region: settings.region });
        confirmedClones = qwenClonedVoices(data.voices || [], voice => cloneProvider(voice, settings.region));
        setVoices(confirmedClones);
      }
      validateVoiceSelection(settings, confirmedClones);
      validateAdvanced(settings.advanced);
      const a = settings.advanced;
      const creation: SessionCreation = { key: apiKey, region: settings.region, avatar: { model: settings.avatarModel, image_uri: imageFileData || settings.imageUri, persona: settings.persona, voice: settings.voice, voice_provider: settings.voiceProvider, greeting_instruction: settings.greeting, advanced: { persona_enhance: a.personaEnhance, idle_action: a.idleAction, enable_transcription: true, vad_type: a.vadType, vad_threshold: a.vadThreshold, silence_duration_ms: a.silenceDurationMs, vad_idle_timeout_ms: a.vadIdleTimeoutMs, temperature: a.temperature, top_p: a.topP, top_k: a.topK, max_tokens: a.maxTokens, idle_timeout_seconds: a.idleTimeoutSeconds } } };
      sessionCreationRef.current = creation;
      const result = await call<Session>('create_session', creation);
      if (endedLiveIdsRef.current.has(result.live_id)) return;
      setSession(result);
      setLiveState(old => old?.live_id === result.live_id ? old : { live_id: result.live_id, status: 'waiting' });
      if (!disconnectedLiveIdsRef.current.has(result.live_id)) setAvatarNotice(old => old?.message === '数字人已就绪，可以开始提问。' ? old : { kind: 'success', message: '会话已创建，正在打开播放窗口并等待数字人就绪。' });
      log(`Vidu 会话已创建：${result.live_id} · 数字人模型：${settings.avatarModel}`);
      try { await call('open_obs_window'); }
      catch (error) { const message = `播放窗口打开失败，正在挂断：${errorText(error)}`; setAvatarNotice({ kind: 'error', message }); reportError(message); log(message); await call('end_session', { liveId: result.live_id }); }
    } catch (error) {
      setInitStage('创建或控制连接失败');
      const message = `创建数字人失败：${errorText(error)}`;
      setAvatarNotice({ kind: 'error', message });
      reportError(message);
      log(message);
    } finally { creatingAvatarRef.current = false; setCreatingAvatar(false); setPending(false); }
  };
  const stopAvatar = () => action(async () => { recoveryRef.current?.cancel(); resumeRecoveredRef.current = null; recoveryAutoRef.current = false; modelRequestRef.current += 1; generatingReplyRef.current = false; setBusyState(false); setAuto(false); expectedDisconnectRef.current = true; try { await call('end_session'); } catch (error) { expectedDisconnectRef.current = false; throw error; } const liveId = activeLiveIdRef.current || session?.live_id; if (liveId) endedLiveIdsRef.current.add(liveId); activeLiveIdRef.current = null; setSession(null); setInitStage('Vidu 已确认会话结束'); setReady(false); setBusyState(false); setRtcJoined(false); setMicEnabled(false); micRef.current = false; setAvatarNotice({ kind: 'success', message: '数字人会话已结束。' }); log('Vidu 会话已结束'); });
  const toggleMicrophone = async () => {
    if (!rtcJoined || micPending || !session) return;
    setMicPending(true);
    setMicError('');
    try {
      if (!micEnabled) {
        setAuto(false);
        await interactionQueueRef.current?.setContext(false, session.live_id, false);
        if (interactionQueueRef.current?.snapshot().tasks.some(task => task.status === 'playing' || task.status === 'uncertain')) {
          await call('interrupt_session');
          await interactionQueueRef.current?.finish('skipped', '开启麦克风，操作员中断当前队列播报');
        }
      }
      await emitTo('obs', 'mic-control', { live_id: session.live_id, enabled: !micEnabled });
    } catch (error) { const message = `麦克风操作失败：${errorText(error)}`; setMicPending(false); setMicError(message); reportError(message); log(message); }
  };
  const manualSend = (messageType: ManualMessageType) => action(async () => {
    const content = (messageType === 'text_dialog' ? dialogue : question).trim();
    const liveId = activeLiveIdRef.current;
    if (!content || !liveId || !readyRef.current) return;
    const manual = manualQuestionsRef.current;
    if (!manual) throw new Error('调度器尚未初始化，请稍后重试');
    manual.enqueue(content, liveId, messageType);
    log(`手动提问（${messageType}）优先待发：${content}`);
    const clearInput = messageType === 'text_dialog' ? setDialogue : setQuestion;
    clearInput(old => old.trim() === content ? '' : old);
  });
  const interrupt = () => action(async () => { modelRequestRef.current += 1; generatingReplyRef.current = false; await call('interrupt_session'); manualQuestionsRef.current?.cancel(); await interactionQueueRef.current?.finish('skipped', '操作员打断'); setBusyState(false); log('已发送打断指令，已清除待发手动提问'); });
  async function manageQueue(task: () => Promise<void> | undefined) {
    try { await task(); }
    catch (error) { setAuto(false); reportError(`队列操作失败：${errorText(error)}`); }
  }
  const skipCurrentQueue = () => manageQueue(async () => {
    const current = interactionQueueRef.current?.snapshot().tasks.find(task => task.status === 'playing' || task.status === 'uncertain');
    if (current?.live_id && current.live_id === activeLiveIdRef.current && readyRef.current) await call('interrupt_session');
    await interactionQueueRef.current?.finish('skipped', '操作员跳过当前任务');
  });
  const toggleAutomaticQueue = () => {
    if (auto) { setAuto(false); return; }
    const config = loadModelConfig();
    if (!config.apiKey.trim() || !config.selectedModel || !config.persona.trim()) { reportError('请先在“模型配置 → 大语言模型”中保存 API Key、模型和人设'); return; }
    if (!session || !ready || !rtcJoined) { reportError('请先创建数字人并等待播放窗口入会'); return; }
    if (!interactionQueueRef.current) { reportError('互动队列尚未初始化，请稍后重试'); return; }
    void call('queue_save_config', { persona: config.persona, model: config.selectedModel, baseUrl: config.baseUrl }).then(() => setAuto(true)).catch(error => reportError(`保存队列配置失败：${errorText(error)}`));
  };
  const importTestDanmaku = () => action(async () => {
    const entries = parseTestDanmaku(testDanmakuInput);
    if (roomConnected) throw new Error('请先停止获取弹幕，再导入测试，避免混入直播间消息');
    const queue = interactionQueueRef.current;
    if (!queue) throw new Error('互动队列尚未初始化，请稍后重试');
    if (!session || !ready || !rtcJoined) throw new Error('请先创建数字人并等待播放窗口入会');
    if (micEnabled || micPending) throw new Error('请先关闭麦克风推流，再测试弹幕播报');
    if (busyRef.current || queue.isGenerating()) throw new Error('请等待当前提问或生成结束后再测试');
    const config = loadModelConfig();
    if (entries.some(entry => !entry.result) && (!config.apiKey.trim() || !config.selectedModel || !config.persona.trim())) {
      throw new Error('请先在“模型配置 → 大语言模型”中保存 API Key、模型和人设');
    }
    const blocked = entries.find(entry => entry.type === 'chat' && blockReason(entry.content, settings.rules));
    if (blocked) throw new Error(`测试弹幕「${blocked.nickname}」${blockReason(blocked.content, settings.rules)}，请修改内容后重试`);
    const liveId = session.live_id;
    await call('queue_save_config', { persona: config.persona, model: config.selectedModel, baseUrl: config.baseUrl });
    if (activeLiveIdRef.current !== liveId || !readyRef.current) throw new Error('数字人会话已变化，请等待连接后重试');
    await queue.setContext(false, liveId, false);
    setAuto(false);
    const batchId = `test:${crypto.randomUUID()}`;
    const createdAt = Date.now();
    const items = entries.map(entry => ({
      event: { event_id: crypto.randomUUID(), type: entry.type, room_id: batchId, user_id: `${batchId}:${entry.nickname}`, nickname: entry.nickname, content: entry.content, created_at: createdAt, ...(entry.gift ? { gift: entry.gift } : {}) },
      result: entry.result,
    }));
    await queue.importTestBatch(items);
    if (activeLiveIdRef.current !== liveId || !readyRef.current) throw new Error('数字人会话已结束，测试已保留在队列中，未启动播报');
    setMessages(old => [...items.map(({ event }) => ({ id: event.event_id, ts: event.created_at, nickname: event.nickname, content: event.content, blocked: null })), ...old].slice(0, 100));
    setShowTestDanmaku(false);
    setAuto(true);
    log(`测试批次 ${batchId} · 会话 ${liveId} · 已按输入顺序导入 ${items.length} 条互动，新一轮等待下行音频静音确认后串行播报；协议诊断记录在应用数据目录 douyin-live/data/vidu-signals.jsonl`);
  });
  const cloneVoice = async () => {
    setVoiceNotice(null);
    setPending(true);
    let ttsReady = false;
    try {
      if (!apiKey.trim()) throw new Error('请先在“模型配置 → Vidu数字人”填写 Vidu API Key');
      const voice = voiceName.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{6,14}[A-Za-z0-9]$/.test(voice)) throw new Error('音色名称需为 8–16 位，以字母开头、字母或数字结尾，仅使用字母、数字和下划线');
      const audioUrl = voiceUrl.trim();
      if (!audioUrl) throw new Error('请填写 Vidu 可访问的公网音频 URL');
      if (!/^https?:\/\//i.test(audioUrl)) throw new Error('音频 URL 需以 http:// 或 https:// 开头');
      if (audioUrl.length > 2048) throw new Error('音频 URL 不能超过 2048 个字符');
      const sampleText = voiceSampleText.trim();
      if (!sampleText || sampleText.length > 200) throw new Error('试听文本需为 1–200 个字');
      const linkKey = voiceLinkKey(voiceRegion, voice);
      const existingLink = voiceLinks[linkKey];
      let ttsVoiceId = existingLink?.ttsVoiceId || '';
      ttsReady = !!existingLink;
      if (existingLink && existingLink.audioUrl !== audioUrl) throw new Error('此名称已关联其他参考音频。请换一个新音色名称，避免复用已有语音合成音色。');
      if (!existingLink) {
        setVoiceNotice({ kind: 'success', message: '正在创建试听音色…' });
        const ttsResult = await call<{ state?: string; voice_id?: string; demo_audio?: string; task_id?: string }>('clone_tts_voice', { key: apiKey, region: voiceRegion, voiceId: voice, audioUrl, text: sampleText });
        if (ttsResult.state !== 'success' || !ttsResult.voice_id) throw new Error(`试听音色尚未创建成功（${ttsResult.state || '未知状态'}${ttsResult.task_id ? `，任务 ${ttsResult.task_id}` : ''}），未提交直播音色。`);
        ttsVoiceId = ttsResult.voice_id;
        const nextLinks = { ...voiceLinks, [linkKey]: { ttsVoiceId: ttsResult.voice_id, audioUrl } };
        setVoiceLinks(nextLinks);
        ttsReady = true;
        try { localStorage.setItem('vidu-voice-links', JSON.stringify(nextLinks)); }
        catch { throw new Error('试听音色已创建，但本机保存音色关联失败。请检查应用存储权限后重试。'); }
        if (ttsResult.demo_audio && /^https?:\/\//i.test(ttsResult.demo_audio)) {
          activePreviewCacheKey.current = '';
          setVoicePreviewName(voice);
          setVoicePreviewUrl(ttsResult.demo_audio);
        }
      }
      setVoiceNotice({ kind: 'success', message: '试听音色已创建，正在创建直播音色…' });
      await call('clone_live_voice', { key: apiKey, region: voiceRegion, voice, audioUrl, transcript: voiceTranscript });
      const nextLinks = { ...loadVoiceLinks(), [linkKey]: { ttsVoiceId, audioUrl, provider: 'qwen_omni' as const } };
      localStorage.setItem('vidu-voice-links', JSON.stringify(nextLinks));
      setVoiceLinks(nextLinks);
      setVoices(old => old.includes(voice) ? old : [...old, voice]);
      if (cloneTarget) cloneTarget.select(voice);
      else if (avatars.library) await avatars.patchProfile(avatars.library.activeId, { voice, voiceProvider: 'qwen_omni', voiceSource: 'clone' });
      setVoicesError('');
      setVoiceNotice({ kind: 'success', message: `音色 ${voice} 克隆成功，已设为当前音色，可点击试听` });
      log(`音色 ${voice} 克隆成功，已设为当前音色`);
    } catch (error) {
      const message = errorText(error);
      setVoiceNotice({ kind: 'error', message: `${message}${ttsReady ? '；试听音色已创建，再次提交会直接重试直播音色。' : ''}` });
      reportError(`音色克隆失败：${message}`);
      log(`音色克隆失败：${message}`);
    } finally {
      setPending(false);
    }
  };
  const refreshVoices = async () => {
    setVoiceNotice(null);
    setVoicesLoading(true); setVoicesError('');
    setPending(true);
    try {
      if (!apiKey.trim()) throw new Error('请先在“模型配置 → Vidu数字人”填写 Vidu API Key');
      const result = await call<{ voices?: ClonedVoice[] }>('list_voices', { key: apiKey, region: voiceRegion });
      setVoices(qwenClonedVoices(result.voices || [], voice => cloneProvider(voice, voiceRegion)));
    } catch (error) {
      const message = errorText(error);
      setVoicesError(message);
      setVoiceNotice({ kind: 'error', message });
      reportError(`刷新音色列表失败：${message}`);
      log(`刷新音色列表失败：${message}`);
    } finally {
      setPending(false); setVoicesLoading(false);
    }
  };
  const refreshCredits = async () => {
    setCreditsError('');
    setCreditsLoading(true);
    try { setCredits(await call<Credits>('account_credits', { key: apiKey, region: settings.region })); }
    catch (error) { const message = `查询账户积分失败：${errorText(error)}`; setCredits(null); setCreditsError(errorText(error)); reportError(message); }
    finally { setCreditsLoading(false); }
  };
  const deleteVoice = async (voice: string) => {
    setVoiceNotice(null);
    if (session) { const message = '请先结束数字人会话，再删除音色。'; setVoiceNotice({ kind: 'error', message }); reportError(message); return; }
    if (!window.confirm(`确定从 Vidu 账户删除直播音色“${voice}”吗？删除后无法恢复。`)) return;
    setPending(true);
    try {
      await call('delete_voice', { key: apiKey, region: voiceRegion, voice });
      setVoices(old => old.filter(item => item !== voice));
      if (avatars.library && settings.region === voiceRegion && settings.voice === voice) await avatars.patchProfile(avatars.library.activeId, { voice: initialSettings.voice, voiceProvider: initialSettings.voiceProvider, voiceSource: 'builtin' });
      if (voicePreviewName === voice) { setVoicePreviewUrl(''); setVoicePreviewName(''); }
      const nextLinks = { ...voiceLinks };
      delete nextLinks[voiceLinkKey(voiceRegion, voice)];
      setVoiceLinks(nextLinks);
      let storageWarning = '';
      try { localStorage.setItem('vidu-voice-links', JSON.stringify(nextLinks)); }
      catch { storageWarning = '；本机音色关联清理失败，请检查应用存储权限'; reportError('本机音色关联清理失败，请检查应用存储权限。'); }
      setVoiceNotice({ kind: 'success', message: `已从 Vidu 删除直播音色 ${voice}${settings.voice === voice ? '，当前音色已切换为默认千问音色 Tina' : ''}${storageWarning}` });
      log(`已删除直播音色 ${voice}`);
    } catch (error) {
      const message = `删除音色失败：${errorText(error)}`; setVoiceNotice({ kind: 'error', message }); reportError(message);
    } finally { setPending(false); }
  };
  const previewVoice = async (voice: string, region: Settings['region'] = voiceRegion) => {
    setVoicePreviewError('');
    const link = voiceLinks[voiceLinkKey(region, voice)];
    if (!link) { const message = '此直播音色没有关联的试听音色。请用双接口流程重新克隆一个新名称。'; setVoicePreviewError(message); reportError(message); return; }
    const cacheKey = JSON.stringify([region, voice, voiceSampleText.trim()]);
    const cachedUrl = voicePreviewCache.current.get(cacheKey);
    if (cachedUrl) {
      activePreviewCacheKey.current = cacheKey;
      setVoicePreviewName(voice);
      if (audioPreviewRef.current?.src === cachedUrl) {
        audioPreviewRef.current.currentTime = 0;
        void audioPreviewRef.current.play().catch(() => {});
      } else {
        playRequestedRef.current = true;
        setVoicePreviewUrl(cachedUrl);
      }
      return;
    }
    setPreviewingVoice(voice);
    try {
      if (!apiKey.trim()) throw new Error('请先在“模型配置 → Vidu数字人”填写 Vidu API Key');
      const url = await call<string>('preview_voice', { key: apiKey, region: region, voiceId: link.ttsVoiceId, text: voiceSampleText });
      if (!/^https?:\/\//i.test(url)) throw new Error('Vidu 返回的试听音频地址无效');
      voicePreviewCache.current.set(cacheKey, url);
      activePreviewCacheKey.current = cacheKey;
      setVoicePreviewName(voice);
      playRequestedRef.current = true;
      setVoicePreviewUrl(url);
    } catch (error) {
      const message = `试听失败：${errorText(error)}`; setVoicePreviewError(message); reportError(message);
    } finally { setPreviewingVoice(null); }
  };
  const voicePlayer = voicePreviewUrl && <div className="voice-preview-player"><span>试听音频：{voicePreviewName}</span><audio ref={audioPreviewRef} src={voicePreviewUrl} controls preload="none" onError={() => { const message = '试听音频加载失败，请重试。'; voicePreviewCache.current.delete(activePreviewCacheKey.current); setVoicePreviewError(message); reportError(message); }}/></div>;
  const creditItems = credits?.remains || credits?.remaining_credits || [];
  const totalCredits = creditItems.reduce((sum, item) => sum + (Number(item.credit_remain) || 0), 0);

  return <div className="app-shell">
    {errorEntries.length > 0 && <div className="error-stack" role="region" aria-label="错误日志">{errorEntries.map(entry => <div className="error-toast" key={entry.id} role="alert"><div className="error-toast-heading"><strong>操作错误</strong><time>{new Date(entry.at).toLocaleString('zh-CN')}</time><button type="button" aria-label="关闭此错误" onClick={() => setErrorEntries(old => old.filter(item => item.id !== entry.id))}>×</button></div><p>{entry.message}</p></div>)}</div>}
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Activity size={25}/></div><div><strong>数字人直播</strong></div></div>
      <button className={tab === 'live' ? 'nav active' : 'nav'} onClick={() => setTab('live')}><Radio size={18}/> 直播中控</button>
      <button className={tab === 'rules' ? 'nav active' : 'nav'} onClick={() => setTab('rules')}><Shield size={18}/> 弹幕配置</button>
      <button className={tab === 'songs' ? 'nav active' : 'nav'} onClick={() => setTab('songs')}><Music2 size={18}/> 唱歌模块</button>
      <button className={tab === 'voice' ? 'nav active' : 'nav'} onClick={() => { setCloneTarget(null); setTab('voice'); }}><Mic2 size={18}/> 音色克隆</button>
      <button className={tab === 'models' ? 'nav active' : 'nav'} onClick={() => setTab('models')}><Cpu size={18}/> 模型配置</button>
      <button className={tab === 'settings' ? 'nav active' : 'nav'} onClick={() => setTab('settings')}><Settings2 size={18}/> 形象设定</button>
      <div className="sidebar-bottom">
        <div className="sidebar-status"><span className={ready ? 'status-dot good' : 'status-dot'}/>{ready ? '数字人已就绪' : '数字人未连接'}</div>
        <div className="credits-panel"><div className="credits-heading"><strong>账户积分</strong><button type="button" disabled={creditsLoading || !apiKey.trim().startsWith('vda_')} onClick={() => void refreshCredits()}>{creditsLoading ? '查询中…' : '刷新'}</button></div>{credits ? <button type="button" className="credits-total-button" onClick={() => setShowCreditDetails(true)} aria-label={`查看积分详情，当前 ${totalCredits.toLocaleString('zh-CN')} 积分`}>{totalCredits.toLocaleString('zh-CN')} <small>积分</small></button> : <p className="hint">{creditsLoading ? '正在读取账户积分…' : creditsError ? `查询失败：${creditsError}` : '未查询'}</p>}</div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div><h1>{tab === 'live' ? '直播中控台' : tab === 'rules' ? '弹幕配置' : tab === 'songs' ? '唱歌模块' : tab === 'voice' ? '音色克隆' : tab === 'models' ? '模型配置' : '形象设定'}</h1></div><div className="top-actions"><span className="pill"><span className={roomConnected ? 'status-dot good' : 'status-dot'}/> 弹幕采集 {roomConnected ? '获取中' : '未启动'}</span><span className="pill"><span className={ready ? 'status-dot good' : 'status-dot'}/> 数字人 {ready ? '已就绪' : session ? '连接中' : '未创建'}</span></div></header>
      {tab === 'live' && <div className="content live-grid">
        <section className="card control-card"><div className="section-title"><div><h2>连接抖音弹幕</h2></div><Radio size={19}/></div><div className="fields-row"><label className="grow">直播间号<input value={settings.roomId} disabled={roomConnected} onChange={e => update({ roomId: e.target.value })} placeholder="输入 web_rid"/></label></div><div className="button-row"><button className="primary" disabled={pending || roomConnected} onClick={startDanmaku}><Play size={16}/> 启动获取弹幕</button><button disabled={pending || !roomConnected} onClick={stopDanmaku}><Square size={16}/> 停止获取弹幕</button><button disabled={pending} aria-expanded={showTestDanmaku} aria-controls="test-danmaku-panel" onClick={() => setShowTestDanmaku(value => !value)}><Plus size={16}/> 测试输入弹幕</button></div>
          {showTestDanmaku && <div className="test-danmaku-panel" id="test-danmaku-panel">
            <label htmlFor="test-danmaku-input">测试弹幕 / 礼物（每次 1～{INTERACTION_SLOT_COUNT} 条）</label>
            <textarea id="test-danmaku-input" rows={6} value={testDanmakuInput} disabled={pending} onChange={event => setTestDanmakuInput(event.target.value)} spellCheck={false}/>

            <div className="button-row"><button className="primary" disabled={pending || roomConnected || testDanmakuCount < 1 || testDanmakuCount > INTERACTION_SLOT_COUNT} onClick={importTestDanmaku}><Play size={16}/> 导入 {testDanmakuCount} 条并开始测试</button><button disabled={pending} onClick={() => setShowTestDanmaku(false)}>取消</button></div>
          </div>}
        </section>
        <section className="card control-card"><div className="section-title"><div><h2>生成与播放</h2></div><Video size={19}/></div><div className="active-avatar-summary"><span>当前数字人：<strong>{avatars.library?.profiles.find(profile => profile.id === avatars.library?.activeId)?.name || (avatars.loading ? '读取中…' : '未选择')}</strong></span><button type="button" onClick={() => setTab('settings')}>管理数字人</button></div><div className="button-row"><button className="primary" disabled={pending || recoveringSession || !!session || avatars.loading || avatars.saving || !avatars.library} onClick={() => void startAvatar()}><Play size={16}/> {creatingAvatar ? '启动中…' : '启动数字人'}</button><button disabled={!session} onClick={() => void call('open_obs_window').catch(error => reportError(`打开 OBS 窗口失败：${errorText(error)}`))}><Clapperboard size={16}/> 打开 OBS 窗口</button><button disabled={creatingAvatar || (!recoveringSession && !session && !ready && avatarNotice?.message !== '数字人已就绪，可以开始提问。')} onClick={stopAvatar}><CircleStop size={16}/> 结束会话</button></div>{avatarNotice && <div className={`voice-notice ${avatarNotice.kind}`} role={avatarNotice.kind === 'error' ? 'alert' : 'status'}>{avatarNotice.message}</div>}<div className="session-info" role="status" aria-live="polite"><span>创建阶段</span><strong>{initStage || '尚未创建'}</strong><span>Vidu 状态</span><strong>{liveState ? liveStatusText(liveState.status) : creatingAvatar ? '等待创建接口返回' : '—'}</strong><span>会话 ID</span><strong>{liveState?.live_id || session?.live_id || '—'}</strong><span>控制连接</span><strong>{ready ? '就绪' : session ? disconnectedLiveIdsRef.current.has(session.live_id) ? '已断开' : '连接中' : '未连接'}</strong>{liveState?.trace_id && <><span>Trace ID</span><strong>{liveState.trace_id}</strong></>}</div>{liveStatusError && <p className="hint">会话状态查询失败：{liveStatusError}</p>}</section>
        <section className="card ask-card">
          <div className="section-title"><div><h2>提问与打断</h2></div><Send size={19}/></div>
          <QuestionInputs question={question} dialogue={dialogue} onQuestionChange={setQuestion} onDialogueChange={setDialogue}
            canSend={!pending && ready && !!queueDirectory} canInterrupt={ready} onSend={messageType => void manualSend(messageType)} onInterrupt={() => void interrupt()}/>
          <p className="hint">手动提问在当前播报结束后优先发送，回答结束后继续互动队列。</p>
          {manualQuestions.length > 0 && <div role="status">
            <p className="hint">{manualQuestions[0].status === 'waiting' ? '优先等待发送' : manualQuestions[0].status === 'uncertain' ? '等待确认' : '正在回答手动提问'}（{manualQuestions[0].message_type}）：{manualQuestions[0].content} · 共 {manualQuestions.length} 条{manualQuestions[0].error && ' · ' + manualQuestions[0].error}</p>
            {manualQuestions[0].status === 'uncertain' && <button onClick={() => manualQuestionsRef.current?.confirm()}>确认手动回答完成</button>}
          </div>}
          <div className="button-row">
            <button disabled={!rtcJoined || micPending} onClick={() => void toggleMicrophone()}>{micEnabled ? <MicOff size={16}/> : <Mic2 size={16}/>} {micPending ? '麦克风连接中…' : micEnabled ? '关闭麦克风' : '开启麦克风推流'}</button>
            <span className="hint">{micError || (micEnabled ? '麦克风已开启' : '麦克风已关闭')}</span>
          </div>
          <div className="auto-row"><div><strong>自动回答弹幕</strong></div><button className={auto ? 'switch on' : 'switch'} onClick={toggleAutomaticQueue} aria-label="切换自动回答" aria-pressed={auto}><span/></button></div>
        </section>
        <section className="card interaction-queue-card"><div className="section-title"><div><h2>互动任务队列</h2></div><span className="count">{interactionState.tasks.length}/{INTERACTION_SLOT_COUNT} 槽位</span></div>
          <p className="hint">候选弹幕 {interactionState.candidates.filter(event => event.type === 'chat').length} · 待感谢礼物 {interactionState.candidates.filter(event => event.type === 'gift').length + Object.keys(interactionState.combos).length} · 模型生成 {interactionState.tasks.filter(task => task.status === 'generating').length}/2 · 已播报 {interactionState.totals?.played ?? 0}</p>
          <div className="queue-handoff-controls">
            <div className="auto-row"><div><strong>语音识别与台词末尾匹配</strong></div><button className={whisperEnabled ? 'switch on' : 'switch'} disabled={!queueDirectory || queuePlaying || interactionState.tasks.some(task => task.status === 'uncertain')} aria-label="切换语音识别结束检测" aria-pressed={whisperEnabled} onClick={() => void manageQueue(() => interactionQueueRef.current?.configureRecognition(!whisperEnabled))}><span/></button></div>
            <div className="fields-row"><label>台词匹配度（%）<input type="number" min={50} max={100} step={1} disabled={!whisperEnabled || !queueDirectory || queuePlaying} value={recognitionMatchDraft} onChange={event => setRecognitionMatchDraft(event.target.value)} onBlur={saveRecognitionMatch} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label></div>
            {whisperEnabled && <div className="button-row"><button disabled={whisperStatus === 'loading' || queuePlaying} onClick={() => void loadWhisper(true)}>{whisperStatus === 'loading' ? '加载中…' : '重新加载语音识别'}</button><span className="hint" role="status">{whisperMessage || '等待加载语音识别'}</span></div>}

          </div>
          <div className="queue-handoff-controls">
            <div className="auto-row"><div><strong>承接动作</strong></div><button className={handoff.enabled ? 'switch on' : 'switch'} disabled={!queueDirectory} aria-label="切换承接动作" aria-pressed={handoff.enabled} onClick={() => void manageQueue(() => interactionQueueRef.current?.configureHandoff(!handoff.enabled, handoff.direction))}><span/></button></div>
            <div className="fields-row"><label>当前槽位语音识别匹配度（%）<input type="number" min={1} max={100} step={1} disabled={!handoff.enabled || !queueDirectory} value={handoffTriggerDraft} onChange={event => setHandoffTriggerDraft(event.target.value)} onBlur={saveHandoffTrigger} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label><label>承接动作方向<select disabled={!handoff.enabled || !queueDirectory} value={handoff.direction} onChange={event => void manageQueue(() => interactionQueueRef.current?.configureHandoff(handoff.enabled, event.target.value as HandoffDirection))}>{HANDOFF_DIRECTIONS.map(direction => <option key={direction.value} value={direction.value}>{direction.label}</option>)}</select></label><label>查看角度（度）<input type="number" min={0} max={90} step={1} disabled={!handoff.enabled || !queueDirectory || handoff.direction === 'front'} value={handoffAngleDraft} onChange={event => setHandoffAngleDraft(event.target.value)} onBlur={saveHandoffAngle} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label><label>动作提交后的等待时间（毫秒）<input type="number" min={0} max={3000} step={1} disabled={!handoff.enabled || !queueDirectory} value={handoffWaitDraft} onChange={event => setHandoffWaitDraft(event.target.value)} onBlur={saveHandoffWait} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/></label></div>
            {handoff.direction === 'front' && <p className="hint">平视前方不使用查看角度，其他方向继续使用已保存的角度。</p>}
            {lastHandoff && <p className="hint" role="status">承接动作：{handoffActionLabel(lastHandoff.direction, lastHandoff.angle_deg ?? 30)} · {{ pending: '正在提交', submitted: '已提交，下一条延后' + (lastHandoff.wait_ms ?? 1699) + '毫秒', failed: '发送失败', cancelled: '已取消' }[lastHandoff.status]}{lastHandoff.error && '：' + errorText(lastHandoff.error)}</p>}
          </div>
          <div className="interaction-slots">{Array.from({ length: INTERACTION_SLOT_COUNT }, (_, index) => { const task = interactionState.tasks[index]; const gesture = task?.result ? avatarActionFor(task) : null; return <div className={task ? 'interaction-slot occupied' : 'interaction-slot'} key={index}>
            <strong>槽位 {index + 1}{task && ' · ' + task.event.nickname}</strong>
            {task ? <><span className="tag">{task.song ? '播放歌曲' : task.event.type === 'gift' ? '礼物优先' : '弹幕'} · {task.song && task.status === 'ready' ? '等待播放' : task.song && task.status === 'playing' ? task.song_playback === 'blocked' ? '等待点击恢复播放' : task.song_playback === 'playing' ? '正在播放原歌曲' : '正在启动原歌曲' : lastHandoff?.task_id === task.id && lastHandoff.status === 'pending' ? '承接动作中' : { pending: '等待优化提问', generating: '优化提问中', ready: '提问已优化', playing: '正在播报', uncertain: '等待人工确认', failed: '生成失败' }[task.status]}</span><p>{task.event.content}</p>{task.song ? <p className="interaction-reply">{`原歌曲时长 ${(task.song.duration_ms / 1000).toFixed(1)} 秒 · 使用预生成歌词时间轴`}</p> : <TaskDialogue task={task}/>}{task.error && <p className="hint">{errorText(task.error)}</p>}
              {task.song && task.status === 'ready' && <p className="hint">{!session || !ready ? '等待数字人连接就绪' : !rtcJoined ? '等待 OBS 播放窗口连接' : micEnabled || micPending ? '请先关闭麦克风推流' : index > 0 ? '等待前面的槽位播放完成；自动回答关闭时，需先处理前面的弹幕任务' : busy && !queuePlaying ? '等待当前提问结束' : !videoPlaying ? '等待 OBS 实时画面恢复' : '等待 OBS 启动原歌曲，无需开启自动回答'}</p>}
              {task.song && task.status === 'playing' && task.song_playback === 'blocked' && <p className="hint">请在 OBS 窗口点击“恢复播放”，歌曲将从头开始。</p>}
              {!task.song && whisperEnabled && ['playing', 'uncertain'].includes(task.status) && <p className="hint">语音识别：{task.recognition?.error ? errorText(task.recognition.error) : task.status === 'uncertain' ? '等待人工确认' : (task.recognition?.progress || 0) * 100 + 1e-9 >= (handoff.enabled ? handoff.trigger_percent ?? 50 : recognitionMatchPercent) ? '匹配通过' : !task.answer?.text ? '等待数字人返回回答' : '匹配实际回答中'} · 匹配度 {Math.floor((task.recognition?.progress || 0) * 100 + 1e-9)}%{task.recognition?.text && <span> · {task.recognition.text}</span>}</p>}
              {gesture && <p className="interaction-action">[动作] {gesture.label} · {task.action_state === 'submitted' ? '已提交' : task.action_state === 'failed' ? '发送失败' : '播报时触发'}{task.action_error && <span>：{task.action_error}</span>}</p>}
              <div className="button-row">{task.status === 'uncertain' && <button onClick={() => void manageQueue(() => interactionQueueRef.current?.finish('played', '操作员确认完成'))}>确认完成</button>}{!task.song && ['failed', 'ready'].includes(task.status) && <button onClick={() => void manageQueue(() => interactionQueueRef.current?.retry(task.id))}>重新生成</button>}{['playing', 'uncertain'].includes(task.status) ? <button onClick={() => void skipCurrentQueue()}>打断并跳过</button> : <button onClick={() => void manageQueue(() => interactionQueueRef.current?.skip(task.id))}>跳过</button>}</div></> : <p className="hint">等待最新候选事件补位</p>}
          </div>; })}</div>{queueDirectory && <p className="hint queue-directory">文件目录：{queueDirectory}</p>}
        </section>
        <section className="card stream-card"><div className="section-title"><div><h2>弹幕流</h2></div><span className="count">{messages.length} 条</span></div><div className="stream-list">{messages.length ? messages.map(m => <div className="message" key={m.id}><div className="message-meta"><strong>{m.nickname}</strong><time>{new Date(m.ts).toLocaleTimeString()}</time>{m.blocked && <span className="blocked">{m.blocked}</span>}</div><div className={m.blocked ? 'message-text muted' : 'message-text'}>{m.content}</div></div>) : <div className="empty">连接直播间后，这里会显示收到的弹幕。</div>}</div></section>
        <section className="card monitor-card"><div className="section-title"><div><h2>操作日志</h2></div><Activity size={19}/></div><div className="monitor-status"><div className={busy ? 'pulse busy' : 'pulse'}/><div><strong>{busy ? '数字人正在回答' : ready ? '等待下一个问题' : '等待连接'}</strong><span>{auto ? '自动模式已开启' : '自动模式已关闭'}</span></div></div><div className="log-list">{logs.map((l, i) => <div key={i}>{l}</div>)}</div><TtsLog/></section>
      </div>}
      {tab === 'rules' && <DanmakuSettings avatarSrc={previewSrc} filters={<FilterRules rules={settings.rules} onChange={rules => update({ rules })} onError={message => { reportError(message); log(message); }}/>}/>}
      <SingingModule active={tab === 'songs'} onConfigureModel={() => { setModelTab('reply'); setTab('models'); }} queueAvailable={!!queueDirectory && interactionState.tasks.length < INTERACTION_SLOT_COUNT} queuedSongIds={interactionState.tasks.flatMap(task => task.song ? [task.song.id] : [])} onEnqueue={async song => { const queue = interactionQueueRef.current; if (!queue) throw new Error('互动任务队列尚未加载'); await queue.enqueueSong(song); }}/>
      {tab === 'models' && <ModelConfiguration tab={modelTab} onTabChange={setModelTab} apiKey={apiKey} onApiKeyChange={setApiKey} storageError={keyStorageError}/>}
      <AvatarSettings cloneProvider={cloneProvider} active={tab === 'settings'} library={avatars.library} loading={avatars.loading} saving={avatars.saving} error={avatars.error} runtimeBusy={runtimeBusy}
        apiKey={apiKey} onConfigureApi={openViduSettings} preview={tab === 'settings' ? voicePlayer : null} previewError={voicePreviewError} previewingVoice={previewingVoice}
        canPreview={(voice, region) => !!voiceLinks[voiceLinkKey(region, voice)]} onPreview={(voice, region) => void previewVoice(voice, region)}
        onClone={(region, select) => { setCloneTarget({ region, select }); setTab('voice'); }}
        onSave={saveProfile} onSelect={selectProfile} onRetry={avatars.retry}/>
      {tab === 'voice' && <div className="content narrow"><section className="card">
        <div className="section-title"><div className="voice-clone-title"><h2>克隆音色</h2><span className="voice-clone-title-note">使用自定义音色的数字人需要先克隆音色，使用平台已有音色无需克隆。</span></div><Mic2 size={19}/></div><div className="voice-clone-cost" role="note">音色克隆每次899积分（约28元），每个客户前十次克隆免费。</div>
        <p className="hint">音色供应商：千问（qwen_omni）。克隆成功后用于千问数字人。</p>

        <div className="form-grid">
          <label>新音色名称<input value={voiceName} onChange={e => setVoiceName(e.target.value)} placeholder="8–16 位，以字母开头"/></label>
          <label>参考音频文字<input value={voiceTranscript} onChange={e => setVoiceTranscript(e.target.value)} placeholder="可选，填写录音对应文本"/></label>
          <label className="full">公网音频 URL<input value={voiceUrl} onChange={e => setVoiceUrl(e.target.value)} placeholder="https://.../reference.wav"/></label>
        </div>
        <div className="button-row"><button className="primary" disabled={pending} onClick={cloneVoice}><Mic2 size={16}/> {pending ? '提交中…' : '提交克隆'}</button><button disabled={pending} onClick={refreshVoices}>刷新音色列表</button></div>
        {voiceNotice && <div className={`voice-notice ${voiceNotice.kind}`} role="alert">{voiceNotice.message}{voiceNotice.kind === 'error' && !apiKey.trim() && <button type="button" onClick={openViduSettings}>前往填写 API Key</button>}</div>}

        <label className="voice-sample-label">试听文本<input value={voiceSampleText} maxLength={200} onChange={e => setVoiceSampleText(e.target.value)} placeholder="输入试听时朗读的文字"/></label>

        <div className="voice-list">{voices.map(v => <div className="voice-item" key={v}><button onClick={() => void selectClonedVoice(v).catch(error => reportError(errorText(error)))}>{v}{settings.voice === v && <span>当前使用</span>}</button><button disabled={!!previewingVoice || !voiceLinks[voiceLinkKey(voiceRegion, v)]} onClick={() => void previewVoice(v)}><Play size={14}/>{previewingVoice === v ? '生成中…' : voiceLinks[voiceLinkKey(voiceRegion, v)] ? '试听' : '未关联试听'}</button><button className="danger" disabled={pending || !!session} onClick={() => void deleteVoice(v)} title={session ? '请先结束数字人会话' : `删除 ${v}`}><Trash2 size={14}/>删除</button></div>)}</div>
        {voicePreviewError && <div className="voice-notice error" role="alert">{voicePreviewError}</div>}
        {voicePlayer}
      </section></div>}
    </main>
    {showCreditDetails && credits && <div className="credits-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowCreditDetails(false); }}><section className="credits-modal" role="dialog" aria-modal="true" aria-labelledby="credits-modal-title"><div className="credits-modal-heading"><h2 id="credits-modal-title">账户积分</h2><button type="button" onClick={() => setShowCreditDetails(false)} aria-label="关闭积分详情">关闭</button></div><div className="credits-total">{totalCredits.toLocaleString('zh-CN')} <small>积分</small></div>{creditItems.length > 0 && <div className="credits-modal-section"><h3>余额与并发</h3>{creditItems.map((item, i) => <div className="credits-modal-row" key={`${item.type || 'balance'}-${i}`}><strong>{item.type || '资源包'}</strong><span>{Number(item.credit_remain || 0).toLocaleString('zh-CN')} 积分{item.concurrency_limit != null && ` · 并发 ${item.current_concurrency || 0}/${item.concurrency_limit}`}</span></div>)}</div>}{credits.packages && credits.packages.length > 0 && <div className="credits-modal-section"><h3>资源包详情（{credits.packages.length}）</h3>{credits.packages.map((item, i) => <div className="credits-modal-row" key={item.id || i}><strong>{item.name || item.type || item.id || '资源包'}</strong><span>{Number(item.credit_remain || 0).toLocaleString('zh-CN')} 积分{item.valid_to && ` · 有效期至 ${item.valid_to}`}</span></div>)}</div>}</section></div>}
  </div>;
}
