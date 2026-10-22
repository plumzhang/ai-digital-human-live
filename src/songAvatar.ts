import type { AvatarProfile } from './avatarProfiles';
import { validateSongDimensions, type SongMedia } from './songMedia';

export function songAvatarPortrait(profile: AvatarProfile): SongMedia {
  const data = profile.image?.data || profile.config.imageUri.trim();
  if (!data) throw new Error('此数字人尚未设置形象图片，请前往形象设定添加，或上传本次使用的正面近景照片');
  if (data.startsWith('data:')) {
    const match = /^data:image\/(?:jpeg|png|webp|bmp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match || match[1].length % 4 !== 0) throw new Error('数字人的形象图片格式无效，请重新上传 JPG、PNG、WebP 或 BMP 图片');
    const padding = match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0;
    if (match[1].length / 4 * 3 - padding >= 10 * 1024 * 1024) throw new Error('数字人的形象图片需小于 10 MB，请更换较小的正面近景照片');
  } else {
    let url: URL;
    try { url = new URL(data); } catch { throw new Error('数字人的形象图片 URL 无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('形象图片需使用可公开访问的 HTTP(S) 地址');
  }
  return { name: profile.image?.data ? profile.image.name : `${profile.name}的形象图片`, data };
}

export async function loadSongAvatarPortrait(profile: AvatarProfile, signal: AbortSignal): Promise<SongMedia> {
  const media = songAvatarPortrait(profile);
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image.onload = null; image.onerror = null; image.src = '';
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException('图片加载已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('加载数字人图片超时，请重试或上传本次使用的照片')), 15000);
    image.onload = () => {
      try {
        validateSongDimensions(image.naturalWidth, image.naturalHeight, 'portrait');
        media.width = image.naturalWidth; media.height = image.naturalHeight;
        finish();
      }
      catch (error) { finish(error as Error); }
    };
    image.onerror = () => finish(new Error('无法加载此数字人的形象图片，请检查图片地址或上传本次使用的照片'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else image.src = media.data;
  });
  return media;
}
