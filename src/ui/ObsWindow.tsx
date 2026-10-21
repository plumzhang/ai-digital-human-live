import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import AliRtcEngine, { AliRtcSdkChannelProfile } from 'aliyun-rtc-sdk';
import { monitorDownlinkAudio, type DownlinkMonitor, type VadActivity } from '../rtcVad';
import { WhisperCapture, type RecognitionTarget, type WhisperResult } from '../whisperRecognition';

type Snapshot = { live_id: string; rtc: { token: string; user_id: string } };
type MediaControl = { enabled: boolean; live_id?: string };
type MediaKind = 'audio' | 'video';
type TranscriptionSignal = { type: number; live_id: string; payload?: { text_msg?: { content?: string } } };

export function ObsWindow() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<AliRtcEngine | null>(null);
  const downlinkMonitorsRef = useRef(new Map<string, DownlinkMonitor>());
  const vadNeedsResumeRef = useRef(false);
  const joinedRef = useRef(false);
  const micRef = useRef(false);
  const liveIdRef = useRef<string | null>(null);
  const lastFrameRef = useRef({ time: -1, reportedAt: 0 });
  const fittedVideoSizeRef = useRef('');
  const [status, setStatus] = useState('等待数字人会话');
  const [resumePlayback, setResumePlayback] = useState(false);
  const [microphoneCaption, setMicrophoneCaption] = useState('');
  const [queueCaption, setQueueCaption] = useState('');
  const [overlayPosition, setOverlayPosition] = useState<{ left: number; top: number | string; width: number | string }>({ left: 0, top: '50%', width: '100%' });
  const updateOverlayPosition = () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight || !video.clientWidth || !video.clientHeight) return;
    const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
    const width = video.videoWidth * scale;
    setOverlayPosition({ left: (video.clientWidth - width) / 2, top: video.clientHeight / 2, width });
  };
  const updateVideoLayout = () => {
    updateOverlayPosition();
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    const key = `${video.videoWidth}x${video.videoHeight}`;
    if (fittedVideoSizeRef.current === key) return;
    fittedVideoSizeRef.current = key;
    void invoke('fit_obs_video', { videoWidth: video.videoWidth, videoHeight: video.videoHeight }).catch(error => {
      if (fittedVideoSizeRef.current !== key) return;
      fittedVideoSizeRef.current = '';
      setStatus(`窗口尺寸适配失败：${String(error)}`);
    });
  };

  useEffect(() => {
    let disposed = false;
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverlayPosition);
    if (videoRef.current) resizeObserver?.observe(videoRef.current);
    let detachRtcListeners: (() => void) | null = null;
    const downlinks = new Map<string, { token: object; bytes?: number; progressAt: number; activity: VadActivity }>();
    let whisperUid: string | undefined;
    const whisper = new WhisperCapture(
      request => invoke<WhisperResult>('whisper_transcribe', { request }),
      result => { if (!disposed && result.live_id === liveIdRef.current) void emit('whisper-recognition', result); },
    );
    const reportVad = (uid: string, state: VadActivity) => {
      const entry = downlinks.get(uid);
      if (!entry || disposed) return;
      entry.activity = state;
      const all = [...downlinks.values()];
      const healthy = all.length > 0 && all.every(item => item.activity.healthy);
      const speaking = all.some(item => item.activity.speaking);
      if (!healthy && whisperUid === uid) whisper.invalidate('RTC 下行音频中断，识别已停止，请确认当前任务');
      void emit('avatar-audio', { live_id: liveIdRef.current, source: 'pcm-vad', speaking, healthy, quiet_ms: state.quiet_ms, ended: healthy && !speaking && state.ended, at: Date.now() });
    };
    async function reportMic(enabled: boolean, error?: string) {
      micRef.current = enabled;
      if (enabled) setQueueCaption('');
      if (!enabled) setMicrophoneCaption('');
      await emit('mic-state', { live_id: liveIdRef.current, enabled, error });
    }
    async function leave() {
      whisper.start(); whisperUid = undefined;
      for (const monitor of downlinkMonitorsRef.current.values()) monitor.dispose();
      downlinkMonitorsRef.current.clear(); downlinks.clear();
      vadNeedsResumeRef.current = false;
      setMicrophoneCaption('');
      setQueueCaption('');
      liveIdRef.current = null;
      lastFrameRef.current = { time: -1, reportedAt: 0 };
      joinedRef.current = false;
      await emit('rtc-status', { joined: false });
      await emit('rtc-media-status', { kind: 'video', subscribed: false });
      await emit('rtc-media-status', { kind: 'audio', subscribed: false });
      if (rtcRef.current) {
        detachRtcListeners?.();
        detachRtcListeners = null;
        try { await rtcRef.current.publishLocalAudioStream(false); } catch { /* closing */ }
        try { rtcRef.current.stopAudioCapture(); } catch { /* closing */ }
        try { await rtcRef.current.publishLocalVideoStream(false); } catch { /* closing */ }
        try { await rtcRef.current.enableLocalVideo(false); } catch { /* closing */ }
        try { await rtcRef.current.leaveChannel(); } catch { /* closing */ }
        try { await rtcRef.current.destroy(); } catch { /* closing */ }
        rtcRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      if (micRef.current) await reportMic(false);
    }
    async function setMicrophone(enabled: boolean) {
      const rtc = rtcRef.current;
      const liveId = liveIdRef.current;
      if (!rtc || !joinedRef.current) {
        await reportMic(false, '播放窗口尚未加入实时会话');
        return;
      }
      try {
        if (enabled) {
          await rtc.startAudioCapture({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
          if (disposed || rtcRef.current !== rtc || !joinedRef.current || liveIdRef.current !== liveId) {
            rtc.stopAudioCapture();
            return;
          }
        }
        await rtc.publishLocalAudioStream(enabled);
        if (!enabled) rtc.stopAudioCapture();
        if (disposed || rtcRef.current !== rtc || !joinedRef.current || liveIdRef.current !== liveId) {
          if (enabled) { await rtc.publishLocalAudioStream(false); rtc.stopAudioCapture(); }
          return;
        }
        await reportMic(enabled);
      } catch (error) {
        try { await rtc.publishLocalAudioStream(false); } catch { /* device or permission failure */ }
        try { rtc.stopAudioCapture(); } catch { /* device or permission failure */ }
        if (disposed || rtcRef.current !== rtc || liveIdRef.current !== liveId) return;
        const detail = String(error);
        const reason = /NotAllowed|PermissionDenied|permission denied/i.test(detail) ? '麦克风权限被拒绝，请在 Windows 隐私设置中允许桌面应用访问麦克风后重试'
          : /NotFound|DevicesNotFound/i.test(detail) ? '未找到本地麦克风，请连接麦克风并检查 Windows 默认输入设备'
          : /NotReadable|TrackStart|device.*(busy|use)/i.test(detail) ? '麦克风无法使用，请检查设备是否被占用'
          : detail;
        await reportMic(false, `麦克风推流失败：${reason}`);
      }
    }
    async function join(snapshot: Snapshot) {
      if (liveIdRef.current === snapshot.live_id) return;
      await leave();
      if (disposed) return;
      liveIdRef.current = snapshot.live_id;
      lastFrameRef.current = { time: -1, reportedAt: 0 };
      setResumePlayback(false);
      setStatus('正在连接实时画面');
      try {
      if (!snapshot.rtc?.token) throw new Error('Vidu 未返回有效的 RTC 入会凭证');
      const rtc = AliRtcEngine.getInstance();
      rtcRef.current = rtc;
      rtc.setChannelProfile(AliRtcSdkChannelProfile.AliRtcSdkCommunication);
      rtc.setAudioOnlyMode(false);
      rtc.setDefaultSubscribeAllRemoteVideoStreams(true);
      rtc.setDefaultSubscribeAllRemoteAudioStreams(true);
      const onVideoSubscribe = (uid: string, _old: number, next: number) => {
        void emit('rtc-media-status', { kind: 'video' satisfies MediaKind, subscribed: next === 3 });
        if (next === 3 && videoRef.current) {
          rtc.setRemoteViewConfig(videoRef.current, uid, 1);
          setStatus('视频已订阅，等待首帧');
          void videoRef.current.play().catch(() => { setResumePlayback(true); setStatus('请点击恢复播放'); });
        } else {
          setStatus('视频订阅中断，正在等待恢复');
        }
      };
      const onAutoplayFailed = () => { setResumePlayback(true); setStatus('请点击恢复播放'); };
      const onVideoPlayError = (_uid: string, reason?: string) => {
        setStatus(`视频播放失败：${reason || '未知错误'}`);
        void emit('rtc-status', { live_id: snapshot.live_id, joined: joinedRef.current, error: reason || '视频播放失败' });
      };
      const onAudioSubscribe = (_uid: string, _old: number, next: number) => {
        void emit('rtc-media-status', { kind: 'audio' satisfies MediaKind, subscribed: next === 3 });
        if (!_uid || _uid === snapshot.rtc.user_id) return;
        downlinkMonitorsRef.current.get(_uid)?.dispose();
        downlinkMonitorsRef.current.delete(_uid);
        const entry = { token: {}, progressAt: 0, activity: { speaking: false, ended: false, healthy: false } };
        downlinks.set(_uid, entry);
        reportVad(_uid, entry.activity);
        if (next !== 3) { downlinks.delete(_uid); if (whisperUid === _uid) { whisper.invalidate('RTC 下行音频取消订阅，请确认当前任务'); whisperUid = undefined; } return; }
        void (async () => {
          const track = await rtc.getAudioTrack(_uid);
          const current = () => !disposed && rtcRef.current === rtc && liveIdRef.current === snapshot.live_id && downlinks.get(_uid)?.token === entry.token;
          if (!current()) return;
          if (!track || track.kind !== 'audio') throw new Error('RTC 下行音轨尚不可用，请等待音频重新订阅');
          const monitor = await monitorDownlinkAudio(track,
            () => current() && entry.progressAt > 0 && Date.now() - entry.progressAt < 3500,
            state => { if (current()) reportVad(_uid, state); },
            message => { if (current()) { vadNeedsResumeRef.current = true; setResumePlayback(true); setStatus(message); void emit('rtc-vad-status', { live_id: snapshot.live_id, error: message }); } },
            (samples, rate, quietMs) => {
              if (!current() || micRef.current) return;
              whisperUid ??= _uid;
              if (whisperUid === _uid) whisper.push(samples, rate, quietMs);
            },
          );
          if (!current()) { monitor.dispose(); return; }
          downlinkMonitorsRef.current.set(_uid, monitor);
          void emit('rtc-vad-status', { live_id: snapshot.live_id, message: '已接入 RTC 下行 PCM 语音活动检测' });
        })().catch(error => {
          if (disposed || rtcRef.current !== rtc || downlinks.get(_uid)?.token !== entry.token) return;
          reportVad(_uid, { speaking: false, ended: false, healthy: false });
          void emit('rtc-vad-status', { live_id: snapshot.live_id, error: String(error) });
        });
      };
      const onAudioStats = (stats: { uid: string; stats: { bytesReceived?: number } }[]) => {
        for (const item of stats) {
          const entry = downlinks.get(item.uid);
          const bytes = item.stats?.bytesReceived;
          if (!entry || typeof bytes !== 'number') continue;
          if (bytes > (entry.bytes ?? 0)) entry.progressAt = Date.now();
          else { entry.progressAt = 0; reportVad(item.uid, { speaking: false, ended: false, healthy: false }); }
          entry.bytes = bytes;
        }
      };
      rtc.on('videoSubscribeStateChanged', onVideoSubscribe);
      rtc.on('audioSubscribeStateChanged', onAudioSubscribe);
      rtc.on('rtcRemoteAudioStats', onAudioStats);
      rtc.on('remoteVideoAutoPlayFail', onAutoplayFailed);
      rtc.on('remoteAudioAutoPlayFail', onAutoplayFailed);
      rtc.on('remoteVideoPlayError', onVideoPlayError);
      detachRtcListeners = () => {
        rtc.off('videoSubscribeStateChanged', onVideoSubscribe);
        rtc.off('audioSubscribeStateChanged', onAudioSubscribe);
        rtc.off('rtcRemoteAudioStats', onAudioStats);
        rtc.off('remoteVideoAutoPlayFail', onAutoplayFailed);
        rtc.off('remoteAudioAutoPlayFail', onAutoplayFailed);
        rtc.off('remoteVideoPlayError', onVideoPlayError);
      };
        await rtc.publishLocalAudioStream(false);
        await rtc.publishLocalVideoStream(false);
        await rtc.joinChannel(snapshot.rtc.token, snapshot.rtc.user_id);
        if (disposed || rtcRef.current !== rtc) { await rtc.leaveChannel(); return; }
        joinedRef.current = true;
        await emit('rtc-status', { joined: true });
        if (!videoRef.current?.videoWidth) setStatus('已入会，等待数字人画面');
        await reportMic(false);
        await emit('queue-caption-request', { live_id: snapshot.live_id });
      } catch (error) { await leave(); setStatus(`RTC 连接失败：${String(error)}`); await emit('rtc-status', { live_id: snapshot.live_id, joined: false, error: String(error) }); }
    }
    // Events and the startup snapshot can describe the same session. Serialize
    // them so one join cannot destroy another join's engine or listeners.
    let operations = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
      operations = operations.then(() => disposed ? undefined : operation()).catch(error => setStatus(String(error)));
    };
    let microphoneOperations = Promise.resolve();
    const unlisteners: Array<() => void> = [];
    void (async () => {
      unlisteners.push(await listen<Snapshot>('session-changed', e => enqueue(() => join(e.payload))));
      unlisteners.push(await listen<{ live_id?: string }>('session-ended', event => {
        const endedId = event.payload?.live_id;
        enqueue(async () => {
          if (endedId && endedId !== liveIdRef.current) return;
          await leave(); setStatus('直播已结束');
        });
      }));
      unlisteners.push(await listen<MediaControl>('mic-control', e => {
        const requestedLiveId = e.payload.live_id || liveIdRef.current;
        microphoneOperations = microphoneOperations.then(async () => {
          if (disposed || !requestedLiveId || requestedLiveId !== liveIdRef.current) return;
          if (e.payload.enabled) whisper.start();
          await setMicrophone(e.payload.enabled);
        }).catch(error => { if (!disposed) void reportMic(false, `麦克风操作失败：${String(error)}`); });
      }));
      unlisteners.push(await listen<TranscriptionSignal>('vidu-signal', event => {
        const signal = event.payload;
        // type=9 is the server's recognition of our microphone audio.
        // type=10 is the avatar's reply and must not be labelled as "我".
        if (disposed || signal.type !== 9 || !micRef.current || signal.live_id !== liveIdRef.current) return;
        const content = signal.payload?.text_msg?.content;
        if (typeof content === 'string' && content.trim()) setMicrophoneCaption(content.trim());
      }));
      unlisteners.push(await listen<{ live_id: string; content: string }>('queue-caption', event => {
        if (disposed || micRef.current || event.payload.live_id !== liveIdRef.current) return;
        if (typeof event.payload.content === 'string') setQueueCaption(event.payload.content.trim());
      }));
      unlisteners.push(await listen<RecognitionTarget>('whisper-task', event => {
        if (disposed || micRef.current || event.payload.live_id !== liveIdRef.current) return;
        whisper.start(event.payload);
      }));
      unlisteners.push(await listen<{ live_id: string }>('vidu-disconnected', event => {
        if (event.payload.live_id === liveIdRef.current) { setMicrophoneCaption(''); setQueueCaption(''); }
      }));
      const snapshot = await invoke<Snapshot | null>('session_snapshot');
      if (snapshot) enqueue(() => join(snapshot));
    })().catch(e => setStatus(String(e)));
    return () => { disposed = true; resizeObserver?.disconnect(); unlisteners.forEach(fn => fn()); void operations.finally(leave); };
  }, []);

  return <div className="obs-root">
    <video ref={videoRef} autoPlay playsInline className="obs-video" onLoadedMetadata={updateVideoLayout} onResize={updateVideoLayout} onTimeUpdate={event => {
      const video = event.currentTarget;
      updateVideoLayout();
      const liveId = liveIdRef.current;
      const now = Date.now();
      if (!liveId || !video.videoWidth || video.paused || video.currentTime === lastFrameRef.current.time || now - lastFrameRef.current.reportedAt < 1000) return;
      lastFrameRef.current = { time: video.currentTime, reportedAt: now };
      setStatus('画面已连接');
      setResumePlayback(vadNeedsResumeRef.current);
      void invoke('playback_frame', { liveId });
      void emit('rtc-playback', { live_id: liveId, playing: true });
    }} />
    <div className="obs-overlay" style={overlayPosition}>
      {(queueCaption || microphoneCaption) && <div className="obs-caption" role="status" aria-live="polite">{queueCaption || `我：${microphoneCaption}`}</div>}
      {resumePlayback && <button className="obs-status" onClick={() => {
        void Promise.all([...downlinkMonitorsRef.current.values()].map(monitor => monitor.resume())).then(() => {
          vadNeedsResumeRef.current = false; setResumePlayback(false);
        }).catch(error => setStatus(`音频检测恢复失败：${String(error)}`));
        void videoRef.current?.play().catch(error => setStatus(`恢复播放失败：${String(error)}`));
      }}>恢复播放</button>}
      {status !== '画面已连接' && <div className="obs-status">{status}</div>}
    </div>
  </div>;
}
