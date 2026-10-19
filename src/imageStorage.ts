export type SavedAvatarImage = { data: string; name: string };

const databaseName = 'digital-human-live-assets';
const storeName = 'images';
const avatarKey = 'avatar';

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
