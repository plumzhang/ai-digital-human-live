import { loadTtsConfig } from '../ttsConfig';
import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import AliRtcEngine, { AliRtcSdkChannelProfile } from 'aliyun-rtc-sdk';
import { monitorDownlinkAudio, type DownlinkMonitor, type VadActivity } from '../rtcVad';
import { createSongAudioBridge } from '../songAudioBridge';
import { MicrophoneInput } from '../microphoneInput';
import { WhisperCapture, type RecognitionTarget, type WhisperResult } from '../whisperRecognition';
import { ObsCaption } from './ObsCaption';
import { loadCaptionSettings, normalizeCaptionSettings } from '../captionSettings';
import { SongDirectorPlayer, type SongDirector, type SongPlaybackIdentity } from '../songDirector';

type Snapshot = { live_id: string; rtc: { token: string; user_id: string } };
type MediaControl = { enabled: boolean; live_id?: string };
type MediaKind = 'audio' | 'video';
type TranscriptionSignal = { type: number; live_id: string; payload?: { text_msg?: { content?: string }; error?: { msg_id?: string; error_msg?: string; message?: string }; msg_id?: string; error_msg?: string; message?: string } };

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
  const resumeSongRef = useRef<(() => Promise<void>) | null>(null);
  const [status, setStatus] = useState('等待数字人会话');
  const [resumePlayback, setResumePlayback] = useState(false);
  const [microphoneCaption, setMicrophoneCaption] = useState('');
  const [queueCaption, setQueueCaption] = useState('');
  const [captionSettings, setCaptionSettings] = useState(loadCaptionSettings);
  const [overlayPosition, setOverlayPosition] = useState<{ left: number; top: number; width: number | string; height: number | string }>({ left: 0, top: 0, width: '100%', height: '100%' });
  const updateOverlayPosition = () => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight || !video.clientWidth || !video.clientHeight) return;
    const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    setOverlayPosition({ left: (video.clientWidth - width) / 2, top: (video.clientHeight - height) / 2, width, height });
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
    let song: { identity: SongPlaybackIdentity; player?: SongDirectorPlayer } | undefined;
    let songCleanup = Promise.resolve();
    const stopSong = async () => {
      const previous = song; song = undefined;
      resumeSongRef.current = null;
      const stopping = previous?.player?.stop();
      songCleanup = Promise.all([songCleanup, stopping]).then(() => {});
      await songCleanup;
    };
    let microphoneStream: MediaStream | undefined;
    let microphoneMonitor: DownlinkMonitor | undefined;
    let microphoneInput: MicrophoneInput | undefined;
    let microphoneGeneration = 0;
    const stopMicrophone = () => { microphoneGeneration++; microphoneInput?.stop(); microphoneInput = undefined; microphoneMonitor?.dispose(); microphoneMonitor = undefined; microphoneStream?.getTracks().forEach(track => track.stop()); microphoneStream = undefined; };
    let whisperUid: string | undefined;
    const whisper = new WhisperCapture(
      request => invoke<WhisperResult>('speech_transcribe', { request, tts: loadTtsConfig() }),
      result => { if (!disposed && result.live_id === liveIdRef.current) void emit('whisper-recognition', result); },
    );
    const reportVad = (uid: string, state: VadActivity) => {
      const entry = downlinks.get(uid);
      if (!entry || disposed) return;
      entry.activity = state;
      const all = [...downlinks.values()];
      const healthy = all.length > 0 && all.every(item => item.activity.healthy);
      const speaking = all.some(item => item.activity.speaking);
      song?.player?.observeAudio({ healthy, speaking, quiet_ms: Math.min(...all.map(item => item.activity.quiet_ms ?? 0)) });
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
      stopMicrophone();
      await stopSong();
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
      stopMicrophone();
      const liveId = liveIdRef.current;
      const generation = microphoneGeneration;
      if (!enabled) { await reportMic(false); return; }
      if (!liveId || !joinedRef.current) { await reportMic(false, '播放窗口尚未加入实时会话'); return; }
      try {
        await invoke('speech_prepare', { tts: loadTtsConfig() });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        const current = () => !disposed && generation === microphoneGeneration && liveIdRef.current === liveId;
        if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
        microphoneStream = stream;
        const input = new MicrophoneInput(liveId,
          request => invoke<WhisperResult>('speech_transcribe', { request, tts: loadTtsConfig() }),
          async () => { if (!current()) return; await emit('microphone-speech-start', { live_id: liveId }); await invoke('interrupt_session', { liveId }); },
          (text, captureId) => { if (current()) { setMicrophoneCaption(text); setQueueCaption(''); void emit('microphone-input', { live_id: liveId, text, capture_id: captureId }); } },
          error => { if (current()) { setStatus(error); void emit('microphone-error', { live_id: liveId, error }); } },
        );
        microphoneInput = input;
        const monitor = await monitorDownlinkAudio(stream.getAudioTracks()[0], current,
          state => { if (current() && !state.healthy) { input.stop(); } },
          error => { if (current()) { setStatus(error); void emit('microphone-error', { live_id: liveId, error }); } },
          (samples, rate, quietMs) => { if (current()) input.push(samples, rate, quietMs); },
        );
        if (!current()) { monitor.dispose(); stream.getTracks().forEach(track => track.stop()); return; }
        microphoneMonitor = monitor;
        await monitor.resume();
        await reportMic(true);
      } catch (error) {
        if (generation !== microphoneGeneration || liveIdRef.current !== liveId) return;
        stopMicrophone();
        const detail = String(error);
        const reason = /NotAllowed|PermissionDenied/i.test(detail) ? '麦克风权限被拒绝，请在 Windows 设置中允许麦克风访问' : detail;
        await reportMic(false, '本地麦克风识别启动失败：' + reason);
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
        if (song) rtc.muteAllRemoteAudioPlaying(true);
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
              if (!current() || micRef.current || song) return;
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
    let songOperations = Promise.resolve();
    const unlisteners: Array<() => void> = [];
    void (async () => {
      unlisteners.push(await listen('caption-settings-changed', event => {
        if (!disposed) setCaptionSettings(normalizeCaptionSettings(event.payload));
      }));
      await emit('caption-settings-request');
      unlisteners.push(await listen<SongPlaybackIdentity & { action: 'start' | 'stop'; song_id?: string }>('song-control', event => {
        const control = event.payload;
        if (disposed || control.live_id !== liveIdRef.current) return;
        // Invalidate a pending director load immediately on stop.
        if (control.action === 'stop' && song?.identity.playback_token === control.playback_token) void stopSong().catch(() => {});
        songOperations = songOperations.then(async () => {
          if (disposed || control.live_id !== liveIdRef.current) return;
          if (control.action === 'stop') {
            if (!song || song.identity.playback_token === control.playback_token) await stopSong();
            await emit('song-playback-state', { ...control, state: 'stopped' }); return;
          }
          if (song?.identity.playback_token === control.playback_token) return;
          await stopSong();
          if (micRef.current || !rtcRef.current) throw new Error('请关闭麦克风并连接数字人后播放歌曲');
          const currentSong: NonNullable<typeof song> = { identity: control }; song = currentSong;
          try {
            const director = await invoke<SongDirector>('director_get', { id: control.song_id });
            if (song !== currentSong || disposed || control.live_id !== liveIdRef.current) return;
            if (director.status !== 'ready' || !director.available || !director.cues.length) throw new Error('歌曲导播或原歌曲文件不可用');
            whisper.start();
            const rtc = rtcRef.current!;
            const audio = new Audio(convertFileSrc(director.audio_path)); audio.preload = 'auto';
            let bridge: Awaited<ReturnType<typeof createSongAudioBridge>> | undefined;
            const player = new SongDirectorPlayer(audio, director.cues, {
              mute: muted => { if (rtcRef.current === rtc) rtc.muteAllRemoteAudioPlaying(muted); },
              speak: (content, index) => invoke('component_transcription', { liveId: control.live_id, taskId: `${control.playback_token}-${index}`, content }),
              interrupt: () => invoke('interrupt_session', { liveId: control.live_id }),
              prepare: async () => {
                await invoke('interrupt_session', { liveId: control.live_id });
                if (song !== currentSong || disposed || liveIdRef.current !== control.live_id) throw new Error('歌曲已取消');
                await invoke('component_audio_begin', { liveId: control.live_id, token: control.playback_token });
                bridge = await createSongAudioBridge(audio,
                  (samples, sequence) => invoke('component_audio_push', { liveId: control.live_id, token: control.playback_token, sequence, samples }),
                  error => { void player.stop('error', error); });
                if (song !== currentSong || disposed) { bridge.dispose(); throw new Error('歌曲已取消'); }
              },
              activateAudio: () => bridge?.resume() || Promise.resolve(),
              cleanup: () => bridge?.dispose(),
              observe: observation => {
                void invoke('tts_log_song_observation', { liveId: control.live_id, msgId: `tts-${control.playback_token}-${observation.index}`, observation })
                  .catch(error => { if (!disposed) setStatus(`歌曲同步日志保存失败：${String(error)}`); });
              },
              progress: progress => { void emit('song-sync-progress', { ...control, ...progress }); },
              caption: text => { if (liveIdRef.current === control.live_id) setQueueCaption(text); },
              state: (state, error) => {
                if (state === 'blocked') {
                  resumeSongRef.current = () => player.resume();
                  setResumePlayback(true); setStatus('歌曲等待播放，请点击恢复播放');
                } else if (song === currentSong || !song) {
                  resumeSongRef.current = null;
                }
                if ((state === 'ended' || state === 'error') && song === currentSong) song = undefined;
                void emit('song-playback-state', { ...control, state, error });
              },
            });
            currentSong.player = player;
            await player.start();
          } catch (error) {
            if (song === currentSong) { await stopSong(); await emit('song-playback-state', { ...control, state: 'error', error: String(error) }); }
          }
        }).catch(error => { void emit('song-playback-state', { ...control, state: 'error', error: String(error) }); });
      }));
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
          if (e.payload.enabled) { await stopSong(); whisper.start(); }
          await setMicrophone(e.payload.enabled);
        }).catch(error => { if (!disposed) void reportMic(false, `麦克风操作失败：${String(error)}`); });
      }));
      unlisteners.push(await listen<TranscriptionSignal>('vidu-signal', event => {
        const signal = event.payload;
        if (disposed || signal.live_id !== liveIdRef.current) return;
        if (signal.type === 103 && song?.player) {
          const error = signal.payload?.error || signal.payload;
          if (!error?.msg_id || error.msg_id.startsWith(`tts-${song.identity.playback_token}-`)) {
            void song.player.stop('error', `Vidu 拒绝歌词指令：${error?.error_msg || error?.message || '服务端指令错误'}`);
          }
        }
        // type=9 is the server's recognition of our microphone audio.
        // type=10 is the avatar's reply and must not be labelled as "我".
        if (signal.type === 10 && micRef.current) {
          const text = signal.payload?.text_msg?.content;
          if (text) setQueueCaption('回复：' + text);
        }
        if (signal.type !== 9 || !micRef.current) return;
        const content = signal.payload?.text_msg?.content;
        if (typeof content === 'string' && content.trim()) setMicrophoneCaption(content.trim());
      }));
      unlisteners.push(await listen<{ live_id: string; content: string }>('queue-caption', event => {
        if (disposed || micRef.current || event.payload.live_id !== liveIdRef.current) return;
        if (!song && typeof event.payload.content === 'string') setQueueCaption(event.payload.content.trim());
      }));
      unlisteners.push(await listen<RecognitionTarget>('whisper-task', event => {
        if (disposed || micRef.current || event.payload.live_id !== liveIdRef.current) return;
        if (!song) whisper.start(event.payload);
      }));
      unlisteners.push(await listen<{ live_id: string }>('vidu-disconnected', event => {
        if (event.payload.live_id === liveIdRef.current) { void stopSong().catch(() => {}); setMicrophoneCaption(''); setQueueCaption(''); }
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
      setResumePlayback(vadNeedsResumeRef.current || !!resumeSongRef.current);
      void invoke('playback_frame', { liveId });
      void emit('rtc-playback', { live_id: liveId, playing: true });
    }} />
    <div className="obs-overlay obs-caption-viewport" style={overlayPosition}>
      <ObsCaption content={queueCaption || (microphoneCaption ? `我：${microphoneCaption}` : '')} settings={captionSettings}/>
      {resumePlayback && <button className="obs-status" onClick={() => {
        void resumeSongRef.current?.();
        void Promise.all([...downlinkMonitorsRef.current.values()].map(monitor => monitor.resume())).then(() => {
          vadNeedsResumeRef.current = false; setResumePlayback(!!resumeSongRef.current);
        }).catch(error => setStatus(`音频检测恢复失败：${String(error)}`));
        void videoRef.current?.play().catch(error => setStatus(`恢复播放失败：${String(error)}`));
      }}>恢复播放</button>}
      {status !== '画面已连接' && <div className="obs-status">{status}</div>}
    </div>
  </div>;
}
