import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import AliRtcEngine, { AliRtcSdkChannelProfile } from 'aliyun-rtc-sdk';

type Snapshot = { live_id: string; rtc: { token: string; user_id: string } };
type MicControl = { enabled: boolean };

export function ObsWindow() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<AliRtcEngine | null>(null);
  const joinedRef = useRef(false);
  const micRef = useRef(false);
  const [status, setStatus] = useState('等待数字人会话');

  useEffect(() => {
    let disposed = false;
    async function reportMic(enabled: boolean, error?: string) {
      micRef.current = enabled;
      await emit('mic-state', { enabled, error });
    }
    async function leave() {
      joinedRef.current = false;
      await emit('rtc-status', { joined: false });
      if (rtcRef.current) {
        try { await rtcRef.current.publishLocalAudioStream(false); } catch { /* closing */ }
        try { await rtcRef.current.leaveChannel(); } catch { /* closing */ }
        rtcRef.current = null;
      }
      if (micRef.current) await reportMic(false);
    }
    async function setMicrophone(enabled: boolean) {
      const rtc = rtcRef.current;
      if (!rtc || !joinedRef.current) {
        await reportMic(false, '播放窗口尚未加入实时会话');
        return;
      }
      try {
        await rtc.publishLocalAudioStream(enabled);
        await reportMic(enabled);
      } catch (error) {
        if (enabled) {
          try { await rtc.publishLocalAudioStream(false); } catch { /* device or permission failure */ }
        }
        await reportMic(micRef.current, `麦克风推流失败：${String(error)}`);
      }
    }
    async function join(snapshot: Snapshot) {
      await leave();
      if (disposed || !snapshot.rtc?.token) return;
      setStatus('正在连接实时画面');
      const rtc = AliRtcEngine.getInstance();
      rtcRef.current = rtc;
      rtc.setChannelProfile(AliRtcSdkChannelProfile.AliRtcSdkCommunication);
      rtc.setAudioOnlyMode(false);
      rtc.setDefaultSubscribeAllRemoteVideoStreams(true);
      rtc.setDefaultSubscribeAllRemoteAudioStreams(true);
      rtc.enableAudioVolumeIndication(500);
      rtc.on('videoSubscribeStateChanged', (uid, _old, next) => {
        if (next === 3 && videoRef.current) {
          rtc.setRemoteViewConfig(videoRef.current, uid, 1);
          setStatus('画面已连接');
        }
      });
      rtc.on('audioVolume', speakers => {
        const speaking = speakers.some(s => s.userId && s.volume > 15);
        void emit('avatar-audio', { speaking, at: Date.now() });
      });
      try {
        await rtc.publishLocalAudioStream(false);
        await rtc.publishLocalVideoStream(false);
        await rtc.joinChannel(snapshot.rtc.token, snapshot.rtc.user_id);
        if (disposed || rtcRef.current !== rtc) { await rtc.leaveChannel(); return; }
        joinedRef.current = true;
        await emit('rtc-status', { joined: true });
        setStatus('已入会，等待数字人画面');
      } catch (error) { setStatus(`RTC 连接失败：${String(error)}`); await emit('rtc-status', { joined: false, error: String(error) }); }
    }
    const unlisteners: Array<() => void> = [];
    void (async () => {
      unlisteners.push(await listen<Snapshot>('session-changed', e => void join(e.payload)));
      unlisteners.push(await listen('session-ended', () => { void leave(); setStatus('直播已结束'); }));
      unlisteners.push(await listen<MicControl>('mic-control', e => void setMicrophone(e.payload.enabled)));
      unlisteners.push(await getCurrentWindow().onCloseRequested(() => { void leave(); }));
      const snapshot = await invoke<Snapshot | null>('session_snapshot');
      if (snapshot) await join(snapshot);
    })().catch(e => setStatus(String(e)));
    return () => { disposed = true; unlisteners.forEach(fn => fn()); void leave(); };
  }, []);

  return <div className="obs-root">
    <video ref={videoRef} autoPlay playsInline className="obs-video" />
    {status !== '画面已连接' && <div className="obs-status">{status}</div>}
  </div>;
}
