import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Drawer, Button, Typography, Space, Image, Tooltip, message } from 'antd';
import Icon, { DeleteFilled, DownloadOutlined, PictureFilled, LeftOutlined, RightOutlined, CopyFilled, FileTextOutlined } from '@ant-design/icons';
import { openImageDb, IMAGE_STORE_NAME } from '../utils/imageDb';
import { buildBackendImageUrl } from '../utils/backendApi';
import { copyTextToClipboard } from '../utils/clipboard';
import type { CollectionItem } from '../types/collection';
import { COLORS } from '../theme/colors';

const { Text } = Typography;

const SendFilledSvg = () => (
  <svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor">
    <path d="M1023.200312 43.682936L877.057399 920.640375c-1.899258 10.995705-8.096837 19.592347-18.292854 25.689965-5.29793 2.898868-11.295588 4.598204-17.693089 4.598204-4.19836 0-8.796564-0.99961-13.69465-2.898868l-236.707536-96.762202c-12.994924-5.29793-27.889106-1.499414-36.785631 9.296368l-123.251855 150.341273c-6.897306 8.796564-16.293635 13.094885-27.989066 13.094885-4.898087 0-9.096447-0.799688-12.695041-2.299102-7.197189-2.698946-12.994924-6.997267-17.393206-13.394768-4.398282-6.29754-6.697384-13.194846-6.697384-20.891839V811.083171c0-14.794221 5.098009-28.988676 14.394377-40.484186l478.912925-587.070676-602.864506 521.796174c-4.598204 3.898477-10.995705 4.998048-16.493557 2.698945L23.390863 619.358063C9.296369 614.060133 1.599375 603.664194 0.599766 587.870363c-0.799688-15.194065 5.29793-26.489652 18.292854-33.786802L968.921515 5.997657c5.797735-3.498633 11.795392-5.098009 18.292854-5.098008 7.696993 0 14.594299 2.199141 20.691918 6.397501 12.695041 8.996486 17.593128 21.291683 15.294025 36.385786z" />
  </svg>
);

const SendFilled = (props: any) => <Icon component={SendFilledSvg} {...props} />;

const InboxFilledSvg = () => (
  <svg viewBox="0 0 1092 1024" width="1em" height="1em" fill="currentColor">
    <path d="M893.3376 55.022933v-1.672533C881.732267 31.914667 860.2624 17.066667 835.4816 17.066667H258.4576a65.877333 65.877333 0 0 0-59.528533 36.283733L17.066667 512v478.446933c0 9.898667 6.621867 16.4864 16.520533 16.4864h1025.092267c9.898667 0 16.520533-6.587733 16.520533-16.4864V512L893.3376 55.022933z m-171.963733 588.970667c-8.260267 28.023467-29.764267 32.9728-59.4944 32.9728h-231.492267c-29.730133 0-54.545067-19.797333-62.805333-47.8208L331.195733 512H127.829333L279.9616 116.053333H810.666667L962.7648 512h-201.728s-24.7808 84.138667-39.662933 131.9936z" />
  </svg>
);

const InboxFilled = (props: any) => <Icon component={InboxFilledSvg} {...props} />;

type ResolvedCollectionItem = CollectionItem & { resolvedImage?: string };

type CollectionGroup = {
  key: string;
  prompt: string;
  items: ResolvedCollectionItem[];
  latestTimestamp: number;
};

interface CollectionBoxProps {
  visible: boolean;
  backendMode?: boolean;
  onClose: () => void;
  collectedItems: CollectionItem[];
  onRemoveItem: (id: string) => void;
  onRemoveGroup: (groupKey: string) => void;
  onClear: () => void;
  onCreateTask: (prompt: string, referenceImages: CollectionItem[]) => void;
}

// Helper functions
const isBackendLocalKey = (key: string) => /\.[a-z0-9]+$/i.test(key);
const isUploadCollectionKey = (key?: string) =>
  Boolean(key && key.startsWith('collection:upload:'));
