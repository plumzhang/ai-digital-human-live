export const LOCAL_PCM_DELAY_KEY = 'danmaku-local-pcm-delay-ms';
export const MAX_LOCAL_PCM_DELAY_MS = 10000;

export function validLocalPcmDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LOCAL_PCM_DELAY_MS;
}
export function loadLocalPcmDelayMs(): number {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_PCM_DELAY_KEY) || '0');
    return validLocalPcmDelay(value) ? value : 0;
  } catch { return 0; }
}
export function saveLocalPcmDelayMs(value: number) {
  if (!validLocalPcmDelay(value)) throw new Error(`播放延迟需为0–${MAX_LOCAL_PCM_DELAY_MS}毫秒的整数`);
  localStorage.setItem(LOCAL_PCM_DELAY_KEY, JSON.stringify(value));
}
