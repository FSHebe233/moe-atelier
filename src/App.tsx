import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Layout, Button, Form, Input, Switch, Row, Col, Typography, Space, ConfigProvider, Drawer, AutoComplete, message, Tooltip } from 'antd';
import { 
  PlusOutlined, 
  SettingFilled, 
  ThunderboltFilled, 
  CheckCircleFilled, 
  ApiFilled, 
  HeartFilled,
  AppstoreFilled,
  ExperimentFilled,
  SafetyCertificateFilled,
  ReloadOutlined,
  DeleteFilled,
  KeyOutlined
} from '@ant-design/icons';
import {
  DndContext, 
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  defaultDropAnimationSideEffects,
  DropAnimation
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
  defaultAnimateLayoutChanges,
  AnimateLayoutChanges
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { v4 as uuidv4 } from 'uuid';
import ImageTask from './components/ImageTask';
import PromptDrawer from './components/PromptDrawer';
import type { AppConfig, TaskConfig } from './types/app';
import type { GlobalStats } from './types/stats';
import {
  cleanupTaskCache,
  getTaskStorageKey,
  loadConfig,
  loadGlobalStats,
  loadTasks,
  STORAGE_KEYS,
} from './app/storage';
import { safeStorageSet } from './utils/storage';
import { calculateSuccessRate, formatDuration } from './utils/stats';
import { TASK_STATE_VERSION, saveTaskState, DEFAULT_TASK_STATS } from './components/imageTaskState';
import {
  authBackend,
  clearBackendToken,
  deleteBackendTask,
  fetchBackendState,
  getBackendMode,
  getBackendToken,
  buildBackendStreamUrl,
  patchBackendState,
  putBackendTask,
  setBackendMode as persistBackendMode,
  setBackendToken,
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

interface SortableTaskItemProps {
  task: TaskConfig;
  config: AppConfig;
  backendMode: boolean;
  onRemove: (id: string) => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
}

const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

const SortableTaskItem = ({ task, config, backendMode, onRemove, onStatsUpdate }: SortableTaskItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ 
    id: task.id,
    animateLayoutChanges
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 999 : 'auto',
    opacity: isDragging ? 0 : 1,
  };

  return (
    <Col 
      id={task.id}
      xs={24} sm={12} xl={8} 
      ref={setNodeRef} 
      style={style}
    >
      <div className="fade-in-up" style={{ height: '100%' }}>
        <ImageTask
          id={task.id}
          storageKey={getTaskStorageKey(task.id)}
          config={config}
          backendMode={backendMode}
          onRemove={() => onRemove(task.id)}
          onStatsUpdate={onStatsUpdate}
          dragAttributes={attributes}
          dragListeners={listeners}
        />
      </div>
    </Col>
  );
};

function App() {
  const initialBackendMode = getBackendMode() && Boolean(getBackendToken());
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [tasks, setTasks] = useState<TaskConfig[]>(() =>
    initialBackendMode ? [] : loadTasks(),
  );
  const [globalStats, setGlobalStats] = useState<GlobalStats>(() => loadGlobalStats());
  const [configVisible, setConfigVisible] = useState(false);
  const [promptDrawerVisible, setPromptDrawerVisible] = useState(false);
  const [models, setModels] = useState<{label: string, value: string}[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeItemWidth, setActiveItemWidth] = useState<number | undefined>(undefined);
  const [form] = Form.useForm();
  const [backendMode, setBackendModeState] = useState<boolean>(() => initialBackendMode);
  const [backendAuthPending, setBackendAuthPending] = useState(false);
  const [backendPassword, setBackendPassword] = useState('');
  const [backendAuthLoading, setBackendAuthLoading] = useState(false);
  const [backendSyncing, setBackendSyncing] = useState(false);
  const backendApplyingRef = useRef(false);
  const backendBootstrappedRef = useRef(false);
  const backendReadyRef = useRef(false);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
    const node = document.getElementById(active.id as string);
    if (node) {
      // 获取内部内容容器的宽度，排除 Col 的 padding 影响
      const innerContent = node.querySelector('.fade-in-up') as HTMLElement;
      if (innerContent) {
        setActiveItemWidth(innerContent.offsetWidth);
      } else {
        setActiveItemWidth(node.offsetWidth);
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveItemWidth(undefined);

    if (active.id !== over?.id) {
      setTasks((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over?.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setActiveItemWidth(undefined);
  };

  const dropAnimation: DropAnimation = {
    duration: 300,
    easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
    sideEffects: (args) => {
      const { dragOverlay } = args;
      const defaultFn = defaultDropAnimationSideEffects({
        styles: {
          active: {
            opacity: '0',
          },
        },
      });
      const cleanup = defaultFn(args);

      const inner = dragOverlay.node.querySelector('.drag-overlay-item');
      if (inner) {
        inner.animate(
          [
            { transform: 'scale(1.02)' },
            { transform: 'scale(1)' }
          ],
          {
            duration: 300,
            easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            fill: 'forwards'
          }
        );
      }
      return cleanup;
    },
  };

  const applyBackendState = useCallback(
    (state: { config: AppConfig; tasksOrder: string[]; globalStats: GlobalStats }) => {
      backendApplyingRef.current = true;
      backendReadyRef.current = true;
      if (state?.config) {
        setConfig(state.config);
      }
      const order = Array.isArray(state?.tasksOrder) ? state.tasksOrder : [];
      setTasks(order.map((id) => ({ id, prompt: '' })));
      if (state?.globalStats) {
        setGlobalStats(state.globalStats);
      }
      window.setTimeout(() => {
        backendApplyingRef.current = false;
      }, 200);
    },
    [form],
  );

  const bootstrapBackendState = useCallback(async () => {
    setBackendSyncing(true);
    try {
      const state = await fetchBackendState();
      if (state.tasksOrder.length === 0) {
        await patchBackendState({ config });
        applyBackendState({ ...state, config });
        const newTaskId = uuidv4();
        await putBackendTask(newTaskId, {
          version: TASK_STATE_VERSION,
          prompt: '',
          concurrency: 2,
          enableSound: true,
          results: [],
          uploads: [],
          stats: DEFAULT_TASK_STATS,
        });
        await patchBackendState({ tasksOrder: [newTaskId] });
        setTasks([{ id: newTaskId, prompt: '' }]);
        return;
      }
      applyBackendState(state);
    } catch (err: any) {
      console.error(err);
      message.error('后端模式初始化失败，请检查密码或服务状态');
      clearBackendToken();
      persistBackendMode(false);
      setBackendModeState(false);
    } finally {
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
    if (!configVisible) return;
    form.setFieldsValue(config);
  }, [configVisible, config, form]);

  React.useEffect(() => {
    if (!backendMode) {
      backendBootstrappedRef.current = false;
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
    if (backendMode) {
      if (!backendReadyRef.current) return;
      if (backendApplyingRef.current) return;
      void patchBackendState({ config }).catch((err) => {
        console.warn('后端配置同步失败:', err);
      });
      return;
    }
    safeStorageSet(STORAGE_KEYS.config, JSON.stringify(config), 'app cache');
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
    safeStorageSet(
      STORAGE_KEYS.globalStats,
      JSON.stringify(globalStats),
      'app cache',
    );
  }, [globalStats, backendMode]);

  React.useEffect(() => {
    if (!backendMode) return;
    const streamUrl = buildBackendStreamUrl();
    const source = new EventSource(streamUrl);
    const handleState = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        applyBackendState(payload);
      } catch (err) {
        console.warn('解析后端状态事件失败:', err);
      }
    };
    const handleTask = (event: MessageEvent) => {
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
    if (!currentConfig.apiUrl) {
      message.warning('请先填写 API 地址');
      return;
    }

    setLoadingModels(true);
    try {
      // 移除末尾斜杠
      const baseUrl = currentConfig.apiUrl.replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${currentConfig.apiKey}`
        }
      });
      
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        const modelOptions = data.data
          .map((m: any) => ({ label: m.id, value: m.id }))
          .sort((a: any, b: any) => a.value.localeCompare(b.value));
        setModels(modelOptions);
        message.success(`成功获取 ${modelOptions.length} 个模型`);
      } else {
        throw new Error('返回数据格式不正确');
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
        results: [],
        uploads: [],
        stats: DEFAULT_TASK_STATS,
      });
    }

    setTasks([...tasks, { id: newTaskId, prompt }]);
  };

  const handleRemoveTask = (id: string) => {
    if (backendMode) {
      void deleteBackendTask(id).catch((err) => {
        console.error(err);
        message.error('删除后端任务失败');
      });
    } else {
      void cleanupTaskCache(getTaskStorageKey(id));
    }
    setTasks(tasks.filter((t: TaskConfig) => t.id !== id));
  };

  const handleConfigChange = (_changedValues: any, allValues: AppConfig) => {
    setConfig({ ...config, ...allValues });
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
    : '0.0s';
  
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
          background: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.5)',
          boxShadow: '0 4px 20px rgba(255, 158, 181, 0.05)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <div className="hover-scale" style={{ 
              width: 40, 
              height: 40, 
              background: 'linear-gradient(135deg, #FF9EB5 0%, #FF7090 100%)', 
              borderRadius: 14, 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(255, 158, 181, 0.4)',
              transform: 'rotate(-6deg)',
            }}>
              <HeartFilled style={{ fontSize: 20, color: '#fff' }} />
            </div>
            <div>
              <Title level={4} style={{ margin: 0, color: '#665555', fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, whiteSpace: 'nowrap' }}>
                萌图 <span style={{ color: '#FF9EB5' }}>工坊</span>
              </Title>
            </div>
          </div>

          <Space size={8} className="header-actions">
            <Tooltip title="提示词广场">
              <Button
                icon={<AppstoreFilled />}
                onClick={() => setPromptDrawerVisible(true)}
                size="large"
                className="mobile-hidden"
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
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
                  background: 'rgba(255,255,255,0.6)', 
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
                      width: 40, height: 40, borderRadius: '50%', background: '#E0F7FA', color: '#00BCD4',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
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
                      width: 40, height: 40, borderRadius: '50%', background: '#E8F5E9', color: '#4CAF50',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <CheckCircleFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#4CAF50' }}>{globalStats.successCount}</div>
                    <div className="stat-label">成功生成</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFF8E1', color: '#FFC107',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ExperimentFilled />
                    </div>
                    <div className="stat-value" style={{ color: successRate > 80 ? '#4CAF50' : '#FFC107' }}>
                      {successRate}%
                    </div>
                    <div className="stat-label">成功率</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#E3F2FD', color: '#2196F3',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#2196F3' }}>{fastestTimeStr}</div>
                    <div className="stat-label">最快用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#FFEBEE', color: '#FF5252',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ThunderboltFilled />
                    </div>
                    <div className="stat-value" style={{ color: '#FF5252' }}>{slowestTimeStr}</div>
                    <div className="stat-label">最慢用时</div>
                  </div>
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <div className="stat-item">
                    <div style={{ 
                      width: 40, height: 40, borderRadius: '50%', background: '#F3E5F5', color: '#9C27B0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, marginBottom: 8
                    }}>
                      <ReloadOutlined />
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
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
              fontSize: 12, fontWeight: 700
            }}>
              {tasks.length}
            </div>
            <Text style={{ fontSize: 18, fontWeight: 800, color: '#665555' }}>
              进行中的任务
            </Text>
          </div>

          <DndContext 
            sensors={sensors} 
            collisionDetection={closestCenter} 
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext 
              items={tasks.map(t => t.id)}
              strategy={rectSortingStrategy}
            >
              <Row gutter={[24, 24]}>
                {tasks.map((task: TaskConfig) => (
                  <SortableTaskItem 
                    key={task.id} 
                    task={task} 
                    config={config}
                    backendMode={backendMode}
                    onRemove={handleRemoveTask}
                    onStatsUpdate={updateGlobalStats}
                  />
                ))}
              </Row>
            </SortableContext>
            <DragOverlay dropAnimation={dropAnimation}>
              {activeId ? (
                <div 
                  className="drag-overlay-item" 
                  style={{ 
                    cursor: 'grabbing',
                    width: activeItemWidth 
                  }}
                >
                   <ImageTask
                      id={activeId}
                      storageKey={getTaskStorageKey(activeId)}
                      config={config}
                      backendMode={backendMode}
                      onRemove={() => handleRemoveTask(activeId)}
                      onStatsUpdate={updateGlobalStats}
                      dragAttributes={{}}
                      dragListeners={{}}
                    />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </Content>

        <PromptDrawer 
          visible={promptDrawerVisible}
          onClose={() => setPromptDrawerVisible(false)}
          onCreateTask={handleCreateTaskFromPrompt}
        />

        {/* 配置抽屉 */}
        <Drawer
          title={
            <Space>
              <div style={{ 
                width: 32, height: 32, borderRadius: 10, background: '#FFF0F3', 
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FF9EB5' 
              }}>
                <SettingFilled />
              </div>
              <span style={{ fontWeight: 800, fontSize: 18, color: '#665555' }}>系统配置</span>
            </Space>
          }
          placement="right"
          onClose={() => {
            setConfigVisible(false);
            if (backendAuthPending) {
              handleBackendAuthCancel();
            }
          }}
          open={configVisible}
          width={400}
          styles={{ body: { padding: 24 } }}
        >
          <Form
            layout="vertical"
            initialValues={config}
            onValuesChange={handleConfigChange}
            form={form}
          >
            <Form.Item name="apiUrl" label={<span style={{ fontWeight: 700, color: '#665555' }}>API 接口地址</span>}>
              <Input size="large" placeholder="https://api.openai.com/v1" prefix={<ApiFilled style={{ color: '#FF9EB5' }} />} />
            </Form.Item>
            
            <Form.Item name="apiKey" label={<span style={{ fontWeight: 700, color: '#665555' }}>API 密钥</span>}>
              <Input.Password size="large" placeholder="sk-..." prefix={<SafetyCertificateFilled style={{ color: '#FF9EB5' }} />} />
            </Form.Item>
            
            <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>模型名称</span>} style={{ marginBottom: 48 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Form.Item name="model" noStyle>
                    <AutoComplete
                      className="model-autocomplete"
                      options={models}
                      filterOption={(inputValue, option) =>
                        option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                      }
                      dropdownMatchSelectWidth={false}
                      dropdownStyle={{ minWidth: 300 }}
                    >
                      <Input 
                        size="large" 
                        placeholder="请输入模型名称"
                        prefix={<ExperimentFilled style={{ color: '#FF9EB5' }} />} 
                      />
                    </AutoComplete>
                  </Form.Item>
                </div>
                <Tooltip title="获取模型列表">
                  <Button 
                    className="model-refresh-btn"
                    icon={<ReloadOutlined spin={loadingModels} />} 
                    onClick={fetchModels}
                    size="large"
                    shape="circle"
                  />
                </Tooltip>
              </div>
            </Form.Item>
            
            <div style={{ background: '#F8F9FA', padding: '16px', borderRadius: 16, marginBottom: 24, border: '1px solid #eee' }}>
              <Form.Item 
                name="stream" 
                label={<span style={{ fontWeight: 700, color: '#665555' }}>流式传输</span>}
                valuePropName="checked"
                style={{ marginBottom: 0 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>启用实时生成进度更新</Text>
                  <Switch />
                </div>
              </Form.Item>
            </div>

            <div style={{ background: '#F1F7FF', padding: '16px', borderRadius: 16, marginBottom: 24, border: '1px dashed #91C1FF' }}>
              <Form.Item 
                label={<span style={{ fontWeight: 700, color: '#665555' }}>后端模式</span>}
                style={{ marginBottom: 8 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                  <Text type="secondary" style={{ fontSize: 13, flex: 1 }}>
                    开启后将配置与任务缓存到服务器，支持多端同步
                  </Text>
                  <Switch
                    checked={backendSwitchChecked}
                    loading={backendSyncing}
                    disabled={backendAuthLoading}
                    onChange={(checked) => {
                      if (checked) {
                        if (!backendMode) {
                          handleBackendEnable();
                        }
                      } else {
                        if (backendMode) {
                          handleBackendDisable();
                        } else {
                          handleBackendAuthCancel();
                        }
                      }
                    }}
                  />
                </div>
              </Form.Item>
              <div style={{ marginTop: 16 }}>
                <Text type="secondary" style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5, display: 'block' }}>
                  需要在服务端 .env 中设置 BACKEND_PASSWORD。开启后生图请求将由服务器执行并自动缓存。
                </Text>
              </div>
              <div className={`password-collapse-container ${backendAuthPending && !backendMode ? 'open' : ''}`}>
                <div className="password-content-wrapper">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Text type="secondary" style={{ fontSize: 12, color: '#6B7280' }}>
                      请输入 .env 中配置的 BACKEND_PASSWORD。
                    </Text>
                    <Input.Password
                      size="large"
                      value={backendPassword}
                      placeholder="后端密码"
                      prefix={<KeyOutlined style={{ color: '#FF9EB5', fontSize: 18 }} />}
                      onChange={(e) => setBackendPassword(e.target.value)}
                      onPressEnter={() => void handleBackendAuthConfirm()}
                    />
                    <Space size={8}>
                      <Button
                        size="small"
                        onClick={() => void handleBackendAuthConfirm()}
                        loading={backendAuthLoading}
                        type="primary"
                      >
                        验证
                      </Button>
                      <Button size="small" type="text" onClick={handleBackendAuthCancel}>
                        取消
                      </Button>
                    </Space>
                  </Space>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24, padding: 16, background: '#FFF8E1', borderRadius: 16, border: '1px dashed #FFC107' }}>
              <Space align="start">
                <ThunderboltFilled style={{ color: '#FFC107', marginTop: 4, fontSize: 16 }} />
                <Text type="secondary" style={{ fontSize: 13, color: '#8D6E63', lineHeight: 1.5 }}>
                  设置将自动应用于所有活动任务窗口。请确保您的 API 密钥有足够的配额。
                </Text>
              </Space>
            </div>
          </Form>
        </Drawer>

      </Layout>
    </ConfigProvider>
  );
}

export default App;