const isUploadCollectionItem = (item: ResolvedCollectionItem) =>
  isUploadCollectionKey(item.localKey) || isUploadCollectionKey(item.id);

const CollectionGroupCard: React.FC<{
  group: CollectionGroup;
  activeIndex: number;
  setActiveIndex: (idx: number) => void;
  onRemoveItem: (id: string) => void;
  onRemoveGroup: (groupKey: string) => void;
  onCreateTask: (prompt: string, referenceImages: CollectionItem[]) => void;
}> = ({ group, activeIndex, setActiveIndex, onRemoveItem, onRemoveGroup, onCreateTask }) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const dragDistanceRef = useRef(0);

  const total = group.items.length;
  // 计算生成图数量（排除参考图）
  const generatedItems = group.items.filter(item => !isUploadCollectionItem(item));
  const generatedCount = generatedItems.length;
  
  const activeItem = group.items[activeIndex] || group.items[0];
  const activeImage = activeItem?.resolvedImage;
  const activeGeneratedIndex = activeItem
    ? generatedItems.findIndex((item) => item.id === activeItem.id)
    : -1;
  const showPager = generatedCount > 1 && activeGeneratedIndex >= 0;
  const downloadName = `collection-${activeItem?.timestamp || Date.now()}.png`;
  
  const allThumbnails = group.items;

  // Auto scroll to active thumbnail
  useEffect(() => {
    if (scrollContainerRef.current && typeof activeIndex === 'number') {
      const container = scrollContainerRef.current;
      const thumbnailNode = container.children[activeIndex] as HTMLElement;
      if (thumbnailNode) {
        const newScrollLeft = thumbnailNode.offsetLeft - (container.clientWidth / 2) + (thumbnailNode.clientWidth / 2);
        container.scrollTo({ left: newScrollLeft, behavior: 'smooth' });
      }
    }
  }, [activeIndex]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    setIsDragging(true);
    setStartX(e.pageX - scrollContainerRef.current.offsetLeft);
    setScrollLeft(scrollContainerRef.current.scrollLeft);
    dragDistanceRef.current = 0;
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !scrollContainerRef.current) return;
    e.preventDefault();
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = (x - startX);
    scrollContainerRef.current.scrollLeft = scrollLeft - walk;
    dragDistanceRef.current = Math.abs(walk);
  };

  const handleCopyPrompt = async () => {
    if (group.prompt && group.prompt !== '无提示词') {
      const copied = await copyTextToClipboard(group.prompt);
      if (copied) {
        message.success('已复制到剪贴板');
      } else {
        message.error('复制失败，请在 HTTPS 环境下访问或手动复制');
      }
    }
  };

  const handleCreateTask = () => {
    const referenceImages = group.items.filter(isUploadCollectionItem);
    onCreateTask(group.prompt === '无提示词' ? '' : group.prompt, referenceImages);
  };

  const handleRemoveGroup = () => {
    onRemoveGroup(group.key);
  };

  return (
    <div
      className="collection-card"
      style={{
        background: COLORS.white,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(255, 143, 171, 0.1)',
        border: `1px solid ${COLORS.accent}`,
      }}
    >
      {/* 图片区域 */}
      <div style={{ position: 'relative', aspectRatio: '4/3', background: '#FAFAFA' }}>
        {activeImage ? (
          <Image.PreviewGroup
            items={allThumbnails.map(i => i.resolvedImage).filter(Boolean) as string[]}
            preview={{
                current: activeIndex,
                onChange: (current) => setActiveIndex(current),
            }}
          >
            <Image
              src={activeImage}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              wrapperStyle={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
            />
          </Image.PreviewGroup>
        ) : (
          <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.secondary,
          }}>
            <PictureFilled style={{ fontSize: 48 }} />
          </div>
        )}

        {/* 顶部信息覆盖层 */}
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          zIndex: 2,
        }}>
          <div style={{
            background: 'rgba(255,255,255,0.95)',
            padding: '4px 10px',
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.text,
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
          }}>
            {generatedCount} 张图片
          </div>
          {activeItem && (
            <div style={{
              background: 'rgba(255,255,255,0.95)',
              padding: '4px 10px',
              borderRadius: 12,
              fontSize: 10,
              color: COLORS.textLight,
              backdropFilter: 'blur(4px)',
              boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}>
              {new Date(activeItem.timestamp).toLocaleString()}
            </div>
          )}
        </div>

        {/* 左右切换按钮 */}
        {total > 1 && (
          <>
            <div
              style={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.9)',
                backdropFilter: 'blur(4px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                zIndex: 2,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setActiveIndex((activeIndex - 1 + total) % total);
              }}
            >
              <LeftOutlined style={{ color: COLORS.text, fontSize: 14 }} />
            </div>
            <div
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.9)',
                backdropFilter: 'blur(4px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                zIndex: 2,
              }}
              onClick={(e) => {
                e.stopPropagation();
                setActiveIndex((activeIndex + 1) % total);
              }}
            >
              <RightOutlined style={{ color: COLORS.text, fontSize: 14 }} />
            </div>
          </>
        )}

        {/* 底部操作按钮 */}
        <div style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          display: 'flex',
          gap: 6,
          zIndex: 2,
        }}>
          {activeImage && (
            <Tooltip title="下载">
              <a
                href={activeImage}
                download={downloadName}
                style={{ display: 'inline-flex' }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.95)',
                  backdropFilter: 'blur(4px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                  cursor: 'pointer',
                }}>
                  <DownloadOutlined style={{ color: COLORS.text, fontSize: 14 }} />
                </div>
              </a>
            </Tooltip>
          )}
          {activeItem && (
            <Tooltip title="移除当前图片">
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.95)',
                  backdropFilter: 'blur(4px)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                  cursor: 'pointer',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveItem(activeItem.id);
                }}
              >
                <DeleteFilled style={{ color: '#FF5252', fontSize: 14 }} />
              </div>
            </Tooltip>
          )}
        </div>

        {/* 底部页码指示器 */}
        {showPager && (
          <div style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.5)',
            borderRadius: 12,
            padding: '2px 10px',
            color: '#fff',
            fontSize: 11,
            zIndex: 2,
          }}>
            {activeGeneratedIndex + 1} / {generatedCount}
          </div>
        )}
      </div>

      {/* 缩略图行 */}
      {allThumbnails.length > 1 && (
        <div 
          ref={scrollContainerRef}
          className="thumbnail-scroll-container"
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          style={{
            padding: '10px 12px',
            borderTop: `1px solid ${COLORS.accent}`,
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
        >
          {allThumbnails.map((item, index) => {
            const isActive = index === activeIndex;
            const isReference = isUploadCollectionItem(item);
            return (
              <div
                key={item.id}
                onClick={() => {
                  if (dragDistanceRef.current < 5) {
                    setActiveIndex(index);
                  }
                }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  overflow: 'hidden',
                  border: isActive 
                    ? `2px solid ${COLORS.primary}` 
                    : `1px solid ${isReference ? COLORS.secondary : '#eee'}`,
                  cursor: 'pointer',
                  flexShrink: 0,
                  background: '#f5f5f5',
                  position: 'relative',
                  userSelect: 'none',
                }}
              >
                {item.resolvedImage ? (
                  <img
                    src={item.resolvedImage}
                    alt=""
                    draggable={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                ) : (
                  <div style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ccc',
                  }}>
                    <PictureFilled style={{ fontSize: 14 }} />
                  </div>
                )}
                {isReference && (
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    background: 'rgba(255, 158, 181, 0.9)',
                    color: '#fff',
                    fontSize: 8,
                    textAlign: 'center',
                    padding: '1px 0',
                  }}>
                    参考
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 提示词区域 */}
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{
          background: COLORS.bg,
          borderRadius: 12,
          padding: 12,
          border: `1px solid ${COLORS.accent}`,
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginBottom: 8 
          }}>
            <Text type="secondary" style={{ fontSize: 11, color: COLORS.textLight }}>
              <FileTextOutlined style={{ marginRight: 4 }} />
              提示词
            </Text>
            <Space size={2}>
              {group.prompt !== '无提示词' && (
                <Tooltip title="复制提示词">
                  <Button 
                    type="text" 
                    size="small" 
                    icon={<CopyFilled style={{ fontSize: 12 }} />}
                    onClick={handleCopyPrompt}
                    style={{ 
                      height: 20, 
                      width: 20, 
                      minWidth: 20,
                      padding: 0,
                      color: COLORS.textLight 
                    }}
                  />
                </Tooltip>
              )}
              <Tooltip title="以此提示词新建任务">
                <Button 
                  type="text" 
                  size="small" 
                  icon={<SendFilled style={{ fontSize: 12 }} />}
                  onClick={handleCreateTask}
                  style={{ 
                    height: 20, 
                    width: 20, 
                    minWidth: 20,
                    padding: 0,
                    color: COLORS.textLight 
                  }}
                />
              </Tooltip>
              <Tooltip title="删除此卡片">
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteFilled style={{ fontSize: 12 }} />}
                  onClick={handleRemoveGroup}
                  style={{
                    height: 20,
                    width: 20,
                    minWidth: 20,
                    padding: 0,
                    color: '#FF5252',
                  }}
                />
              </Tooltip>
            </Space>
          </div>
          <div style={{
            maxHeight: 80,
            overflowY: 'auto',
          }}>
            <Text style={{ 
              fontSize: 13, 
              color: group.prompt === '无提示词' ? COLORS.textLight : COLORS.text,
              lineHeight: 1.5,
              fontStyle: group.prompt === '无提示词' ? 'italic' : 'normal',
              wordBreak: 'break-word',
            }}>
              {group.prompt}
            </Text>
          </div>
        </div>
      </div>
    </div>
  );
};

const CollectionBox: React.FC<CollectionBoxProps> = ({
  visible,
  onClose,
  collectedItems,
  onRemoveItem,
  onRemoveGroup,
  onClear,
  onCreateTask,
  backendMode = false,
}) => {
  const dbPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const objectUrlMapRef = useRef<Map<string, string>>(new Map());
  const [imageCacheVersion, setImageCacheVersion] = useState(0);
  const [activeIndexes, setActiveIndexes] = useState<Record<string, number>>({});
  const hasOpenedRef = useRef(visible);
  if (visible && !hasOpenedRef.current) {
    hasOpenedRef.current = true;
  }
  const hasOpened = hasOpenedRef.current;
  const collectedGeneratedCount = useMemo(
    () => collectedItems.filter((item) => !isUploadCollectionItem(item)).length,
    [collectedItems],
  );

  const getImageDb = () => {
    if (typeof indexedDB === 'undefined') return null;
    if (!dbPromiseRef.current) {
      dbPromiseRef.current = openImageDb().catch((err) => {
        console.warn('Failed to open image cache:', err);
        dbPromiseRef.current = null;
        return Promise.reject(err);
      });
    }
    return dbPromiseRef.current;
  };

  const readCachedImage = async (key: string): Promise<Blob | null> => {
    const dbPromise = getImageDb();
    if (!dbPromise) return null;
    try {
      const db = await dbPromise;
      return await new Promise<Blob | null>((resolve) => {
        const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
        const store = tx.objectStore(IMAGE_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
          const value = request.result as { blob?: Blob } | undefined;
          resolve(value?.blob || null);
        };
        request.onerror = () => resolve(null);
      });
    } catch (err) {
      console.warn('Failed to read image cache:', err);
      return null;
    }
  };

  useEffect(() => {
    let isActive = true;
    const activeKeys = new Set(
      collectedItems
        .map((item) => item.localKey)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
    );
    const cacheKeys = backendMode
      ? new Set(Array.from(activeKeys).filter((key) => !isBackendLocalKey(key)))
      : activeKeys;

    if (backendMode && cacheKeys.size === 0) {
      if (objectUrlMapRef.current.size > 0) {
        objectUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
        objectUrlMapRef.current.clear();
        setImageCacheVersion((prev) => prev + 1);
      }
      return () => {
        isActive = false;
      };
    }

    objectUrlMapRef.current.forEach((url, key) => {
      if (cacheKeys.has(key)) return;
      URL.revokeObjectURL(url);
      objectUrlMapRef.current.delete(key);
    });

    const loadMissing = async () => {
      for (const key of cacheKeys) {
        if (objectUrlMapRef.current.has(key)) continue;
        const blob = await readCachedImage(key);
        if (!isActive) return;
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        objectUrlMapRef.current.set(key, url);
        setImageCacheVersion((prev) => prev + 1);
      }
    };

    void loadMissing();
    return () => {
      isActive = false;
    };
  }, [collectedItems, backendMode]);

  useEffect(() => {
    return () => {
      objectUrlMapRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlMapRef.current.clear();
    };
  }, []);

  const normalizePrompt = (prompt: string) =>
    prompt.trim().replace(/\s+/g, ' ');

  const buildPromptKey = (prompt: string) => {
    const normalized = normalizePrompt(prompt);
    return normalized ? normalized.toLowerCase() : '__empty__';
  };

  const resolvedItems = useMemo(() => {
    return collectedItems.map((item) => {
      let resolvedImage = item.image;
      if (item.localKey) {
        if (backendMode && isBackendLocalKey(item.localKey)) {
          resolvedImage = buildBackendImageUrl(item.localKey);
        } else {
          resolvedImage = objectUrlMapRef.current.get(item.localKey) || item.image;
        }
      }
      return { ...item, resolvedImage };
    });
  }, [collectedItems, backendMode, imageCacheVersion]);

  const groupedItems = useMemo(() => {
    const sortGroupItems = (a: ResolvedCollectionItem, b: ResolvedCollectionItem) => {
      const aUpload = isUploadCollectionItem(a);
      const bUpload = isUploadCollectionItem(b);
      if (aUpload !== bUpload) {
        return aUpload ? -1 : 1; // 上传的排前面
      }
      return b.timestamp - a.timestamp;
    };
    const dedupeUploads = (items: ResolvedCollectionItem[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        if (!isUploadCollectionItem(item)) return true;
        const key = item.sourceSignature ||
          (isUploadCollectionKey(item.id)
            ? item.id
            : item.localKey || item.image || item.id);
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const groups = new Map<string, CollectionGroup>();
    const sortedItems = [...resolvedItems].sort((a, b) => b.timestamp - a.timestamp);
    sortedItems.forEach((item) => {
      const rawPrompt = item.prompt || '';
      const normalized = normalizePrompt(rawPrompt);
      const key = buildPromptKey(rawPrompt);
      const displayPrompt = normalized || '无提示词';
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          key,
          prompt: displayPrompt,
          items: [item],
          latestTimestamp: item.timestamp,
        });
        return;
      }
      existing.items.push(item);
      existing.latestTimestamp = Math.max(existing.latestTimestamp, item.timestamp);
      if (!existing.prompt || existing.prompt === '无提示词') {
        existing.prompt = displayPrompt;
      }
    });
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        items: dedupeUploads(group.items.sort(sortGroupItems)),
      }))
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }, [resolvedItems]);

  useEffect(() => {
    setActiveIndexes((prev) => {
      const next: Record<string, number> = {};
      groupedItems.forEach((group) => {
        const maxIndex = Math.max(0, group.items.length - 1);
        const current = prev[group.key];
        if (typeof current === 'number') {
          next[group.key] = Math.min(current, maxIndex);
          return;
        }
        const firstGenerated = group.items.findIndex(
          (item) => !isUploadCollectionItem(item),
        );
        next[group.key] = firstGenerated >= 0 ? firstGenerated : 0;
      });
      return next;
    });
  }, [groupedItems]);

  return (
    <>
      <Drawer
        title={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <Space>
              <InboxFilled style={{ color: COLORS.primary, fontSize: 18 }} />
              <span style={{ fontWeight: 800, color: '#665555' }}>图片收纳盒</span>
              <span style={{ 
                background: COLORS.accent, 
                padding: '2px 8px', 
                borderRadius: 10, 
                fontSize: 12, 
                color: COLORS.primary,
                fontWeight: 600
              }}>
                {collectedGeneratedCount}
              </span>
            </Space>
            {collectedItems.length > 0 && (
              <Button 
                size="small" 
                icon={<DeleteFilled />}
                onClick={onClear}
                style={{ 
                  background: 'rgba(255,255,255,0.6)', 
                  border: '1px solid #FF9EB5', 
                  color: '#FF9EB5' 
                }}
              >
                清空
              </Button>
            )}
          </div>
        }
        placement="right"
        onClose={onClose}
        open={visible}
        forceRender
        width={400}
        mask={false}
        rootClassName={`collection-drawer${hasOpened ? '' : ' collection-drawer-unopened'}`}
        styles={{
          wrapper: {
            overflow: 'visible',
            boxShadow: visible ? '-4px 0 16px rgba(0,0,0,0.05)' : 'none',
          },
        }}
        bodyStyle={{ padding: 0, background: '#FFFFFF' }}
        headerStyle={{ borderBottom: `1px solid ${COLORS.accent}`, background: 'rgba(255,255,255,0.95)' }}
        drawerRender={(node) => (
          <div className="collection-drawer-shell">
            <div
              className="collection-drawer-handle"
              onClick={() => onClose()}
              style={{ left: -20 }}
            >
              <svg width="20" height="135" viewBox="0 0 20.42 135.19" style={{ display: 'block' }}>
                <path
                  d="M3.68,40.65c-2.41,4.09-3.68,8.75-3.68,13.5v26.9c0,4.75,1.27,9.41,3.68,13.5l10.55,17.92c4.06,6.89,6.19,14.74,6.19,22.73V0c0,7.99-2.14,15.84-6.19,22.73L3.68,40.65Z"
                  fill="#fff"
                />
              </svg>
              <div className="collection-drawer-handle-icon">
                <LeftOutlined
                  style={{
                    fontSize: 16,
                    transform: visible ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform var(--dur-base) var(--ease-out-quart)',
                  }}
                />
              </div>
            </div>
            <div className="collection-drawer-panel">
              {node}
            </div>
          </div>
        )}
      >
        {collectedItems.length === 0 ? (
          <div style={{ 
            height: '100%', 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            gap: 16,
            padding: 32
          }}>
            <div style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: COLORS.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <InboxFilled style={{ fontSize: 36, color: COLORS.primary }} />
            </div>
            <Text style={{ fontSize: 14, color: COLORS.textLight, textAlign: 'center' }}>
              暂无收藏图片
            </Text>
            <Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
              开启自动收纳后生成的图片将出现在这里
            </Text>
          </div>
        ) : (
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            gap: 16, 
            padding: 16,
            minHeight: '100%'
          }}>
            {groupedItems.map((group) => (
              <CollectionGroupCard
                key={group.key}
                group={group}
                activeIndex={activeIndexes[group.key] ?? 0}
                setActiveIndex={(idx) => setActiveIndexes(prev => ({ ...prev, [group.key]: idx }))}
                onRemoveItem={onRemoveItem}
                onRemoveGroup={onRemoveGroup}
                onCreateTask={onCreateTask}
              />
            ))}
          </div>
        )}
      </Drawer>
    </>
  );
};

export default CollectionBox;
