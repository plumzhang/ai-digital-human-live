export type TtsConfig = { base_url: string; key: string; model: string; ref_audio: string; ref_text: string };
export const ttsStorageKey = 'speech-service-config-v1';
export const defaultTtsConfig: TtsConfig = { base_url: 'http://127.0.0.1:8766', key: '', model: 'k2-fsa/OmniVoice', ref_audio: '', ref_text: '' };
export function loadTtsConfig(): TtsConfig {
  try {
    const current = localStorage.getItem(ttsStorageKey);
    // Keep reference recordings/transcripts while retiring the old Qwen endpoint/model.
    const legacy = current ? {} : JSON.parse(localStorage.getItem('qwen3-tts-config') || '{}');
    const saved = current ? JSON.parse(current) : { ref_audio: legacy.ref_audio, ref_text: legacy.ref_text };
    return Object.fromEntries(Object.entries(defaultTtsConfig).map(([key, value]) => [key, typeof saved[key] === 'string' ? saved[key] : value])) as TtsConfig;
  } catch { return { ...defaultTtsConfig }; }
}
