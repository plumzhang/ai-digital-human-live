import { Ban, Send } from 'lucide-react';

type Props = {
  question: string;
  onQuestionChange: (text: string) => void;
  canSend: boolean; canInterrupt: boolean;
  onSend: () => void; onInterrupt: () => void;
};

export function QuestionInputs(props: Props) {
  return <>
    <div className="manual-line" style={{ marginBottom: 16 }}>
      <label style={{ flex: 1 }}>文本消息
        <input value={props.question} onChange={event => props.onQuestionChange(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && props.canSend && props.question.trim()) { event.preventDefault(); props.onSend(); } }}
          placeholder="输入文本消息，可让数字人回复或做动作"/>
      </label>
      <button type="button" className="primary" disabled={!props.canSend || !props.question.trim()} onClick={props.onSend}><Send size={16}/> 发送文本消息</button>
    </div>
    <div className="button-row"><button type="button" className="danger" disabled={!props.canInterrupt} onClick={props.onInterrupt}><Ban size={16}/> 打断</button></div>
  </>;
}
