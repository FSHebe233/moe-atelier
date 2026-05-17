import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Row, Col, Typography, Space, ConfigProvider, message, Tooltip, theme } from 'antd';
import { 
  PlusOutlined, 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  HeartFilled,
  AppstoreFilled,
  DeleteFilled,
  RocketFilled,
  HourglassFilled,
  DashboardFilled,
  TrophyFilled,
  DesktopOutlined,
  MoonOutlined,
  BulbOutlined
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import PromptDrawer from './components/PromptDrawer';
import CollectionBox from './components/CollectionBox';
import TaskGrid from './components/TaskGrid';
import ConfigDrawer from './components/ConfigDrawer';
import type { AppConfig, TaskConfig } from './types/app';
import type { CollectionItem } from './types/collection';
import type { GlobalStats } from './types/stats';
import type { PersistedUploadImage } from './types/imageTask';
import {
  cleanupTaskCache,
  cleanupUnusedImageCache,
  collectTaskImageKeys,
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
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  authBackend,
  clearBackendToken,
  deleteBackendTask,
  fetchBackendCollection,
  fetchBackendState,
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

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalRequests: 0,
  successCount: 0,
  fastestTime: 0,
  slowestTime: 0,
  totalTime: 0,
};
const API_FORMATS: ApiFormat[] = ['openai', 'gemini', 'vertex'];

type FormatConfigMap = Record<ApiFormat, FormatConfig>;

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
    next[fallbackConfig.apiFormat] = {
      ...next[fallbackConfig.apiFormat],
      ...buildFormatConfig(fallbackConfig),
    };
  }
  return next;
};

