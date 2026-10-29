export type DouyinEvent = { id: string; roomId: string; type: string; [key: string]: unknown };
export type DouyinStatus = { connection_id: string; room_id: string; status: string; message: string; terminal: boolean };
type Detach = () => void;
type Adapter = {
  listen<T>(channel: string, callback: (payload: T) => void): Promise<Detach>;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  uuid(): string;
};
type Active = { id: string; detach: Detach[] };

// Attach listeners before opening the room so the first chat/status cannot be lost.
export class DouyinConnection {
  private active?: Active;
  private generation = 0;
  constructor(private adapter: Adapter, private event: (event: DouyinEvent) => void, private status: (status: DouyinStatus) => void) {}

  async start(roomId: string): Promise<string | undefined> {
    const generation = ++this.generation;
    await this.release();
    if (generation !== this.generation) return;
    const active: Active = { id: this.adapter.uuid(), detach: [] };
    this.active = active;
    const attach = async <T>(channel: string, handler: (payload: T) => void) => {
      const detach = await this.adapter.listen<T>(channel, handler);
      if (this.active === active) active.detach.push(detach);
      else detach();
    };
    try {
      await Promise.all([
        attach<{ connection_id: string; event: DouyinEvent }>('douyin-event', payload => {
          if (this.active === active && payload.connection_id === active.id) this.event(payload.event);
        }),
        attach<DouyinStatus>('douyin-status', payload => {
          if (this.active === active && payload.connection_id === active.id) this.status(payload);
        }),
      ]);
      if (this.active !== active) return;
      const result = await this.adapter.invoke<{ room_id: string }>('douyin_connect', { roomId, connectionId: active.id });
      if (this.active === active) return result.room_id;
    } catch (error) {
      if (this.active === active) await this.stop().catch(() => {});
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    await this.release();
  }

  private async release(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    active.detach.forEach(detach => detach());
    await this.adapter.invoke('douyin_disconnect', { connectionId: active.id });
  }
}
