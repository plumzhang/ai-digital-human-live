import type { InteractionTask } from '../interactionQueue';

export function TaskDialogue({ task, waitingReason }: { task: InteractionTask; waitingReason?: string }) {
  return <>
    <p className="interaction-reply"><strong>问：</strong>{task.event?.content || task.result?.speech || '等待互动…'}</p>
    <p className="interaction-reply"><strong>答：</strong>{task.action_only ? '唱词期间仅处理动作，不发送弹幕语音' : task.generation_note || task.result?.prepared_reply || task.answer?.text || (task.status === 'uncertain' ? '尚未收到此槽位的回答文本' : waitingReason || '等待后台生成回答…')}</p>
    {task.result?.prepared_reply && !task.action_only && !task.generation_note && task.status !== 'uncertain' && <p className="hint">{task.prepared_audio?.state === 'ready' ? `声音已就绪${task.prepared_audio.duration_ms ? ` · ${(task.prepared_audio.duration_ms / 1000).toFixed(1)}秒` : ''}` : task.prepared_audio?.state === 'preparing' ? '正在预合成声音…' : '回答已生成，等待声音预合成'}</p>}
  </>;
}
