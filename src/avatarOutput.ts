export type AvatarOutput = {
  live_id: string; text: string; received_at: number; msg_id?: string; request_id?: string; final?: boolean;
};

export function parseAvatarOutput(signal: unknown, now = Date.now()): AvatarOutput | null {
  if (!signal || typeof signal !== 'object') return null;
  const frame = signal as { type?: unknown; live_id?: unknown; received_at?: unknown; payload?: { text_msg?: { content?: unknown; msg_id?: unknown; request_id?: unknown; reply_to?: unknown; is_final?: unknown; final?: unknown } } };
  const message = frame.payload?.text_msg;
  if (frame.type !== 10 || typeof frame.live_id !== 'string' || !frame.live_id || typeof message?.content !== 'string' || !message.content.trim()) return null;
  const received = frame.received_at === undefined ? now : frame.received_at;
  if (typeof received !== 'number' || !Number.isFinite(received)) return null;
  const final = message.is_final ?? message.final;
  return {
    live_id: frame.live_id, text: message.content.trim().slice(0, 10000), received_at: received,
    msg_id: typeof message.msg_id === 'string' ? message.msg_id : undefined,
    request_id: typeof message.request_id === 'string' ? message.request_id : typeof message.reply_to === 'string' ? message.reply_to : undefined,
    final: typeof final === 'boolean' ? final : undefined,
  };
}

// Accept cumulative transcripts and separate chunks; ignore repeated snapshots.
export function mergeAvatarText(previous: string, incoming: string): string {
  if (!previous || incoming.startsWith(previous)) return incoming.slice(0, 10000);
  if (previous.startsWith(incoming) || previous.endsWith(incoming)) return previous;
  const limit = Math.min(previous.length, incoming.length);
  for (let overlap = limit; overlap > 0; overlap--) {
    if (previous.endsWith(incoming.slice(0, overlap))) return (previous + incoming.slice(overlap)).slice(0, 10000);
  }
  return (previous + incoming).slice(0, 10000);
}
