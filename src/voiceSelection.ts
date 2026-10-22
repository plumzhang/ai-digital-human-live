import { builtinVoices } from './voiceCatalog';

export type ClonedVoice = { voice: string; provider?: string };
export function qwenClonedVoices(voices: ClonedVoice[], providerFor: (voice: string) => string = () => 'qwen_omni'): string[] {
  return voices.filter(voice => (voice.provider || providerFor(voice.voice)) === 'qwen_omni').map(voice => voice.voice);
}

export function normalizeStoredVoice(settings: { voice: string; voiceProvider: 'qwen_omni' | 'doubao'; voiceSource: 'builtin' | 'clone' }): { voice: string; voiceProvider: 'qwen_omni'; voiceSource: 'builtin' | 'clone' } {
  const valid = settings.voiceProvider === 'qwen_omni' && !!settings.voice.trim() && (settings.voiceSource === 'clone' || builtinVoices.some(voice => voice.id === settings.voice));
  return { voice: valid ? settings.voice : 'Tina', voiceProvider: 'qwen_omni', voiceSource: valid ? settings.voiceSource : 'builtin' };
}

export function validateVoiceSelection(settings: { voiceSource: 'builtin' | 'clone'; voice: string; voiceProvider: 'qwen_omni' | 'doubao'; region: 'cn' | 'global' }, clones: string[]): void {
  if (!settings.voice.trim()) throw new Error('请先在“形象设定”选择音色');
  if (settings.voiceProvider !== 'qwen_omni') throw new Error('请在“形象设定”选择千问 qwen_omni 音色后创建数字人');
  if (settings.voiceSource === 'clone') {
    if (!clones.includes(settings.voice)) throw new Error('所选千问克隆音色尚未创建或已删除，请先在“音色克隆”克隆成功后再选择');
    return;
  }
  const voice = builtinVoices.find(item => item.id === settings.voice && item.provider === settings.voiceProvider);
  if (!voice) throw new Error('请选择音色列表中的已有音色，供应商需与音色匹配');
  if (voice.domesticOnly && settings.region !== 'cn') throw new Error('此内置音色仅适用于中国区，请切换 API 地区或重新选择音色');
}
