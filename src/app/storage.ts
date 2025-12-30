import { v4 as uuidv4 } from 'uuid';
import type { AppConfig, TaskConfig } from '../types/app';
import type { GlobalStats } from '../types/stats';
import { safeStorageGet, safeStorageRemove } from '../utils/storage';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';

export const STORAGE_KEYS = {
  config: 'moe-image-config',
  tasks: 'moe-image-tasks',
  globalStats: 'moe-image-global-stats',
};

const TASK_STORAGE_PREFIX = 'moe-image-task:';

const DEFAULT_CONFIG: AppConfig = {
  apiUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  stream: false,
};

const DEFAULT_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};

export const loadConfig = (): AppConfig => {
  const raw = safeStorageGet(STORAGE_KEYS.config, 'app cache');
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const data = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...data };
  } catch (err) {
    console.warn('Failed to parse config cache:', err);
    return { ...DEFAULT_CONFIG };
  }
};

export const loadGlobalStats = (): GlobalStats => {
  const raw = safeStorageGet(STORAGE_KEYS.globalStats, 'app cache');
  if (!raw) return { ...DEFAULT_GLOBAL_STATS };
  try {
    const data = JSON.parse(raw);
    return { ...DEFAULT_GLOBAL_STATS, ...data };
  } catch (err) {
    console.warn('Failed to parse stats cache:', err);
    return { ...DEFAULT_GLOBAL_STATS };
  }
};

export const loadTasks = (): TaskConfig[] => {
  const raw = safeStorageGet(STORAGE_KEYS.tasks, 'app cache');
  if (!raw) return [{ id: uuidv4(), prompt: '' }];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [{ id: uuidv4(), prompt: '' }];
    }
    const uniqueIds = Array.from(
      new Set(data.filter((item: unknown) => typeof item === 'string')),
    );
    if (uniqueIds.length === 0) {
      return [{ id: uuidv4(), prompt: '' }];
    }
    return uniqueIds.map((id) => ({ id, prompt: '' }));
  } catch (err) {
    console.warn('Failed to parse tasks cache:', err);
    return [{ id: uuidv4(), prompt: '' }];
  }
};

export const getTaskStorageKey = (id: string) => `${TASK_STORAGE_PREFIX}${id}`;

const getTaskImageKeys = (storageKey: string) => {
  const raw = safeStorageGet(storageKey, 'app cache');
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as {
      results?: Array<{ id?: string; localKey?: string }>;
      uploads?: Array<{ localKey?: string }>;
    };
    const resultKeys = Array.isArray(data?.results)
      ? data.results
          .map((item) => item?.localKey || item?.id)
          .filter((key): key is string => typeof key === 'string')
      : [];
    const uploadKeys = Array.isArray(data?.uploads)
      ? data.uploads
          .map((item) => item?.localKey)
          .filter((key): key is string => typeof key === 'string')
      : [];
    return Array.from(new Set([...resultKeys, ...uploadKeys]));
  } catch (err) {
    console.warn('Failed to parse task cache for cleanup:', err);
    return [];
  }
};

const deleteImageBlobs = async (keys: string[]) => {
  if (keys.length === 0 || typeof indexedDB === 'undefined') return;
  try {
    const db = await openImageDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      keys.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Failed to remove image cache:', err);
  }
};

export const cleanupTaskCache = async (storageKey: string) => {
  const keys = getTaskImageKeys(storageKey);
  await deleteImageBlobs(keys);
  safeStorageRemove(storageKey, 'app cache');
};
