import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import AliRtcEngine, { AliRtcSdkChannelProfile } from 'aliyun-rtc-sdk';

type Snapshot = { live_id: string; rtc: { token: string; user_id: string } };
type MediaControl = { enabled: boolean };
type MediaKind = 'audio' | 'video';

export function ObsWindow() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<AliRtcEngine | null>(null);
  const joinedRef = useRef(false);
  const micRef = useRef(false);
  const cameraRef = useRef(false);
  const liveIdRef = useRef<string | null>(null);
  const lastFrameRef = useRef({ time: -1, reportedAt: 0 });
  const [status, setStatus] = useState('等待数字人会话');
  const [resumePlayback, setResumePlayback] = useState(false);

  useEffect(() => {
    let disposed = false;
    let detachRtcListeners: (() => void) | null = null;
    async function reportMic(enabled: boolean, error?: string) {
      micRef.current = enabled;
      await emit('mic-state', { enabled, error });
    }
    async function reportCamera(enabled: boolean, error?: string) {
      cameraRef.current = enabled;
      await emit('camera-state', { enabled, error });
    }
    async function leave() {
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
      if (cameraRef.current) await reportCamera(false);
    }
    async function setMicrophone(enabled: boolean) {
      const rtc = rtcRef.current;
      if (!rtc || !joinedRef.current) {
        await reportMic(false, '播放窗口尚未加入实时会话');
        return;
      }
      try {
        if (enabled) await rtc.startAudioCapture();
        await rtc.publishLocalAudioStream(enabled);
        if (!enabled) rtc.stopAudioCapture();
        if (disposed || rtcRef.current !== rtc || !joinedRef.current) {
          if (enabled) { await rtc.publishLocalAudioStream(false); rtc.stopAudioCapture(); }
          return;
        }
        await reportMic(enabled);
      } catch (error) {
        if (enabled) {
          try { await rtc.publishLocalAudioStream(false); } catch { /* device or permission failure */ }
          try { rtc.stopAudioCapture(); } catch { /* device or permission failure */ }
        }
        await reportMic(micRef.current, `麦克风推流失败：${String(error)}`);
      }
    }
    async function setCamera(enabled: boolean) {
      const rtc = rtcRef.current;
      if (!rtc || !joinedRef.current) {
        await reportCamera(false, '播放窗口尚未加入实时会话');
        return;
      }
      try {
        if (enabled) await rtc.enableLocalVideo(true);
        await rtc.publishLocalVideoStream(enabled);
        if (!enabled) await rtc.enableLocalVideo(false);
        if (disposed || rtcRef.current !== rtc || !joinedRef.current) {
          if (enabled) {
            await rtc.publishLocalVideoStream(false);
            await rtc.enableLocalVideo(false);
          }
          return;
        }
        await reportCamera(enabled);
      } catch (error) {
        if (enabled) {
          try { await rtc.publishLocalVideoStream(false); } catch { /* device or permission failure */ }
          try { await rtc.enableLocalVideo(false); } catch { /* device or permission failure */ }
        }
        await reportCamera(false, `摄像头推流失败：${String(error)}`);
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
      rtc.enableAudioVolumeIndication(500);
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
      };
      const onAudioVolume = (speakers: { userId: string; volume: number }[]) => {
        const speaking = speakers.some(s => s.userId && s.volume > 15);
        void emit('avatar-audio', { speaking, at: Date.now() });
      };
      rtc.on('videoSubscribeStateChanged', onVideoSubscribe);
      rtc.on('audioSubscribeStateChanged', onAudioSubscribe);
      rtc.on('audioVolume', onAudioVolume);
      rtc.on('remoteVideoAutoPlayFail', onAutoplayFailed);
      rtc.on('remoteAudioAutoPlayFail', onAutoplayFailed);
      rtc.on('remoteVideoPlayError', onVideoPlayError);
      detachRtcListeners = () => {
        rtc.off('videoSubscribeStateChanged', onVideoSubscribe);
        rtc.off('audioSubscribeStateChanged', onAudioSubscribe);
        rtc.off('audioVolume', onAudioVolume);
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
        void setMicrophone(true);
        void setCamera(true);
      } catch (error) { await leave(); setStatus(`RTC 连接失败：${String(error)}`); await emit('rtc-status', { live_id: snapshot.live_id, joined: false, error: String(error) }); }
    }
    // Events and the startup snapshot can describe the same session. Serialize
    // them so one join cannot destroy another join's engine or listeners.
    let operations = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
      operations = operations.then(() => disposed ? undefined : operation()).catch(error => setStatus(String(error)));
    };
    const unlisteners: Array<() => void> = [];
    void (async () => {
      unlisteners.push(await listen<Snapshot>('session-changed', e => enqueue(() => join(e.payload))));
      unlisteners.push(await listen('session-ended', () => enqueue(async () => { await leave(); setStatus('直播已结束'); })));
      unlisteners.push(await listen<MediaControl>('mic-control', e => void setMicrophone(e.payload.enabled)));
      unlisteners.push(await listen<MediaControl>('camera-control', e => void setCamera(e.payload.enabled)));
      const snapshot = await invoke<Snapshot | null>('session_snapshot');
      if (snapshot) enqueue(() => join(snapshot));
    })().catch(e => setStatus(String(e)));
    return () => { disposed = true; unlisteners.forEach(fn => fn()); void operations.finally(leave); };
  }, []);

  return <div className="obs-root">
    <video ref={videoRef} autoPlay playsInline className="obs-video" onTimeUpdate={event => {
      const video = event.currentTarget;
      const liveId = liveIdRef.current;
      const now = Date.now();
      if (!liveId || !video.videoWidth || video.paused || video.currentTime === lastFrameRef.current.time || now - lastFrameRef.current.reportedAt < 1000) return;
      lastFrameRef.current = { time: video.currentTime, reportedAt: now };
      setStatus('画面已连接');
      setResumePlayback(false);
      void invoke('playback_frame', { liveId });
      void emit('rtc-playback', { live_id: liveId, playing: true });
    }} />
    {resumePlayback && <button className="obs-status" onClick={() => void videoRef.current?.play().catch(error => setStatus(`恢复播放失败：${String(error)}`))}>恢复播放</button>}
    {status !== '画面已连接' && <div className="obs-status">{status}</div>}
  </div>;
}
