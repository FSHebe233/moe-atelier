import React, { useState, useRef, useEffect } from 'react';
import { 
  Input, Button, Upload, message, Spin, Image, 
  Space, Typography, Tooltip, Progress
} from 'antd';
import { 
  UploadOutlined, DeleteFilled, ReloadOutlined, 
  BellFilled, BellOutlined, DownloadOutlined, PictureFilled,
  CloseCircleFilled, PauseCircleFilled, FireFilled,
  StarFilled,
  LoadingOutlined,
  PlayCircleFilled
} from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { AppConfig } from '../App';

const { Text } = Typography;
const { TextArea } = Input;

interface ImageTaskProps {
  id: string;
  config: AppConfig;
  onRemove: () => void;
  onStatsUpdate: (type: 'request' | 'success' | 'fail', duration?: number) => void;
}

interface SubTaskResult {
  id: string;
  displayUrl?: string;
  localKey?: string;
  savedLocal?: boolean;
  status: 'pending' | 'loading' | 'success' | 'error';
  error?: string;
  retryCount: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
}

interface TaskStats {
  totalRequests: number;
  successCount: number;
  fastestTime: number;
  slowestTime: number;
  totalTime: number;
}

const SUCCESS_AUDIO_SRC = 'https://actions.google.com/sounds/v1/cartoon/magic_chime.ogg'; 
const IMAGE_DB_NAME = 'moe-image-cache';
const IMAGE_STORE_NAME = 'images';
const IMAGE_DB_VERSION = 1;
const IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;

const openImageDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
      db.createObjectStore(IMAGE_STORE_NAME);
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const ImageTask: React.FC<ImageTaskProps> = ({ id, config, onRemove, onStatsUpdate }: ImageTaskProps) => {
  const [prompt, setPrompt] = useState('');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [concurrency, setConcurrency] = useState<number>(2);
  const [enableSound, setEnableSound] = useState<boolean>(true);
  
  const [results, setResults] = useState<SubTaskResult[]>([]);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [stats, setStats] = useState<TaskStats>({ 
    totalRequests: 0, 
    successCount: 0, 
    fastestTime: 0,
    slowestTime: 0,
    totalTime: 0
  });
  
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const isRetryingRef = useRef<Map<string, boolean>>(new Map());
  const taskStartTimesRef = useRef<Map<string, number>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dbPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    audioRef.current = new Audio(SUCCESS_AUDIO_SRC);
    void cleanupExpiredCache();
    const cleanupTimer = window.setInterval(() => {
      void cleanupExpiredCache();
    }, IMAGE_CACHE_TTL_MS);
    const handleBeforeUnload = () => {
      void clearImageCache();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.clearInterval(cleanupTimer);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      void clearImageCache();
      abortControllersRef.current.forEach((controller: AbortController) => controller.abort());
      objectUrlMapRef.current.forEach((url: string) => URL.revokeObjectURL(url));
      objectUrlMapRef.current.clear();
      taskStartTimesRef.current.clear();
    };
  }, []);

  const playSuccessSound = () => {
    if (enableSound && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((e: any) => console.error('Error playing sound:', e));
    }
  };

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
      tx.objectStore(IMAGE_STORE_NAME).put({ blob, createdAt: now, expiresAt: now + IMAGE_CACHE_TTL_MS }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const cleanupExpiredCache = async () => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    const db = await dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const request = store.openCursor();
      const now = Date.now();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value as any;
        const expiresAt = value?.expiresAt;
        if (typeof expiresAt !== 'number' || expiresAt <= now) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  const clearImageCache = async () => {
    const dbPromise = getImageDb();
    if (!dbPromise) return;
    const db = await dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      tx.objectStore(IMAGE_STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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

  const saveImageToProject = async (result: SubTaskResult) => {
    if (!result.displayUrl || result.savedLocal) return;
    try {
      const response = await fetch(result.displayUrl);
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

  const getBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });

  const parseMarkdownImage = (text: string): string | null => {
    const mdImageRegex = /!\[.*?\]\((.*?)\)/;
    const match = text.match(mdImageRegex);
    if (match && match[1]) return match[1];
    if (text.startsWith('http') || text.startsWith('data:image')) return text;
    return null;
  };

  const extractImageFromMessage = (message: any): string | null => {
    if (!message) return null;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'image_url') {
          const url = part?.image_url?.url || part?.image_url;
          if (url) return url;
        }
        if (part?.type === 'text' && typeof part.text === 'string') {
          const imageUrl = parseMarkdownImage(part.text);
          if (imageUrl) return imageUrl;
        }
      }
    }
    if (typeof message.content === 'string') {
      const imageUrl = parseMarkdownImage(message.content);
      if (imageUrl) return imageUrl;
    }
    if (typeof message.reasoning_content === 'string') {
      const imageUrl = parseMarkdownImage(message.reasoning_content);
      if (imageUrl) return imageUrl;
    }
    return null;
  };

  const resolveImageFromResponse = (data: any): string | null => {
    const fromDataArray = data?.data?.[0];
    if (fromDataArray) {
      if (typeof fromDataArray === 'string') return fromDataArray;
      if (fromDataArray.url) return fromDataArray.url;
      if (fromDataArray.b64_json) return `data:image/png;base64,${fromDataArray.b64_json}`;
    }
    return extractImageFromMessage(data?.choices?.[0]?.message);
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

    setIsGlobalLoading(true);

    // 找出非成功的任务（error 或 pending），优先复用这些任务
    const nonSuccessTasks = results.filter(r => r.status !== 'success');
    const tasksToReuse = nonSuccessTasks.slice(0, concurrency);
    const numNewTasks = Math.max(0, concurrency - tasksToReuse.length);
    
    const newSubTasks: SubTaskResult[] = Array.from({ length: numNewTasks }).map(() => ({
      id: uuidv4(),
      status: 'loading',
      retryCount: 0,
      startTime: Date.now(),
      savedLocal: false
    }));

    setResults((prev: SubTaskResult[]) => {
      const next = [...prev];
      
      // 1. 插入新任务到顶部
      if (newSubTasks.length > 0) {
        next.unshift(...newSubTasks);
      }

      // 2. 更新复用任务的状态
      tasksToReuse.forEach(task => {
        const index = next.findIndex(r => r.id === task.id);
        if (index !== -1) {
          next[index] = {
            ...next[index],
            status: 'loading',
            error: undefined,
            displayUrl: undefined,
            localKey: undefined,
            savedLocal: false,
            startTime: Date.now(),
            retryCount: 0 // 重置重试计数
          };
        }
      });

      return next;
    });

    // 启动所有任务（新的 + 复用的）
    [...newSubTasks, ...tasksToReuse].forEach(task => {
      taskStartTimesRef.current.set(task.id, Date.now());
      isRetryingRef.current.set(task.id, true);
      performRequest(task.id);
    });
  };

  const handleRetrySingle = (subTaskId: string) => {
    updateResult(subTaskId, { status: 'loading', error: undefined, displayUrl: undefined, localKey: undefined, savedLocal: false, startTime: Date.now() });
    taskStartTimesRef.current.set(subTaskId, Date.now());
    isRetryingRef.current.set(subTaskId, true);
    performRequest(subTaskId);
  };

  const handleStopSingle = (subTaskId: string) => {
    isRetryingRef.current.set(subTaskId, false);
    // 不 abort 请求，让它自然完成或失败，但停止重试
    // 如果需要强制停止请求，可以调用 abortControllersRef.current.get(subTaskId)?.abort();
    // 根据需求：停止新的请求，如果有图返回还是要显示的。所以不 abort。
    // 更新状态显示为“停止重试”
    updateResult(subTaskId, { status: 'error', error: '已停止重试' });
  };

  const performRequest = async (subTaskId: string) => {
    const controller = new AbortController();
    abortControllersRef.current.set(subTaskId, controller);
    updateStats('request');
    const startTime = taskStartTimesRef.current.get(subTaskId) || Date.now();

    try {
      const baseUrl = config.apiUrl.replace(/\/+$/, '');
      const hasImage = fileList.length > 0;

      const messages: any[] = [];
      const content: any[] = [];
      if (prompt) {
        content.push({ type: 'text', text: prompt });
      }
      if (hasImage) {
        // 支持多图上传，将所有图片添加到 content 中
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

      let imageUrl: string | null = null;
      
      if (config.stream) {
        const fetchResponse = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, messages, stream: true }),
          signal: controller.signal,
        });

        if (!fetchResponse.ok) throw new Error(fetchResponse.statusText);

        const reader = fetchResponse.body?.getReader();
        const decoder = new TextDecoder();
        let generatedText = '';

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(line.slice(6));
                  const delta = json.choices?.[0]?.delta;
                  if (delta?.content) generatedText += delta.content;
                  if (delta?.reasoning_content) generatedText += delta.reasoning_content;
                } catch (e) { /* ignore */ }
              }
            }
          }
        }
        imageUrl = parseMarkdownImage(generatedText);
      } else {
        const response = await axios.post(
          `${baseUrl}/chat/completions`,
          { model: config.model, messages, stream: false },
          { headers: { ...headers, 'Content-Type': 'application/json' }, signal: controller.signal }
        );
        imageUrl = resolveImageFromResponse(response.data);
      }
      
      if (imageUrl) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const { displayUrl, localKey } = await persistImageLocally(imageUrl, subTaskId);
        updateResult(subTaskId, { status: 'success', displayUrl, localKey, savedLocal: false, endTime, duration });
        updateStats('success', duration);
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
        
        setTimeout(() => {
            if (isRetryingRef.current.get(subTaskId)) { 
                 performRequest(subTaskId);
            } else {
                updateResult(subTaskId, { status: 'error', error: '已停止重试' });
            }
        }, 1000);
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
    isRetryingRef.current.forEach((_: boolean, key: string) => {
      isRetryingRef.current.set(key, false);
    });
    message.info('已停止所有自动重试');
    setIsGlobalLoading(false);
  };

  const handleUploadChange = ({ fileList: newFileList }: any) => {
    setFileList(newFileList);
  };

  const successRate = stats.totalRequests > 0 
    ? Math.round((stats.successCount / stats.totalRequests) * 100) 
    : 0;

  const formatTime = (ms: number) => {
    if (ms === 0) return '0.0s';
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}m ${secs}s`;
  };

  const averageTime = stats.successCount > 0 
    ? formatTime(stats.totalTime / stats.successCount)
    : '0.0s';
  
  const fastestTimeStr = formatTime(stats.fastestTime);
  const slowestTimeStr = formatTime(stats.slowestTime);

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
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)} 
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
                    src={file.thumbUrl || (file.originFileObj ? URL.createObjectURL(file.originFileObj) : '')} 
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
              <Upload
                fileList={fileList}
                onChange={handleUploadChange}
                beforeUpload={() => false}
                multiple
                showUploadList={false}
              >
                <Tooltip title="上传参考图">
                  <Button 
                    size="small" 
                    icon={<UploadOutlined />} 
                    style={fileList.length > 0 ? { 
                      background: '#FF9EB5', color: '#fff', border: 'none' 
                    } : { 
                      background: '#fff', color: '#998888', border: 'none' 
                    }}
                  />
                </Tooltip>
              </Upload>

              <Space size={4} style={{ background: '#fff', padding: '2px 8px', borderRadius: 12, display: 'flex', alignItems: 'center' }}>
                <Text type="secondary" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>并发</Text>
                <input 
                  type="number"
                  min={1} 
                  max={10} 
                  value={concurrency} 
                  onChange={e => setConcurrency(parseInt(e.target.value) || 1)} 
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
              {results.map((result: SubTaskResult) => (
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
                    {result.status === 'success' && result.displayUrl ? (
                      <>
                        <Image
                          src={result.displayUrl}
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
                            {formatTime(result.duration)}
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
                              href={result.displayUrl}
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
                              {result.error === '已停止重试' ? (
                                <Button 
                                  size="small" 
                                  icon={<PlayCircleFilled />} 
                                  onClick={() => handleRetrySingle(result.id)}
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
                    {result.status === 'loading' && result.error && (
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
              ))}
            </div>
          </Image.PreviewGroup>
        )}
      </div>
    </div>
  );
};

export default ImageTask;