function App() {
  const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'system'>(() => 
    (localStorage.getItem('themeMode') as 'light' | 'dark' | 'system') || 'system'
  );
  const [isDarkMode, setIsDarkMode] = useState(false);

  React.useEffect(() => {
    localStorage.setItem('themeMode', themeMode);
    const updateDark = (matches: boolean) => {
      setIsDarkMode(matches);
      if (matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };
    
    if (themeMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      updateDark(mediaQuery.matches);
      const listener = (e: MediaQueryListEvent) => updateDark(e.matches);
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    } else {
      updateDark(themeMode === 'dark');
    }
  }, [themeMode]);

  const toggleTheme = () => {
    const nextMode = themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system';
    setThemeMode(nextMode);
  };
  const ThemeIcon = themeMode === 'system' ? DesktopOutlined : themeMode === 'dark' ? MoonOutlined : BulbOutlined;
  const themeTooltip = themeMode === 'system' ? '系统主题' : themeMode === 'dark' ? '深色主题' : '浅色主题';

  const initialBackendMode = getBackendMode() && Boolean(getBackendToken());
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() =>
    initialBackendMode ? [] : loadTasks(),
  );
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [collectionVisible, setCollectionVisible] = useState(false);
  const [collectedItems, setCollectedItems] = useState<CollectionItem[]>(() =>
    initialBackendMode ? [] : loadCollectionItems(),
  );
  const [collectionRevision, setCollectionRevision] = useState(0);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [form] = Form.useForm();
  const [backendMode, setBackendModeState] = useState<boolean>(() => initialBackendMode);
  const [backendAuthPending, setBackendAuthPending] = useState(false);
  const [backendPassword, setBackendPassword] = useState('');
  const [backendAuthLoading, setBackendAuthLoading] = useState(false);
  const [backendSyncing, setBackendSyncing] = useState(false);
  const backendModeRef = useRef(initialBackendMode);
  const configRef = useRef(config);
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
  const collectedItemsRef = useRef(collectedItems);
  const collectionCountRef = useRef(collectedItems.length);
  const configGuard = useInputGuard({ idleMs: 700 });
  const backendConfigPayload =
    backendMode && backendReadyRef.current
      ? { config, configByFormat: backendFormatConfigsRef.current }
      : null;
  const syncBackendConfig = useCallback(
    (payload: { config: AppConfig; configByFormat: FormatConfigMap }) => {
      void patchBackendState(payload).catch((err) => {
        console.warn('后端配置同步失败:', err);
      });
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

  const applyBackendState = useCallback((state: BackendStateSnapshot) => {
      if (!backendModeRef.current) return;
      backendApplyingRef.current = true;
      backendReadyRef.current = true;
      if (state?.config) {
        const formatConfigs = buildBackendFormatConfigs(
          state.configByFormat,
          state.config,
        );
        const incomingKey = JSON.stringify(state.config);
        const currentKey = JSON.stringify(configRef.current);
        const preserveConfig =
          !backendBootstrappingRef.current && shouldPreserveConfig(incomingKey, currentKey);
        if (preserveConfig) {
          const localConfig = configRef.current;
          const localFormat =
            localConfig.apiFormat === 'gemini' || localConfig.apiFormat === 'vertex'
              ? localConfig.apiFormat
              : 'openai';
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
      setTasks(order.map((id) => ({ id, prompt: '' })));
      if (state?.globalStats) {
        setGlobalStats(state.globalStats);
      }
      window.setTimeout(() => {
        backendApplyingRef.current = false;
      }, 200);
    }, [clearConfigDirty, markConfigSynced, shouldPreserveConfig]);

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
      const localConfig = loadConfig();
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
    const localConfig = loadConfig();
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
    const keepKeys = collectTaskImageKeys(tasks.map((task) => task.id));
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
    saveConfig(config);
  }, [config, backendMode]);

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
        window.dispatchEvent(new CustomEvent('backend-task-update', { detail: payload }));
      } catch (err) {
        console.warn('解析后端任务事件失败:', err);
      }
    };
    source.addEventListener('state', handleState as EventListener);
    source.addEventListener('task', handleTask as EventListener);
    source.onerror = () => {
      console.warn('后端事件流断开，等待自动重连');
    };
    return () => {
      source.removeEventListener('state', handleState as EventListener);
      source.removeEventListener('task', handleTask as EventListener);
      source.close();
    };
  }, [backendMode, applyBackendState]);

  const fetchModels = async () => {
    const currentConfig = form.getFieldsValue();
    if (!currentConfig.apiKey) {
      message.warning('请先填写 API 密钥');
      return;
    }

    setLoadingModels(true);
    try {
      const apiFormat = currentConfig.apiFormat || 'openai';
      const apiUrl = resolveApiUrl(currentConfig.apiUrl, apiFormat);
      const versionFallback =
        apiFormat === 'openai' ? 'v1' : apiFormat === 'vertex' ? 'v1beta1' : 'v1beta';
      const version = resolveApiVersion(
        apiUrl,
        currentConfig.apiVersion,
        versionFallback,
      );
      const baseInfo = normalizeApiBase(apiUrl);
      const basePath = baseInfo.origin
        ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
        : apiUrl.replace(/\/+$/, '');

      let url = '';
      const headers: Record<string, string> = {};

      if (apiFormat === 'openai') {
        const hasVersion = Boolean(inferApiVersionFromUrl(apiUrl));
        const openAiBase = hasVersion ? basePath : `${basePath}/${version}`;
        url = openAiBase.endsWith('/models') ? openAiBase : `${openAiBase}/models`;
        headers.Authorization = `Bearer ${currentConfig.apiKey}`;
      } else if (apiFormat === 'gemini') {
        const segments = [...baseInfo.segments];
        if (!inferApiVersionFromUrl(apiUrl)) {
          const modelIndex = segments.indexOf('models');
          if (modelIndex >= 0) {
            segments.splice(modelIndex, 0, version);
          } else {
            segments.push(version);
          }
        }
        const modelIndex = segments.indexOf('models');
        if (modelIndex >= 0) {
          segments.splice(modelIndex + 1);
        } else {
          segments.push('models');
        }
        const geminiBase = baseInfo.origin
          ? `${baseInfo.origin}/${segments.join('/')}`
          : `${segments.join('/')}`;
        const isOfficial = baseInfo.host === 'generativelanguage.googleapis.com';
        if (isOfficial) {
          url = `${geminiBase}?key=${encodeURIComponent(currentConfig.apiKey)}`;
        } else {
          url = geminiBase;
          headers.Authorization = `Bearer ${currentConfig.apiKey}`;
        }
      } else {
        message.warning('Vertex 模型列表暂不支持自动获取');
        return;
      }

      const res = await fetch(url, { headers });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      if (apiFormat === 'openai') {
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
      } else {
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
            const name = rawName.replace(/^models\//, '');
            return name ? { label: name, value: name } : null;
          })
          .filter((item: any) => item && item.value)
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
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
    setTasks(nextTasks);
  }, []);

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
      const preserveKeys = config.enableCollection
        ? collectedItems
            .filter(
              (item) =>
                item.taskId === id &&
                typeof item.localKey === 'string' &&
                !isCollectionCacheKey(item.localKey) &&
                !isBackendImageKey(item.localKey),
            )
            .map((item) => item.localKey as string)
        : [];
      if (preserveKeys.length > 0) {
        void cleanupTaskCache(storageKey, { preserveImageKeys: preserveKeys });
      } else {
        void cleanupTaskCache(storageKey);
      }
    }
    setTasks(tasks.filter((t: TaskConfig) => t.id !== id));
  };

  const handleConfigChange = (changedValues: any, allValues: AppConfig) => {
    let nextConfig = { ...config, ...allValues };

    if (changedValues.activeApiProfileId && changedValues.activeApiProfileId !== config.activeApiProfileId) {
      const selectedProfile = nextConfig.apiProfiles?.find(p => p.id === changedValues.activeApiProfileId);
      if (selectedProfile) {
        const { id, name, ...profileFields } = selectedProfile;
        nextConfig = { ...nextConfig, ...profileFields };
        form.setFieldsValue(profileFields);
        changedValues.apiFormat = selectedProfile.apiFormat; // Trigger format config load if format differs
      }
    } else if (!changedValues.apiProfiles) {
      // Normal field change, sync to active profile
      const profileKeys = ['apiUrl', 'apiKey', 'model', 'apiFormat', 'apiVersion', 'vertexProjectId', 'vertexLocation', 'vertexPublisher', 'thinkingBudget', 'includeThoughts', 'includeImageConfig', 'includeSafetySettings', 'safety', 'imageConfig', 'webpQuality', 'useResponseModalities', 'customJson'];
      const isProfileFieldChanged = Object.keys(changedValues).some(k => profileKeys.includes(k));
      if (isProfileFieldChanged && nextConfig.apiProfiles) {
        nextConfig.apiProfiles = nextConfig.apiProfiles.map(p => 
          p.id === nextConfig.activeApiProfileId 
            ? { ...p, ...profileKeys.reduce((acc, key) => ({ ...acc, [key]: (nextConfig as any)[key] }), {}) }
            : p
        );
      }
    }

    const nextFormat = nextConfig.apiFormat || config.apiFormat;
    nextConfig.apiFormat = nextFormat;

    const formatChanged =
      typeof changedValues?.apiFormat === 'string' &&
      changedValues.apiFormat !== config.apiFormat;

    if (backendMode) {
      markConfigDirty();
    }

    if (formatChanged && !changedValues.activeApiProfileId) {
      const formatConfig = backendMode
        ? getBackendFormatConfig(nextFormat)
        : loadFormatConfig(nextFormat);
      nextConfig = { ...nextConfig, ...formatConfig, apiFormat: nextFormat };
      form.setFieldsValue({
        apiUrl: formatConfig.apiUrl,
        apiKey: formatConfig.apiKey,
        model: formatConfig.model,
        apiVersion: formatConfig.apiVersion,
        vertexProjectId: formatConfig.vertexProjectId,
        vertexLocation: formatConfig.vertexLocation,
        vertexPublisher: formatConfig.vertexPublisher,
        thinkingBudget: formatConfig.thinkingBudget,
        includeThoughts: formatConfig.includeThoughts,
        includeImageConfig: formatConfig.includeImageConfig,
        includeSafetySettings: formatConfig.includeSafetySettings,
        safety: formatConfig.safety,
        imageConfig: formatConfig.imageConfig,
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

    if (backendMode) {
      backendFormatConfigsRef.current = {
        ...backendFormatConfigsRef.current,
        [nextConfig.apiFormat]: buildFormatConfig(nextConfig),
      };
    }

    setConfig(nextConfig);
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
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#FF9EB5',
          colorTextBase: isDarkMode ? '#e5e7eb' : '#665555',
          colorBgBase: isDarkMode ? '#1e1e1e' : '#FFF9FA',
          colorBgContainer: isDarkMode ? '#252526' : '#FFFFFF',
          borderRadius: 20,
          fontFamily: "'Nunito', 'Quicksand', sans-serif",
        },
        components: {
          Button: {
            colorPrimary: '#FF9EB5',
            algorithm: true,
            fontWeight: 700,
          },
          Input: {
            colorBgContainer: isDarkMode ? '#3c3c3c' : '#FFF0F3',
            activeBorderColor: '#FF9EB5',
            hoverBorderColor: '#FFB7C5',
          },
          Select: {
            colorBgContainer: isDarkMode ? '#3c3c3c' : '#FFFFFF',
          },
          Drawer: {
            colorBgElevated: isDarkMode ? '#252526' : '#FFFFFF',
          },
          Modal: {
            colorBgElevated: isDarkMode ? '#252526' : '#FFFFFF',
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
          background: isDarkMode ? 'rgba(31, 41, 55, 0.9)' : 'var(--c-bg-card)',
          backdropFilter: 'blur(12px)',
          borderBottom: isDarkMode ? '2px dashed #4b5563' : '2px dashed var(--c-primary-light)',
          boxShadow: isDarkMode ? '0 4px 20px rgba(0, 0, 0, 0.2)' : '0 4px 20px rgba(255, 158, 181, 0.1)'
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
              <HeartFilled style={{ fontSize: 24, color: 'var(--c-bg-card)' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <Title level={3} style={{ margin: 0, color: 'var(--c-text-main)', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
              <Text style={{ margin: 0, color: '#FF9EB5', fontWeight: 700, fontSize: 12, letterSpacing: '0.5px', lineHeight: 1, marginTop: 4 }}>
                moe atelier
              </Text>
            </div>
          </div>

          <Space size={8} className="header-actions">
            <Tooltip title={themeTooltip}>
              <Button
                icon={<ThemeIcon />}
                onClick={toggleTheme}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: isDarkMode ? 'rgba(55,65,81,0.6)' : 'var(--c-bg-card)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
                }}
              />
            </Tooltip>
            <Button
              icon={<ThemeIcon />}
              onClick={toggleTheme}
              size="large"
              shape="circle"
              className="desktop-hidden circle-icon-btn"
              style={{ 
                background: isDarkMode ? 'rgba(55,65,81,0.6)' : 'var(--c-bg-card)', 
                border: '1px solid #FF9EB5',
                color: '#FF9EB5' 
              }}
            />
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: isDarkMode ? 'rgba(55,65,81,0.6)' : 'var(--c-bg-card)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
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
                className="desktop-hidden circle-icon-btn"
                style={{ 
                  background: isDarkMode ? 'rgba(55,65,81,0.6)' : 'var(--c-bg-card)', 
                  border: '1px solid #FF9EB5',
                  color: '#FF9EB5' 
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
              className="desktop-hidden circle-icon-btn"
            />
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={handleAddTask}
              size="large"
            >
              新建任务
            </Button>
          </Space>
        </Header>
        
        <Content style={{ padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          
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
                <Text style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text-main)' }}>
                  数据总览
                </Text>
              </div>
              <Button
                size="small"
                icon={<DeleteFilled />}
                onClick={handleClearGlobalStats}
                disabled={backendSyncing}
                style={{ 
                  background: isDarkMode ? 'rgba(55,65,81,0.6)' : 'var(--c-bg-card)', 
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
                      width: 48, height: 48, borderRadius: 16, background: 'var(--c-primary-light)', color: '#FF9EB5',
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
                      width: 48, height: 48, borderRadius: 16, background: isDarkMode ? '#1e3a2f' : '#E8F5E9', color: '#6BCB8A',
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
                      width: 48, height: 48, borderRadius: 16, background: isDarkMode ? '#3a3015' : '#FFF8D6', color: '#FFC857',
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
                      width: 48, height: 48, borderRadius: 16, background: isDarkMode ? '#11353b' : '#E0F7FA', color: '#00BCD4',
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
                      width: 48, height: 48, borderRadius: 16, background: isDarkMode ? '#3b250d' : '#FFF3E0', color: '#FF9800',
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
                      width: 48, height: 48, borderRadius: 16, background: isDarkMode ? '#2c1236' : '#F3E5F5', color: '#9C27B0',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, paddingLeft: 4 }}>
            <div style={{ 
              width: 24, height: 24, borderRadius: '50%', background: '#FF9EB5', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-bg-card)',
              fontSize: 12, fontWeight: 700
            }}>
              {tasks.length}
            </div>
            <Text style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text-main)' }}>
              进行中的任务
            </Text>
          </div>

          <TaskGrid
            tasks={tasks}
            config={config}
            backendMode={backendMode}
            collectionRevision={collectionRevision}
            onRemoveTask={handleRemoveTask}
            onStatsUpdate={updateGlobalStats}
            onCollect={handleCollect}
            onReorder={handleReorderTasks}
          />
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
          onBackendPasswordChange={setBackendPassword}
          onBackendEnable={handleBackendEnable}
          onBackendDisable={handleBackendDisable}
          onBackendAuthCancel={handleBackendAuthCancel}
          onBackendAuthConfirm={handleBackendAuthConfirm}
        />

      </Layout>
    </ConfigProvider>
  );
}

export default App;

