import type { InteractionTask } from './interactionQueue';

export function formatQueueCaption(task?: InteractionTask): string {
  if (task?.song) return ''; // OBS displays the current timed lyric itself.
  if (!task?.result?.speech.trim() || !task.answer?.text.trim()) return '';
  const line = (value: string) => value.trim().replace(/[\r\n]+/g, ' ');
  return `[${task.event.type === 'gift' ? '礼物' : '弹幕'}] ${line(task.event.nickname)}: ${line(task.event.content)}\n[回复] ${line(task.answer.text)}`;
}
