import type { GiftGesture, InteractionTask } from './interactionQueue';

const gestures: GiftGesture[] = ['heart', 'kiss', 'flying_kiss'];
const labels: Record<GiftGesture, string> = { heart: '比心', kiss: '亲吻手势', flying_kiss: '飞吻' };
export const DEFAULT_GAZE_INSTRUCTION = '目光注视前方，看向镜头。';

export function avatarActionFor(task: InteractionTask): { kind?: GiftGesture; instruction?: string; label: string } | null {
  if (task.event.type === 'gift') return giftActionFor(task);
  if (task.result?.intent !== 'action_request') return { instruction: DEFAULT_GAZE_INSTRUCTION, label: '目光注视前方（看向镜头）' };
  const instruction = task.result.action_instruction?.trim();
  return instruction ? { instruction, label: instruction } : null;
}

export function giftActionFor(task: InteractionTask): { kind: GiftGesture; label: string } | null {
  if (task.event.type !== 'gift') return null;
  const requested = task.result?.gesture;
  // Fixed per task, including imported answers and old snapshots without a
  // gesture. Rendering or restarting must not choose a different action.
  const hash = [...task.event.event_id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const kind = requested && gestures.includes(requested as GiftGesture) ? requested as GiftGesture : gestures[hash % gestures.length];
  return { kind, label: labels[kind] };
}
