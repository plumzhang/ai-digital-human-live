import { builtinVoices } from './voiceCatalog';

export function normalizeStoredVoice(settings: { voice: string; voiceProvider: 'qwen_omni' | 'doubao'; voiceSource: 'builtin' | 'clone' }): { voice: string; voiceProvider: 'doubao'; voiceSource: 'builtin' | 'clone' } {
  const valid = settings.voiceProvider === 'doubao' && (settings.voiceSource === 'clone' || builtinVoices.some(voice => voice.id === settings.voice && voice.provider === 'doubao'));
  return { voice: valid ? settings.voice : '', voiceProvider: 'doubao', voiceSource: valid ? settings.voiceSource : 'builtin' };
}

export function validateVoiceSelection(settings: { voiceSource: 'builtin' | 'clone'; voice: string; voiceProvider: 'qwen_omni' | 'doubao'; region: 'cn' | 'global' }, clones: string[]): void {
  if (!settings.voice.trim()) throw new Error('请先在“形象与配置”选择音色');
  if (settings.voiceProvider !== 'doubao') throw new Error('仅支持豆包音色，请在“形象与配置”重新选择后创建数字人');
  if (settings.voiceSource === 'clone') {
    if (!clones.includes(settings.voice)) throw new Error('所选克隆音色尚未创建或已删除，请先在“音色克隆”克隆成功后再选择');
    return;
  }
  const voice = builtinVoices.find(item => item.id === settings.voice && item.provider === settings.voiceProvider);
  if (!voice) throw new Error('请选择音色列表中的已有音色，供应商需与音色匹配');
  if (voice.domesticOnly && settings.region !== 'cn') throw new Error('此豆包内置音色仅适用于中国区，请切换 API 地区或重新选择音色');
}
