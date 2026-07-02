import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Row, Col, Typography, Space, ConfigProvider, message, Tooltip, Segmented } from 'antd';
import { 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  HeartFilled,
  AppstoreFilled,
  BranchesOutlined,
  CloudUploadOutlined,
  DeleteFilled,
  RocketFilled,
  HourglassFilled,
  DashboardFilled,
  TrophyFilled
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import PromptDrawer from './components/PromptDrawer';
import CollectionBox from './components/CollectionBox';
import OneClickSubmissionModal from './components/OneClickSubmissionModal';
import TaskGrid from './components/TaskGrid';
import ConfigDrawer from './components/ConfigDrawer';
import WorkflowBoard from './components/WorkflowBoard';
import type { AppConfig, TaskConfig } from './types/app';
import type { CollectionItem } from './types/collection';
import type { GlobalStats } from './types/stats';
import type { PersistedUploadImage } from './types/imageTask';
import {
  cleanupTaskCache,
  cleanupUnusedImageCache,
  collectTaskImageKeys,
  collectWorkflowProjectImageKeys,
  deleteImageCache,
  type FormatConfig,
  buildFormatConfig,
  getDefaultFormatConfig,
  getTaskStorageKey,
  loadCollectionItems,
  loadConfig,
  loadFormatConfig,
  loadGlobalStats,
  loadTasks,
  saveConfig,
  saveCollectionItems,
  STORAGE_KEYS,
} from './app/storage';
import { useDebouncedSync, useInputGuard } from './utils/inputSync';
import {
  type ApiFormat,
  extractVertexProjectId,
  inferApiVersionFromUrl,
  normalizeApiBase,
  resolveApiUrl,
  resolveApiVersion,
} from './utils/apiUrl';
import {
  API_FORMATS,
  buildGoogleModelsRequest,
  coerceApiFormat,
} from './utils/providerRequests.mjs';
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  authBackend,
  clearBackendToken,
  deleteBackendTask,
  fetchBackendCollection,
  fetchBackendState,
  fetchBackendTask,
  getBackendMode,
  getBackendToken,
  buildBackendStreamUrl,
  patchBackendState,
  putBackendTask,
  putBackendCollection,
  setBackendMode as persistBackendMode,
  setBackendToken,
  type BackendStateSnapshot,
} from './utils/backendApi';
import { normalizeTaskName } from './utils/taskName';

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};
type FormatConfigMap = Record<ApiFormat, FormatConfig>;

const API_PROFILE_FIELD_KEYS = [
  'apiUrl',
  'apiKey',
  'model',
  'apiFormat',
  'openaiEndpointMode',
  'apiVersion',
  'vertexAuthMode',
  'vertexProjectId',
  'vertexLocation',
  'vertexDefaultLocation',
  'vertexModelLocations',
  'vertexPublisher',
  'thinkingBudget',
  'includeThoughts',
  'includeImageConfig',
	  'includeSafetySettings',
	  'safety',
	  'imageConfig',
	  'novelAiConfig',
	  'webpQuality',
  'useResponseModalities',
  'customJson',
] as const;

const pickApiProfileFields = (config: AppConfig) =>
  API_PROFILE_FIELD_KEYS.reduce((acc, key) => {
    (acc as Record<string, unknown>)[key] = config[key];
    return acc;
  }, {} as Omit<AppConfig, 'apiProfiles' | 'activeApiProfileId' | 'stream' | 'enableCollection'>);

const buildBackendFormatConfigs = (
  value: unknown,
  fallbackConfig?: AppConfig,
): FormatConfigMap => {
  const next = API_FORMATS.reduce((acc, format) => {
    acc[format] = getDefaultFormatConfig(format);
    return acc;
  }, {} as FormatConfigMap);
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    API_FORMATS.forEach((format) => {
      const entry = raw[format];
      if (entry && typeof entry === 'object') {
        next[format] = { ...next[format], ...buildFormatConfig(entry as Partial<AppConfig>) };
      }
    });
  }
  if (fallbackConfig?.apiFormat) {
    const fallbackFormat = coerceApiFormat(fallbackConfig.apiFormat);
    next[fallbackFormat] = {
      ...next[fallbackFormat],
      ...buildFormatConfig(fallbackConfig),
    };
  }
  return next;
};

