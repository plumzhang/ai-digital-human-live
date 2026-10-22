import type { InteractionTask } from '../interactionQueue';

export function TaskDialogue({ task }: { task: InteractionTask }) {
  return <>
    <p className="interaction-reply"><strong>问：</strong>{task.result?.speech || '等待模型优化提问…'}</p>
    <p className="interaction-reply"><strong>答：</strong>{task.answer?.text || (task.status === 'uncertain' ? '尚未收到此槽位的回答文本' : '等待数字人返回回答…')}</p>
  </>;
}
