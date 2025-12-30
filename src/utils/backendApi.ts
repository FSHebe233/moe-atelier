import type { AppConfig } from '../types/app';
import type { GlobalStats } from '../types/stats';
import type { PersistedImageTaskState } from '../types/imageTask';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './storage';

export interface BackendState {
  config: AppConfig;
  tasksOrder: string[];
  globalStats: GlobalStats;
}

const BACKEND_MODE_KEY = 'moe-image-backend-mode';
const BACKEND_TOKEN_KEY = 'moe-image-backend-token';

export const getBackendMode = () => safeStorageGet(BACKEND_MODE_KEY) === 'true';

export const setBackendMode = (enabled: boolean) => {
  if (enabled) {
    safeStorageSet(BACKEND_MODE_KEY, 'true', 'backend mode');
  } else {
    safeStorageRemove(BACKEND_MODE_KEY, 'backend mode');
  }
};

export const getBackendToken = () => safeStorageGet(BACKEND_TOKEN_KEY);

export const setBackendToken = (token: string) => {
  safeStorageSet(BACKEND_TOKEN_KEY, token, 'backend token');
};

export const clearBackendToken = () => {
  safeStorageRemove(BACKEND_TOKEN_KEY, 'backend token');
};

const buildBackendHeaders = (headers?: HeadersInit) => {
  const next = new Headers(headers);
  const token = getBackendToken();
  if (token) {
    next.set('X-Backend-Token', token);
  }
  return next;
};

const backendFetch = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: buildBackendHeaders(options.headers),
  });
  if (response.status === 401) {
    const error = new Error('BACKEND_UNAUTHORIZED');
    (error as Error & { code?: string }).code = 'BACKEND_UNAUTHORIZED';
    throw error;
  }
  return response;
};

type BackendJsonOptions = Omit<RequestInit, 'body' | 'headers'> & {
  body?: unknown;
  headers?: HeadersInit;
};

const backendJson = async <T>(
  path: string,
  options: BackendJsonOptions = {},
): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const response = await backendFetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
};

export const authBackend = async (password: string) => {
  const data = await backendJson<{ token: string }>('/api/backend/auth', {
    method: 'POST',
    body: { password },
  });
  return data.token;
};

export const fetchBackendState = async () => backendJson<BackendState>('/api/backend/state');

export const patchBackendState = async (payload: Partial<BackendState>) =>
  backendJson<BackendState>('/api/backend/state', {
    method: 'PATCH',
    body: payload,
  });

export const fetchBackendTask = async (taskId: string) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`);

export const putBackendTask = async (taskId: string, state: PersistedImageTaskState) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: state,
  });

export const patchBackendTask = async (
  taskId: string,
  payload: Partial<PersistedImageTaskState>,
) =>
  backendJson<PersistedImageTaskState>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: payload,
  });

export const deleteBackendTask = async (taskId: string) =>
  backendJson<{ ok: true }>(`/api/backend/task/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });

export const generateBackendTask = async (taskId: string) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/generate`,
    { method: 'POST' },
  );

export const retryBackendSubTask = async (taskId: string, subTaskId: string) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/retry`,
    { method: 'POST', body: { subTaskId } },
  );

export type BackendStopMode = 'pause' | 'abort';

export const stopBackendSubTask = async (
  taskId: string,
  subTaskId?: string,
  mode: BackendStopMode = 'pause',
) =>
  backendJson<PersistedImageTaskState>(
    `/api/backend/task/${encodeURIComponent(taskId)}/stop`,
    { method: 'POST', body: { subTaskId, mode } },
  );

export const uploadBackendImage = async (
  blob: Blob,
  meta: { name?: string; lastModified?: number } = {},
) => {
  const headers: HeadersInit = {
    'Content-Type': blob.type || 'application/octet-stream',
  };
  if (typeof meta.lastModified === 'number') {
    headers['X-Upload-Last-Modified'] = String(meta.lastModified);
  }
  const response = await backendFetch('/api/backend/upload', {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as { key: string; url: string };
};

export const buildBackendImageUrl = (key: string) => {
  const token = getBackendToken();
  const encodedKey = encodeURIComponent(key);
  if (!token) {
    return `/api/backend/image/${encodedKey}`;
  }
  return `/api/backend/image/${encodedKey}?token=${encodeURIComponent(token)}`;
};

export const buildBackendStreamUrl = () => {
  const token = getBackendToken();
  if (!token) return '/api/backend/stream';
  return `/api/backend/stream?token=${encodeURIComponent(token)}`;
};

export const stripBackendToken = (url: string) =>
  url
    .replace(/[?&]token=[^&]+/g, '')
    .replace(/[?&]$/, '');
