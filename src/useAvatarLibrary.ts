import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAvatarLibrary, saveAvatarLibrary } from './imageStorage';
import { activateProfile, saveProfileInLibrary, type AvatarConfig, type AvatarLibrary, type AvatarProfile } from './avatarProfiles';

export function useAvatarLibrary(legacyConfig: AvatarConfig, onActive: (profile: AvatarProfile) => void) {
  const [library, setLibrary] = useState<AvatarLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const stored = useRef<AvatarLibrary | null>(null);
  const initialConfig = useRef(legacyConfig);
  const activeCallback = useRef(onActive);
  activeCallback.current = onActive;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const pending = useRef(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setLoading(true); setError('');
    void loadAvatarLibrary(initialConfig.current).then(result => {
      if (cancelled) return;
      stored.current = result; setLibrary(result);
      activeCallback.current(result.profiles.find(profile => profile.id === result.activeId)!);
    }).catch(error => { if (!cancelled) setError(`读取数字人列表失败：${String(error instanceof Error ? error.message : error)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [attempt]);

  const commit = useCallback((change: (library: AvatarLibrary) => AvatarLibrary) => {
    pending.current += 1; setSaving(true);
    const task = queue.current.then(async () => {
      const previous = stored.current;
      if (!previous) throw new Error('数字人列表尚未读取完成，请稍后重试');
      const next = change(previous);
      await saveAvatarLibrary(next);
      stored.current = next;
      if (!mounted.current) return;
      setLibrary(next); setError('');
      const active = next.profiles.find(profile => profile.id === next.activeId)!;
      if (active !== previous.profiles.find(profile => profile.id === previous.activeId)) activeCallback.current(active);
    });
    queue.current = task.catch(() => {});
    return task.finally(() => { pending.current -= 1; if (mounted.current) setSaving(pending.current > 0); });
  }, []);

  const saveProfile = (profile: AvatarProfile) => commit(library => saveProfileInLibrary(library, profile));
  const selectProfile = (id: string) => commit(library => activateProfile(library, id));
  const patchProfile = (id: string, patch: Partial<AvatarConfig>) => commit(library => {
    const profile = library.profiles.find(profile => profile.id === id);
    if (!profile) throw new Error('未找到要更新的数字人');
    return saveProfileInLibrary(library, { ...profile, config: { ...profile.config, ...patch, advanced: { ...profile.config.advanced, ...patch.advanced } } });
  });
  const patchActive = (patch: Partial<AvatarConfig>) => {
    const id = stored.current?.activeId;
    return id ? patchProfile(id, patch) : Promise.reject(new Error('数字人列表尚未读取完成'));
  };
  return { library, loading, saving, error, saveProfile, selectProfile, patchProfile, patchActive, retry: () => setAttempt(old => old + 1) };
}
