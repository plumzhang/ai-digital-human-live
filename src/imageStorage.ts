export type SavedAvatarImage = { data: string; name: string };

import { migrateAvatarLibrary, parseAvatarLibrary, type AvatarConfig, type AvatarLibrary } from './avatarProfiles';

import { normalizeStoredVoice } from './voiceSelection';

const databaseName = 'digital-human-live-assets';
const storeName = 'images';
const avatarKey = 'avatar';
const libraryKey = 'avatar-library';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本机图片存储'));
  });
}

export async function loadAvatarImage(): Promise<SavedAvatarImage | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(avatarKey);
      request.onsuccess = () => resolve((request.result as SavedAvatarImage | undefined) || null);
      request.onerror = () => reject(request.error || new Error('读取本机图片失败'));
    });
  } finally { db.close(); }
}

export async function saveAvatarImage(image: SavedAvatarImage | null): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      if (image) transaction.objectStore(storeName).put(image, avatarKey);
      else transaction.objectStore(storeName).delete(avatarKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('保存本机图片失败'));
      transaction.onabort = () => reject(transaction.error || new Error('保存本机图片失败'));
    });
  } finally { db.close(); }
}

export async function loadAvatarLibrary(legacyConfig: AvatarConfig): Promise<AvatarLibrary> {
  const db = await openDatabase();
  try {
    // Read and migrate in one transaction: concurrent startup reads cannot create duplicate cards.
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      let library: AvatarLibrary;
      let failure: unknown;
      store.get(libraryKey).onsuccess = event => {
        try {
          const value = (event.target as IDBRequest).result;
          if (value !== undefined) {
            library = parseAvatarLibrary(value);
            const profiles = library.profiles.map(profile => ({ ...profile, config: { ...profile.config, ...normalizeStoredVoice(profile.config) } }));
            if (profiles.some((profile, index) => JSON.stringify(profile.config) !== JSON.stringify(library.profiles[index].config))) {
              library = { ...library, profiles };
              store.put(library, libraryKey);
            }
          }
          else {
            store.get(avatarKey).onsuccess = event => {
              try {
                library = migrateAvatarLibrary(legacyConfig, (event.target as IDBRequest).result || null);
                store.put(library, libraryKey);
              } catch (error) { failure = error; transaction.abort(); }
            };
          }
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(library);
      transaction.onerror = () => reject(failure || transaction.error || new Error('读取数字人列表失败'));
      transaction.onabort = () => reject(failure || transaction.error || new Error('读取数字人列表失败'));
    });
  } finally { db.close(); }
}

export async function saveAvatarLibrary(library: AvatarLibrary): Promise<void> {
  parseAvatarLibrary(library);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const image = library.profiles.find(profile => profile.id === library.activeId)!.image;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('保存数字人列表失败'));
      transaction.onabort = () => reject(transaction.error || new Error('保存数字人列表失败'));
      try {
        store.put(library, libraryKey);
        if (image) store.put(image, avatarKey); else store.delete(avatarKey);
      } catch (error) { transaction.abort(); reject(error); }
    });
  } finally { db.close(); }
}
