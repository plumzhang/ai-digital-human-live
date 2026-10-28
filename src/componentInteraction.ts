import type { GeneratedReply, HistoryEntry, InteractionTask, ReplyDiversity } from './interactionQueue';
import type { ModelConfig } from './modelConfig';
import { giftActionFor } from './giftActions';

type Planner = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export async function planComponentInteraction(task: InteractionTask, history: HistoryEntry[], diversity: ReplyDiversity, config: ModelConfig, invoke: Planner, liveId: string): Promise<GeneratedReply> {
  const context = history.map(entry => ({ comment: entry.task.event.content, question: entry.task.result?.generation_mode === 'question' ? entry.task.result.speech : undefined, answer: entry.task.answer?.text }));
  // Let the model distinguish questions from requests. A keyword shortlist missed
  // valid requests such as “札一下马尾” and actions outside the shortlist.
  const plan = task.event.type === 'chat' ? await invoke<GeneratedReply>('generate_interaction', {
    baseUrl: config.baseUrl, key: config.apiKey, model: config.selectedModel, persona: config.persona,
    nickname: task.event.nickname, comment: task.event.content, history: context,
    openingStyle: diversity.openingStyle, recentOpenings: diversity.recentOpenings, eventType: 'chat',
  }) : { speech: task.event.content, intent: 'gift' as const, emotion: 'natural', gesture: giftActionFor(task)?.kind || 'none' as const, segments: [] };
  if (plan.intent === 'action_request' && !plan.action_instruction?.trim()) throw new Error('模型识别到动作请求但没有返回动作描述，请重新生成');
  const request = JSON.stringify({ current_event: { type: task.event.type, nickname: task.event.nickname, content: task.event.content, gift: task.event.gift }, viewer_history: context, opening_style: diversity.openingStyle, recent_answer_openings: diversity.recentOpenings });
  const prepared = await invoke<string>('component_prepare_reply', { liveId, llm: { base_url: config.baseUrl, key: config.apiKey, model: config.selectedModel, persona: config.persona }, content: request });
  if (typeof prepared !== 'string' || !prepared.trim()) throw new Error('模型未返回有效的主播回答');
  return { ...plan, generation_mode: 'component', speech: task.event.content, prepared_reply: prepared.trim(), prepared_for_live: liveId, request };
}
