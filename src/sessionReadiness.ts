// A window may mount after the one-shot initialization ack. Read readiness
// from the owned native session, discarding reads made before newer events.
export class SessionSnapshotSync<T> {
  private version = 0;
  private reading = false;
  private disposed = false;
  constructor(private read: () => Promise<T | null>, private apply: (snapshot: T | null) => void, private failed: (error: unknown) => void) {}
  invalidate() { this.version++; }
  dispose() { this.disposed = true; this.invalidate(); }
  async refresh() {
    if (this.disposed || this.reading) return;
    this.reading = true;
    const version = this.version;
    try {
      const snapshot = await this.read();
      if (!this.disposed && version === this.version) this.apply(snapshot);
    } catch (error) { if (!this.disposed && version === this.version) this.failed(error); }
    finally { this.reading = false; }
  }
}

export function queueWaitingReason(state: {
  hasSession: boolean; creating: boolean; controlReady: boolean; rtcJoined: boolean;
  auto: boolean; micEnabled: boolean; micPending: boolean; occupied: boolean;
}): string | undefined {
  if (!state.hasSession) return state.creating ? '正在创建数字人会话…' : '等待启动数字人…';
  if (!state.controlReady) return '等待 Vidu 控制连接初始化确认…';
  if (!state.rtcJoined) return '等待 OBS 播放窗口加入实时会话…';
  if (state.micPending) return '等待麦克风切换完成…';
  if (state.micEnabled) return '麦克风识别已开启，弹幕自动回答暂停…';
  if (!state.auto) return '等待开启“自动回答弹幕”…';
  if (state.occupied) return '等待当前手动提问处理完成…';
  return undefined;
}
