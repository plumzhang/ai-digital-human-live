import type { InteractionTask } from './interactionQueue';

export function formatQueueCaption(task?: InteractionTask): string {
  if (!task?.result?.speech.trim()) return '';
  const line = (value: string) => value.trim().replace(/[\r\n]+/g, ' ');
  return `[${task.event.type === 'gift' ? '礼物' : '弹幕'}] ${line(task.event.nickname)}: ${line(task.event.content)}\n[回复] ${line(task.result.speech)}`;
}
