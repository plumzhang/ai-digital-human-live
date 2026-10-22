import type { CSSProperties } from 'react';

export type CaptionSettings = {
  x: number; y: number; width: number;
  fontSize: number; fontFamily: 'sans' | 'hei' | 'song' | 'kai'; bold: boolean;
  color: string; align: 'left' | 'center' | 'right'; opacity: number;
  shadow: boolean; shadowColor: string; shadowBlur: number;
  stroke: boolean; strokeColor: string; strokeWidth: number;
  background: boolean; backgroundColor: string; backgroundOpacity: number; padding: number; radius: number;
  entrance: 'fade' | 'slide' | 'zoom' | 'none'; entranceMs: number;
};
export const CAPTION_SETTINGS_KEY = 'obs-caption-settings';
export const defaultCaptionSettings: CaptionSettings = {
  x: 50, y: 50, width: 90, fontSize: 32, fontFamily: 'sans', bold: false,
  color: '#ffffff', align: 'left', opacity: 100,
  shadow: true, shadowColor: '#000000', shadowBlur: 4,
  stroke: false, strokeColor: '#000000', strokeWidth: 2,
  background: false, backgroundColor: '#000000', backgroundOpacity: 45, padding: 16, radius: 12,
  entrance: 'fade', entranceMs: 280,
};
export function normalizeCaptionSettings(raw: unknown): CaptionSettings {
  const result = { ...defaultCaptionSettings };
  if (!raw || typeof raw !== 'object') return result;
  const value = raw as Record<string, unknown>;
  const bounds = { x: [0, 100], y: [0, 100], width: [10, 100], fontSize: [12, 100], opacity: [0, 100], shadowBlur: [0, 24], strokeWidth: [0, 8], backgroundOpacity: [0, 100], padding: [0, 48], radius: [0, 48], entranceMs: [100, 1200] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number)) Object.assign(result, { [key]: Math.round(Math.max(min, Math.min(max, number))) });
  }
  for (const key of ['bold', 'shadow', 'stroke', 'background'] as const) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['color', 'shadowColor', 'strokeColor', 'backgroundColor'] as const) if (typeof value[key] === 'string' && /^#[\da-f]{6}$/i.test(value[key])) result[key] = value[key];
  if (['sans', 'hei', 'song', 'kai'].includes(String(value.fontFamily))) result.fontFamily = value.fontFamily as CaptionSettings['fontFamily'];
  if (['left', 'center', 'right'].includes(String(value.align))) result.align = value.align as CaptionSettings['align'];
  if (['fade', 'slide', 'zoom', 'none'].includes(String(value.entrance))) result.entrance = value.entrance as CaptionSettings['entrance'];
  return result;
}
export function loadCaptionSettings(): CaptionSettings {
  try { return normalizeCaptionSettings(JSON.parse(localStorage.getItem(CAPTION_SETTINGS_KEY) || '{}')); }
  catch { return { ...defaultCaptionSettings }; }
}
export function captionAnchorStyle(settings: CaptionSettings): CSSProperties {
  return { left: `${settings.x}%`, top: `${settings.y}%`, width: `${settings.width}%`, transform: `translate(-${settings.x}%, -${settings.y}%)`, opacity: settings.opacity / 100 };
}
export function captionTextStyle(settings: CaptionSettings): CSSProperties {
  // Both preview and OBS use their video area's width as the same reference.
  const size = (pixels: number) => `${pixels / 10.8}cqw`;
  const fonts = { sans: "'Microsoft YaHei', 'Noto Sans SC', sans-serif", hei: "SimHei, 'Microsoft YaHei', sans-serif", song: 'SimSun, serif', kai: 'KaiTi, STKaiti, serif' };
  const hex = settings.backgroundColor;
  return {
    fontSize: size(settings.fontSize), fontFamily: fonts[settings.fontFamily], fontWeight: settings.bold ? 700 : 400,
    color: settings.color, textAlign: settings.align,
    textShadow: settings.shadow ? `0 ${size(2)} ${size(settings.shadowBlur)} ${settings.shadowColor}` : 'none',
    WebkitTextStroke: settings.stroke ? `${size(settings.strokeWidth)} ${settings.strokeColor}` : '0 transparent', paintOrder: 'stroke fill',
    backgroundColor: settings.background ? `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${settings.backgroundOpacity / 100})` : 'transparent',
    padding: settings.background ? size(settings.padding) : 0, borderRadius: size(settings.radius),
    animationDuration: `${settings.entranceMs}ms`,
  };
}
