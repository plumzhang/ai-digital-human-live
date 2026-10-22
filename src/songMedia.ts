export type SongMode = 'sing' | 'sing_perform' | 'perform' | 'dance';
export type SongMedia = { name: string; data: string; duration?: number; width?: number; height?: number };
export const songAspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export type SongAspectRatio = typeof songAspectRatios[number];

export function closestSongAspectRatio(width: number, height: number): SongAspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('无法读取图片尺寸');
  const ratio = width / height;
  const distance = (candidate: SongAspectRatio) => {
    const [w, h] = candidate.split(':').map(Number);
    return Math.abs(Math.log(ratio / (w / h)));
  };
  return songAspectRatios.reduce((closest, candidate) => distance(candidate) < distance(closest) ? candidate : closest);
}
export const songModes: { value: SongMode; title: string; description: string }[] = [
  { value: 'sing', title: '全程对口型唱歌', description: 'sing · 推荐唱歌使用' },
  { value: 'sing_perform', title: '唱歌与表演交替', description: 'sing_perform · 对口型与表演穿插' },
  { value: 'perform', title: '表演', description: 'perform · 跟随歌曲演绎' },
  { value: 'dance', title: '跳舞', description: 'dance · 跟随歌曲跳舞' },
];

const imageTypes: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' };
const audioTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', m4a: 'audio/mp4' };

export function validateSongFile(file: Pick<File, 'name' | 'size'>, kind: 'portrait' | 'scene' | 'audio'): string {
  const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
  const mime = (kind === 'audio' ? audioTypes : imageTypes)[extension];
  if (!mime || kind === 'scene' && extension === 'bmp') throw new Error(kind === 'audio' ? '请上传 MP3、WAV、AAC 或 M4A 音频' : '请上传 JPG、PNG、WebP 图片' + (kind === 'portrait' ? '或 BMP 图片' : ''));
  const limit = (kind === 'audio' ? 20 : 10) * 1024 * 1024;
  if (file.size <= 0 || file.size >= limit) throw new Error(`文件不能为空，且需小于 ${kind === 'audio' ? 20 : 10} MB`);
  return mime;
}

export function validateSongDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration < 10 || duration > 300) throw new Error('歌声音频时长需为 10～300 秒，请上传包含人声和伴奏的演唱版音频');
}

export function validateSongDimensions(width: number, height: number, kind: 'portrait' | 'scene'): void {
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (!Number.isFinite(ratio) || width <= 0 || height <= 0) throw new Error('无法读取图片尺寸');
  if (kind === 'portrait' && (ratio > 2 || Math.max(width, height) > 4096)) throw new Error('正面照片长宽比需不超过 2，最长边需不超过 4096 像素');
  if (kind === 'scene' && ratio >= 4) throw new Error('场景图片长宽比需小于 4');
}

async function readMetadata(file: File, kind: 'portrait' | 'scene' | 'audio'): Promise<Pick<SongMedia, 'duration' | 'width' | 'height'>> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const media = kind === 'audio' ? document.createElement('audio') : new Image();
      const done = (error?: Error, metadata: Pick<SongMedia, 'duration' | 'width' | 'height'> = {}) => {
        clearTimeout(timeout);
        media.onerror = null;
        if (media instanceof HTMLAudioElement) { media.onloadedmetadata = null; media.removeAttribute('src'); media.load(); }
        else { media.onload = null; media.src = ''; }
        if (error) reject(error); else resolve(metadata);
      };
      const timeout = setTimeout(() => done(new Error('读取媒体文件超时，请更换文件重试')), 15000);
      media.onerror = () => done(new Error('无法读取媒体文件，请确认文件完整且格式正确'));
      if (media instanceof HTMLAudioElement) {
        media.preload = 'metadata';
        media.onloadedmetadata = () => { try { validateSongDuration(media.duration); done(undefined, { duration: media.duration }); } catch (error) { done(error as Error); } };
      } else {
        media.onload = () => { try { validateSongDimensions(media.naturalWidth, media.naturalHeight, kind as 'portrait' | 'scene'); done(undefined, { width: media.naturalWidth, height: media.naturalHeight }); } catch (error) { done(error as Error); } };
      }
      media.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export async function readSongMedia(file: File, kind: 'portrait' | 'scene' | 'audio'): Promise<SongMedia> {
  const mime = validateSongFile(file, kind);
  const metadata = await readMetadata(file, kind);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`data:${mime};base64,${String(reader.result).split(',')[1]}`);
    reader.onerror = () => reject(new Error('读取上传文件失败'));
    reader.onabort = () => reject(new Error('文件读取已取消'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, data, ...metadata };
}

export type Song = {
  id: string; task_id: string | null; title: string; mode: SongMode; region: string;
  avatar_id?: string | null; avatar_name?: string | null;
  resolution: string; aspect_ratio: string; created_at: number; status: string;
  progress: number | null; downloaded_bytes: number; total_bytes: number | null;
  local_path: string | null; error: string | null; available: boolean;
};

export function songStatusText(song: Pick<Song, 'status'>): string {
  return ({ submitting: '正在提交 / 等待确认', submission_unknown: '提交结果待核对', submission_failed: '提交失败', created: '任务已创建', queueing: '排队中', processing: '生成中', downloading: '正在保存到本机', download_failed: '下载失败', success: '已保存到本机', failed: '生成失败' } as Record<string, string>)[song.status] || song.status;
}

export function songProgress(song: Song): number | undefined {
  if (song.status === 'downloading') return song.total_bytes && song.total_bytes > 0 ? Math.min(100, song.downloaded_bytes / song.total_bytes * 100) : undefined;
  if (['created', 'queueing', 'processing'].includes(song.status) && song.progress !== null && Number.isFinite(song.progress)) return Math.max(0, Math.min(100, song.progress));
  return undefined;
}
