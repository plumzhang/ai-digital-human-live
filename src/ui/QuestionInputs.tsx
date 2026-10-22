import { Ban, Send } from 'lucide-react';
import type { ManualMessageType } from '../manualQuestions';

type Props = {
  question: string; dialogue: string;
  onQuestionChange: (text: string) => void; onDialogueChange: (text: string) => void;
  canSend: boolean; canInterrupt: boolean;
  onSend: (type: ManualMessageType) => void; onInterrupt: () => void;
};

export function QuestionInputs(props: Props) {
  const inputs = [
    { type: 'text_msg' as const, label: '文本消息', value: props.question, change: props.onQuestionChange, hint: '输入文本消息，可让数字人回复或做动作' },
    { type: 'text_dialog' as const, label: '文本对话', value: props.dialogue, change: props.onDialogueChange, hint: '输入对话内容，仅产生回复，不触发动作' },
  ];
  return <>
    {inputs.map(input => <div key={input.type} className="manual-line" style={{ marginBottom: 16 }}>
      <label style={{ flex: 1 }}>{input.label} <code>{input.type}</code>
        <input value={input.value} onChange={event => input.change(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && props.canSend && input.value.trim()) { event.preventDefault(); props.onSend(input.type); } }}
          placeholder={input.hint}/>
      </label>
      <button type="button" className="primary" disabled={!props.canSend || !input.value.trim()} onClick={() => props.onSend(input.type)}><Send size={16}/> 发送{input.label}</button>
    </div>)}
    <div className="button-row"><button type="button" className="danger" disabled={!props.canInterrupt} onClick={props.onInterrupt}><Ban size={16}/> 打断</button></div>
  </>;
}
