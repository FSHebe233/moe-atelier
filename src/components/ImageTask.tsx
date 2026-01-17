import React, { useState, useRef, useEffect } from 'react';
import { 
  Input, Button, Upload, message, Spin, Image,
  Space, Typography, Tooltip, Progress, Modal
} from 'antd';
import {
  UploadOutlined, DeleteFilled, ReloadOutlined,
  BellFilled, BellOutlined, DownloadOutlined, PictureFilled,
  CloseCircleFilled, PauseCircleFilled, FireFilled,
  StarFilled,
  LoadingOutlined,
  PlayCircleFilled,
  HolderOutlined,
  SnippetsOutlined
} from '@ant-design/icons';
import type { RcFile, UploadFile } from 'antd/es/upload/interface';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../types/app';
import type { TaskStats } from '../types/stats';
import type {
  PersistedImageTaskState,
  PersistedSubTaskResult,
  SubTaskResult,
  PersistedUploadImage,
} from '../types/imageTask';
import type { CollectionItem } from '../types/collection';
import { DEFAULT_TASK_STATS, loadTaskState, saveTaskState, serializeResults, TASK_STATE_VERSION } from './imageTaskState';
import { getBase64 } from '../utils/file';
import { parseMarkdownImage, resolveImageFromResponse } from '../utils/imageResponse';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';
import {
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from '../utils/apiUrl';
import { calculateSuccessRate, formatDuration } from '../utils/stats';
import {
  buildBackendImageUrl,
  fetchBackendTask,
  generateBackendTask,
  getBackendToken,
  patchBackendTask,
  retryBackendSubTask,
  stopBackendSubTask,
  uploadBackendImage,
  stripBackendToken,
} from '../utils/backendApi';

const { Text } = Typography;
const { TextArea } = Input;

interface ImageTaskProps {
  id: string;
  storageKey: string;
  config: AppConfig;
  backendMode: boolean;
  onRemove: () => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
  onCollect?: (item: CollectionItem) => void;
  collectionRevision?: number;
  dragAttributes?: any;
  dragListeners?: any;
}
const SUCCESS_AUDIO_SRC = 'https://actions.google.com/sounds/v1/cartoon/magic_chime.ogg';
const DEFAULT_CONCURRENCY = 2;

type UploadFileWithMeta = UploadFile & {
  localKey?: string;
  lastModified?: number;
  fromCollection?: boolean;
  sourceSignature?: string;
};

const normalizeStoredResult = (item: PersistedSubTaskResult, backendMode: boolean): SubTaskResult => {
  const wasLoading = item.status === 'loading' || item.status === 'pending';
  const shouldMarkInterrupted = wasLoading && !backendMode;
  return {
    id: item.id,
    status: shouldMarkInterrupted ? 'error' : item.status,
    error: shouldMarkInterrupted ? '刷新后已中断' : item.error,
    retryCount: typeof item.retryCount === 'number' ? item.retryCount : 0,
    startTime: item.startTime,
    endTime: item.endTime,
    duration: item.duration,
    localKey: item.localKey,
    sourceUrl: item.sourceUrl,
    savedLocal: item.savedLocal,
    displayUrl: item.localKey ? undefined : item.sourceUrl,
  };
};

const serializeUploads = (uploads: UploadFileWithMeta[]): PersistedUploadImage[] =>
  uploads
    .filter((file) => file.localKey)
    .map((file) => ({
      uid: file.uid,
      name: file.name,
      type: file.type || file.originFileObj?.type,
      size: file.size ?? file.originFileObj?.size,
      lastModified: file.lastModified ?? file.originFileObj?.lastModified,
      localKey: file.localKey as string,
      fromCollection: file.fromCollection,
      sourceSignature: file.sourceSignature,
    }));

const normalizeUploadsPayload = (uploads: PersistedUploadImage[] = []) =>
  uploads.map((item) => ({
    uid: item.uid,
    name: item.name,
    type: item.type,
    size: item.size,
    lastModified: item.lastModified,
    localKey: item.localKey,
    fromCollection: item.fromCollection,
    sourceSignature: item.sourceSignature,
  }));

const normalizeConcurrency = (value: unknown, fallback = DEFAULT_CONCURRENCY) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const ImageTask: React.FC<ImageTaskProps> = ({ id, storageKey, config, backendMode, onRemove, onStatsUpdate, onCollect, collectionRevision, dragAttributes, dragListeners }: ImageTaskProps) => {
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef(prompt);
  const promptDirtyRef = useRef(false);
  const promptFocusedRef = useRef(false);
  const [fileList, setFileList] = useState<UploadFileWithMeta[]>([]);
  const [tempFileList, setTempFileList] = useState<UploadFile[]>([]);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [concurrency, setConcurrency] = useState<number>(DEFAULT_CONCURRENCY);
  const [concurrencyInput, setConcurrencyInput] = useState<string>(String(DEFAULT_CONCURRENCY));
  const [enableSound, setEnableSound] = useState<boolean>(true);
  
  const [results, setResults] = useState<SubTaskResult[]>([]);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [stats, setStats] = useState<TaskStats>({ ...DEFAULT_TASK_STATS });
  const [hydrated, setHydrated] = useState(false);
  
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const isRetryingRef = useRef<Map<string, boolean>>(new Map());
  const taskStartTimesRef = useRef<Map<string, number>>(new Map());
  const retryTimersRef = useRef<Map<string, number>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevResultsRef = useRef<SubTaskResult[]>([]);
  const dbPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());
  const uploadKeysRef = useRef<Map<string, string>>(new Map());
  const cachedUploadKeysRef = useRef<Set<string>>(new Set());
  const backendPersistTimerRef = useRef<number | null>(null);
  const backendLastPayloadRef = useRef<string>('');
  const collectedCollectionKeysRef = useRef<Set<string>>(new Set());
  const lastCollectionRevisionRef = useRef(collectionRevision);

  const withBackendToken = (url: string) => {
    const cleaned = stripBackendToken(url);
    const token = getBackendToken();
    if (!token) return cleaned;
    return cleaned.includes('?')
      ? `${cleaned}&token=${encodeURIComponent(token)}`
      : `${cleaned}?token=${encodeURIComponent(token)}`;
  };

  const resolveBackendDisplayUrl = (localKey?: string, sourceUrl?: string) => {
    if (localKey) {
      return buildBackendImageUrl(localKey);
    }
    if (sourceUrl) {
      return sourceUrl.includes('/api/backend/image/')
        ? withBackendToken(sourceUrl)
        : sourceUrl;
    }
    return undefined;
  };

  const extractBackendImageKey = (url?: string) => {
    if (!url) return undefined;
    const match = url.match(/\/api\/backend\/image\/([^?]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  };

  const applyBackendTaskState = (
    stored: PersistedImageTaskState,
    options: { preserveUploads?: boolean; preservePrompt?: boolean } = {},
  ) => {
    const nextPrompt = stored.prompt ?? '';
    const currentPrompt = promptRef.current;
    const shouldPreservePrompt =
      options.preservePrompt ||
      promptFocusedRef.current ||
      (promptDirtyRef.current && nextPrompt !== currentPrompt);
    const nextConcurrency = normalizeConcurrency(stored.concurrency, DEFAULT_CONCURRENCY);
    const nextEnableSound = typeof stored.enableSound === 'boolean' ? stored.enableSound : true;
    const storedUploads = Array.isArray(stored.uploads) ? stored.uploads : [];
    backendLastPayloadRef.current = JSON.stringify({
      prompt: nextPrompt,
      concurrency: nextConcurrency,
      enableSound: nextEnableSound,
      uploads: normalizeUploadsPayload(storedUploads),
    });

    if (!shouldPreservePrompt) {
      promptRef.current = nextPrompt;
      promptDirtyRef.current = false;
      setPrompt(nextPrompt);
    } else if (nextPrompt === currentPrompt) {
      promptDirtyRef.current = false;
    }
    setConcurrency(nextConcurrency);
    setConcurrencyInput(String(nextConcurrency));
    setEnableSound(nextEnableSound);
    setStats({ ...DEFAULT_TASK_STATS, ...(stored.stats || {}) });

    const storedResults = Array.isArray(stored.results) ? stored.results : [];
    const hydratedResults = storedResults.map((item) => {
      const normalized = normalizeStoredResult(item, true);
      if (normalized.sourceUrl && normalized.sourceUrl.includes('/api/backend/image/')) {
        normalized.sourceUrl = stripBackendToken(normalized.sourceUrl);
      }
      normalized.displayUrl = resolveBackendDisplayUrl(
        normalized.localKey,
        normalized.sourceUrl,
      );
      return normalized;
    });
    setResults(hydratedResults);

    if (!options.preserveUploads) {
      const hydratedUploads: UploadFileWithMeta[] = storedUploads.map((item) => {
        const signature =
          item.sourceSignature ||
          buildUploadSignature({
            uid: item.uid,
            name: item.name,
            size: item.size,
            lastModified: item.lastModified,
            type: item.type,
          } as UploadFileWithMeta);
        return {
          uid: item.uid,
          name: item.name,
          status: 'done',
          size: item.size,
          type: item.type,
          lastModified: item.lastModified,
          localKey: item.localKey,
          thumbUrl: item.localKey ? buildBackendImageUrl(item.localKey) : undefined,
          fromCollection: item.fromCollection,
          sourceSignature: signature || item.sourceSignature,
        };
      });
      setFileList(hydratedUploads);
    }
  };

  useEffect(() => {
    let isActive = true;
    const hydrate = async () => {
      if (backendMode) {
        objectUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
        objectUrlMapRef.current.clear();
        try {
          const stored = await fetchBackendTask(id);
          if (stored && isActive) {
            applyBackendTaskState(stored);
          }
        } catch (err) {
          console.warn('后端任务初始化失败:', err);
        }
        if (isActive) {
          setHydrated(true);
        }
        return;
      }

      const stored = loadTaskState(storageKey);
      if (stored) {
        setPrompt(stored.prompt ?? '');
        const nextConcurrency = normalizeConcurrency(stored.concurrency, DEFAULT_CONCURRENCY);
        setConcurrency(nextConcurrency);
        setConcurrencyInput(String(nextConcurrency));
        setEnableSound(typeof stored.enableSound === 'boolean' ? stored.enableSound : true);
        setStats({ ...DEFAULT_TASK_STATS, ...(stored.stats || {}) });
        const storedResults = Array.isArray(stored.results) ? stored.results : [];
        const hydratedResults: SubTaskResult[] = [];
        for (const item of storedResults) {
          const normalized = normalizeStoredResult(item, false);
          if (normalized.localKey) {
            const blob = await getImageBlob(normalized.localKey);
            if (blob) {
              const objectUrl = URL.createObjectURL(blob);
              normalized.displayUrl = objectUrl;
              registerObjectUrl(normalized.id, objectUrl);
            } else if (normalized.sourceUrl) {
              normalized.displayUrl = normalized.sourceUrl;
            }
          } else if (normalized.sourceUrl) {
            normalized.displayUrl = normalized.sourceUrl;
          }
          hydratedResults.push(normalized);
        }
        if (isActive) {
          setResults(hydratedResults);
        }
        const storedUploads = Array.isArray(stored.uploads) ? stored.uploads : [];
        if (storedUploads.length > 0) {
          const hydratedUploads: UploadFileWithMeta[] = [];
          for (const item of storedUploads) {
            if (!item?.localKey) continue;
            const blob = await getImageBlob(item.localKey);
            if (!blob) continue;
            const rawFile = new File([blob], item.name, {
              type: item.type || blob.type || 'application/octet-stream',
              lastModified: item.lastModified || Date.now(),
            });
            const rcFile = rawFile as RcFile;
            const objectUrl = URL.createObjectURL(blob);
            registerObjectUrl(item.localKey, objectUrl);
            cachedUploadKeysRef.current.add(item.localKey);
            const signature =
              item.sourceSignature ||
              buildUploadSignature({
                uid: item.uid,
                name: item.name,
                size: item.size ?? rcFile.size,
                lastModified: item.lastModified ?? rcFile.lastModified,
                type: item.type ?? rcFile.type,
              } as UploadFileWithMeta);
            hydratedUploads.push({
              uid: item.uid,
              name: item.name,
              status: 'done',
              size: item.size ?? rcFile.size,
              type: item.type ?? rcFile.type,
              lastModified: item.lastModified ?? rcFile.lastModified,
              originFileObj: rcFile,
              thumbUrl: objectUrl,
              localKey: item.localKey,
              fromCollection: item.fromCollection,
              sourceSignature: signature || item.sourceSignature,
            });
          }
          if (isActive) {
            setFileList(hydratedUploads);
          }
        }
      }
      if (isActive) {
        setHydrated(true);
      }
    };
    void hydrate();
    return () => {
      isActive = false;
    };
  }, [storageKey, backendMode, id]);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    audioRef.current = new Audio(SUCCESS_AUDIO_SRC);
    return () => {
      abortControllersRef.current.forEach((controller: AbortController) => controller.abort());
      retryTimersRef.current.forEach((timerId: number) => clearTimeout(timerId));
      retryTimersRef.current.clear();
      objectUrlMapRef.current.forEach((url: string) => URL.revokeObjectURL(url));
      objectUrlMapRef.current.clear();
      taskStartTimesRef.current.clear();
      if (backendPersistTimerRef.current) {
        clearTimeout(backendPersistTimerRef.current);
        backendPersistTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hydrated || backendMode) return;
    const payload: PersistedImageTaskState = {
      version: TASK_STATE_VERSION,
      prompt,
      concurrency,
      enableSound,
      results: serializeResults(results),
      uploads: serializeUploads(fileList),
      stats,
    };
    saveTaskState(storageKey, payload);
  }, [prompt, concurrency, enableSound, results, stats, storageKey, hydrated, fileList, backendMode]);

  useEffect(() => {
    if (!hydrated || !backendMode) return;
    if (backendPersistTimerRef.current) {
      clearTimeout(backendPersistTimerRef.current);
    }
    const payloadUploads = normalizeUploadsPayload(serializeUploads(fileList));
    const payload: Partial<PersistedImageTaskState> = {
      prompt,
      concurrency,
      enableSound,
      uploads: payloadUploads,
    };
    const payloadKey = JSON.stringify(payload);
    if (payloadKey === backendLastPayloadRef.current) {
      return;
    }
    backendLastPayloadRef.current = payloadKey;
    backendPersistTimerRef.current = window.setTimeout(() => {
      void patchBackendTask(id, payload).catch((err) => {
        console.warn('后端任务保存失败:', err);
      });
    }, 300);
  }, [prompt, concurrency, enableSound, fileList, hydrated, backendMode, id]);

  useEffect(() => {
    if (!backendMode) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        taskId?: string;
        state?: PersistedImageTaskState;
      };
      if (!detail?.state || detail.taskId !== id) return;
      const localUploads = normalizeUploadsPayload(serializeUploads(fileList));
      const serverUploads = normalizeUploadsPayload(
        Array.isArray(detail.state.uploads) ? detail.state.uploads : [],
      );
      const shouldPreserveUploads =
        fileList.some((file) => !file.localKey) ||
        JSON.stringify(localUploads) !== JSON.stringify(serverUploads);
      applyBackendTaskState(detail.state, { preserveUploads: shouldPreserveUploads });
    };
    window.addEventListener('backend-task-update', handler as EventListener);
    return () => {
      window.removeEventListener('backend-task-update', handler as EventListener);
    };
  }, [backendMode, id, fileList]);

  useEffect(() => {
    if (!backendMode) return;
    setIsGlobalLoading(results.some((result) => result.status === 'loading'));
  }, [backendMode, results]);

  useEffect(() => {
    const previous = prevResultsRef.current;
    prevResultsRef.current = results;
    if (!backendMode || !enableSound) return;
    if (previous.length === 0) return;
    const previousStatus = new Map(previous.map((item) => [item.id, item.status]));
    const hasNewSuccess = results.some(
      (item) => item.status === 'success' && previousStatus.get(item.id) !== 'success',
    );
    if (hasNewSuccess) {
      playSuccessSound();
    }
  }, [results, backendMode, enableSound]);

  useEffect(() => {
    collectedCollectionKeysRef.current.clear();
  }, [id]);

  useEffect(() => {
    if (collectionRevision === undefined) return;
    if (lastCollectionRevisionRef.current === collectionRevision) return;
    lastCollectionRevisionRef.current = collectionRevision;
    Array.from(collectedCollectionKeysRef.current).forEach((key) => {
      if (key.startsWith('collection:upload:')) {
        collectedCollectionKeysRef.current.delete(key);
      }
    });
  }, [collectionRevision]);

  useEffect(() => {
    if (!backendMode || !config.enableCollection || !onCollect) return;
    const currentPrompt = promptRef.current;
    results.forEach((result) => {
      if (result.status !== 'success') return;
      const endTime =
        typeof result.endTime === 'number' ? result.endTime : result.startTime;
      if (!endTime) return;
      const collectionKey = buildResultCollectionKey(result.id, endTime);
      const resolvedSourceUrl =
        resolveBackendDisplayUrl(result.localKey, result.sourceUrl) ||
        result.displayUrl ||
        result.sourceUrl;
      void collectImageForCollection({
        collectionKey,
        sourceUrl: resolvedSourceUrl || undefined,
        sourceLocalKey: result.localKey,
        prompt: currentPrompt,
        timestamp: endTime,
        taskId: id,
      });
    });
    if (results.some((result) => result.status === 'success')) {
      collectReferenceImagesForCollection();
    }
  }, [backendMode, config.enableCollection, onCollect, results, id]);

  useEffect(() => {
    if (!hydrated || backendMode) return;
    let isActive = true;
    const persistUploads = async () => {
      const pending = fileList.filter(
        (file) => file.originFileObj && file.localKey && !cachedUploadKeysRef.current.has(file.localKey),
      );
      if (pending.length === 0) return;
      try {
        await Promise.all(
          pending.map(async (file) => {
            const localKey = file.localKey as string;
            await saveImageBlob(localKey, file.originFileObj as File);
            cachedUploadKeysRef.current.add(localKey);
          }),
        );
        if (!isActive) return;
      } catch (err) {
        console.warn('上传图片缓存失败:', err);
      }
    };
    void persistUploads();
    return () => {
      isActive = false;
    };
  }, [fileList, hydrated, backendMode]);

  useEffect(() => {
    const nextKeys = new Map<string, string>();
    fileList.forEach((file) => {
      const key = file.localKey || buildUploadKey(file.uid);
      nextKeys.set(file.uid, key);
    });
    uploadKeysRef.current.forEach((key, uid) => {
      const nextKey = nextKeys.get(uid);
      if (!nextKey) {
        clearObjectUrl(key);
        cachedUploadKeysRef.current.delete(key);
        if (!backendMode) {
          void deleteImageBlob(key);
        }
        return;
      }
      if (nextKey !== key) {
        clearObjectUrl(key);
        cachedUploadKeysRef.current.delete(key);
      }
    });
    uploadKeysRef.current = nextKeys;
  }, [fileList, backendMode]);

  const playSuccessSound = () => {
    if (enableSound && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((e: any) => console.error('Error playing sound:', e));
    }
  };

  const handlePromptChange = (value: string) => {
    promptDirtyRef.current = true;
    promptRef.current = value;
    setPrompt(value);
  };

  const handlePromptFocus = () => {
    promptFocusedRef.current = true;
  };

  const handlePromptBlur = () => {
    promptFocusedRef.current = false;
  };

  const handleConcurrencyInputChange = (value: string) => {
    if (value === '') {
      setConcurrencyInput('');
      return;
    }
    if (!/^\d+$/.test(value)) return;
    const parsed = Number(value);
    const normalized = Math.max(1, parsed);
    setConcurrencyInput(value);
    setConcurrency(normalized);
  };

  const handleConcurrencyInputBlur = () => {
    if (concurrencyInput === '') {
      setConcurrencyInput(String(concurrency));
      return;
    }
    if (!/^\d+$/.test(concurrencyInput)) {
      setConcurrencyInput(String(concurrency));
      return;
    }
    const parsed = Number(concurrencyInput);
    const normalized = Math.max(1, parsed);
    const normalizedValue = String(normalized);
    if (normalizedValue !== concurrencyInput) {
      setConcurrencyInput(normalizedValue);
    }
    if (normalized !== concurrency) {
      setConcurrency(normalized);
    }
  };

  const buildUploadKey = (uid: string) => `${storageKey}:upload:${uid}`;
  const buildResultCollectionKey = (subTaskId: string, endTime: number) =>
    `collection:result:${subTaskId}:${endTime}`;
  const buildUploadCollectionKey = (taskId: string, uploadKey: string) =>
    `collection:upload:${taskId}:${uploadKey}`;
  const buildUploadSignature = (file: UploadFileWithMeta) => {
    const name = typeof file.name === 'string' ? file.name : '';
    const size = file.size ?? file.originFileObj?.size;
    const lastModified = file.lastModified ?? file.originFileObj?.lastModified;
    const type = file.type ?? file.originFileObj?.type;
    if (!name || typeof size !== 'number' || typeof lastModified !== 'number') {
      return '';
    }
    return `${name}:${size}:${lastModified}:${type || ''}`;
  };
  const isCollectionUploadKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:upload:'));

  const getImageDb = () => {
    if (typeof indexedDB === 'undefined') return null;
    if (!dbPromiseRef.current) {
      dbPromiseRef.current = openImageDb();
    }
    return dbPromiseRef.current;
  };

  const saveImageBlob = async (key: string, blob: Blob) => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    const db = await dbPromise;
    await new Promise<void>((resolve, reject) => {
      const now = Date.now();
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      tx.objectStore(IMAGE_STORE_NAME).put({ blob, createdAt: now }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const getImageBlob = async (key: string): Promise<Blob | null> => {
    const dbPromise = getImageDb();
    if (!dbPromise) return null;
    const db = await dbPromise;
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result as { blob?: Blob } | undefined;
        if (!value?.blob) {
          resolve(null);
          return;
        }
        resolve(value.blob);
      };
      request.onerror = () => resolve(null);
    });
  };

  const deleteImageBlob = async (key: string) => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    try {
      const db = await dbPromise;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
        tx.objectStore(IMAGE_STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Failed to remove cached image:', err);
    }
  };

  const fetchImageBlob = async (sourceUrl: string): Promise<Blob | null> => {
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) return null;
      return await response.blob();
    } catch (err) {
      console.warn('读取图片数据失败:', err);
      return null;
    }
  };

  const collectImageForCollection = async (options: {
    collectionKey: string;
    sourceUrl?: string;
    sourceLocalKey?: string;
    sourceBlob?: Blob;
    sourceSignature?: string;
    prompt: string;
    timestamp: number;
    taskId: string;
  }) => {
    if (!config.enableCollection || !onCollect) return;
    if (collectedCollectionKeysRef.current.has(options.collectionKey)) return;

    if (backendMode) {
      const backendLocalKey =
        options.sourceLocalKey || extractBackendImageKey(options.sourceUrl);
      if (!backendLocalKey) return;
      collectedCollectionKeysRef.current.add(options.collectionKey);
      onCollect({
        id: options.collectionKey,
        prompt: options.prompt,
        timestamp: options.timestamp,
        taskId: options.taskId,
        localKey: backendLocalKey,
        sourceSignature: options.sourceSignature,
      });
      return;
    }

    collectedCollectionKeysRef.current.add(options.collectionKey);
    let blob: Blob | null = null;
    if (options.sourceBlob) {
      blob = options.sourceBlob;
    } else if (options.sourceLocalKey) {
      blob = await getImageBlob(options.sourceLocalKey);
    }
    if (!blob && options.sourceUrl) {
      blob = await fetchImageBlob(options.sourceUrl);
    }

    let localKey: string | undefined;
    if (blob) {
      await saveImageBlob(options.collectionKey, blob);
      localKey = options.collectionKey;
    }

    onCollect({
      id: localKey || options.collectionKey,
      prompt: options.prompt,
      image: options.sourceUrl,
      timestamp: options.timestamp,
      taskId: options.taskId,
      localKey,
      sourceSignature: options.sourceSignature,
    });
  };

  const collectReferenceImagesForCollection = () => {
    if (!config.enableCollection || !onCollect) return;
    if (fileList.length === 0) return;
    const currentPrompt = promptRef.current;
    fileList.forEach((file) => {
      if (file.fromCollection || isCollectionUploadKey(file.localKey)) return;
      const signature = file.sourceSignature || buildUploadSignature(file);
      const uploadKey = file.uid || file.localKey;
      if (!uploadKey) return;
      if (backendMode && !file.localKey) return;
      const collectionKey = buildUploadCollectionKey(id, uploadKey);
      const sourceBlob = file.originFileObj as Blob | undefined;
      const sourceUrl = typeof file.thumbUrl === 'string' ? file.thumbUrl : undefined;
      void collectImageForCollection({
        collectionKey,
        sourceBlob,
        sourceLocalKey: file.localKey,
        sourceUrl,
        sourceSignature: signature || undefined,
        prompt: currentPrompt,
        timestamp: Date.now(),
        taskId: id,
      });
    });
  };

  const apiMarkerSegments = new Set(['projects', 'locations', 'publishers', 'models']);
  const apiVersionPattern = /^v1(?:beta1|beta)?$/i;
  const isVersionSegment = (value?: string) =>
    Boolean(value && apiVersionPattern.test(value));

  const normalizeBase64Payload = (value: string) => value.replace(/\s+/g, '');
  const clampNumber = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));

  const splitDataUrl = (value: string) => {
    const match = value.match(/^data:(.+?);base64,(.*)$/i);
    if (!match) {
      return { mimeType: '', data: normalizeBase64Payload(value) };
    }
    return { mimeType: match[1], data: normalizeBase64Payload(match[2]) };
  };

  const resolveWebpQuality = () => {
    if (typeof config.webpQuality !== 'number' || Number.isNaN(config.webpQuality)) {
      return null;
    }
    return clampNumber(Math.round(config.webpQuality), 50, 100);
  };

  const convertDataUrlToWebp = (dataUrl: string, quality: number) =>
    new Promise<{ mimeType: string; data: string }>((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas context is unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          const webpDataUrl = canvas.toDataURL('image/webp', quality);
          const parts = webpDataUrl.split(';base64,');
          if (parts.length !== 2) {
            reject(new Error('Unexpected WebP data URL format'));
            return;
          }
          resolve({
            mimeType: parts[0].split(':')[1] || 'image/webp',
            data: parts[1],
          });
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to decode image for WebP conversion'));
      img.src = dataUrl;
    });

  const maybeConvertToWebp = async (dataUrl: string) => {
    const { mimeType, data } = splitDataUrl(dataUrl);
    const normalized = normalizeBase64Payload(data);
    if (!mimeType || mimeType.toLowerCase() === 'image/webp') {
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
    const quality = resolveWebpQuality();
    if (!quality) {
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
    try {
      const webp = await convertDataUrlToWebp(
        `data:${mimeType};base64,${normalized}`,
        clampNumber(quality / 100, 0.1, 1),
      );
      return {
        mimeType: webp.mimeType,
        data: normalizeBase64Payload(webp.data),
      };
    } catch (err) {
      console.warn('WebP conversion failed, using original image.', err);
      return { mimeType: mimeType || 'image/png', data: normalized };
    }
  };

  const buildGeminiContents = async () => {
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
    const promptText = promptRef.current.trim();
    if (promptText) {
      parts.push({ text: promptText });
    }
    for (const file of fileList) {
      if (!file.originFileObj) continue;
      const base64 = await getBase64(file.originFileObj);
      const converted = await maybeConvertToWebp(base64);
      const resolvedMime = converted.mimeType || file.type || 'image/png';
      const payload = normalizeBase64Payload(converted.data);
      parts.push({ inline_data: { mime_type: resolvedMime, data: payload } });
    }
    return [{ role: 'user', parts }];
  };

  const buildGeminiGenerationConfig = () => {
    const generationConfig: Record<string, unknown> = {};
    if (config.includeImageConfig) {
      const imageSize = config.imageConfig?.imageSize || '2K';
      const aspectRatio = config.imageConfig?.aspectRatio || 'auto';
      const imageConfig: Record<string, string> = { imageSize };
      if (aspectRatio && aspectRatio !== 'auto') {
        imageConfig.aspectRatio = aspectRatio;
      }
      generationConfig.imageConfig = imageConfig;
      if (config.useResponseModalities) {
        generationConfig.responseModalities = ['TEXT', 'IMAGE'];
      }
    }
    if (config.includeThoughts) {
      const budget = clampNumber(
        Math.round(typeof config.thinkingBudget === 'number' ? config.thinkingBudget : 128),
        0,
        8192,
      );
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true,
      };
    }
    return Object.keys(generationConfig).length > 0 ? generationConfig : null;
  };

  const buildGeminiSafetySettings = () => {
    if (!config.includeSafetySettings || !config.safety) return null;
    const entries = Object.entries(config.safety).filter(
      ([, threshold]) => threshold && threshold !== 'OFF',
    );
    if (entries.length === 0) return null;
    return entries.map(([category, threshold]) => ({
      category,
      threshold,
    }));
  };

  const mergeGeminiCustomJson = (payload: Record<string, unknown>) => {
    const raw = typeof config.customJson === 'string' ? config.customJson.trim() : '';
    if (!raw) return payload;
    try {
      const custom = JSON.parse(raw);
      if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
        return payload;
      }
      const mergedGenerationConfig = {
        ...(payload.generationConfig as Record<string, unknown> | undefined),
        ...(custom.generationConfig || {}),
      };
      return {
        ...payload,
        ...custom,
        generationConfig:
          Object.keys(mergedGenerationConfig).length > 0 ? mergedGenerationConfig : undefined,
        safetySettings: custom.safetySettings ?? payload.safetySettings,
      };
    } catch (err) {
      console.warn('自定义 JSON 解析失败，已忽略。', err);
      return payload;
    }
  };

  const buildGeminiPayload = (contents: Array<Record<string, unknown>>) => {
    const payload: Record<string, unknown> = { contents };
    const generationConfig = buildGeminiGenerationConfig();
    if (generationConfig) {
      payload.generationConfig = generationConfig;
    }
    const safetySettings = buildGeminiSafetySettings();
    if (safetySettings) {
      payload.safetySettings = safetySettings;
    }
    return mergeGeminiCustomJson(payload);
  };

  const buildGeminiRequest = () => {
    const apiFormat = config.apiFormat || 'openai';
    const format = apiFormat === 'vertex' ? 'vertex' : 'gemini';
    const apiUrl = resolveApiUrl(config.apiUrl, format);
    const baseInfo = normalizeApiBase(apiUrl);
    const baseOrigin = baseInfo.origin || apiUrl.replace(/\/+$/, '');
    const versionFallback = format === 'vertex' ? 'v1beta1' : 'v1beta';
    const version = resolveApiVersion(apiUrl, config.apiVersion, versionFallback);
    const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
    const segments = [...baseInfo.segments];

    if (!hasVersion && version) {
      const markerIndex = segments.findIndex((segment) => apiMarkerSegments.has(segment));
      if (markerIndex >= 0) {
        segments.splice(markerIndex, 0, version);
      } else {
        segments.push(version);
      }
    }

    const modelValue = config.model.trim();
    if (!modelValue) {
      throw new Error('请填写模型名称');
    }

    const modelSegments = modelValue.split('/').filter(Boolean);
    const modelHasProjectPath = modelSegments.includes('projects');
    const geminiModelIsPath = modelSegments[0] === 'models';
    const normalizedModel = geminiModelIsPath ? modelSegments.slice(1).join('/') : modelValue;

    const applyModelPath = () => {
      const modelIndex = segments.indexOf('models');
      if (geminiModelIsPath) {
        if (modelIndex >= 0 && modelSegments[0] === 'models') {
          segments.splice(modelIndex + 1);
          segments.push(...modelSegments.slice(1));
        } else {
          segments.push(...modelSegments);
        }
        return;
      }
      if (modelIndex >= 0) {
        segments.splice(modelIndex + 1);
        segments.push(modelValue);
      } else {
        segments.push('models', modelValue);
      }
    };

    const ensureMarkerValue = (marker: string, value?: string) => {
      const idx = segments.indexOf(marker);
      if (idx === -1) {
        if (!value) return false;
        segments.push(marker, value);
        return true;
      }
      const next = segments[idx + 1];
      if (!next || apiMarkerSegments.has(next) || isVersionSegment(next)) {
        if (!value) return false;
        segments.splice(idx + 1, 0, value);
        return true;
      }
      return true;
    };

    if (format === 'vertex') {
      const projectId =
        config.vertexProjectId?.trim() || extractVertexProjectId(apiUrl) || '';
      const location = config.vertexLocation?.trim() || 'us-central1';
      const publisher = config.vertexPublisher?.trim() || 'google';
      const hasProjectsMarker = segments.includes('projects');
      const useVertexMarkers = Boolean(projectId || hasProjectsMarker || modelHasProjectPath);

      if (modelHasProjectPath) {
        segments.push(...modelSegments);
      } else if (useVertexMarkers) {
        if (projectId) {
          ensureMarkerValue('projects', projectId);
        }
        if (segments.includes('projects') || projectId) {
          ensureMarkerValue('locations', location);
          ensureMarkerValue('publishers', publisher);
        }
        if (segments.includes('projects') || projectId) {
          ensureMarkerValue('models', normalizedModel);
        } else {
          applyModelPath();
        }
      } else {
        applyModelPath();
      }
    } else {
      applyModelPath();
    }

    const suffix = config.stream ? ':streamGenerateContent' : ':generateContent';
    let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`;
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const isOfficial =
      format === 'vertex'
        ? baseInfo.host === 'aiplatform.googleapis.com'
        : baseInfo.host === 'generativelanguage.googleapis.com';
    if (isOfficial) {
      url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.apiKey)}`;
    } else {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return { url, headers };
  };

  const readGeminiStream = async (response: Response) => {
    const reader = response.body?.getReader();
    if (!reader) {
      return response.json();
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let lastJson: any = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line) continue;
        const cleaned = line.replace(/^data:\s*/i, '').trim();
        if (!cleaned || cleaned === '[DONE]') continue;
        try {
          lastJson = JSON.parse(cleaned);
        } catch {
          // ignore partial lines
        }
      }
    }

    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }
    const remainder = buffer.trim();
    if (remainder) {
      const cleaned = remainder.replace(/^data:\s*/i, '').trim();
      if (cleaned && cleaned !== '[DONE]') {
        try {
          lastJson = JSON.parse(cleaned);
        } catch {
          // ignore
        }
      }
    }

    return lastJson;
  };

  const registerObjectUrl = (key: string, url: string) => {
    const existing = objectUrlMapRef.current.get(key);
    if (existing && existing !== url) {
      URL.revokeObjectURL(existing);
    }
    objectUrlMapRef.current.set(key, url);
  };

  const clearObjectUrl = (key: string) => {
    const existing = objectUrlMapRef.current.get(key);
    if (existing) {
      URL.revokeObjectURL(existing);
      objectUrlMapRef.current.delete(key);
    }
  };

  const clearRetryTimer = (subTaskId: string) => {
    const timerId = retryTimersRef.current.get(subTaskId);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      retryTimersRef.current.delete(subTaskId);
    }
  };

  const abortSubTaskRequest = (subTaskId: string) => {
    const controller = abortControllersRef.current.get(subTaskId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(subTaskId);
    }
  };

  const persistImageLocally = async (sourceUrl: string, key: string) => {
    try {
      const isHttp = /^https?:\/\//i.test(sourceUrl);
      const isData = sourceUrl.startsWith('data:image');
      if (!isHttp && !isData) {
        return { displayUrl: sourceUrl, localKey: undefined };
      }

      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('图片下载失败');
      const blob = await response.blob();
      await saveImageBlob(key, blob);
      const objectUrl = URL.createObjectURL(blob);
      return { displayUrl: objectUrl, localKey: key };
    } catch (err) {
      console.warn('图片缓存失败，回退为直链显示:', err);
      return { displayUrl: sourceUrl, localKey: undefined };
    }
  };

  const getPreferredImageSrc = (result: SubTaskResult) => {
    if (backendMode) {
      return result.displayUrl || result.sourceUrl;
    }
    const sourceUrl = result.sourceUrl;
    if (sourceUrl && (/^https?:\/\//i.test(sourceUrl) || sourceUrl.startsWith('data:image'))) {
      return sourceUrl;
    }
    return result.displayUrl || sourceUrl;
  };

  const saveImageToProject = async (result: SubTaskResult) => {
    const imageUrl = getPreferredImageSrc(result);
    if (!imageUrl || result.savedLocal) return;
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) return;
      const blob = await response.blob();
      const saveResponse = await fetch('/api/save-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Image-Type': blob.type || 'application/octet-stream',
        },
        body: blob,
      });
      if (!saveResponse.ok) return;
      updateResult(result.id, { savedLocal: true });
    } catch (err) {
      console.warn('保存到项目目录失败:', err);
    }
  };

  const updateResult = (id: string, updates: Partial<SubTaskResult>) => {
    setResults((prev: SubTaskResult[]) => prev.map((r: SubTaskResult) => {
      if (r.id !== id) return r;
      const next = { ...r, ...updates };
      if (Object.prototype.hasOwnProperty.call(updates, 'displayUrl')) {
        if (next.displayUrl && next.displayUrl.startsWith('blob:')) {
          registerObjectUrl(id, next.displayUrl);
        } else {
          clearObjectUrl(id);
        }
      }
      return next;
    }));
  };

  const updateStats = (type: 'request' | 'success' | 'fail', duration?: number) => {
    setStats((prev: TaskStats) => {
      const newState = {
        ...prev,
        totalRequests: type === 'request' ? prev.totalRequests + 1 : prev.totalRequests,
        successCount: type === 'success' ? prev.successCount + 1 : prev.successCount,
      };
      if (type === 'success' && duration) {
        newState.totalTime = prev.totalTime + duration;
        newState.fastestTime = prev.fastestTime === 0 ? duration : Math.min(prev.fastestTime, duration);
        newState.slowestTime = Math.max(prev.slowestTime, duration);
      }
      return newState;
    });
    onStatsUpdate(type, duration);
  };

  const resetTaskForGenerate = (task: SubTaskResult, startTime: number): SubTaskResult => ({
    ...task,
    status: 'loading',
    error: undefined,
    displayUrl: undefined,
    localKey: undefined,
    sourceUrl: undefined,
    savedLocal: false,
    startTime,
    endTime: undefined,
    duration: undefined,
    retryCount: 0
  });

  const handleGenerate = async () => {
    if (!config.apiKey) {
      message.error('请先配置 API Key');
      return;
    }
    const hasImage = fileList.length > 0;
    if (!prompt && !hasImage) {
      message.warning('请输入提示词或上传参考图');
      return;
    }
    if (backendMode) {
      if (fileList.some((file) => !file.localKey)) {
        message.warning('图片正在上传，请稍后再试');
        return;
      }
      setIsGlobalLoading(true);
      try {
        await patchBackendTask(id, {
          prompt,
          concurrency,
          enableSound,
          uploads: serializeUploads(fileList),
        });
        const nextState = await generateBackendTask(id);
        applyBackendTaskState(nextState);
      } catch (err) {
        console.error(err);
        message.error('后端生成失败，请检查服务状态');
      } finally {
        setIsGlobalLoading(false);
      }
      return;
    }

    results.forEach((task) => {
      abortSubTaskRequest(task.id);
      clearRetryTimer(task.id);
      clearObjectUrl(task.id);
      isRetryingRef.current.delete(task.id);
      taskStartTimesRef.current.delete(task.id);
    });

    setIsGlobalLoading(true);

    const startTime = Date.now();
    const tasksToReuse = results.slice(0, concurrency);
    const numNewTasks = Math.max(0, concurrency - tasksToReuse.length);
    
    const newSubTasks: SubTaskResult[] = Array.from({ length: numNewTasks }).map(() => ({
      id: uuidv4(),
      status: 'loading',
      retryCount: 0,
      startTime,
      savedLocal: false
    }));

    const resetTasks = tasksToReuse.map(task => resetTaskForGenerate(task, startTime));
    setResults(() => {
      if (newSubTasks.length > 0) {
        return [...newSubTasks, ...resetTasks];
      }
      return resetTasks;
    });

    // 启动所有任务（新的 + 复用的）
    [...newSubTasks, ...resetTasks].forEach(task => {
      taskStartTimesRef.current.set(task.id, startTime);
      isRetryingRef.current.set(task.id, true);
      performRequest(task.id);
    });
  };

  const handleRetrySingle = (subTaskId: string) => {
    if (backendMode) {
      setIsGlobalLoading(true);
      void retryBackendSubTask(id, subTaskId)
        .then((nextState) => {
          applyBackendTaskState(nextState);
        })
        .catch((err) => {
          console.error(err);
          message.error('后端重试失败');
        })
        .finally(() => {
          setIsGlobalLoading(false);
        });
      return;
    }
    clearRetryTimer(subTaskId);
    updateResult(subTaskId, { status: 'loading', error: undefined, displayUrl: undefined, localKey: undefined, sourceUrl: undefined, savedLocal: false, startTime: Date.now() });
    taskStartTimesRef.current.set(subTaskId, Date.now());
    isRetryingRef.current.set(subTaskId, true);
    performRequest(subTaskId);
  };

  const handleResumeSingle = (subTaskId: string) => {
    if (backendMode) {
      void retryBackendSubTask(id, subTaskId)
        .then((nextState) => {
          applyBackendTaskState(nextState);
        })
        .catch((err) => {
          console.error(err);
          message.error('后端继续失败');
        });
      return;
    }
    isRetryingRef.current.set(subTaskId, true);
    const hasActiveRequest = abortControllersRef.current.has(subTaskId);
    const hasPendingRetry = retryTimersRef.current.has(subTaskId);
    const existingStartTime = taskStartTimesRef.current.get(subTaskId);
    const nextStartTime = existingStartTime ?? Date.now();
    if (!existingStartTime) {
      taskStartTimesRef.current.set(subTaskId, nextStartTime);
    }
    updateResult(subTaskId, { status: 'loading', error: undefined, startTime: nextStartTime });
    if (hasActiveRequest || hasPendingRetry) {
      return;
    }
    performRequest(subTaskId);
  };

  const handleStopSingle = (subTaskId: string) => {
    if (backendMode) {
      void stopBackendSubTask(id, subTaskId, 'pause')
        .then((nextState) => {
          applyBackendTaskState(nextState);
        })
        .catch((err) => {
          console.error(err);
          message.error('后端停止失败');
        });
      return;
    }
    isRetryingRef.current.set(subTaskId, false);
    // 不 abort 请求，让它自然完成或失败，但停止重试
    // 如果需要强制停止请求，可以调用 abortControllersRef.current.get(subTaskId)?.abort();
    // 根据需求：停止新的请求，如果有图返回还是要显示的。所以不 abort。
    // 更新状态显示为“暂停重试”
    updateResult(subTaskId, { status: 'error', error: '已暂停重试' });
  };

  const performRequest = async (subTaskId: string) => {
    if (backendMode) return;
    if (abortControllersRef.current.has(subTaskId)) {
      return;
    }
    const controller = new AbortController();
    abortControllersRef.current.set(subTaskId, controller);
    updateStats('request');
    const startTime = taskStartTimesRef.current.get(subTaskId) || Date.now();

    try {
      const apiFormat = config.apiFormat || 'openai';
      const hasImage = fileList.length > 0;
      let imageUrl: string | null = null;

      if (apiFormat === 'openai') {
        const apiUrl = resolveApiUrl(config.apiUrl, 'openai');
        const baseInfo = normalizeApiBase(apiUrl);
        const basePath = baseInfo.origin
          ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
          : apiUrl.replace(/\/+$/, '');
        const version = resolveApiVersion(apiUrl, config.apiVersion, 'v1');
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        const chatUrl = openAiBase.endsWith('/chat/completions')
          ? openAiBase
          : `${openAiBase}/chat/completions`;

        const messages: any[] = [];
        const content: any[] = [];
        if (prompt) {
          content.push({ type: 'text', text: prompt });
        }
        if (hasImage) {
          for (const file of fileList) {
            if (file.originFileObj) {
              const base64 = await getBase64(file.originFileObj);
              content.push({
                type: 'image_url',
                image_url: {
                  url: base64,
                },
              });
            }
          }
        }
        messages.push({
          role: 'user',
          content,
        });
        const headers = {
          'Authorization': `Bearer ${config.apiKey}`,
          'x-api-key': config.apiKey,
        };

        if (config.stream) {
          const fetchResponse = await fetch(chatUrl, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: config.model, messages, stream: true }),
            signal: controller.signal,
          });

          if (!fetchResponse.ok) throw new Error(fetchResponse.statusText);

          const reader = fetchResponse.body?.getReader();
          const decoder = new TextDecoder();
          let generatedText = '';
          let pending = '';
          const consumeLine = (line: string) => {
            const cleaned = line.replace(/\r$/, '');
            if (!cleaned.startsWith('data:')) return;
            const payload = cleaned.slice(5).trimStart();
            if (!payload || payload === '[DONE]') return;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) generatedText += delta.content;
              if (delta?.reasoning_content) generatedText += delta.reasoning_content;
            } catch (e) { /* ignore */ }
          };

          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              let newlineIndex = pending.indexOf('\n');
              while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex);
                pending = pending.slice(newlineIndex + 1);
                consumeLine(line);
                newlineIndex = pending.indexOf('\n');
              }
            }
            const tail = decoder.decode();
            if (tail) pending += tail;
          }
          if (pending) {
            consumeLine(pending);
          }
          imageUrl = parseMarkdownImage(generatedText);
        } else {
          const response = await axios.post(
            chatUrl,
            { model: config.model, messages, stream: false },
            { headers: { ...headers, 'Content-Type': 'application/json' }, signal: controller.signal }
          );
          imageUrl = resolveImageFromResponse(response.data);
        }
      } else {
        const contents = await buildGeminiContents();
        const { url, headers } = buildGeminiRequest();
        const payload = buildGeminiPayload(contents);
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = config.stream ? await readGeminiStream(response) : await response.json();
        if (!response.ok) {
          const errorMessage =
            data?.error?.message ||
            (typeof data === 'string' ? data : '') ||
            response.statusText;
          throw new Error(errorMessage);
        }
        imageUrl = resolveImageFromResponse(data);
      }
      
      if (imageUrl) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const { displayUrl, localKey } = await persistImageLocally(imageUrl, subTaskId);
        updateResult(subTaskId, { status: 'success', displayUrl, localKey, sourceUrl: imageUrl, savedLocal: false, endTime, duration });
        updateStats('success', duration);
        
        if (config.enableCollection && onCollect) {
          const collectionKey = buildResultCollectionKey(subTaskId, endTime);
          await collectImageForCollection({
            collectionKey,
            sourceUrl: imageUrl,
            sourceLocalKey: localKey,
            prompt: promptRef.current,
            timestamp: endTime,
            taskId: id,
          });
          collectReferenceImagesForCollection();
        }

        playSuccessSound();
        isRetryingRef.current.set(subTaskId, false);
      } else {
        throw new Error('未在响应中找到图片数据');
      }

    } catch (err: any) {
      if (axios.isCancel(err) || err.name === 'AbortError') {
        return;
      }

      console.error('Generation error:', err);
      const errorMessage = err.response?.data?.error?.message || err.message || '未知错误';
      updateStats('fail');
      
      const shouldRetry = isRetryingRef.current.get(subTaskId);
      
      if (shouldRetry) {
        setResults(prev => prev.map(r => {
          if (r.id !== subTaskId) return r;
          return {
            ...r,
            status: 'loading',
            error: `${errorMessage} (1s后重试...)`,
            retryCount: (r.retryCount || 0) + 1
          };
        }));

        clearRetryTimer(subTaskId);
        const timerId = window.setTimeout(() => {
          clearRetryTimer(subTaskId);
        if (isRetryingRef.current.get(subTaskId)) { 
          performRequest(subTaskId);
        } else {
          updateResult(subTaskId, { status: 'error', error: '已暂停重试' });
        }
      }, 1000);
        retryTimersRef.current.set(subTaskId, timerId);
      } else {
        updateResult(subTaskId, { status: 'error', error: errorMessage });
      }
    } finally {
      abortControllersRef.current.delete(subTaskId);
      if (abortControllersRef.current.size === 0 && Array.from(isRetryingRef.current.values()).every(v => !v)) {
        setIsGlobalLoading(false);
      }
    }
  };

  const handleStopAll = () => {
    if (backendMode) {
      setIsGlobalLoading(true);
      void stopBackendSubTask(id, undefined, 'abort')
        .then((nextState) => {
          applyBackendTaskState(nextState);
        })
        .catch((err) => {
          console.error(err);
          message.error('后端停止失败');
        })
        .finally(() => {
          setIsGlobalLoading(false);
        });
      return;
    }
    results.forEach((result) => {
      isRetryingRef.current.set(result.id, false);
      clearRetryTimer(result.id);
      abortSubTaskRequest(result.id);
    });
    setResults((prev) =>
      prev.map((item) => {
        if (item.status !== 'loading') return item;
        return { ...item, status: 'error', error: '已停止', endTime: Date.now() };
      }),
    );
    message.info('已停止所有请求');
    setIsGlobalLoading(false);
  };

  const handleUploadChange = ({ fileList: newFileList }: { fileList: UploadFile[] }) => {
    const fromCollectionMap = new Map(
      fileList.map((file) => [file.uid, file.fromCollection]),
    );
    const signatureMap = new Map(
      fileList.map((file) => [file.uid, file.sourceSignature]),
    );
    const normalized = newFileList.map((file) => {
      const next = { ...file, originFileObj: file.originFileObj } as UploadFileWithMeta;
      if (fromCollectionMap.get(next.uid)) {
        next.fromCollection = true;
      }
      const existingSignature = signatureMap.get(next.uid);
      if (existingSignature) {
        next.sourceSignature = existingSignature;
      }
      if (file.originFileObj && !next.originFileObj) {
        next.originFileObj = file.originFileObj;
      }
      if (!next.localKey && !backendMode) {
        next.localKey = buildUploadKey(next.uid);
      }
      if (!next.thumbUrl && next.originFileObj) {
        const objectUrl = URL.createObjectURL(next.originFileObj);
        const previewKey = next.localKey || buildUploadKey(next.uid);
        registerObjectUrl(previewKey, objectUrl);
        next.thumbUrl = objectUrl;
      }
      if (next.originFileObj) {
        next.type = next.type || next.originFileObj.type;
        next.size = next.size ?? next.originFileObj.size;
        next.lastModified = next.lastModified ?? next.originFileObj.lastModified;
      }
      if (!next.sourceSignature) {
        const signature = buildUploadSignature(next);
        if (signature) {
          next.sourceSignature = signature;
        }
      }
      if (!next.status) {
        next.status = 'done';
      }
      return next;
    });
    setFileList(normalized);

    if (!backendMode) return;
    const pending = normalized.filter(
      (file) => file.originFileObj && !file.localKey,
    );
    if (pending.length === 0) return;

    void (async () => {
      for (const file of pending) {
        try {
          const { key } = await uploadBackendImage(file.originFileObj as File, {
            name: file.name,
            lastModified: file.lastModified ?? file.originFileObj?.lastModified,
          });
          setFileList((prev) =>
            prev.map((item) =>
              item.uid === file.uid
                ? {
                    ...item,
                    localKey: key,
                    thumbUrl: buildBackendImageUrl(key),
                  }
                : item,
            ),
          );
        } catch (err) {
          console.error(err);
          message.error(`上传失败: ${file.name}`);
        }
      }
    })();
  };

  const successRate = calculateSuccessRate(
    stats.totalRequests,
    stats.successCount,
  );

  const averageTime = stats.successCount > 0 
    ? formatDuration(stats.totalTime / stats.successCount)
    : '0.0s';
  
  const fastestTimeStr = formatDuration(stats.fastestTime);
  const slowestTimeStr = formatDuration(stats.slowestTime);

  const handlePasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const imageItems = items.filter((item) =>
        item.types.some((type) => type.startsWith('image/')),
      );

      if (imageItems.length === 0) {
        message.info('剪贴板中没有图片');
        return;
      }

      const newFiles: UploadFile[] = [];

      for (const item of imageItems) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          const file = new File([blob], `clipboard-${Date.now()}.png`, { type });
          const rcFile = file as RcFile;
          const objectUrl = URL.createObjectURL(file);
          const uploadFile: UploadFile = {
            uid: `clipboard-${Date.now()}-${Math.random()}`,
            name: file.name,
            status: 'done',
            originFileObj: rcFile,
            type: file.type,
            size: file.size,
            thumbUrl: objectUrl,
          };
          newFiles.push(uploadFile);
        }
      }

      if (newFiles.length > 0) {
        setTempFileList((prev) => [...prev, ...newFiles]);
        message.success(`已从剪贴板读取 ${newFiles.length} 张图片`);
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      message.error('无法读取剪贴板，请确保已授予权限');
    }
  };

  const handleTempUploadChange = ({ fileList: newFileList }: { fileList: UploadFile[] }) => {
    const processedList = newFileList.map((file) => {
      if (!file.thumbUrl && file.originFileObj) {
        file.thumbUrl = URL.createObjectURL(file.originFileObj);
      }
      return file;
    });
    setTempFileList(processedList);
  };

  const handleModalSubmit = () => {
    if (tempFileList.length > 0) {
      handleUploadChange({ fileList: [...fileList, ...tempFileList] });
    }
    setTempFileList([]);
    setIsUploadModalOpen(false);
  };

  const handleModalCancel = () => {
    setTempFileList([]);
    setIsUploadModalOpen(false);
  };

  return (
    <div className="moe-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ 
        padding: '12px 16px', 
        borderBottom: '1px solid #F0F0F0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: '#fff'
      }}>
        <Space>
          <div 
            style={{ 
              cursor: 'grab', 
              marginRight: 4, 
              display: 'flex', 
              alignItems: 'center',
              color: '#D0C0C0',
              touchAction: 'none'
            }}
            {...dragAttributes}
            {...dragListeners}
          >
            <HolderOutlined style={{ fontSize: 16 }} />
          </div>
          <div style={{ 
            width: 28, height: 28, 
            background: '#FFF0F3', 
            borderRadius: 8, 
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#FF9EB5'
          }}>
            <PictureFilled style={{ fontSize: 14 }} />
          </div>
          <Text strong style={{ fontSize: 14, color: '#665555' }}>任务 #{id.slice(0, 6).toUpperCase()}</Text>
        </Space>
        <Button 
          type="text" 
          danger 
          icon={<DeleteFilled />} 
          onClick={onRemove} 
          size="small"
          style={{ color: '#FFB7C5' }} 
        />
      </div>

      {/* Stats Bar - 紧凑设计 */}
      <div style={{ 
        padding: '12px 16px', 
        background: '#FAFAFA',
        borderBottom: '1px solid #F0F0F0',
        fontSize: 12
      }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(6, 1fr)', 
          gap: 4,
          textAlign: 'center'
        }}>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>请求</div>
            <div style={{ fontWeight: 700, color: '#665555' }}>{stats.totalRequests}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>成功</div>
            <div style={{ fontWeight: 700, color: '#4CAF50' }}>{stats.successCount}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>成功率</div>
            <div style={{ fontWeight: 700, color: successRate > 80 ? '#4CAF50' : '#FFC107' }}>{successRate}%</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>最快</div>
            <div style={{ fontWeight: 700, color: '#2196F3' }}>{fastestTimeStr}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>最慢</div>
            <div style={{ fontWeight: 700, color: '#FF5252' }}>{slowestTimeStr}</div>
          </div>
          <div>
            <div style={{ color: '#998888', fontSize: 10, marginBottom: 2 }}>平均</div>
            <div style={{ fontWeight: 700, color: '#9C27B0' }}>{averageTime}</div>
          </div>
        </div>
      </div>
      <Progress 
        percent={successRate} 
        showInfo={false} 
        strokeColor={{ '0%': '#FFC107', '100%': '#4CAF50' }} 
        trailColor="transparent"
        size="small"
        strokeLinecap="square"
        style={{ margin: 0, lineHeight: 0, height: 2 }}
      />

      {/* Input Area */}
      <div style={{ padding: '16px' }}>
        <div style={{ 
          background: '#FFF0F3', 
          borderRadius: 16, 
          padding: 4,
          border: '1px solid transparent',
          transition: 'all 0.3s',
        }}
        onFocus={(e) => e.currentTarget.style.borderColor = '#FF9EB5'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'transparent'}
        >
          <TextArea 
            placeholder="在此描述您的想象..." 
            value={prompt} 
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handlePromptChange(e.target.value)}
            onFocus={handlePromptFocus}
            onBlur={handlePromptBlur}
            autoSize={{ minRows: 3, maxRows: 12 }}
            variant="borderless"
            style={{ padding: '12px', fontSize: 14, resize: 'vertical', background: 'transparent', color: '#665555' }}
          />
          
          {/* 图片预览区域 */}
          {fileList.length > 0 && (
            <div style={{ padding: '8px 12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {fileList.map((file, index) => (
                <div key={file.uid} style={{ position: 'relative', width: 60, height: 60 }}>
                  <Image
                    src={file.thumbUrl || ''} 
                    alt="preview" 
                    style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 8 }}
                    width={60}
                    height={60}
                  />
                  <div 
                    style={{ 
                      position: 'absolute', top: -6, right: -6, 
                      background: '#fff', borderRadius: '50%', cursor: 'pointer',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                      zIndex: 1
                    }}
                    onClick={() => {
                      const newFileList = [...fileList];
                      newFileList.splice(index, 1);
                      setFileList(newFileList);
                    }}
                  >
                    <CloseCircleFilled style={{ color: '#FF5252', fontSize: 16 }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ 
            padding: '8px 12px', 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8
          }}>
            <Space size={8}>
              <Tooltip title="上传参考图">
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={() => setIsUploadModalOpen(true)}
                  style={
                    fileList.length > 0
                      ? {
                          background: '#FF9EB5',
                          color: '#fff',
                          border: 'none',
                        }
                      : {
                          background: '#fff',
                          color: '#998888',
                          border: 'none',
                        }
                  }
                />
              </Tooltip>
              <Modal
                title="上传参考图"
                open={isUploadModalOpen}
                onCancel={handleModalCancel}
                footer={[
                  <Button key="cancel" onClick={handleModalCancel}>
                    取消
                  </Button>,
                  <Button key="submit" type="primary" onClick={handleModalSubmit}>
                    确认添加
                  </Button>,
                ]}
                width={500}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    padding: '16px 0',
                  }}
                >
                  <div
                    style={{
                      minHeight: 120,
                      border: '1px dashed #d9d9d9',
                      borderRadius: 8,
                      padding: 12,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      alignContent: 'flex-start',
                      background: '#fafafa',
                    }}
                  >
                    {tempFileList.length === 0 && (
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#999',
                          minHeight: 96,
                        }}
                      >
                        暂无图片，请粘贴或选择文件
                      </div>
                    )}
                    {tempFileList.map((file, index) => (
                      <div
                        key={file.uid}
                        style={{ position: 'relative', width: 80, height: 80 }}
                      >
                        <Image
                          src={file.thumbUrl || ''}
                          alt={file.name}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            borderRadius: 4,
                          }}
                          preview={false}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            cursor: 'pointer',
                            background: '#fff',
                            borderRadius: '50%',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                            display: 'flex',
                            zIndex: 1,
                          }}
                          onClick={() => {
                            const newList = [...tempFileList];
                            newList.splice(index, 1);
                            setTempFileList(newList);
                          }}
                        >
                          <CloseCircleFilled
                            style={{ color: '#ff4d4f', fontSize: 16 }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Buttons Area */}
                  <div style={{ display: 'flex', gap: 16 }}>
                    <Button
                      style={{ flex: 1, height: 40 }}
                      icon={<SnippetsOutlined />}
                      onClick={handlePasteFromClipboard}
                    >
                      从剪贴板粘贴
                    </Button>

                    <div style={{ flex: 1 }}>
                      <Upload
                        fileList={tempFileList}
                        onChange={handleTempUploadChange}
                        beforeUpload={() => false}
                        multiple
                        showUploadList={false}
                      >
                        <Button
                          style={{ width: '100%', height: 40 }}
                          icon={<UploadOutlined />}
                        >
                          选择本地文件
                        </Button>
                      </Upload>
                    </div>
                  </div>
                </div>
              </Modal>

              <Space size={4} style={{ background: '#fff', padding: '2px 8px', borderRadius: 12, display: 'flex', alignItems: 'center' }}>
                <Text type="secondary" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>并发</Text>
                <input 
                  type="number"
                  min={1} 
                  value={concurrencyInput} 
                  onChange={(e) => handleConcurrencyInputChange(e.target.value)} 
                  onBlur={handleConcurrencyInputBlur}
                  style={{ 
                    width: 32, 
                    border: 'none', 
                    textAlign: 'center', 
                    color: '#665555', 
                    fontWeight: 700,
                    background: 'transparent',
                    outline: 'none',
                    fontSize: 12,
                    padding: 0,
                    height: 20
                  }}
                />
              </Space>

              <Button 
                type="text" 
                size="small" 
                icon={enableSound ? <BellFilled /> : <BellOutlined />} 
                style={{ color: enableSound ? '#FF9EB5' : '#D0C0C0' }}
                onClick={() => setEnableSound(!enableSound)}
              />
            </Space>

            {isGlobalLoading ? (
              <Button 
                danger 
                type="primary"
                icon={<PauseCircleFilled />} 
                onClick={handleStopAll} 
                size="small"
                style={{ borderRadius: 16, padding: '0 16px', height: 32, fontWeight: 700 }}
              >
                停止
              </Button>
            ) : (
              <Button 
                type="primary" 
                icon={<FireFilled />} 
                onClick={handleGenerate} 
                size="small"
                style={{ borderRadius: 16, padding: '0 20px', height: 32, fontWeight: 700 }}
              >
                生成
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Results Grid */}
      <div style={{ 
        flex: 1, 
        overflowY: 'auto', 
        padding: '0 16px 16px',
        minHeight: 200
      }}>
        {results.length === 0 ? (
          <div style={{ 
            height: '100%', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 12,
            color: '#D0C0C0',
            padding: '40px 0'
          }}>
            <StarFilled style={{ fontSize: 32, color: '#FFE5A0' }} />
            <Text type="secondary" style={{ fontSize: 13 }}>准备好开始创作了吗？</Text>
          </div>
        ) : (
          <Image.PreviewGroup>
            <div className="mobile-compact-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {results.map((result: SubTaskResult) => {
                const imageSrc = getPreferredImageSrc(result);
                return (
                <div key={result.id} style={{ 
                  position: 'relative', 
                  paddingTop: '100%', 
                  borderRadius: 12, 
                  overflow: 'hidden',
                  background: '#F8F9FA',
                  border: '1px solid #eee',
                }}>
                  <div style={{ 
                    position: 'absolute', 
                    top: 0, left: 0, right: 0, bottom: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    {result.status === 'success' && imageSrc ? (
                      <>
                        <Image
                          src={imageSrc}
                          alt="Generated"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }}
                          wrapperStyle={{ width: '100%', height: '100%' }}
                        />
                        {result.duration && (
                          <div style={{
                            position: 'absolute',
                            top: 8,
                            left: 8,
                            background: 'rgba(0,0,0,0.6)',
                            color: '#fff',
                            padding: '2px 6px',
                            borderRadius: 4,
                            fontSize: 10,
                            backdropFilter: 'blur(4px)',
                            zIndex: 2
                          }}>
                            {formatDuration(result.duration)}
                          </div>
                        )}
                        <div style={{
                          position: 'absolute',
                          bottom: 8,
                          right: 8,
                          display: 'flex',
                          gap: 8
                        }}>
                          <div style={{
                            background: 'rgba(255,255,255,0.9)',
                            backdropFilter: 'blur(4px)',
                            borderRadius: '50%',
                            width: 28,
                            height: 28,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                            cursor: 'pointer'
                          }}
                          onClick={() => handleRetrySingle(result.id)}
                          >
                            <ReloadOutlined style={{ color: '#665555' }} />
                          </div>
                          <div style={{
                            background: 'rgba(255,255,255,0.9)',
                            backdropFilter: 'blur(4px)',
                            borderRadius: '50%',
                            width: 28,
                            height: 28,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                            cursor: 'pointer'
                          }}>
                            <a
                              href={imageSrc}
                              download={`image-${result.id}.png`}
                              onClick={() => {
                                void saveImageToProject(result);
                              }}
                              style={{ color: '#665555', display: 'flex' }}
                            >
                              <DownloadOutlined />
                            </a>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div style={{ textAlign: 'center', padding: 8, width: '100%' }}>
                        {result.status === 'loading' ? (
                          <Space direction="vertical" size={8}>
                            <Spin indicator={<LoadingOutlined style={{ fontSize: 24, color: '#FF9EB5' }} spin />} />
                            <Text type="secondary" style={{ fontSize: 10, fontWeight: 600 }}>
                              {result.retryCount > 0 ? `重试 (${result.retryCount})...` : '生成中...'}
                            </Text>
                          </Space>
                        ) : (
                          <Space direction="vertical" align="center" size={8}>
                            <CloseCircleFilled style={{ fontSize: 20, color: '#FF5252' }} />
                            <Space>
                              {result.error === '已暂停重试' ? (
                                <Button 
                                  size="small" 
                                  icon={<PlayCircleFilled />} 
                                  onClick={() => handleResumeSingle(result.id)}
                                  style={{ fontSize: 10, height: 24, padding: '0 8px' }}
                                >继续</Button>
                              ) : (
                                <Button 
                                  size="small" 
                                  icon={<ReloadOutlined />} 
                                  onClick={() => handleRetrySingle(result.id)}
                                  style={{ fontSize: 10, height: 24, padding: '0 8px' }}
                                >重试</Button>
                              )}
                            </Space>
                          </Space>
                        )}
                      </div>
                    )}
                    
                    {/* 错误信息浮层 */}
                    {result.error && result.status !== 'success' && (
                      <div style={{
                        position: 'absolute',
                        top: 0, left: 0, right: 0,
                        background: 'rgba(255, 82, 82, 0.9)',
                        color: '#fff',
                        padding: '4px 8px',
                        fontSize: 10,
                        textAlign: 'center',
                        zIndex: 2
                      }}>
                        {result.error}
                      </div>
                    )}

                    {/* 单张控制按钮 */}
                    {result.status === 'loading' && (
                      <div style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        zIndex: 3
                      }}>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<PauseCircleFilled />}
                          onClick={() => handleStopSingle(result.id)}
                          style={{ background: 'rgba(255,255,255,0.8)', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        />
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </Image.PreviewGroup>
        )}
      </div>
    </div>
  );
};

export default ImageTask;