function App() {
  const initialBackendMode = getBackendMode() && Boolean(getBackendToken());
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() =>
    initialBackendMode ? [] : loadTasks(),
  );
  const tasksRef = useRef<TaskConfig[]>(tasks);
  const [workspaceMode, setWorkspaceMode] = useState<'tasks' | 'workflow'>('tasks');
  const [workflowOpenProjectIds, setWorkflowOpenProjectIds] = useState<string[]>([]);
  const [workflowActiveProjectId, setWorkflowActiveProjectId] = useState<string | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [collectionVisible, setCollectionVisible] = useState(false);
  const [collectedItems, setCollectedItems] = useState<CollectionItem[]>(() =>
    initialBackendMode ? [] : loadCollectionItems(),
  );
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [submissionModalOpen, setSubmissionModalOpen] = useState(false);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [form] = Form.useForm();
  const [backendMode, setBackendModeState] = useState<boolean>(() => initialBackendMode);
  const [backendAuthPending, setBackendAuthPending] = useState(false);
  const [backendPassword, setBackendPassword] = useState('');
  const [backendAuthLoading, setBackendAuthLoading] = useState(false);
  const [backendSyncing, setBackendSyncing] = useState(false);
  const [apiConfigDirty, setApiConfigDirty] = useState(false);
  const backendModeRef = useRef(initialBackendMode);
  const configRef = useRef(config);
  const persistedConfigRef = useRef(config);
  const apiConfigDirtyRef = useRef(false);
  const backendFormatConfigsRef = useRef<FormatConfigMap>(
    buildBackendFormatConfigs(null),
  );
  const localHydratingRef = useRef(false);
  const backendApplyingRef = useRef(false);
  const backendBootstrappedRef = useRef(false);
  const backendBootstrappingRef = useRef(initialBackendMode);
  const backendReadyRef = useRef(false);
  const backendCollectionHydratingRef = useRef(false);
  const backendCollectionSyncTimerRef = useRef<number | null>(null);
  const backendCollectionLastPayloadRef = useRef<string>('');
  const backendTaskNamesRef = useRef<Record<string, string | undefined>>({});
  const backendTaskNameLoadedRef = useRef<Set<string>>(new Set());
  const backendTaskNameLoadingRef = useRef<Set<string>>(new Set());
  const collectedItemsRef = useRef(collectedItems);
  const collectionCountRef = useRef(collectedItems.length);
  const configGuard = useInputGuard({ idleMs: 700 });

  const backendConfigPayload =
    backendMode && backendReadyRef.current && !apiConfigDirty
      ? { config, configByFormat: backendFormatConfigsRef.current }
      : null;
  const syncBackendConfig = useCallback(
    async (payload: { config: AppConfig; configByFormat: FormatConfigMap }) => {
      await patchBackendState(payload);
    },
    [],
  );
  const configSync = useDebouncedSync({
    enabled: backendMode && backendReadyRef.current,
    payload: backendConfigPayload,
    delay: 500,
    retryDelay: 200,
    isBlocked: () => backendApplyingRef.current,
    onSync: syncBackendConfig,
  });
  const {
    markDirty: markConfigDirty,
    clearDirty: clearConfigDirty,
    shouldPreserve: shouldPreserveConfig,
  } = configGuard;
  const { markSynced: markConfigSynced } = configSync;

  const applyTaskNameToCache = useCallback((taskId: string, value?: string) => {
    const nextName = normalizeTaskName(value);
    if (nextName) {
      backendTaskNamesRef.current[taskId] = nextName;
    } else {
      delete backendTaskNamesRef.current[taskId];
    }

    setTasks((current) => {
      let changed = false;
      const nextTasks = current.map((task) => {
        if (task.id !== taskId) return task;
        const currentName = normalizeTaskName(task.name);
        if (currentName === nextName) return task;
        changed = true;
        const nextTask: TaskConfig = { ...task };
        if (nextName) {
          nextTask.name = nextName;
        } else {
          delete nextTask.name;
        }
        return nextTask;
      });
      if (changed) {
        tasksRef.current = nextTasks;
        return nextTasks;
      }
      return current;
    });
  }, []);

  const buildTasksFromOrder = useCallback((order: string[]) =>
    order.map((id) => {
      const cachedName =
        backendTaskNamesRef.current[id] ||
        normalizeTaskName(tasksRef.current.find((task) => task.id === id)?.name);
      return {
        id,
        ...(cachedName ? { name: cachedName } : {}),
        prompt: '',
      };
    }), []);

  const hydrateBackendTaskNames = useCallback((ids: string[]) => {
    ids.forEach((id) => {
      if (backendTaskNameLoadedRef.current.has(id)) return;
      if (backendTaskNameLoadingRef.current.has(id)) return;
      backendTaskNameLoadingRef.current.add(id);
      void fetchBackendTask(id)
        .then((state) => {
          backendTaskNameLoadedRef.current.add(id);
          applyTaskNameToCache(id, state.name);
        })
        .catch((err) => {
          console.warn('后端任务名称读取失败:', err);
        })
        .finally(() => {
          backendTaskNameLoadingRef.current.delete(id);
        });
    });
  }, [applyTaskNameToCache]);

  const applyBackendState = useCallback((state: BackendStateSnapshot) => {
      if (!backendModeRef.current) return;
      backendApplyingRef.current = true;
      backendReadyRef.current = true;
      if (state?.config) {
        persistedConfigRef.current = state.config;
        const formatConfigs = buildBackendFormatConfigs(
          state.configByFormat,
          state.config,
        );
        const incomingKey = JSON.stringify(state.config);
        const currentKey = JSON.stringify(configRef.current);
        const preserveConfig =
          apiConfigDirtyRef.current ||
          (!backendBootstrappingRef.current && shouldPreserveConfig(incomingKey, currentKey));
        if (preserveConfig) {
          const localConfig = configRef.current;
          const localFormat = coerceApiFormat(localConfig.apiFormat);
          formatConfigs[localFormat] = {
            ...formatConfigs[localFormat],
            ...buildFormatConfig(localConfig),
          };
          backendFormatConfigsRef.current = formatConfigs;
          if (incomingKey === currentKey) {
            clearConfigDirty();
          }
        } else {
          backendFormatConfigsRef.current = formatConfigs;
          setConfig(state.config);
          setApiConfigDirty(false);
          clearConfigDirty();
        }
        markConfigSynced({
          config: state.config,
          configByFormat: formatConfigs,
        });
        const needsFormatSync =
          !state.configByFormat ||
          API_FORMATS.some((format) => !state.configByFormat?.[format]);
        if (needsFormatSync) {
          window.setTimeout(() => {
            if (!backendModeRef.current) return;
            void patchBackendState({ configByFormat: formatConfigs }).catch((err) => {
              console.warn('后端配置缓存补全失败:', err);
            });
          }, 240);
        }
      }
      const order = Array.isArray(state?.tasksOrder) ? state.tasksOrder : [];
      const orderSet = new Set(order);
      Object.keys(backendTaskNamesRef.current).forEach((id) => {
        if (!orderSet.has(id)) delete backendTaskNamesRef.current[id];
      });
      backendTaskNameLoadedRef.current.forEach((id) => {
        if (!orderSet.has(id)) backendTaskNameLoadedRef.current.delete(id);
      });
      const nextTasks = buildTasksFromOrder(order);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      hydrateBackendTaskNames(order);
      if (state?.globalStats) {
        setGlobalStats(state.globalStats);
      }
      window.setTimeout(() => {
        backendApplyingRef.current = false;
      }, 200);
    }, [buildTasksFromOrder, clearConfigDirty, hydrateBackendTaskNames, markConfigSynced, shouldPreserveConfig]);

  const bootstrapBackendState = useCallback(async () => {
    backendBootstrappingRef.current = true;
    setBackendSyncing(true);
    try {
      let state = await fetchBackendState();
      if (!backendModeRef.current) return;

      if (!state.meta.hasSavedState) {
        const seededFormatConfigs = buildBackendFormatConfigs(null, config);
        backendFormatConfigsRef.current = seededFormatConfigs;
        state = await patchBackendState({
          config,
          configByFormat: seededFormatConfigs,
        });
        if (!backendModeRef.current) return;
      }

      applyBackendState(state);
      if (!backendModeRef.current) return;

      if (state.tasksOrder.length === 0) {
        const newTaskId = uuidv4();
        await putBackendTask(newTaskId, {
          version: TASK_STATE_VERSION,
          prompt: '',
          concurrency: 2,
          enableSound: true,
          retryInterval: 1000,
          retryLimit: -1,
          results: [],
          uploads: [],
          stats: DEFAULT_TASK_STATS,
        });
        if (!backendModeRef.current) return;
        state = await patchBackendState({ tasksOrder: [newTaskId] });
        if (!backendModeRef.current) return;
        applyBackendState(state);
        return;
      }
    } catch (err: any) {
      console.error(err);
      message.error('后端模式初始化失败，请检查密码或服务状态');
      clearBackendToken();
      persistBackendMode(false);
      localHydratingRef.current = true;
      backendModeRef.current = false;
      setBackendModeState(false);
      backendTaskNamesRef.current = {};
      backendTaskNameLoadedRef.current.clear();
      backendTaskNameLoadingRef.current.clear();
      const localConfig = loadConfig();
      persistedConfigRef.current = localConfig;
      setApiConfigDirty(false);
      setConfig(localConfig);
      setTasks(loadTasks());
      setGlobalStats(loadGlobalStats());
    } finally {
      backendBootstrappingRef.current = false;
      setBackendSyncing(false);
    }
  }, [applyBackendState, config]);

  const handleBackendEnable = () => {
    setBackendPassword('');
    setBackendAuthPending(true);
  };

  const handleBackendDisable = () => {
    setBackendAuthPending(false);
    setBackendPassword('');
    clearBackendToken();
    persistBackendMode(false);
    localHydratingRef.current = true;
    backendModeRef.current = false;
    backendBootstrappingRef.current = false;
    setBackendModeState(false);
    backendTaskNamesRef.current = {};
    backendTaskNameLoadedRef.current.clear();
    backendTaskNameLoadingRef.current.clear();
    const localConfig = loadConfig();
    persistedConfigRef.current = localConfig;
    setApiConfigDirty(false);
    setConfig(localConfig);
    setTasks(loadTasks());
    setGlobalStats(loadGlobalStats());
  };

  const handleBackendAuthConfirm = async () => {
    if (!backendPassword) {
      message.warning('请输入后端密码');
      return;
    }
    setBackendAuthLoading(true);
    try {
      const token = await authBackend(backendPassword);
      setBackendToken(token);
      persistBackendMode(true);
      backendTaskNamesRef.current = {};
      backendTaskNameLoadedRef.current.clear();
      backendTaskNameLoadingRef.current.clear();
      setBackendModeState(true);
      backendModeRef.current = true;
      setBackendAuthPending(false);
      setBackendPassword('');
    } catch (err: any) {
      console.error(err);
      message.error('后端密码错误或服务器不可用');
    } finally {
      setBackendAuthLoading(false);
    }
  };

  const handleBackendAuthCancel = () => {
    setBackendAuthPending(false);
    setBackendPassword('');
  };

  React.useEffect(() => {
    backendModeRef.current = backendMode;
  }, [backendMode]);

  React.useEffect(() => {
    configRef.current = config;
  }, [config]);

  React.useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  React.useEffect(() => {
    apiConfigDirtyRef.current = apiConfigDirty;
  }, [apiConfigDirty]);

  React.useEffect(() => {
    if (!configVisible) {
      clearConfigDirty();
    }
  }, [configVisible, clearConfigDirty]);

  React.useEffect(() => {
    if (!configVisible) return;
    form.setFieldsValue(config);
  }, [configVisible, config, form]);

  React.useEffect(() => {
    let isActive = true;
    if (backendMode) {
      backendCollectionHydratingRef.current = true;
      backendCollectionLastPayloadRef.current = JSON.stringify(collectedItemsRef.current);
      void (async () => {
        try {
          const items = await fetchBackendCollection();
          if (!isActive) return;
          const payload = JSON.stringify(items);
          backendCollectionLastPayloadRef.current = payload;
          setCollectedItems(items);
        } catch (err) {
          console.warn('后端收藏读取失败:', err);
        } finally {
          if (isActive) {
            backendCollectionHydratingRef.current = false;
          }
        }
      })();
      return () => {
        isActive = false;
      };
    }

    backendCollectionHydratingRef.current = false;
    backendCollectionLastPayloadRef.current = '';
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
      backendCollectionSyncTimerRef.current = null;
    }
    const localItems = loadCollectionItems();
    const filteredItems = localItems.filter((item) => {
      const localKey = item.localKey || '';
      if (localKey && isBackendImageKey(localKey)) return false;
      if (typeof item.image === 'string' && item.image.includes('/api/backend/image/')) {
        return false;
      }
      return true;
    });
    setCollectedItems(filteredItems);
    return () => {
      isActive = false;
    };
  }, [backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (localHydratingRef.current) return;
    saveCollectionItems(collectedItems);
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    collectedItemsRef.current = collectedItems;
  }, [collectedItems]);

  React.useEffect(() => {
    if (!backendMode) return;
    if (backendCollectionHydratingRef.current) return;
    const payload = JSON.stringify(collectedItems);
    if (payload === backendCollectionLastPayloadRef.current) return;
    backendCollectionLastPayloadRef.current = payload;
    if (backendCollectionSyncTimerRef.current) {
      clearTimeout(backendCollectionSyncTimerRef.current);
    }
    backendCollectionSyncTimerRef.current = window.setTimeout(() => {
      void putBackendCollection(collectedItems).catch((err) => {
        console.warn('后端收藏保存失败:', err);
      });
    }, 300);
    return () => {
      if (backendCollectionSyncTimerRef.current) {
        clearTimeout(backendCollectionSyncTimerRef.current);
        backendCollectionSyncTimerRef.current = null;
      }
    };
  }, [collectedItems, backendMode]);

  React.useEffect(() => {
    if (collectionCountRef.current > collectedItems.length) {
      setCollectionRevision((prev) => prev + 1);
    }
    collectionCountRef.current = collectedItems.length;
  }, [collectedItems.length]);

  React.useEffect(() => {
    if (config.enableCollection) return;
    if (backendMode) return;
    if (localHydratingRef.current) return;
    const keepKeys = [
      ...collectTaskImageKeys(tasks.map((task) => task.id)),
      ...collectWorkflowProjectImageKeys(),
    ];
    void cleanupUnusedImageCache(keepKeys);
  }, [config.enableCollection, tasks, backendMode]);

  React.useEffect(() => {
    if (!backendMode) {
      backendBootstrappedRef.current = false;
      backendBootstrappingRef.current = false;
      backendReadyRef.current = false;
      return;
    }
    if (backendBootstrappedRef.current) return;
    backendBootstrappedRef.current = true;
    void bootstrapBackendState();
  }, [backendMode, bootstrapBackendState]);

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    navigator.storage.persist().catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (backendMode) return;
    if (localHydratingRef.current) return;
    if (apiConfigDirty) return;
    saveConfig(config);
    persistedConfigRef.current = config;
  }, [config, backendMode, apiConfigDirty]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ tasksOrder: tasks.map((task: TaskConfig) => task.id) }).catch((err) => {
        console.warn('后端任务列表同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.tasks,
      JSON.stringify(tasks.map((task: TaskConfig) => task.id)),
      'app cache',
    );
  }, [tasks, backendMode]);

  React.useEffect(() => {
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ globalStats }).catch((err) => {
        console.warn('后端统计同步失败:', err);
      });
      return;
    }
    if (localHydratingRef.current) return;
    safeStorageSet(
      STORAGE_KEYS.globalStats,
      JSON.stringify(globalStats),
      'app cache',
    );
  }, [globalStats, backendMode]);

  React.useEffect(() => {
    if (backendMode) return;
    if (!localHydratingRef.current) return;
    localHydratingRef.current = false;
  }, [backendMode]);

  React.useEffect(() => {
    if (!backendMode) return;
    const streamUrl = buildBackendStreamUrl();
    const source = new EventSource(streamUrl);
    const handleState = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        applyBackendState(payload);
      } catch (err) {
        console.warn('解析后端状态事件失败:', err);
      }
    };
    const handleTask = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const payload = JSON.parse(event.data || '{}');
        if (typeof payload?.taskId === 'string' && payload?.state) {
          backendTaskNameLoadedRef.current.add(payload.taskId);
          applyTaskNameToCache(payload.taskId, payload.state.name);
        }
        window.dispatchEvent(new CustomEvent('backend-task-update', { detail: payload }));
      } catch (err) {
        console.warn('解析后端任务事件失败:', err);
      }
    };
    const handleCollection = (event: MessageEvent) => {
      if (!backendModeRef.current) return;
      try {
        const items = JSON.parse(event.data || '[]') as CollectionItem[];
        if (!Array.isArray(items)) return;
        backendCollectionLastPayloadRef.current = JSON.stringify(items);
        setCollectedItems(items);
      } catch (err) {
        console.warn('解析后端收藏事件失败:', err);
      }
    };
    source.addEventListener('state', handleState as EventListener);
    source.addEventListener('task', handleTask as EventListener);
    source.addEventListener('collection', handleCollection as EventListener);
    source.onerror = () => {
      console.warn('后端事件流断开，等待自动重连');
    };
    return () => {
      source.removeEventListener('state', handleState as EventListener);
      source.removeEventListener('task', handleTask as EventListener);
      source.removeEventListener('collection', handleCollection as EventListener);
      source.close();
    };
  }, [backendMode, applyBackendState, applyTaskNameToCache]);

  const fetchModels = async () => {
    const currentConfig = form.getFieldsValue();
    if (!currentConfig.apiKey) {
      message.warning('请先填写 API 密钥');
      return;
    }

    setLoadingModels(true);
    try {
      const apiFormat = coerceApiFormat(currentConfig.apiFormat || 'openai');
	      if (apiFormat === 'novelai') {
	        message.warning('NovelAI 模型列表暂不支持自动获取');
	        return;
	      }
	      if (apiFormat === 'openai') {
	        const apiUrl = resolveApiUrl(currentConfig.apiUrl, apiFormat);
	        const version = resolveApiVersion(apiUrl, currentConfig.apiVersion, 'v1');
	        const baseInfo = normalizeApiBase(apiUrl);
	        const basePath = baseInfo.origin
	          ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
	          : apiUrl.replace(/\/+$/, '');
	        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
	        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
	        const url = openAiBase.endsWith('/models') ? openAiBase : `${openAiBase}/models`;
	        const res = await fetch(url, { headers: { Authorization: `Bearer ${currentConfig.apiKey}` } });
	        if (!res.ok) {
	          throw new Error(`HTTP error! status: ${res.status}`);
	        }
	        const data = await res.json();
	        const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
	        if (list.length === 0) {
	          throw new Error('返回数据格式不正确');
	        }
	        const modelOptions = list
	          .map((m: any) => ({ label: m.id || m.name, value: m.id || m.name }))
	          .filter((item: any) => typeof item.value === 'string')
	          .sort((a: any, b: any) => a.value.localeCompare(b.value));
	        setModels(modelOptions);
	        message.success(`成功获取 ${modelOptions.length} 个模型`);
	        return;
	      } else if (apiFormat === 'gemini' || apiFormat === 'vertex') {
	        const { url, headers } = await buildGoogleModelsRequest({ ...currentConfig, apiFormat });
	        const res = await fetch(url, { headers });
	        if (!res.ok) {
	          throw new Error(`HTTP error! status: ${res.status}`);
	        }
	        const data = await res.json();
	        const list = Array.isArray(data.models)
	          ? data.models
	          : Array.isArray(data.data)
	            ? data.data
	            : [];
	        if (list.length === 0) {
	          throw new Error('返回数据格式不正确');
	        }
	        const modelOptions = list
	          .map((m: any) => {
	            const rawName =
	              typeof m?.name === 'string' ? m.name : typeof m?.id === 'string' ? m.id : '';
	            const name = rawName
	              .replace(/^models\//, '')
	              .replace(/^publishers\/[^/]+\/models\//, '');
	            return name ? { label: name, value: name } : null;
	          })
	          .filter((item: any) => item && item.value)
	          .sort((a: any, b: any) => a.value.localeCompare(b.value));
	        setModels(modelOptions);
	        message.success(`成功获取 ${modelOptions.length} 个模型`);
	        return;
	      } else {
	        message.warning('当前 API 格式暂不支持自动获取模型列表');
	        return;
	      }
    } catch (e) {
      console.error(e);
      message.error('获取模型列表失败，请检查配置');
    } finally {
      setLoadingModels(false);
    }
  };

  // 当配置抽屉打开且有 API Key 时，如果列表为空，自动获取一次
  React.useEffect(() => {
    if (configVisible && config.apiKey && models.length === 0) {
      fetchModels();
    }
  }, [configVisible]);

	  const handleAddTask = () => {
	    const newTaskId = uuidv4();
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: '',
        concurrency: 2,
        enableSound: true,
        retryInterval: 1000,
        retryLimit: -1,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
		    }
		    setTasks([...tasks, { id: newTaskId, prompt: '' }]);
		  };

  const handleReorderTasks = useCallback((nextTasks: TaskConfig[]) => {
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
  }, []);

  const handleTaskNameChange = useCallback((id: string, name?: string) => {
    applyTaskNameToCache(id, name);
  }, [applyTaskNameToCache]);

  const handleCreateTaskFromPrompt = (prompt: string) => {
    const newTaskId = uuidv4();
    
    // Pre-save task state with prompt
    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        retryInterval: 1000,
        retryLimit: -1,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        // If we could handle image upload here we would, but for now just prompt
        concurrency: 2,
        enableSound: true,
        retryInterval: 1000,
        retryLimit: -1,
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      });
    }

		    setTasks([...tasks, { id: newTaskId, prompt }]);
		  };

  const handleCreateTaskFromCollection = (prompt: string, referenceImages: CollectionItem[]) => {
    const newTaskId = uuidv4();
    
    const uploads: PersistedUploadImage[] = referenceImages
      .filter((img) => img.localKey)
      .map((img) => {
        const uid = uuidv4();
        return {
          uid,
          name: `reference-${uid.slice(0, 8)}.png`,
          type: 'image/png',
          localKey: img.localKey as string,
          lastModified: Date.now(),
          fromCollection: true,
          sourceSignature: img.sourceSignature,
        };
      });

    const storageKey = getTaskStorageKey(newTaskId);
    if (backendMode) {
      void putBackendTask(newTaskId, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        retryInterval: 1000,
        retryLimit: -1,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      }).catch((err) => {
        console.error(err);
        message.error('创建后端任务失败');
      });
    } else {
      saveTaskState(storageKey, {
        version: TASK_STATE_VERSION,
        prompt: prompt,
        concurrency: 2,
        enableSound: true,
        retryInterval: 1000,
        retryLimit: -1,
        results: [],
        uploads: uploads,
        stats: DEFAULT_TASK_STATS,
      });
    }

		    setTasks([...tasks, { id: newTaskId, prompt }]);
		    setCollectionVisible(false);
    message.success('已创建新任务');
  };

  const isCollectionCacheKey = (key: string) => key.startsWith('collection:');
  const isBackendImageKey = (key: string) => /\.[a-z0-9]+$/i.test(key);
  const getBackendFormatConfig = (format: ApiFormat) =>
    backendFormatConfigsRef.current[format];

  const handleRemoveTask = (id: string) => {
    if (backendMode) {
      void deleteBackendTask(id).catch((err) => {
        console.error(err);
        message.error('删除后端任务失败');
      });
    } else {
      const storageKey = getTaskStorageKey(id);
      const preserveKeys = [
        ...(config.enableCollection
          ? collectedItems
              .filter(
                (item) =>
                  item.taskId === id &&
                  typeof item.localKey === 'string' &&
                  !isCollectionCacheKey(item.localKey) &&
                  !isBackendImageKey(item.localKey),
              )
              .map((item) => item.localKey as string)
          : []),
        ...collectWorkflowProjectImageKeys(),
      ];
      if (preserveKeys.length > 0) {
        void cleanupTaskCache(storageKey, { preserveImageKeys: preserveKeys });
      } else {
        void cleanupTaskCache(storageKey);
      }
	    }
		    const nextTasks = tasks.filter((t: TaskConfig) => t.id !== id);
		    setTasks(nextTasks);
		  };

  const handleConfigChange = (changedValues: any, allValues: AppConfig) => {
    let nextConfig = { ...config, ...allValues };
    const profileFieldChanged = Object.keys(changedValues).some((key) =>
      API_PROFILE_FIELD_KEYS.includes(key as typeof API_PROFILE_FIELD_KEYS[number]),
    );

    if (profileFieldChanged && nextConfig.apiProfiles) {
      nextConfig.apiProfiles = nextConfig.apiProfiles.map((profile) =>
        profile.id === nextConfig.activeApiProfileId
          ? { ...profile, ...pickApiProfileFields(nextConfig) }
          : profile,
      );
      setApiConfigDirty(true);
    }

    const nextFormat = coerceApiFormat(nextConfig.apiFormat || config.apiFormat);
    nextConfig.apiFormat = nextFormat;

    const formatChanged =
      typeof changedValues?.apiFormat === 'string' &&
      changedValues.apiFormat !== config.apiFormat;

    if (backendMode && !profileFieldChanged) {
      markConfigDirty();
    }

    if (formatChanged) {
      const formatConfig = backendMode
        ? getBackendFormatConfig(nextFormat)
        : loadFormatConfig(nextFormat);
      nextConfig = { ...nextConfig, ...formatConfig, apiFormat: nextFormat };
      if (nextConfig.apiProfiles) {
        nextConfig.apiProfiles = nextConfig.apiProfiles.map((profile) =>
          profile.id === nextConfig.activeApiProfileId
            ? { ...profile, ...pickApiProfileFields(nextConfig) }
            : profile,
        );
      }
      form.setFieldsValue({
        apiUrl: formatConfig.apiUrl,
        apiKey: formatConfig.apiKey,
        model: formatConfig.model,
	        openaiEndpointMode: formatConfig.openaiEndpointMode,
	        apiVersion: formatConfig.apiVersion,
	        vertexAuthMode: formatConfig.vertexAuthMode,
	        vertexProjectId: formatConfig.vertexProjectId,
	        vertexLocation: formatConfig.vertexLocation,
	        vertexDefaultLocation: formatConfig.vertexDefaultLocation,
	        vertexModelLocations: formatConfig.vertexModelLocations,
	        vertexPublisher: formatConfig.vertexPublisher,
        thinkingBudget: formatConfig.thinkingBudget,
        includeThoughts: formatConfig.includeThoughts,
        includeImageConfig: formatConfig.includeImageConfig,
        includeSafetySettings: formatConfig.includeSafetySettings,
        safety: formatConfig.safety,
        imageConfig: formatConfig.imageConfig,
        novelAiConfig: formatConfig.novelAiConfig,
        webpQuality: formatConfig.webpQuality,
        useResponseModalities: formatConfig.useResponseModalities,
        customJson: formatConfig.customJson,
      });
      setModels([]);
    }

    if (typeof nextConfig.apiUrl === 'string') {
      const inferredVersion = inferApiVersionFromUrl(nextConfig.apiUrl);
      if (inferredVersion && inferredVersion !== nextConfig.apiVersion) {
        nextConfig.apiVersion = inferredVersion;
        form.setFieldsValue({ apiVersion: inferredVersion });
      }
      if (nextFormat === 'vertex') {
        const inferredProjectId = extractVertexProjectId(nextConfig.apiUrl);
        if (inferredProjectId && inferredProjectId !== nextConfig.vertexProjectId) {
          nextConfig.vertexProjectId = inferredProjectId;
          form.setFieldsValue({ vertexProjectId: inferredProjectId });
        }
      }
    }

    if (profileFieldChanged && nextConfig.apiProfiles) {
      nextConfig.apiProfiles = nextConfig.apiProfiles.map((profile) =>
        profile.id === nextConfig.activeApiProfileId
          ? { ...profile, ...pickApiProfileFields(nextConfig) }
          : profile,
      );
    }

    if (backendMode) {
      backendFormatConfigsRef.current = {
        ...backendFormatConfigsRef.current,
        [nextConfig.apiFormat]: buildFormatConfig(nextConfig),
      };
    }

    setConfig(nextConfig);
  };

  const handleApiProfileChange = (profileId: string) => {
    if (profileId === config.activeApiProfileId) return;
    if (
      apiConfigDirtyRef.current &&
      !window.confirm('当前 API 配置档有未保存修改，切换后会丢弃这些修改。确定切换吗？')
    ) {
      form.setFieldsValue({ activeApiProfileId: config.activeApiProfileId });
      return;
    }

    const savedConfig = persistedConfigRef.current;
    const savedProfiles = savedConfig.apiProfiles || config.apiProfiles || [];
    const selectedProfile = savedProfiles.find((profile) => profile.id === profileId);
    let nextConfig: AppConfig = {
      ...config,
      apiProfiles: savedProfiles,
      activeApiProfileId: profileId,
    };
    if (selectedProfile) {
      const profileFields = pickApiProfileFields(selectedProfile as unknown as AppConfig);
      nextConfig = {
        ...nextConfig,
        ...profileFields,
        apiFormat: coerceApiFormat(profileFields.apiFormat),
      };
      form.setFieldsValue({ ...profileFields, activeApiProfileId: profileId });
    } else {
      form.setFieldsValue({ activeApiProfileId: profileId });
    }

    setModels([]);
    setApiConfigDirty(false);
    clearConfigDirty();
    setConfig(nextConfig);
  };

  const handleSaveApiProfile = async () => {
    const formValues = form.getFieldsValue(true) as AppConfig;
    let nextConfig: AppConfig = {
      ...config,
      ...formValues,
      apiFormat: coerceApiFormat(formValues.apiFormat || config.apiFormat),
    };
    const activeProfileId = nextConfig.activeApiProfileId || 'default';
    const profiles =
      nextConfig.apiProfiles && nextConfig.apiProfiles.length > 0
        ? nextConfig.apiProfiles
        : [
            {
              id: activeProfileId,
              name: '默认配置',
              ...pickApiProfileFields(nextConfig),
            },
          ];
    nextConfig = {
      ...nextConfig,
      activeApiProfileId: activeProfileId,
      apiProfiles: profiles.map((profile) =>
        profile.id === activeProfileId
          ? { ...profile, ...pickApiProfileFields(nextConfig) }
          : profile,
      ),
    };
    const nextFormatConfigs: FormatConfigMap = {
      ...backendFormatConfigsRef.current,
      [nextConfig.apiFormat]: buildFormatConfig(nextConfig),
    };
    backendFormatConfigsRef.current = nextFormatConfigs;
    persistedConfigRef.current = nextConfig;
    setConfig(nextConfig);
    setApiConfigDirty(false);
    clearConfigDirty();

    try {
      if (backendMode && backendReadyRef.current) {
        const synced = await patchBackendState({
          config: nextConfig,
          configByFormat: nextFormatConfigs,
        });
        markConfigSynced({
          config: synced.config,
          configByFormat: buildBackendFormatConfigs(synced.configByFormat, synced.config),
        });
      } else {
        saveConfig(nextConfig);
      }
      message.success('当前 API 配置档已保存');
    } catch (err) {
      console.error(err);
      message.error('API 配置档保存失败');
    }
  };

  const normalizePrompt = (prompt: string) =>
    prompt.trim().replace(/\s+/g, ' ');

  const buildPromptKey = (prompt: string) => {
    const normalized = normalizePrompt(prompt);
    return normalized ? normalized.toLowerCase() : '__empty__';
  };

  const isUploadCollectionKey = (key?: string) =>
    Boolean(key && key.startsWith('collection:upload:'));

  const isUploadCollectionItem = (item: CollectionItem) =>
    isUploadCollectionKey(item.id) || isUploadCollectionKey(item.localKey);

  const getCollectionGroupKey = (item: CollectionItem) =>
    buildPromptKey(typeof item.prompt === 'string' ? item.prompt : '');

  const getCollectionKey = (item: CollectionItem, useIdOnly = false) => {
    if (isUploadCollectionItem(item) && item.sourceSignature) {
      return `upload:${buildPromptKey(item.prompt)}:${item.sourceSignature}`;
    }
    return useIdOnly ? item.id : item.localKey || item.image || item.id;
  };


  const handleCollect = (item: CollectionItem) => {
    const normalized: CollectionItem = {
      ...item,
      id: item.id || item.localKey || uuidv4(),
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      taskId: typeof item.taskId === 'string' ? item.taskId : '',
    };
    const incomingKey = getCollectionKey(normalized, backendMode);
    setCollectedItems((prev) => {
      if (!incomingKey) return [normalized, ...prev];
      const existingIndex = prev.findIndex(
        (entry) => getCollectionKey(entry, backendMode) === incomingKey,
      );
      if (existingIndex === -1) {
        return [normalized, ...prev];
      }
      const existing = prev[existingIndex];
      const updated = { ...existing, ...normalized, id: existing.id || normalized.id };
      const next = prev.filter(
        (entry) => getCollectionKey(entry, backendMode) !== incomingKey,
      );
      return [updated, ...next];
    });
  };

  const getCollectionCacheKey = (item: CollectionItem) => {
    if (item.localKey) return item.localKey;
    if (item.id && isCollectionCacheKey(item.id)) return item.id;
    return undefined;
  };

  const handleRemoveCollectedItem = (id: string) => {
    setCollectedItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (!backendMode) {
        const cacheKey = target ? getCollectionCacheKey(target) : undefined;
        if (cacheKey) {
          void deleteImageCache(cacheKey);
        }
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleRemoveCollectedGroup = (groupKey: string) => {
    setCollectedItems((prev) => {
      const toRemove = prev.filter(
        (item) => getCollectionGroupKey(item) === groupKey,
      );
      if (!backendMode) {
        const keys = Array.from(
          new Set(
            toRemove
              .map((item) => getCollectionCacheKey(item))
              .filter((key): key is string => typeof key === 'string'),
          ),
        );
        keys.forEach((key) => {
          void deleteImageCache(key);
        });
      }
      return prev.filter((item) => getCollectionGroupKey(item) !== groupKey);
    });
  };

  const handleClearCollection = () => {
    if (!backendMode) {
      const keys = Array.from(
        new Set(
          collectedItems
            .map((item) =>
              getCollectionCacheKey(item),
            )
            .filter((key): key is string => typeof key === 'string'),
        ),
      );
      keys.forEach((key) => {
        void deleteImageCache(key);
      });
    }
    setCollectedItems([]);
  };

  const updateGlobalStats = useCallback((type: 'request' | 'success' | 'fail', duration?: number) => {
    setGlobalStats((prev: GlobalStats) => {
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
  }, []);

  const handleClearGlobalStats = () => {
    setGlobalStats({ ...EMPTY_GLOBAL_STATS });
    message.success('数据总览统计已清空');
  };

  const successRate = calculateSuccessRate(
    globalStats.totalRequests,
    globalStats.successCount,
  );
  
  const averageTime = globalStats.successCount > 0 
    ? formatDuration(globalStats.totalTime / globalStats.successCount)
    : '0s';
  
  const fastestTimeStr = formatDuration(globalStats.fastestTime);

  const slowestTimeStr = formatDuration(globalStats.slowestTime);
  const backendSwitchChecked = backendMode || backendAuthPending;

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#FF9EB5',
          colorTextBase: '#665555',
          colorBgBase: '#FFF9FA',
          borderRadius: 20,
          fontFamily: "'Nunito', 'Quicksand', sans-serif",
          motionDurationFast: '0.18s',
          motionDurationMid: '0.24s',
          motionDurationSlow: '0.35s',
          motionEaseOut: 'cubic-bezier(0.25, 1, 0.5, 1)',
          motionEaseInOut: 'cubic-bezier(0.45, 0, 0.55, 1)',
          motionEaseOutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        },
        components: {
          Button: {
            colorPrimary: '#FF9EB5',
            algorithm: true,
            fontWeight: 700,
          },
          Input: {
            colorBgContainer: '#FFF0F3',
            activeBorderColor: '#FF9EB5',
            hoverBorderColor: '#FFB7C5',
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          }
        }
      }}
    >
      <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
        {/* 顶部导航栏 */}
        <Header className="app-header" style={{ 
          height: 72, 
          // padding handled in css
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(12px)',
          borderBottom: '2px dashed #FFF0F3',
          boxShadow: '0 4px 20px rgba(255, 158, 181, 0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="hover-scale" style={{ 
              width: 44, 
              height: 44, 
              background: 'linear-gradient(135deg, #FF9EB5 0%, #FF7090 100%)', 
              borderRadius: 16, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              boxShadow: '0 6px 0 #FF7090, 0 8px 16px rgba(255, 158, 181, 0.4)',
              transform: 'rotate(-8deg)',
              border: '2px solid #fff'
            }}>
              <HeartFilled style={{ fontSize: 24, color: '#fff' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <Title level={3} style={{ margin: 0, color: '#665555', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
              <Text style={{ margin: 0, color: '#FF9EB5', fontWeight: 700, fontSize: 12, letterSpacing: '0.5px', lineHeight: 1, marginTop: 4 }}>
                moe atelier
              </Text>
            </div>
          </div>

          <div className="header-actions">
            <Segmented
              className="workspace-mode-switch mobile-hidden"
              value={workspaceMode}
              onChange={(value) => setWorkspaceMode(value as 'tasks' | 'workflow')}
              options={[
                {
                  value: 'tasks',
                  label: (
                    <span className="workspace-mode-label">
                      <AppstoreFilled />
                      任务卡
                    </span>
                  ),
                },
                {
                  value: 'workflow',
                  label: (
                    <span className="workspace-mode-label">
                      <BranchesOutlined />
                      工作流
                    </span>
                  ),
                },
              ]}
            />
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{
                  background: 'rgba(255,255,255,0.6)',
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5',
                }}
              >
                广场
              </Button>
            </Tooltip>
            <Button
              icon={<AppstoreFilled />}
              onClick={() => setPromptDrawerVisible(true)}
              size="large"
              shape="circle"
              aria-label="提示词广场"
              className="desktop-hidden circle-icon-btn"
              style={{
                background: 'rgba(255,255,255,0.6)',
                border: '1px solid #FF9EB5',
                color: '#FF9EB5',
              }}
            />

            <Button
              icon={<SettingFilled />}
              onClick={() => setConfigVisible(true)}
              size="large"
              className="mobile-hidden"
            >
              系统配置
            </Button>
            <Button
              icon={<SettingFilled />}
              onClick={() => setConfigVisible(true)}
              size="large"
              shape="circle"
              aria-label="系统配置"
              className="desktop-hidden circle-icon-btn"
            />
            <Button
              type="primary"
              icon={<span className="thick-plus-icon" aria-hidden="true" />}
              onClick={handleAddTask}
              size="large"
              className="mobile-hidden"
            >
              新建任务
            </Button>
            <Tooltip title="新建任务">
              <Button
                type="primary"
                icon={<span className="thick-plus-icon" aria-hidden="true" />}
                onClick={handleAddTask}
                size="large"
                shape="circle"
                aria-label="新建任务"
                className="desktop-hidden circle-icon-btn mobile-new-task-btn"
              />
            </Tooltip>
          </div>
        </Header>

	        <Content
	          key={workspaceMode}
	          className="view-enter"
	          style={
	            workspaceMode === 'workflow'
	              ? { padding: 0, width: '100%', minHeight: 'calc(100vh - 72px)' }
	              : { padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }
	          }
	        >
	          {workspaceMode === 'workflow' ? (
		            <WorkflowBoard
		              tasks={tasks}
			              config={config}
			              backendMode={backendMode}
			              openProjectIds={workflowOpenProjectIds}
			              activeProjectId={workflowActiveProjectId}
			              onOpenProjectIdsChange={setWorkflowOpenProjectIds}
			              onActiveProjectIdChange={setWorkflowActiveProjectId}
			              onCreateTask={handleAddTask}
	              onStatsUpdate={updateGlobalStats}
	            />
	          ) : (
	          <>
	          {/* 数据仪表盘 - 重新设计 */}
	          <div className="fade-in-up" style={{ marginBottom: 32 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 16,
                paddingLeft: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AppstoreFilled style={{ fontSize: 18, color: '#FF9EB5' }} />
                <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
                  数据总览
                </Text>
              </div>
              <Button
                size="small"
                icon={<DeleteFilled />}
                onClick={handleClearGlobalStats}
                disabled={backendSyncing}
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              >
                清空统计
              </Button>
            </div>
            
            <div className="stat-panel">
              <Row gutter={[16, 16]}>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF0F3', color: '#FF9EB5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFB7C5, 0 4px 8px rgba(255,158,181,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value">{globalStats.totalRequests}</div>
                    <div className="stat-label">总请求数</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#E8F5E9', color: '#6BCB8A',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #A7E8BD, 0 4px 8px rgba(107,203,138,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <CheckCircleFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#6BCB8A' }}>{globalStats.successCount}</div>
                    <div className="stat-label">成功生成</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF8D6', color: '#FFC857',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFE5A0, 0 4px 8px rgba(255,200,87,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <TrophyFilled />
                    </div>
                    <div className="stat-value" style={{ color: successRate > 80 ? '#6BCB8A' : '#FFC857' }}>
                      {successRate}%
                    </div>
                    <div className="stat-label">成功率</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#E0F7FA', color: '#00BCD4',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #A0E1E8, 0 4px 8px rgba(0,188,212,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <RocketFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#00BCD4' }}>{fastestTimeStr}</div>
                    <div className="stat-label">最快用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#FFF3E0', color: '#FF9800',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #FFCC80, 0 4px 8px rgba(255,152,0,0.2)', transform: 'rotate(-5deg)'
                    }}>
                      <HourglassFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#FF9800' }}>{slowestTimeStr}</div>
                    <div className="stat-label">最慢用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 48, height: 48, borderRadius: 16, background: '#F3E5F5', color: '#9C27B0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 12,
                      boxShadow: '0 4px 0 #E1BEE7, 0 4px 8px rgba(156,39,176,0.2)', transform: 'rotate(5deg)'
                    }}>
                      <DashboardFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#9C27B0' }}>{averageTime}</div>
                    <div className="stat-label">平均用时</div>
                  </div>
                </Col>
              </Row>
            </div>
          </div>

          {/* 任务列表 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 16,
              paddingLeft: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%', background: '#FF9EB5',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                fontSize: 12, fontWeight: 700
              }}>
                {tasks.length}
              </div>
              <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
                进行中的任务
              </Text>
            </div>
            <Space size={8} wrap>
              <Button
                type="primary"
                size="small"
                icon={<CloudUploadOutlined />}
                disabled={tasks.length === 0}
                onClick={() => setSubmissionModalOpen(true)}
              >
                一键投稿
              </Button>
            </Space>
          </div>

          <TaskGrid
            tasks={tasks}
            config={config}
            backendMode={backendMode}
            collectionRevision={collectionRevision}
            onRemoveTask={handleRemoveTask}
            onTaskNameChange={handleTaskNameChange}
            onStatsUpdate={updateGlobalStats}
            onCollect={handleCollect}
            onReorder={handleReorderTasks}
          />
	          </>
	          )}
	        </Content>

        <PromptDrawer 
          visible={promptDrawerVisible}
          onClose={() => setPromptDrawerVisible(false)}
          onCreateTask={handleCreateTaskFromPrompt}
        />
        
        {config.enableCollection && (
          <CollectionBox
            visible={collectionVisible}
            backendMode={backendMode}
            onClose={() => setCollectionVisible(!collectionVisible)}
            collectedItems={collectedItems}
            onRemoveItem={handleRemoveCollectedItem}
            onRemoveGroup={handleRemoveCollectedGroup}
            onClear={handleClearCollection}
            onCreateTask={handleCreateTaskFromCollection}
          />
        )}

        <OneClickSubmissionModal
          open={submissionModalOpen}
          tasks={tasks}
          backendMode={backendMode}
          onClose={() => setSubmissionModalOpen(false)}
        />

        <ConfigDrawer
          visible={configVisible}
          config={config}
          form={form}
          onClose={() => {
            setConfigVisible(false);
            if (backendAuthPending) {
              handleBackendAuthCancel();
            }
          }}
          onConfigChange={handleConfigChange}
          models={models}
          loadingModels={loadingModels}
          fetchModels={fetchModels}
          backendSwitchChecked={backendSwitchChecked}
          backendSyncing={backendSyncing}
          backendAuthLoading={backendAuthLoading}
          backendMode={backendMode}
          backendAuthPending={backendAuthPending}
          backendPassword={backendPassword}
          apiConfigDirty={apiConfigDirty}
          onBackendPasswordChange={setBackendPassword}
          onBackendEnable={handleBackendEnable}
          onBackendDisable={handleBackendDisable}
          onBackendAuthCancel={handleBackendAuthCancel}
          onBackendAuthConfirm={handleBackendAuthConfirm}
          onSaveApiProfile={() => void handleSaveApiProfile()}
          onApiProfileChange={handleApiProfileChange}
        />

      </Layout>
    </ConfigProvider>
  );
}

export default App;

