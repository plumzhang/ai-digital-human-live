import type { GeneratedReply, HistoryEntry, InteractionTask, ReplyDiversity } from './interactionQueue';
import type { ModelConfig } from './modelConfig';
import { giftActionFor } from './giftActions';

type Planner = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

function replyRequest(task: InteractionTask, history: HistoryEntry[], diversity: ReplyDiversity, draft?: string) {
  return JSON.stringify({ current_event: { type: task.event.type, nickname: task.event.nickname, content: task.event.content, gift: task.event.gift },
    viewer_history: history.map(entry => ({ comment: entry.task.event.content, answer: entry.task.answer?.text })),
    opening_style: diversity.openingStyle, recent_answer_openings: diversity.recentOpenings,
    speech_requirements: '自然变化开场，不沿用最近回答的语气词或前几个字。最近开头仅作风格避重提示，不代表当前观众经历。保留当前观众、问题、礼物名称及数量。只输出最终口播台词。',
    ...(draft ? { rewrite: { draft, reason: '该草稿开头与最近回答重复。改写开头和衔接句式，保留事实、回答含义和主播人设；不要只换昵称、标点或同类叹词，不输出改写说明。' } } : {}),
  });
}

export async function rewriteComponentReply(task: InteractionTask, draft: GeneratedReply, history: HistoryEntry[], diversity: ReplyDiversity, config: ModelConfig, invoke: Planner, liveId: string): Promise<GeneratedReply> {
  const request = replyRequest(task, history, diversity, draft.prepared_reply);
  const prepared = await invoke<string>('component_prepare_reply', { liveId, llm: { base_url: config.baseUrl, key: config.apiKey, model: config.selectedModel, persona: config.persona }, content: request });
  if (typeof prepared !== 'string' || !prepared.trim()) throw new Error('模型未返回有效的改写回答');
  return { ...draft, prepared_reply: prepared.trim(), prepared_for_live: liveId, request };
}

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
  if(task.action_only)return {...plan,generation_mode:'component',speech:task.event.content,prepared_for_live:liveId};
  const request = replyRequest(task, history, diversity);
  const prepared = await invoke<string>('component_prepare_reply', { liveId, llm: { base_url: config.baseUrl, key: config.apiKey, model: config.selectedModel, persona: config.persona }, content: request });
  if (typeof prepared !== 'string' || !prepared.trim()) throw new Error('模型未返回有效的主播回答');
  return { ...plan, generation_mode: 'component', speech: task.event.content, prepared_reply: prepared.trim(), prepared_for_live: liveId, request };
}
