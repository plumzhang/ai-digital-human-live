export type ManualQuestion = {
  id: number;
  live_id: string;
  content: string;
  status: 'waiting' | 'playing' | 'uncertain';
  error?: string;
};

type Adapter = {
  holdPlayback: (held: boolean) => void;
  canStart: (quietMs?: number) => boolean;
  send: (content: string, liveId: string) => Promise<void>;
  changed: (questions: ManualQuestion[]) => void;
  error: (message: string) => void;
  now?: () => number;
};

// Operator questions reserve the gap between interaction replies. Their answer
// is generated and sent locally, so completion waits for sending and healthy silence
// rather than matching a pre-generated script.
export class ManualQuestions {
  private questions: ManualQuestion[] = [];
  private sequence = 0;
  private sending = false;
  private startedAt = 0;
  private heardSpeech = false;
  private sentAt = 0;

  constructor(private adapter: Adapter) {}
  private now() { return this.adapter.now?.() ?? Date.now(); }
  private publish() {
    this.adapter.holdPlayback(this.questions.length > 0);
    this.adapter.changed(this.questions.map(question => ({ ...question })));
  }
  enqueue(content: string, liveId: string) {
    if (!content.trim() || !liveId) return;
    this.questions.push({ id: ++this.sequence, live_id: liveId, content: content.trim(), status: 'waiting' });
    this.publish();
  }
  observeSpeech(liveId: string) {
    const current = this.questions[0];
    if (current?.status === 'playing' && current.live_id === liveId) this.heardSpeech = true;
  }
  cancel() {
    this.questions = [];
    this.heardSpeech = false;
    this.publish();
  }
  confirm() {
    if (this.questions[0]?.status !== 'uncertain') return;
    this.questions.shift();
    this.publish();
  }
  async tick(liveId: string, ready: boolean) {
    if (this.questions.some(question => !ready || question.live_id !== liveId)) this.cancel();
    const current = this.questions[0];
    if (!current || this.sending || current.status === 'uncertain') return;
    if (current.status === 'playing') {
      if (this.heardSpeech && this.now() - this.sentAt >= 1500 && this.adapter.canStart(2500)) {
        this.questions.shift();
        this.publish();
      } else if (this.now() - this.startedAt >= 60_000) {
        current.status = 'uncertain';
        current.error = '手动回答尚未确认结束，请确认完成或打断后再继续';
        this.publish();
      }
      return;
    }
    if (!this.adapter.canStart()) return;
    this.sending = true;
    this.startedAt = this.now(); this.heardSpeech = false;
    current.status = 'playing';
    this.publish();
    try {
      await this.adapter.send(current.content, current.live_id);
      this.sentAt = this.now();
    } catch (error) {
      if (this.questions[0] === current) {
        // A transport failure can occur after the instruction was delivered.
        // Keep the reservation until the operator resolves that uncertainty.
        current.status = 'uncertain'; current.error = `手动提问发送未确认：${String(error)}`;
        this.adapter.error(current.error);
        this.publish();
      }
    } finally { this.sending = false; }
  }
}
