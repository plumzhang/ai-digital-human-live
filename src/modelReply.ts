import { invoke } from '@tauri-apps/api/core';
import { loadModelConfig, type ModelConfig } from './modelConfig';

type ReplyOptions = {
  liveId: string;
  nickname: string;
  comment: string;
  isCurrent: () => boolean;
  onReply: (text: string, model: string) => void;
};

export async function replyWithSavedModel(options: ReplyOptions): Promise<boolean> {
  const config: ModelConfig = loadModelConfig();
  if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.selectedModel.trim() || !config.persona.trim()) {
    throw new Error('请先在“模型配置”填写 API 地址、Key、模型和固定人设，并点击“保存配置”。');
  }
  const text = await invoke<string>('generate_reply', {
    baseUrl: config.baseUrl, key: config.apiKey, model: config.selectedModel,
    persona: config.persona, nickname: options.nickname, comment: options.comment,
  });
  if (!options.isCurrent()) return false;
  if (!text.trim()) throw new Error('模型返回了空回复，请重试。');
  await invoke('speak_text', { liveId: options.liveId, content: text });
  if (!options.isCurrent()) return false;
  options.onReply(text, config.selectedModel);
  return true;
}
