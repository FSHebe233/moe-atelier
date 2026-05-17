import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  Drawer, Input, Button, Tag, 
  Typography, Space, Empty, Spin, 
  Modal, message, Tabs, Badge, Grid, 
  Tooltip, Avatar, Select, Image, Popover
} from 'antd';
import { 
  ReloadOutlined, StarFilled, StarOutlined, 
  PlusCircleFilled, AppstoreFilled,
  FilterFilled, UserOutlined, FileTextOutlined,
  FireFilled, LeftOutlined, RightOutlined,
  CopyOutlined, CompassFilled, CloudUploadOutlined,
  EyeInvisibleOutlined, ArrowLeftOutlined,
  InfoCircleFilled,
  CloudSyncOutlined
} from '@ant-design/icons';
import type { PromptData, PromptItem } from '../types/prompt';
import { safeStorageGet, safeStorageSet } from '../utils/storage';
import { copyTextToClipboard } from '../utils/clipboard';
import { COLORS } from '../theme/colors';

const { Title, Text } = Typography;
const { useBreakpoint } = Grid;

interface PaginationProps {
  current: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}

const RoundedArrowIcon: React.FC<{ direction: 'left' | 'right' }> = ({ direction }) => (
  <span role="img" className="anticon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path 
        d={direction === 'left' ? "M15 18L9 12L15 6" : "M9 6L15 12L9 18"} 
        stroke="currentColor" 
        strokeWidth="4" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

const CutePagination: React.FC<PaginationProps> = ({ current, total, pageSize, onChange }) => {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  // Generate page numbers
  let pages: (number | string)[] = [];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    if (current <= 4) {
      pages = [1, 2, 3, 4, 5, '...', totalPages];
    } else if (current >= totalPages - 3) {
      pages = [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    } else {
      pages = [1, '...', current - 1, current, current + 1, '...', totalPages];
    }
  }

  const renderEllipsis = (start: number, end: number) => {
    const hiddenPages = [];
    for (let i = start; i <= end; i++) {
      hiddenPages.push(i);
    }
  
    const columns = Math.min(hiddenPages.length, 5);
  
    const content = (
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: `repeat(${columns}, 1fr)`, 
        gap: 8, 
        maxHeight: '200px', 
        overflowY: 'auto',
        padding: '8px'
      }} className="hide-scrollbar">
        {hiddenPages.map(page => (
          <div
            key={page}
            onClick={() => onChange(page)}
            style={{
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              cursor: 'pointer',
              transition: 'all 0.2s',
              color: COLORS.text,
              fontSize: 13,
              fontWeight: 500
            }}
            onMouseEnter={(e) => {
               e.currentTarget.style.background = 'rgba(255, 158, 181, 0.2)';
               e.currentTarget.style.color = COLORS.primary;
               e.currentTarget.style.transform = 'scale(1.1)';
            }}
            onMouseLeave={(e) => {
               e.currentTarget.style.background = 'transparent';
               e.currentTarget.style.color = COLORS.text;
               e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {page}
          </div>
        ))}
      </div>
    );
  
    return (
      <Popover 
        content={content} 
        trigger="click" 
        overlayInnerStyle={{ borderRadius: 16, padding: 0 }}
        key={`ellipsis-${start}-${end}`}
        showArrow={false}
        placement="top"
      >
        <span 
          className="cute-pagination-ellipsis" 
          style={{ cursor: 'pointer', userSelect: 'none', padding: '0 4px', transition: 'color 0.2s' }}
          onMouseEnter={(e) => e.currentTarget.style.color = COLORS.primary}
          onMouseLeave={(e) => e.currentTarget.style.color = COLORS.secondary}
        >
          •••
        </span>
      </Popover>
    );
  };

  return (
    <div className="cute-pagination">
      <Button 
        className="cute-pagination-nav"
        disabled={current === 1}
        onClick={() => onChange(current - 1)}
        icon={<RoundedArrowIcon direction="left" />}
        shape="circle"
      />
      <div className="cute-pagination-pages">
        {pages.map((p, idx) => {
          if (p === '...') {
             const prev = pages[idx - 1] as number;
             const next = pages[idx + 1] as number;
             return renderEllipsis(prev + 1, next - 1);
          }
          return (
            <div 
              key={p} 
              className={`cute-pagination-item ${current === p ? 'active' : ''}`}
              onClick={() => onChange(p as number)}
            >
              {p}
            </div>
          );
        })}
      </div>
      <Button 
        className="cute-pagination-nav"
        disabled={current === totalPages}
        onClick={() => onChange(current + 1)}
        icon={<RoundedArrowIcon direction="right" />}
        shape="circle"
      />
    </div>
  );
};

interface PromptDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateTask: (prompt: string) => void;
}

type ExtendedPromptItem = PromptItem & { sectionId: string; sectionTitle: string };

interface PromptCardProps {
  prompt: ExtendedPromptItem;
  favorites: string[];
  revealedImages: Set<string>;
  isNew: boolean;
  isNSFW: (prompt: ExtendedPromptItem) => boolean;
  onToggleFavorite: (e: React.MouseEvent, id: string) => void;
  onToggleReveal: (e: React.MouseEvent, id: string) => void;
  onClick: (prompt: ExtendedPromptItem) => void;
  onContributorClick: (e: React.MouseEvent, name?: string) => void;
  showSectionTag?: boolean;
  timeLabel?: string;
}

const PromptCard: React.FC<PromptCardProps> = ({
  prompt, favorites, revealedImages, isNew, isNSFW,
  onToggleFavorite, onToggleReveal, onClick, onContributorClick, showSectionTag = true, timeLabel = ''
}) => {
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const shortTimeLabel = useMemo(() => {
    if (!timeLabel) return '';
    return timeLabel.split(' ')[0];
  }, [timeLabel]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    const images = prompt.images;
    const shouldAutoScroll = (isHovered || isMobile) && images && images.length > 1;

    if (shouldAutoScroll) {
      interval = setInterval(() => {
        setActiveImageIndex((prev) => (prev + 1) % images.length);
      }, 1500);
    } else {
      setActiveImageIndex(0);
    }
    return () => clearInterval(interval);
  }, [isHovered, prompt.images, isMobile]);

  return (
    <div 
      style={{ 
        cursor: 'pointer',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
      className="moe-card"
      onClick={() => onClick(prompt)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={{ position: 'relative', aspectRatio: '1/1', background: 'var(--c-bg-input)', overflow: 'hidden' }}>
        {prompt.images && prompt.images.length > 0 ? (
          <>
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              {prompt.images.map((imgSrc, idx) => (
                <img 
                  key={idx}
                  src={imgSrc} 
                  alt={prompt.title}
                  style={{ 
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%', 
                    height: '100%', 
                    objectFit: 'cover',
                    opacity: activeImageIndex === idx ? 1 : 0,
                    filter: (isNSFW(prompt) && !revealedImages.has(prompt.id)) ? 'blur(20px)' : 'none',
                    transition: 'opacity 0.5s ease-in-out, filter 0.3s ease',
                    zIndex: activeImageIndex === idx ? 1 : 0
                  }}
                  loading="lazy"
                />
              ))}
            </div>
            {isNSFW(prompt) && !revealedImages.has(prompt.id) && (
              <div 
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--c-bg-card)',
                  backdropFilter: 'blur(4px)',
                  cursor: 'pointer',
                  zIndex: 5
                }}
                onClick={(e) => onToggleReveal(e, prompt.id)}
              >
                <div style={{
                  background: 'rgba(0,0,0,0.6)',
                  borderRadius: 20,
                  padding: '6px 16px',
                  color: 'var(--c-text-white)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  fontWeight: 600
                }}>
                  <EyeInvisibleOutlined />
                  <span>点击显示</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: COLORS.secondary }}>
            <FileTextOutlined style={{ fontSize: 32 }} />
          </div>
        )}
        
        {/* Tags Overlay */}
        <div style={{ 
          position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between',
          zIndex: 10, pointerEvents: 'none'
        }}>
          {/* 左上角：时间 */}
          <div style={{ pointerEvents: 'auto' }}>
            {timeLabel && (
              <div style={{ 
                background: 'var(--c-bg-card)', 
                padding: '2px 8px', 
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 700,
                color: COLORS.text,
                backdropFilter: 'blur(4px)',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}>
                {shortTimeLabel}
              </div>
            )}
          </div>

          {/* 右上角：NEW */}
          <div style={{ pointerEvents: 'auto' }}>
            {isNew && (
              <div style={{ 
                background: COLORS.new, color: 'var(--c-text-white)',
                padding: '2px 6px', borderRadius: 10,
                fontSize: 10, fontWeight: 800,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}>
                NEW
              </div>
            )}
          </div>
        </div>

        {/* 左下角：分类  */}
        {showSectionTag && (
          <div style={{
            position: 'absolute',
            bottom: 10,
            left: 10,
            padding: '2px 8px',
            borderRadius: 10,
            background: 'var(--c-bg-card)',
            color: COLORS.text,
            fontSize: 10,
            fontWeight: 700,
            backdropFilter: 'blur(4px)',
            boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
            zIndex: 10
          }}>
            {prompt.sectionTitle}
          </div>
        )}

        {/* Slideshow Indicator */}
        {prompt.images && prompt.images.length > 1 && (
          <div style={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 4,
            zIndex: 10
          }}>
            {prompt.images.slice(0, 5).map((_, idx) => (
              <div 
                key={idx}
                style={{
                  width: idx === activeImageIndex ? 16 : 6,
                  height: 4,
                  borderRadius: 2,
                  background: idx === activeImageIndex ? 'var(--c-bg-card)' : 'var(--c-bg-card)',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                }}
              />
            ))}
            {prompt.images.length > 5 && (
               <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--c-bg-card)' }} />
            )}
          </div>
        )}

        {/* Favorite Button */}
        <div 
          style={{ 
            position: 'absolute', bottom: 8, right: 8,
            background: 'var(--c-bg-card)',
            width: 28, height: 28, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            zIndex: 10
          }}
          onClick={(e) => onToggleFavorite(e, prompt.id)}
        >
          {favorites.includes(prompt.id) ? 
            <StarFilled style={{ color: COLORS.gold, fontSize: 16 }} /> : 
            <StarOutlined style={{ color: COLORS.textLight, fontSize: 16 }} />
          }
        </div>
      </div>

      <div style={{ padding: '8px 12px 10px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Title level={5} style={{ margin: '0 0 6px 0', color: COLORS.text, fontSize: 18, fontWeight: 700, lineHeight: 1.3 }} ellipsis={{ rows: 1 }}>
          {prompt.title}
        </Title>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {prompt.tags?.slice(0, 3).map(tag => (
            <span key={tag} className="moe-tag" style={{ fontSize: 11, padding: '2px 8px', boxShadow: 'none' }}>#{tag}</span>
          ))}
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 6 }}>
          <div 
            style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', cursor: 'pointer' }}
            onClick={(e) => onContributorClick(e, prompt.contributor)}
            className="contributor-tag"
          >
            <Avatar size={20} icon={<UserOutlined />} style={{ backgroundColor: COLORS.secondary, flexShrink: 0 }} />
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 6, color: COLORS.textLight, transition: 'color 0.2s' }} ellipsis>
              {prompt.contributor || '匿名'}
            </Text>
          </div>
          {prompt.similar && prompt.similar.length > 0 && (
            <div style={{ 
              fontSize: 11, 
              color: COLORS.primary, 
              background: COLORS.accent, 
              padding: '1px 6px', 
              borderRadius: 6,
              flexShrink: 0,
              marginLeft: 8,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center'
            }}>
              {prompt.similar.length} 个变体
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const DEFAULT_DATA_SOURCE = 'https://raw.githubusercontent.com/unknowlei/nanobanana-website/refs/heads/main/public/data.json';
const PROMPT_MANAGER_SOURCE = '/api/prompt-manager';
const BUILTIN_SOURCES = [
  { label: 'nanobanana-website', value: DEFAULT_DATA_SOURCE },
  { label: 'Prompt-Manager', value: PROMPT_MANAGER_SOURCE }
];
const PROMO_NOTE_PATTERNS = [/labnana/i, /aff=/i, /邀请链接/, /分享给你试试/, /通过我的邀请链接/];
const NSFW_KEYWORDS = ['猎奇', '恐怖'];

const hasNsfwKeyword = (value: string) => {
  const normalized = value.trim();
  return NSFW_KEYWORDS.some(keyword => normalized.includes(keyword));
};

const sanitizePromoNotes = (text?: string) => {
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !PROMO_NOTE_PATTERNS.some(pattern => pattern.test(line)));
  return lines.join('\n');
};

const normalizePromptManagerRefs = (refs: unknown): string[] => {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => {
      if (!ref || typeof ref !== 'object') return null;
      const record = ref as Record<string, unknown>;
      const filePath = typeof record.file_path === 'string' ? record.file_path : '';
      if (!filePath) return null;
      if (record.is_placeholder === true || filePath.includes('{{')) return null;
      const position = typeof record.position === 'number' ? record.position : Number.POSITIVE_INFINITY;
      return { filePath, position };
    })
    .filter((value): value is { filePath: string; position: number } => Boolean(value))
    .sort((a, b) => a.position - b.position)
    .map((ref) => ref.filePath);
};

const normalizePromptManagerTimestamp = (createdAt?: string) => {
  if (!createdAt) return null;
  const normalized = createdAt.replace(/\.(\d{3})\d+/, '.$1');
  const iso = /Z|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
};

const buildPromptManagerId = (item: Record<string, unknown>, index: number) => {
  const createdAt = typeof item.created_at === 'string' ? item.created_at : '';
  const timestamp = normalizePromptManagerTimestamp(createdAt);
  const baseId = (typeof item.id === 'string' || typeof item.id === 'number') ? item.id : index;
  if (timestamp) {
    return `imported-${timestamp}-${baseId}`;
  }
  return `pm-${baseId}`;
};

const normalizePromptManagerData = (payload: { data?: Record<string, unknown>[] }): PromptData => {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const prompts = items.map((item, index) => {
    const fallbackId = (typeof item.id === 'string' || typeof item.id === 'number') ? item.id : index;
    const createdAt = normalizePromptManagerTimestamp(typeof item.created_at === 'string' ? item.created_at : '');
    const notes = sanitizePromoNotes(typeof item.description === 'string' ? item.description : '');
    const imageUrl = (typeof item.file_path === 'string' && item.file_path)
      || (typeof item.thumbnail_path === 'string' && item.thumbnail_path)
      || '';
    const tags = Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string' && tag.length > 0) : undefined;
    const refImages = normalizePromptManagerRefs(item.refs);
    return {
      id: buildPromptManagerId(item, index),
      title: typeof item.title === 'string' && item.title ? item.title : `未命名-${fallbackId}`,
      content: typeof item.prompt === 'string' ? item.prompt : '',
      createdAt: createdAt ?? undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
      contributor: typeof item.author === 'string' && item.author ? item.author : undefined,
      notes: notes || undefined,
      images: imageUrl ? [imageUrl] : undefined,
      refs: refImages.length > 0 ? refImages : undefined
    };
  });
  return {
    sections: [
      {
        id: 'prompt-manager',
        title: 'Prompt-Manager',
        prompts
      }
    ]
  };
};

const parsePromptTimestamp = (text: string) => {
  if (!text) return null;
  const match = text.match(/(?:^|[\s/_\-=])(\d{13}|\d{10})(?=[\s/_\-.?&]|$)/);
  if (!match) return null;
  const raw = match[1];
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return raw.length === 10 ? value * 1000 : value;
};

const getPromptTimestamp = (prompt: Pick<PromptItem, 'id' | 'createdAt' | 'images'>) => {
  if (prompt.images?.length) {
    let latest = 0;
    for (const image of prompt.images) {
      const ts = parsePromptTimestamp(image);
      if (ts && ts > latest) latest = ts;
    }
    if (latest) return latest;
  }
  if (typeof prompt.createdAt === 'number' && Number.isFinite(prompt.createdAt)) {
    return prompt.createdAt < 1e12 ? prompt.createdAt * 1000 : prompt.createdAt;
  }
  return parsePromptTimestamp(prompt.id);
};

const formatPromptTime = (prompt: Pick<PromptItem, 'id' | 'createdAt' | 'images'>) => {
  const timestamp = getPromptTimestamp(prompt);
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const STORAGE_KEY_FAVORITES = 'moe-atelier:favorites';
const STORAGE_KEY_SOURCE = 'moe-atelier:prompt-source';
const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;
const CONTRIBUTOR_HEADER_EXPANDED_HEIGHT = 200;
const CONTRIBUTOR_HEADER_COLLAPSED_HEIGHT = 80;
const CONTRIBUTOR_NAME_TARGET_GAP = 16;


const SearchIcon: React.FC<{ color: string; size?: number }> = ({ color, size = 20 }) => (
  <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
    <path d="M750.08 192.512c-154.112-154.112-403.456-154.112-557.568 0s-154.112 403.456 0 557.568c138.24 138.24 352.768 152.064 506.88 42.496l135.68 135.68c25.6 25.6 67.584 25.6 93.184 0s25.6-67.584 0-93.184l-135.68-135.68c109.056-154.112 95.744-368.64-42.496-506.88z m-93.184 464.384c-102.4 102.4-269.312 102.4-371.712 0s-102.4-269.312 0-371.712 269.312-102.4 371.712 0 102.912 269.312 0 371.712z" fill={color}></path>
  </svg>
);

const PromptDrawer: React.FC<PromptDrawerProps> = ({ visible, onClose, onCreateTask }) => {
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [sourceUrl, setSourceUrl] = useState<string>(() => safeStorageGet(STORAGE_KEY_SOURCE) || DEFAULT_DATA_SOURCE);
  const [data, setData] = useState<PromptData | null>(null);
  const [loading, setLoading] = useState(false);
  const isBuiltInSource = BUILTIN_SOURCES.some(source => source.value === sourceUrl);
  const isPromptManagerSource = sourceUrl === PROMPT_MANAGER_SOURCE;
  
  // Tabs: 'all', 'new', 'favorites', or sectionId
  const [activeTab, setActiveTab] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [contributorPage, setContributorPage] = useState(1);
  const PAGE_SIZE = 36;

  const mainListRef = useRef<HTMLDivElement>(null);
  const contributorListRef = useRef<HTMLDivElement>(null);
  const prevSourceRef = useRef<string | null>(null);

  // 投稿人筛选
  const [selectedContributor, setSelectedContributor] = useState<string | null>(null);
  const [contributorActiveSection, setContributorActiveSection] = useState<string>('all');
  const [contributorSelectedTags, setContributorSelectedTags] = useState<string[]>([]);

  // 移动端筛选抽屉
  const [mobileFilterVisible, setMobileFilterVisible] = useState(false);
  const [mobileSearchVisible, setMobileSearchVisible] = useState(false);
  const [mobileSourceVisible, setMobileSourceVisible] = useState(false);
  const [contributorMobileFilterVisible, setContributorMobileFilterVisible] = useState(false);
  const [isFabVisible, setIsFabVisible] = useState(true);

  const mobileInactiveIconColor = COLORS.text;

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = safeStorageGet(STORAGE_KEY_FAVORITES);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Preview Modal State
  const [previewPrompt, setPreviewPrompt] = useState<ExtendedPromptItem | null>(null);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  const [activeVariantIndex, setActiveVariantIndex] = useState(0); // 0: Main, 1+: Variants
  const [imageAspectRatio, setImageAspectRatio] = useState<'landscape' | 'portrait' | null>(null);
  const [modalWidth, setModalWidth] = useState<string | number>('min(1000px, 90vw)');
  const [revealedImages, setRevealedImages] = useState<Set<string>>(new Set());

  // Refs for contributor scroll animation
  const headerRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLDivElement>(null);
  const contributorNameLayoutRef = useRef<{
    left: number;
    bottom: number;
    height: number;
    centerY: number;
    targetLeft: number;
    targetCenterY: number;
  } | null>(null);
  const ticking = useRef(false);

  const syncContributorNameLayout = useCallback(() => {
    if (!headerRef.current || !nameRef.current || !backButtonRef.current) {
      return;
    }

    const headerRect = headerRef.current.getBoundingClientRect();
    const nameRect = nameRef.current.getBoundingClientRect();
    const backRect = backButtonRef.current.getBoundingClientRect();

    contributorNameLayoutRef.current = {
      left: nameRect.left - headerRect.left,
      bottom: nameRect.bottom - headerRect.top,
      height: nameRect.height,
      centerY: nameRect.top - headerRect.top + nameRect.height / 2,
      targetLeft: backRect.right - headerRect.left + CONTRIBUTOR_NAME_TARGET_GAP,
      targetCenterY: backRect.top - headerRect.top + backRect.height / 2
    };
  }, []);

  const handleContributorScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = e.currentTarget.scrollTop;
    
    if (!ticking.current) {
      window.requestAnimationFrame(() => {
        if (!contributorNameLayoutRef.current) {
          syncContributorNameLayout();
        }

        const maxScroll = CONTRIBUTOR_HEADER_EXPANDED_HEIGHT - CONTRIBUTOR_HEADER_COLLAPSED_HEIGHT;
        const progress = Math.min(scrollTop / maxScroll, 1);
        
        if (headerRef.current) {
          headerRef.current.style.height = `${CONTRIBUTOR_HEADER_EXPANDED_HEIGHT - (progress * maxScroll)}px`;
        }

        if (avatarRef.current) {
          // Fade out and shrink avatar
          const opacity = Math.max(0, 1 - (progress * 1.5));
          avatarRef.current.style.opacity = `${opacity}`;
          avatarRef.current.style.transform = `scale(${1 - (0.5 * progress)})`;
          avatarRef.current.style.pointerEvents = progress > 0.5 ? 'none' : 'auto';
        }

        if (nameRef.current) {
          const scale = 1 - (0.3 * progress);
          let translateX = -80 * progress;
          let translateY = 16 * progress;
          const layout = contributorNameLayoutRef.current;

          if (layout) {
            const desiredLeft = layout.left + (layout.targetLeft - layout.left) * progress;
            const desiredCenterY = layout.centerY + (layout.targetCenterY - layout.centerY) * progress;
            const currentCenterY = layout.bottom - (maxScroll * progress) - (layout.height * scale) / 2;
            translateX = desiredLeft - layout.left;
            translateY = desiredCenterY - currentCenterY;
          }

          nameRef.current.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        }

        if (statsRef.current) {
          // Fade out stats quickly
          const opacity = Math.max(0, 1 - (progress * 1.5));
          statsRef.current.style.opacity = `${opacity}`;
          statsRef.current.style.transform = `translateY(${progress * 20}px)`;
          statsRef.current.style.pointerEvents = progress > 0.1 ? 'none' : 'auto';
        }

        ticking.current = false;
      });

      ticking.current = true;
    }
  };

  useEffect(() => {
    if (!selectedContributor) {
      contributorNameLayoutRef.current = null;
      return;
    }

    const animationId = window.requestAnimationFrame(() => {
      syncContributorNameLayout();
    });

    return () => window.cancelAnimationFrame(animationId);
  }, [selectedContributor, isMobile, syncContributorNameLayout]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error('Network response was not ok');
      const jsonData = await response.json();
      const normalizedData = sourceUrl === PROMPT_MANAGER_SOURCE
        ? normalizePromptManagerData(jsonData)
        : jsonData;
      setData(normalizedData);
    } catch (error) {
      message.error('获取数据失败，请检查链接是否正确');
      console.error('Fetch error:', error);
    } finally {
      setLoading(false);
    }
  }, [sourceUrl]);

  useEffect(() => {
    if (!visible || !sourceUrl) return;
    if (prevSourceRef.current === sourceUrl) return;
    prevSourceRef.current = sourceUrl;
    if (!isBuiltInSource) return;
    setActiveTab('all');
    setSelectedTags([]);
    setSearchText('');
    setSelectedContributor(null);
    setContributorActiveSection('all');
    setContributorSelectedTags([]);
    fetchData();
  }, [visible, sourceUrl, isBuiltInSource, fetchData]);

  useEffect(() => {
    if (!visible || !sourceUrl || isBuiltInSource || data) return;
    fetchData();
  }, [visible, sourceUrl, isBuiltInSource, data, fetchData]);

  useEffect(() => {
    safeStorageSet(STORAGE_KEY_FAVORITES, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    safeStorageSet(STORAGE_KEY_SOURCE, sourceUrl);
  }, [sourceUrl]);

  // Reset pagination when filters change
  useEffect(() => {
    setCurrentPage(1);
    if (mainListRef.current) {
      mainListRef.current.scrollTop = 0;
    }
  }, [activeTab, searchText, selectedTags]);

  useEffect(() => {
    setContributorPage(1);
    if (contributorListRef.current) {
      contributorListRef.current.scrollTop = 0;
    }
  }, [selectedContributor, contributorActiveSection, contributorSelectedTags]);

  useEffect(() => {
    const container = mainListRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // 当距离底部小于 100px 时隐藏投稿按钮
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsFabVisible(!isNearBottom);
    };

    container.addEventListener('scroll', handleScroll);
    // 初始化检查
    handleScroll();
    
    return () => container.removeEventListener('scroll', handleScroll);
  }, [loading, data, currentPage, activeTab]);

  const isNewItem = (prompt: Pick<PromptItem, 'id' | 'createdAt' | 'images'>) => {
    const timestamp = getPromptTimestamp(prompt);
    if (!timestamp) return false;
    const delta = Date.now() - timestamp;
    return delta >= 0 && delta <= NEW_WINDOW_MS;
  };

  const toggleFavorite = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setFavorites(prev => 
      prev.includes(id) ? prev.filter(fid => fid !== id) : [...prev, id]
    );
  };

  const isNSFW = (prompt: ExtendedPromptItem) => {
    if (hasNsfwKeyword(prompt.sectionTitle)) return true;
    return prompt.tags?.some(tag => hasNsfwKeyword(tag)) ?? false;
  };

  const toggleReveal = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setRevealedImages(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleUsePrompt = (content: string) => {
    onCreateTask(content);
    setPreviewPrompt(null);
    onClose();
    message.success('已应用提示词 ✨');
  };

  const handleContribute = () => {
    Modal.confirm({
      title: '投稿提示词',
      icon: <CloudUploadOutlined style={{ color: COLORS.primary }} />,
      content: (
        <div>
          <p>欢迎前往投稿页面分享您的提示词！</p>
          <p>投稿地址：<a href="https://bmzxdlj.cn" target="_blank" rel="noopener noreferrer">https://bmzxdlj.cn</a></p>
        </div>
      ),
      okText: '前往投稿',
      cancelText: '取消',
      className: 'moe-modal',
      onOk: () => {
        window.open('https://bmzxdlj.cn', '_blank');
      },
      maskClosable: true,
      centered: true
    });
  };

  const handleContributorClick = (e: React.MouseEvent, name?: string) => {
    e.stopPropagation();
    // 如果已经在预览弹窗中，先关闭弹窗
    if (previewPrompt) {
      setPreviewPrompt(null);
    }
    setSelectedContributor(name || '匿名');
    setContributorActiveSection('all');
    setContributorSelectedTags([]);
  };

  // 数据处理
  const allPrompts = useMemo(() => {
    if (!data) return [];
    return data.sections.flatMap(section => 
      section.prompts.map(p => ({ ...p, sectionId: section.id, sectionTitle: section.title }))
    );
  }, [data]);

  const newPrompts = useMemo(() => allPrompts.filter(isNewItem), [allPrompts]);

  const filteredPrompts = useMemo(() => {
    let result = allPrompts;

    // Filter by Tab
    if (activeTab === 'favorites') {
      result = result.filter(p => favorites.includes(p.id));
    } else if (activeTab === 'new') {
      result = result.filter(isNewItem);
    } else if (activeTab !== 'all') {
      result = result.filter(p => p.sectionId === activeTab);
    }

    // Filter by Search
    if (searchText) {
      const lowerSearch = searchText.toLowerCase();
      result = result.filter(p => 
        p.title.toLowerCase().includes(lowerSearch) || 
        p.content.toLowerCase().includes(lowerSearch) ||
        p.tags?.some(t => t.toLowerCase().includes(lowerSearch)) ||
        (p.contributor && p.contributor.toLowerCase().includes(lowerSearch))
      );
    }

    // Filter by Tags
    if (selectedTags.length > 0) {
      result = result.filter(p => 
        selectedTags.every(tag => p.tags?.includes(tag))
      );
    }

    return result
      .map((prompt, index) => ({ prompt, index }))
      .sort((a, b) => {
        const aNew = isNewItem(a.prompt);
        const bNew = isNewItem(b.prompt);
        if (aNew !== bNew) return aNew ? -1 : 1;
        return a.index - b.index;
      })
      .map(({ prompt }) => prompt);
  }, [allPrompts, activeTab, searchText, selectedTags, favorites]);

  const paginatedPrompts = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredPrompts.slice(start, start + PAGE_SIZE);
  }, [filteredPrompts, currentPage]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    // 从当前 Tab 上下文收集标签
    let contextPrompts = allPrompts;
    if (activeTab === 'favorites') {
      contextPrompts = contextPrompts.filter(p => favorites.includes(p.id));
    } else if (activeTab === 'new') {
      contextPrompts = contextPrompts.filter(isNewItem);
    } else if (activeTab !== 'all') {
      contextPrompts = contextPrompts.filter(p => p.sectionId === activeTab);
    }

    contextPrompts.forEach(p => {
      p.tags?.forEach(t => tags.add(t));
    });
    return Array.from(tags).sort();
  }, [allPrompts, activeTab, favorites]);

  const contributorPrompts = useMemo(() => {
    if (!selectedContributor) return [];
    return allPrompts.filter(p => {
      const pContributor = p.contributor || '匿名';
      return pContributor === selectedContributor;
    }).sort((a, b) => {
      return b.id.localeCompare(a.id);
    });
  }, [allPrompts, selectedContributor]);

  const contributorSections = useMemo(() => {
    const sectionCountMap = new Map<string, number>();
    const fallbackTitleMap = new Map<string, string>();

    contributorPrompts.forEach((p) => {
      sectionCountMap.set(p.sectionId, (sectionCountMap.get(p.sectionId) ?? 0) + 1);
      if (!fallbackTitleMap.has(p.sectionId)) {
        fallbackTitleMap.set(p.sectionId, p.sectionTitle);
      }
    });

    if (!data?.sections?.length) {
      return Array.from(sectionCountMap.entries())
        .filter(([, count]) => count > 0)
        .map(([id, count]) => ({
          id,
          title: fallbackTitleMap.get(id) ?? id,
          count
        }));
    }

    const orderedSections = data.sections
      .map((section) => ({
        id: section.id,
        title: section.title,
        count: sectionCountMap.get(section.id) ?? 0
      }))
      .filter((section) => section.count > 0);

    const knownIds = new Set(orderedSections.map((section) => section.id));
    sectionCountMap.forEach((count, id) => {
      if (count <= 0 || knownIds.has(id)) return;
      orderedSections.push({
        id,
        title: fallbackTitleMap.get(id) ?? id,
        count
      });
    });

    return orderedSections;
  }, [contributorPrompts, data]);

  const contributorTags = useMemo(() => {
    const tags = new Set<string>();
    let filtered = contributorPrompts;
    if (contributorActiveSection !== 'all') {
      filtered = filtered.filter(p => p.sectionId === contributorActiveSection);
    }
    filtered.forEach(p => p.tags?.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [contributorPrompts, contributorActiveSection]);

  const filteredContributorPrompts = useMemo(() => {
    let result = contributorPrompts;
    if (contributorActiveSection !== 'all') {
      result = result.filter(p => p.sectionId === contributorActiveSection);
    }
    if (contributorSelectedTags.length > 0) {
      result = result.filter(p => contributorSelectedTags.every(t => p.tags?.includes(t)));
    }
    return result;
  }, [contributorPrompts, contributorActiveSection, contributorSelectedTags]);

  const paginatedContributorPrompts = useMemo(() => {
    const start = (contributorPage - 1) * PAGE_SIZE;
    return filteredContributorPrompts.slice(start, start + PAGE_SIZE);
  }, [filteredContributorPrompts, contributorPage]);

  // Preview Modal Logic
  const openPreview = (prompt: ExtendedPromptItem) => {
    setPreviewPrompt(prompt);
    setPreviewImageIndex(0);
    setActiveVariantIndex(0);
    setImageAspectRatio(null); // Reset layout detection
    setModalWidth('min(1000px, 90vw)');
  };

  const currentPreviewData = useMemo(() => {
    if (!previewPrompt) return null;
    if (activeVariantIndex === 0) {
      return {
        content: previewPrompt.content,
        contributor: previewPrompt.contributor,
        notes: previewPrompt.notes,
        images: previewPrompt.images || [],
        refs: previewPrompt.refs || []
      };
    } else {
      const variant = previewPrompt.similar?.[activeVariantIndex - 1];
      return {
        content: variant?.content || '',
        contributor: variant?.contributor,
        notes: variant?.notes,
        images: variant?.images?.length ? variant.images : (previewPrompt.images || []),
        refs: previewPrompt.refs || []
      };
    }
  }, [previewPrompt, activeVariantIndex]);

  const previewTimeLabel = useMemo(() => {
    if (!previewPrompt) return '';
    return formatPromptTime(previewPrompt);
  }, [previewPrompt]);

  // Layout Detection
  useEffect(() => {
    if (!currentPreviewData || currentPreviewData.images.length === 0) return;
    
    const img = new window.Image();
    img.src = currentPreviewData.images[previewImageIndex];
    img.onload = () => {
      const isLandscape = img.naturalWidth > img.naturalHeight;
      if (isLandscape) {
        setImageAspectRatio('landscape');
        if (!isMobile) {
          const vh = window.innerHeight;
          const targetHeight = vh * 0.45; // 45vh
          const ratio = img.naturalWidth / img.naturalHeight;
          let targetWidth = targetHeight * ratio;
          
          // Limits
          const minW = 600;
          const maxW = Math.min(1200, window.innerWidth * 0.95);
          
          setModalWidth(Math.max(minW, Math.min(targetWidth, maxW)));
        }
      } else {
        setImageAspectRatio('portrait');
        if (!isMobile) {
          const vh = window.innerHeight;
          const targetImgHeight = vh * 0.8; // 80vh
          const ratio = img.naturalWidth / img.naturalHeight;
          const targetImgWidth = targetImgHeight * ratio;
          
          // Left side is flex: 1.5, Right side is flex: 1. Total flex: 2.5
          // Left width ratio ≈ 0.6
          // We want LeftWidth >= targetImgWidth to avoid vertical scaling
          let targetTotalWidth = targetImgWidth / 0.55; // Use 0.55 to be safe (left width is ~55-60%)

          // Limits
          const minW = 900; // Ensure right side has enough space
          const maxW = Math.min(1400, window.innerWidth * 0.95);

          setModalWidth(Math.max(minW, Math.min(targetTotalWidth, maxW)));
        } else {
          setModalWidth('100%');
        }
      }
    };
  }, [currentPreviewData, previewImageIndex, isMobile]);

  const renderContributorSidebar = () => (
    <div style={{ 
      display: 'flex', flexDirection: 'column', gap: 24,
      height: isMobile ? 'auto' : '100%',
      overflowY: isMobile ? 'visible' : 'auto',
      overflowX: 'hidden',
      padding: isMobile ? 20 : 24,
      background: isMobile ? 'transparent' : 'var(--c-bg-card)',
      backdropFilter: isMobile ? 'none' : 'blur(10px)',
      borderRight: isMobile ? 'none' : `1px solid ${COLORS.accent}`
    }}>
      {/* Section Filter */}
      {!isPromptManagerSource && contributorSections.length > 1 && (
        <div>
          {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
            <AppstoreFilled style={{ marginRight: 8 }} /> 分类
          </Title>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button
              className={`moe-nav-btn ${contributorActiveSection === 'all' ? 'active' : ''}`}
              onClick={() => {
                setContributorActiveSection('all');
                if (isMobile) setContributorMobileFilterVisible(false);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <CompassFilled style={{ color: contributorActiveSection === 'all' ? 'var(--c-bg-card)' : 'var(--c-primary)' }} />
                <span style={{ marginLeft: 8 }}>全部</span>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <Badge count={contributorPrompts.length} overflowCount={99999} style={{ backgroundColor: COLORS.gold }} />
              </div>
            </Button>

            <div style={{ height: 1, background: COLORS.secondary, margin: '8px 0', opacity: 0.5 }}></div>

            {contributorSections.map(section => (
              <Button
                key={section.id}
                className={`moe-nav-btn-secondary ${contributorActiveSection === section.id ? 'active' : ''}`}
                onClick={() => {
                  setContributorActiveSection(section.id);
                  if (isMobile) setContributorMobileFilterVisible(false);
                }}
              >
                <span>{section.title}</span>
                <div style={{ marginLeft: 'auto' }}>
                  <Badge
                    count={section.count}
                    overflowCount={99999}
                    style={{
                      backgroundColor: contributorActiveSection === section.id ? COLORS.primary : 'var(--c-primary-light)',
                      color: contributorActiveSection === section.id ? 'var(--c-bg-card)' : COLORS.textLight
                    }}
                  />
                </div>
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Tags Filter */}
      {contributorTags.length > 0 && (
        <div>
          {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
            <FilterFilled style={{ marginRight: 8 }} /> 标签
          </Title>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: 8 }}>
            {contributorTags.map(tag => (
              <Tag.CheckableTag
                key={tag}
                checked={contributorSelectedTags.includes(tag)}
                onChange={checked => {
                  if (checked) {
                    setContributorSelectedTags([...contributorSelectedTags, tag]);
                  } else {
                    setContributorSelectedTags(contributorSelectedTags.filter(t => t !== tag));
                  }
                }}
                style={{ 
                  border: `1px solid ${contributorSelectedTags.includes(tag) ? COLORS.primary : COLORS.secondary}`, 
                  borderRadius: 12,
                  padding: '4px 2px',
                  margin: 0,
                  background: contributorSelectedTags.includes(tag) ? COLORS.primary : 'transparent',
                  color: contributorSelectedTags.includes(tag) ? 'var(--c-bg-card)' : COLORS.textLight,
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  textAlign: 'center'
                }}
              >
                <div style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</div>
              </Tag.CheckableTag>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // Render Sidebar
  const renderSidebar = () => (
    <div style={{ 
      display: 'flex', flexDirection: 'column', gap: 24,
      height: '100%',
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: isMobile ? 20 : 24,
      background: isMobile ? 'transparent' : 'var(--c-bg-card)',
      backdropFilter: isMobile ? 'none' : 'blur(10px)',
      borderRight: isMobile ? 'none' : `1px solid ${COLORS.accent}`
    }}>
      {!isMobile && (
        <Input 
          size="large"
          prefix={
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <SearchIcon color={COLORS.primary} />
            </span>
          }
          placeholder="搜索提示词..." 
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          className="custom-search-input"
        />
      )}

      {/* Categories */}
      <div>
        {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
          <AppstoreFilled style={{ marginRight: 8 }} /> 分类
        </Title>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { id: 'all', label: '全部', color: 'var(--c-primary)', icon: CompassFilled, badge: allPrompts.length },
            { id: 'new', label: '最新', color: COLORS.new, icon: FireFilled, badge: newPrompts.length },
            { id: 'favorites', label: '我的收藏', color: COLORS.gold, icon: StarFilled, badge: favorites.length }
          ].map(item => {
            const isActive = activeTab === item.id;
            const IconComponent = item.icon;
            let badgeColor: string = COLORS.primary;
            if (item.id === 'all') badgeColor = COLORS.gold;
            if (item.id === 'new') badgeColor = COLORS.new;
            if (item.id === 'favorites') badgeColor = COLORS.gold;

            return (
              <Button 
                key={item.id}
                className={`moe-nav-btn ${isActive ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(item.id);
                  if (isMobile) setMobileFilterVisible(false);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <IconComponent style={{ color: isActive ? 'var(--c-bg-card)' : item.color }} />
                  <span style={{ marginLeft: 8 }}>{item.label}</span>
                </div>
                {item.badge !== undefined ? <div style={{ marginLeft: 'auto' }}><Badge count={item.badge} overflowCount={99999} style={{ backgroundColor: badgeColor }} /></div> : null}
              </Button>
            );
          })}
          
          {!isPromptManagerSource && data?.sections.length ? (
            <>
              <div style={{ height: 1, background: COLORS.secondary, margin: '8px 0', opacity: 0.5 }}></div>
              {data.sections.map(section => (
                <Button 
                  key={section.id}
                  className={`moe-nav-btn-secondary ${activeTab === section.id ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab(section.id);
                    if (isMobile) setMobileFilterVisible(false);
                  }}
                >
                  <span>{section.title}</span>
                  <div style={{ marginLeft: 'auto' }}>
                    <Badge 
                      count={section.prompts.length} 
                      overflowCount={99999} 
                      style={{ 
                        backgroundColor: activeTab === section.id ? COLORS.primary : 'var(--c-primary-light)',
                        color: activeTab === section.id ? 'var(--c-bg-card)' : COLORS.textLight
                      }} 
                    />
                  </div>
                </Button>
              ))}
            </>
          ) : null}
        </div>
      </div>

      {/* Tags */}
      <div>
        {!isMobile && <Title level={5} style={{ color: COLORS.text, marginBottom: 12, fontSize: 14, paddingLeft: 8 }}>
          <FilterFilled style={{ marginRight: 8 }} /> 标签
        </Title>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: 8 }}>
          {availableTags.map(tag => (
            <Tag.CheckableTag
              key={tag}
              checked={selectedTags.includes(tag)}
              onChange={checked => {
                if (checked) {
                  setSelectedTags([...selectedTags, tag]);
                } else {
                  setSelectedTags(selectedTags.filter(t => t !== tag));
                }
              }}
              style={{ 
                border: `1px solid ${selectedTags.includes(tag) ? COLORS.primary : COLORS.secondary}`, 
                borderRadius: 12,
                padding: '4px 2px',
                margin: 0,
                background: selectedTags.includes(tag) ? COLORS.primary : 'transparent',
                color: selectedTags.includes(tag) ? 'var(--c-bg-card)' : COLORS.textLight,
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                textAlign: 'center'
              }}
            >
              <div style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</div>
            </Tag.CheckableTag>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        title={
          isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
              <div className="prompt-drawer-title-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <Space align="center" className="prompt-drawer-title-left">
                  <div style={{ 
                    width: 32, height: 32, borderRadius: 8, background: COLORS.primary, 
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-text-white)' 
                  }}>
                    <AppstoreFilled />
                  </div>
                  <span className="prompt-drawer-title-text" style={{ fontWeight: 800, color: COLORS.text, fontSize: 18 }}>提示词广场</span>
                </Space>
                <Space size={8}>
                  <Button
                    icon={<CloudSyncOutlined style={{ color: mobileSourceVisible ? COLORS.primary : mobileInactiveIconColor, fontSize: 18 }} />}
                    shape="circle"
                    onClick={() => {
                      setMobileSourceVisible((prev) => !prev);
                      setMobileSearchVisible(false);
                    }}
                    className={`mobile-icon-btn circle-icon-btn${mobileSourceVisible ? ' is-active' : ''}`}
                  />
                  <Button
                    icon={<SearchIcon color={mobileSearchVisible ? COLORS.primary : mobileInactiveIconColor} />}
                    shape="circle"
                    onClick={() => {
                      setMobileSearchVisible((prev) => !prev);
                      setMobileSourceVisible(false);
                    }}
                    className={`mobile-icon-btn circle-icon-btn${mobileSearchVisible ? ' is-active' : ''}`}
                  />
                  <Button
                    icon={<FilterFilled style={{ color: mobileFilterVisible ? COLORS.primary : mobileInactiveIconColor, fontSize: 18, transform: 'translateY(1px)' }} />}
                    shape="circle"
                    onClick={() => setMobileFilterVisible(true)}
                    className={`mobile-icon-btn circle-icon-btn${mobileFilterVisible ? ' is-active' : ''}`}
                  />
                </Space>
              </div>
              <div style={{
                height: mobileSearchVisible ? 46 : (mobileSourceVisible ? (isBuiltInSource ? 46 : 94) : 0),
                opacity: (mobileSearchVisible || mobileSourceVisible) ? 1 : 0,
                marginTop: (mobileSearchVisible || mobileSourceVisible) ? 12 : 0,
                overflow: 'hidden',
                transition: 'all 0.3s ease',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: mobileSourceVisible ? 'flex-start' : 'center',
                padding: '0 4px'
              }}>
                {mobileSearchVisible && (
                  <Input 
                    size="large"
                    key="search-input"
                    autoFocus
                    prefix={
                      <span style={{ display: 'flex', alignItems: 'center' }}>
                        <SearchIcon color={COLORS.primary} />
                      </span>
                    }
                    placeholder="搜索提示词..." 
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    className="custom-search-input"
                    style={{ width: '100%' }}
                  />
                )}
                {mobileSourceVisible && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                       <Select
                        size="large"
                        style={{ flex: 1 }}
                        value={isBuiltInSource ? sourceUrl : 'custom'}
                        onChange={(value) => {
                          if (value === 'custom') {
                            setSourceUrl('');
                          } else {
                            setSourceUrl(value);
                          }
                        }}
                        options={[
                          ...BUILTIN_SOURCES,
                          { label: '自定义源', value: 'custom' }
                        ]}
                      />
                      <Button 
                        size="large"
                        className="prompt-refresh-btn" 
                        shape="circle" 
                        icon={<ReloadOutlined spin={loading} />} 
                        onClick={fetchData} 
                      />
                    </div>
                    {!isBuiltInSource && (
                       <Input 
                          size="large"
                          style={{ borderRadius: 12 }} 
                          value={sourceUrl} 
                          onChange={(e) => setSourceUrl(e.target.value)}
                          placeholder="数据源 URL"
                        />
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="prompt-drawer-title-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Space align="center" className="prompt-drawer-title-left">
                <div style={{ 
                  width: 32, height: 32, borderRadius: 8, background: COLORS.primary, 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-text-white)' 
                }}>
                  <AppstoreFilled />
                </div>
                <span className="prompt-drawer-title-text" style={{ fontWeight: 800, color: COLORS.text, fontSize: 18 }}>提示词广场</span>
              </Space>
              <Space size={8}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {sourceUrl === DEFAULT_DATA_SOURCE && (
                    <Button 
                      icon={<CloudUploadOutlined />} 
                      onClick={handleContribute}
                      style={{ 
                        borderRadius: 12,
                        border: `1px solid ${COLORS.secondary}`,
                        color: COLORS.textLight
                      }}
                    >
                      投稿
                    </Button>
                  )}
                  <Select
                    style={{ width: 180 }}
                    value={isBuiltInSource ? sourceUrl : 'custom'}
                    onChange={(value) => {
                      if (value === 'custom') {
                        setSourceUrl('');
                      } else {
                        setSourceUrl(value);
                      }
                    }}
                    options={[
                      ...BUILTIN_SOURCES,
                      { label: '自定义源', value: 'custom' }
                    ]}
                  />
                  <Input 
                    style={{ width: 240, borderRadius: 12 }} 
                    value={sourceUrl} 
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="数据源 URL"
                  />
                  <Button className="prompt-refresh-btn" shape="circle" icon={<ReloadOutlined spin={loading} />} onClick={fetchData} />
                </div>
              </Space>
            </div>
          )
        }
        placement={isMobile ? "bottom" : "top"}
        height="100%"
        push={false}
        onClose={onClose}
        open={visible}
        styles={{
          body: {
            padding: 0,
            background: 'var(--c-bg)',
            backgroundImage: 'var(--moe-dot-bg-image)',
            backgroundSize: 'var(--moe-dot-bg-size)',
            backgroundPosition: 'var(--moe-dot-bg-position)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          },
          header: {
            background: 'var(--c-bg-card)',
            borderBottom: `1px solid ${COLORS.accent}`,
            backdropFilter: 'blur(10px)',
            transition: 'height 0.3s ease',
            alignItems: isMobile ? 'flex-start' : 'center'
          }
        }}
        width={isMobile ? "100%" : undefined}
      >
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
          {/* Desktop Sidebar */}
          {!isMobile && (
            <div style={{ width: 260, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}>
              {renderSidebar()}
            </div>
          )}

          {/* Main Content */}
          <div 
            ref={mainListRef}
            style={{ flex: 1, minWidth: 0, minHeight: 0, padding: isMobile ? 16 : 32, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
          >

            {loading ? (
              <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <Spin size="large" tip="少女祈祷中..." />
              </div>
            ) : filteredPrompts.length === 0 ? (
              <Empty 
                description="没有找到相关提示词~" 
                image={Empty.PRESENTED_IMAGE_SIMPLE} 
                style={{ marginTop: 60, color: COLORS.textLight }} 
              />
            ) : (
              <>
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(200px, 1fr))', 
                  gap: isMobile ? 12 : 24 
                }}>
                  {paginatedPrompts.map(prompt => (
                    <PromptCard
                      key={prompt.id}
                      prompt={prompt}
                      favorites={favorites}
                      revealedImages={revealedImages}
                      isNew={isNewItem(prompt)}
                      isNSFW={isNSFW}
                      onToggleFavorite={toggleFavorite}
                      onToggleReveal={toggleReveal}
                      onClick={openPreview}
                      onContributorClick={handleContributorClick}
                      showSectionTag={!isPromptManagerSource}
                      timeLabel={formatPromptTime(prompt)}
                    />
                  ))}
                </div>
                
                <CutePagination 
                  current={currentPage}
                  total={filteredPrompts.length}
                  pageSize={PAGE_SIZE}
                  onChange={(page) => {
                    setCurrentPage(page);
                    mainListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              </>
            )}
          </div>

          {/* Mobile FAB */}
          {isMobile && sourceUrl === DEFAULT_DATA_SOURCE && (
            <div style={{
              position: 'absolute',
              bottom: 24,
              right: 24,
              zIndex: 100,
              opacity: isFabVisible ? 1 : 0,
              pointerEvents: isFabVisible ? 'auto' : 'none',
              transition: 'opacity 0.3s ease'
            }}>
              <Tooltip title="投稿提示词" placement="left">
                <Button
                  type="primary"
                  shape="circle"
                  size="large"
                  icon={<CloudUploadOutlined style={{ fontSize: 24 }} />}
                  onClick={handleContribute}
                  style={{
                    width: 56,
                    height: 56,
                    boxShadow: '0 4px 16px rgba(255, 158, 181, 0.5)',
                    background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.secondary})`,
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                />
              </Tooltip>
            </div>
          )}
        </div>

        {/* Mobile Filter Drawer */}
        <Drawer
          title="筛选提示词"
          placement="bottom"
          height="70vh"
          onClose={() => setMobileFilterVisible(false)}
          open={mobileFilterVisible && isMobile}
          styles={{ body: { padding: 0 } }}
          push={false}
        >
          {renderSidebar()}
        </Drawer>

        {/* Contributor Profile Drawer */}
        <Drawer
          title={null}
          placement="right"
          width="100%"
          onClose={() => setSelectedContributor(null)}
          open={!!selectedContributor}
          styles={{ 
            body: { 
              padding: 0,
              background: COLORS.bg,
              overflow: 'hidden',
            },
            header: { display: 'none' } 
          }}
          push={false}
          zIndex={1001}
        >
          {selectedContributor && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
              {/* Header Banner */}
              <div 
                ref={headerRef}
                style={{ 
                  height: CONTRIBUTOR_HEADER_EXPANDED_HEIGHT, 
                  position: 'relative',
                  background: `linear-gradient(135deg, ${COLORS.primary}22, ${COLORS.secondary}44)`,
                  overflow: 'hidden',
                  willChange: 'height'
                }}
              >
                {/* Background Image Effect */}
                {contributorPrompts[0]?.images?.[0] && (
                  <div style={{
                    position: 'absolute', top: -20, left: -20, right: -20, bottom: -20,
                    backgroundImage: `url(${contributorPrompts[0].images[0]})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    filter: 'blur(30px) brightness(0.9)',
                    opacity: 0.6
                  }} />
                )}
                
                <div style={{ 
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                  background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.9))'
                }} />

                <div ref={backButtonRef} style={{
                  position: 'absolute',
                  top: 24, left: 24,
                  zIndex: 10
                }}>
                  <Button 
                    icon={<ArrowLeftOutlined />} 
                    shape="circle"
                    onClick={() => setSelectedContributor(null)}
                    className="prompt-refresh-btn"
                  />
                </div>
                {isMobile && (
                   <div style={{
                      position: 'absolute',
                      top: 24, right: 24,
                      zIndex: 10
                   }}>
                      <Button
                        icon={<FilterFilled style={{ color: contributorMobileFilterVisible ? COLORS.primary : COLORS.text }} />}
                        shape="circle"
                        onClick={() => setContributorMobileFilterVisible(true)}
                        className={`prompt-refresh-btn${contributorMobileFilterVisible ? ' is-active' : ''}`}
                      />
                   </div>
                )}

                <div style={{ 
                  position: 'absolute', 
                  bottom: 0, left: 0, right: 0,
                  padding: '0 32px 24px',
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 24
                }}>
                  <div 
                    ref={avatarRef} 
                    style={{ 
                      transformOrigin: 'left bottom',
                      willChange: 'transform'
                    }}
                  >
                    <Avatar 
                      size={100} 
                      icon={<UserOutlined />} 
                      src={contributorPrompts[0]?.images?.[0]}
                      style={{ 
                        backgroundColor: 'var(--c-bg-card)', 
                        boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                        border: '4px solid #fff'
                      }} 
                    />
                  </div>
                  <div style={{ paddingBottom: 12 }}>
                    <div 
                      ref={nameRef}
                      style={{ 
                        transformOrigin: 'left bottom',
                        willChange: 'transform',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <Title level={2} style={{ margin: '0 0 8px', color: COLORS.text }}>
                        {selectedContributor}
                      </Title>
                    </div>
                    <div ref={statsRef} style={{ willChange: 'opacity, transform' }}>
                      <Space size={16}>
                        <div style={{ display: 'flex', alignItems: 'center', color: COLORS.textLight }}>
                          <AppstoreFilled style={{ marginRight: 6 }} />
                          <span style={{ fontWeight: 600, fontSize: 16 }}>{contributorPrompts.length}</span>
                          <span style={{ fontSize: 14, marginLeft: 4 }}>个作品</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', color: COLORS.textLight }}>
                          <FireFilled style={{ marginRight: 6, color: COLORS.new }} />
                          <span style={{ fontWeight: 600, fontSize: 16 }}>{contributorPrompts.reduce((acc, cur) => acc + (isNewItem(cur) ? 1 : 0), 0)}</span>
                          <span style={{ fontSize: 14, marginLeft: 4 }}>近期更新</span>
                        </div>
                      </Space>
                    </div>
                  </div>
                </div>
              </div>

              {/* Content Area */}
              <div style={{ 
                flex: 1, 
                display: 'flex', 
                flexDirection: isMobile ? 'column' : 'row',
                overflow: 'hidden',
                background: 'var(--c-bg-card)'
              }}>
                {/* Filters Sidebar */}
                {!isMobile && (
                  <div style={{ width: 260, flexShrink: 0 }}>
                    {renderContributorSidebar()}
                  </div>
                )}

                {/* Grid */}
                <div 
                  ref={contributorListRef}
                  onScroll={handleContributorScroll}
                  style={{ 
                  flex: 1, 
                  overflowY: 'auto', 
                  padding: 24,
                  background: 'var(--c-bg)',
                  backgroundImage: 'var(--moe-dot-bg-image)',
                  backgroundSize: 'var(--moe-dot-bg-size)',
                  backgroundPosition: 'var(--moe-dot-bg-position)',
                }}>
                  {filteredContributorPrompts.length === 0 ? (
                    <Empty description="没有符合条件的提示词" style={{ marginTop: 60 }} />
                  ) : (
                    <>
                      <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fill, minmax(220px, 1fr))', 
                        gap: isMobile ? 12 : 24 
                      }}>
                        {paginatedContributorPrompts.map(prompt => (
                          <PromptCard
                            key={prompt.id}
                            prompt={prompt}
                            favorites={favorites}
                            revealedImages={revealedImages}
                            isNew={isNewItem(prompt)}
                            isNSFW={isNSFW}
                            onToggleFavorite={toggleFavorite}
                            onToggleReveal={toggleReveal}
                            onClick={openPreview}
                            onContributorClick={() => {}} // No-op in profile
                            showSectionTag={!isPromptManagerSource}
                            timeLabel={formatPromptTime(prompt)}
                          />
                        ))}
                      </div>
                      <CutePagination 
                        current={contributorPage}
                        total={filteredContributorPrompts.length}
                        pageSize={PAGE_SIZE}
                        onChange={(page) => {
                          setContributorPage(page);
                          contributorListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Contributor Mobile Filter Drawer */}
          <Drawer
            title="筛选提示词"
            placement="bottom"
            height="auto"
            onClose={() => setContributorMobileFilterVisible(false)}
            open={contributorMobileFilterVisible && isMobile}
            styles={{ body: { padding: 0, maxHeight: '70vh', overflowY: 'auto' } }}
            push={false}
            zIndex={1003}
          >
            {renderContributorSidebar()}
          </Drawer>
        </Drawer>
      </Drawer>

      {/* Detail Modal */}
      <Modal
        zIndex={1002}
        open={!!previewPrompt}
        onCancel={() => setPreviewPrompt(null)}
        footer={null}
        width={isMobile ? '100%' : modalWidth}
        centered
        destroyOnClose
        style={isMobile ? { maxWidth: '100vw', margin: 0, padding: 0, top: 0 } : {}}
        styles={{ 
          content: { 
            padding: 0, 
            borderRadius: isMobile ? 0 : 20, 
            overflow: 'hidden',
            height: isMobile ? '100vh' : 'auto',
            maxHeight: isMobile ? '100vh' : '90vh',
            display: 'flex',
            flexDirection: 'column'
          },
          body: { 
            height: isMobile ? '100%' : 'auto',
            padding: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            flex: 1
          }
        }}
        closeIcon={
          <div style={{ 
            background: 'rgba(0,0,0,0.1)', borderRadius: '50%', width: 30, height: 30, 
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-text-white)' 
          }}><div style={{marginTop: -2}}>×</div></div>
        }
      >
        {previewPrompt && currentPreviewData && (
          <div style={{ 
            display: 'flex', 
            flexDirection: (isMobile || imageAspectRatio === 'landscape') ? 'column' : 'row',
            height: isMobile ? '100%' : '80vh',
            maxHeight: isMobile ? '100%' : 800,
            background: 'var(--c-bg-card)'
          }}>
            {/* Image Area */}
            <div style={{ 
              flex: (isMobile || imageAspectRatio === 'landscape') ? '0 0 auto' : '1.5',
              background: 'var(--c-bg-input)',
              display: 'flex', 
              flexDirection: 'column',
              alignItems: 'center', 
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              height: (isMobile || imageAspectRatio === 'landscape') ? 'auto' : '100%',
              maxHeight: (isMobile || imageAspectRatio === 'landscape') ? '60vh' : 'unset',
              width: (isMobile || imageAspectRatio === 'landscape') ? '100%' : '55%'
            }}>
              {currentPreviewData.images.length > 0 ? (
                <>
                  <div style={{ width: '100%', flex: (isMobile || imageAspectRatio === 'landscape') ? '0 0 auto' : 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    <Image
                      src={currentPreviewData.images[previewImageIndex]}
                      style={{ 
                        width: '100%', 
                        height: (isMobile || imageAspectRatio === 'landscape') ? 'auto' : '100%', 
                        maxHeight: (isMobile || imageAspectRatio === 'landscape') ? '60vh' : '100%',
                        objectFit: 'contain' 
                      }}
                      width="100%"
                      preview={isMobile ? { maskClassName: 'mobile-hidden-mask' } : undefined}
                    />
                  </div>
                  {/* Image Navigation */}
                  {currentPreviewData.images.length > 1 && (
                    <div style={{ 
                      position: 'absolute',
                      bottom: 20,
                      left: 0,
                      width: '100%', 
                      display: 'flex', 
                      justifyContent: 'center',
                      zIndex: 10,
                      pointerEvents: 'none'
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: 12, 
                        background: 'rgba(0,0,0,0.5)', 
                        backdropFilter: 'blur(4px)',
                        borderRadius: 18, 
                        padding: '6px 12px',
                        pointerEvents: 'auto'
                      }}>
                        <div 
                          style={{ 
                            width: 32, height: 32, borderRadius: '50%',
                            background: 'rgba(255,255,255,0.2)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: '#fff'
                          }}
                          onClick={() => setPreviewImageIndex(prev => (prev - 1 + currentPreviewData.images.length) % currentPreviewData.images.length)}
                        >
                          <LeftOutlined style={{ fontSize: 16 }} />
                        </div>
                        <div style={{ color: '#fff', fontSize: 12, minWidth: 52, textAlign: 'center' }}>
                          {previewImageIndex + 1} / {currentPreviewData.images.length}
                        </div>
                        <div 
                          style={{ 
                            width: 32, height: 32, borderRadius: '50%',
                            background: 'rgba(255,255,255,0.2)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: '#fff'
                          }}
                          onClick={() => setPreviewImageIndex(prev => (prev + 1) % currentPreviewData.images.length)}
                        >
                          <RightOutlined style={{ fontSize: 16 }} />
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <Empty description="暂无预览图" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>

            {/* Info Area */}
            <div style={{ 
              flex: 1, 
              display: 'flex', 
              flexDirection: 'column',
              padding: isMobile ? 20 : 32,
              overflowY: 'auto',
              background: COLORS.bg
            }}>
              {/* Header */}
              <div style={{ marginBottom: 20 }}>
                <Space style={{ marginBottom: 8 }} wrap>
                  {!isPromptManagerSource && (
                    <Tag color="volcano" style={{ borderRadius: 8 }}>{previewPrompt.sectionTitle}</Tag>
                  )}
                  {favorites.includes(previewPrompt.id) && <Tag color="gold" icon={<StarFilled />} style={{ borderRadius: 8 }}>已收藏</Tag>}
                  {isNewItem(previewPrompt) && <Tag color={COLORS.new} style={{ borderRadius: 8 }}>NEW</Tag>}
                </Space>
                <Title level={isMobile ? 4 : 3} style={{ margin: 0, color: COLORS.text }}>{previewPrompt.title}</Title>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                  <Space>
                    <Avatar size="small" icon={<UserOutlined />} style={{ backgroundColor: COLORS.secondary }} />
                    <div 
                      onClick={(e) => handleContributorClick(e, currentPreviewData.contributor)}
                      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                      className="contributor-link"
                    >
                      <Text type="secondary" style={{ transition: 'color 0.2s' }}>
                        {currentPreviewData.contributor || '匿名贡献者'}
                      </Text>
                      <RightOutlined style={{ fontSize: 10, marginLeft: 4, color: COLORS.textLight }} />
                    </div>
                  </Space>
                  {previewTimeLabel && (
                    <Text type="secondary" style={{ fontSize: 12, color: COLORS.textLight }}>
                      {previewTimeLabel}
                    </Text>
                  )}
                </div>
              </div>

              {/* Variants Tabs */}
              {previewPrompt.similar && previewPrompt.similar.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Tabs 
                    activeKey={activeVariantIndex.toString()}
                    onChange={(k) => {
                      setActiveVariantIndex(parseInt(k));
                      setPreviewImageIndex(0);
                    }}
                    type="card"
                    size="small"
                    items={[
                      { label: '主提示词', key: '0' },
                      ...previewPrompt.similar.map((_, i) => ({ label: `变体 ${i + 1}`, key: (i + 1).toString() }))
                    ]}
                  />
                </div>
              )}

              {/* Content Box */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {currentPreviewData.notes && (
                  <div style={{ 
                    background: 'var(--c-bg)', 
                    border: '1px solid var(--c-warning-dark)',
                    borderRadius: 12,
                    padding: '12px 16px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                      <InfoCircleFilled style={{ color: 'var(--c-warning-dark)', fontSize: 16 }} />
                      <div style={{ fontWeight: 600, color: 'var(--c-text-main)', fontSize: 13 }}>投稿者备注</div>
                    </div>
                    <Text style={{ color: 'var(--c-text-main)', fontSize: 13, lineHeight: 1.5, display: 'block' }}>{currentPreviewData.notes}</Text>
                  </div>
                )}

                {currentPreviewData.refs && currentPreviewData.refs.length > 0 && (
                  <div style={{ 
                    background: 'var(--c-bg-card)', 
                    borderRadius: 16,
                    border: `1px solid ${COLORS.accent}`,
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}>
                    <Text type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-text-light)' }}>
                      <FileTextOutlined /> 参考图
                    </Text>
                    <Image.PreviewGroup>
                      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                        {currentPreviewData.refs.map((src, index) => (
                          <div
                            key={`${src}-${index}`}
                            style={{
                              width: 64,
                              height: 64,
                              borderRadius: 12,
                              overflow: 'hidden',
                              border: `1px solid ${COLORS.accent}`,
                              flex: '0 0 auto',
                              background: 'var(--c-bg-card)'
                            }}
                          >
                            <Image
                              src={src}
                              width="100%"
                              height="100%"
                              style={{ objectFit: 'cover', display: 'block' }}
                              preview={isMobile ? { maskClassName: 'mobile-hidden-mask' } : undefined}
                            />
                          </div>
                        ))}
                      </div>
                    </Image.PreviewGroup>
                  </div>
                )}

                <div style={{ 
                  background: 'var(--c-bg-card)', 
                  borderRadius: 16, 
                  border: `1px solid ${COLORS.accent}`,
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)',
                  flex: 1,
                  maxHeight: isMobile ? 200 : 300,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }}>
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 16px',
                    background: 'var(--c-bg-card)',
                    flexShrink: 0
                  }}>
                    <Text type="secondary" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-text-light)' }}>
                      <FileTextOutlined /> 提示词内容
                    </Text>
                    <Tooltip title="复制内容">
                      <Button 
                        type="text" 
                        size="small" 
                        icon={<CopyOutlined />} 
                        style={{ color: COLORS.textLight }}
                        onClick={async () => {
                          const copied = await copyTextToClipboard(currentPreviewData.content);
                          if (copied) {
                            message.success('已复制到剪贴板');
                          } else {
                            message.error('复制失败，请在 HTTPS 环境下访问或手动复制');
                          }
                        }}
                      />
                    </Tooltip>
                  </div>
                  <div style={{ padding: '6px 16px 12px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'monospace', color: COLORS.text }}>
                      {currentPreviewData.content}
                    </Text>
                  </div>
                </div>

                {/* Tags */}
                <div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {previewPrompt.tags?.map(tag => (
                      <Tag key={tag} style={{ 
                        padding: '4px 10px', fontSize: 12, borderRadius: 10, 
                        border: 'none', background: 'var(--c-bg-card)', color: COLORS.textLight 
                      }}>#{tag}</Tag>
                    ))}
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div style={{ display: 'flex', gap: 12, marginTop: 24, paddingTop: 16, borderTop: `1px solid ${COLORS.accent}` }}>
                <Button 
                  type="primary" 
                  size="large" 
                  block 
                  icon={<PlusCircleFilled />}
                  onClick={() => handleUsePrompt(currentPreviewData.content)}
                  style={{ 
                    height: 44, fontSize: 16, borderRadius: 22, 
                    background: `linear-gradient(45deg, ${COLORS.primary}, #FFB2C1)`,
                    border: 'none',
                    boxShadow: '0 4px 12px rgba(255, 143, 171, 0.4)'
                  }}
                >
                  使用此提示词
                </Button>
                <Button 
                  size="large" 
                  icon={favorites.includes(previewPrompt.id) ? <StarFilled style={{ color: COLORS.gold }} /> : <StarOutlined />}
                  onClick={(e) => toggleFavorite(e, previewPrompt.id)}
                  style={{ width: 44, height: 44, borderRadius: '50%', border: `1px solid ${COLORS.secondary}` }}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
      
      <style>{`
        .prompt-card-hover:hover {
          transform: translateY(-4px);
          box-shadow: 0 8px 20px rgba(255, 143, 171, 0.25) !important;
        }
        /* Custom Scrollbar */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #FFC2D1;
          border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #FF8FAB;
        }
        .custom-search-input.ant-input-affix-wrapper {
          border-radius: 50px;
          border: 1px solid #FFE5EC;
          background-color: #fff;
          transition: all 0.3s ease;
          padding: 4px 12px;
          padding-left: 10px;
          height: 38px;
          align-items: center;
        }

        .mobile-icon-btn.ant-btn {
          border: 2px solid #F0F0F0 !important;
          background: #fff !important;
        }

        .mobile-icon-btn.ant-btn.is-active {
          border-color: ${COLORS.primary} !important;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix {
          display: flex;
          align-items: center;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix svg {
          display: block;
          transform: translateY(-1px);
        }
        
        /* 强制覆盖 Ant Design 默认样式以避免“双重框”感 */
        .custom-search-input.ant-input-affix-wrapper > input.ant-input {
          border: none !important;
          box-shadow: none !important;
          background: transparent !important;
          padding-left: 8px; /* 增加一点 input 的 padding 以控制光标位置，但不要太远 */
          font-size: 14px;
        }

        .custom-search-input.ant-input-affix-wrapper .ant-input-prefix {
          margin-inline-end: 0;
        }
        
        .custom-search-input.ant-input-affix-wrapper::before,
        .custom-search-input.ant-input-affix-wrapper::after {
          display: none;
        }
        
        .custom-search-input.ant-input-affix-wrapper:hover {
          border-color: #FFC2D1;
        }
        
        .custom-search-input.ant-input-affix-wrapper-focused,
        .custom-search-input.ant-input-affix-wrapper:focus-within {
          border-color: var(--c-primary);
          box-shadow: 0 0 0 2px rgba(255, 158, 181, 0.2);
        }

        .prompt-drawer-title-row {
          min-height: 40px;
        }

        .prompt-drawer-title-left {
          display: inline-flex;
          align-items: center;
          height: 40px;
        }

        .prompt-drawer-title-text {
          display: inline-flex;
          align-items: center;
          height: 32px;
          line-height: 1;
        }

        .contributor-tag:hover .ant-typography {
          color: ${COLORS.primary} !important;
          text-decoration: underline;
        }

        .contributor-link:hover .ant-typography {
          color: ${COLORS.primary} !important;
          text-decoration: underline;
        }

        .mobile-hidden-mask {
          opacity: 0 !important;
          background: transparent !important;
        }
        
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .hide-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        /* Cute Pagination Styles */
        .cute-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          margin-top: 32px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }
        .cute-pagination-nav {
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
          color: ${COLORS.primary} !important;
          width: 32px !important;
          height: 32px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        .cute-pagination-nav:disabled {
          color: ${COLORS.secondary} !important;
          opacity: 0.5;
        }
        .cute-pagination-nav:not(:disabled):hover {
          background: var(--c-bg-card) !important;
          border-radius: 50%;
        }
        .cute-pagination-pages {
          display: flex;
          align-items: center;
          gap: 4px;
          background: var(--c-bg-card);
          backdrop-filter: blur(4px);
          padding: 4px;
          border-radius: 20px;
          border: 1px solid ${COLORS.accent};
        }
        .cute-pagination-item {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
          color: ${COLORS.textLight};
          transition: all 0.2s ease;
        }
        .cute-pagination-item:hover {
          color: ${COLORS.primary};
          background: var(--c-bg-card);
        }
        .cute-pagination-item.active {
          background: ${COLORS.primary};
          color: var(--c-text-white);
          box-shadow: 0 2px 8px rgba(255, 158, 181, 0.4);
          transform: scale(1.05);
        }
        .cute-pagination-ellipsis {
          color: ${COLORS.secondary};
          font-size: 12px;
          padding: 0 4px;
        }
      `}</style>
    </>
  );
};

export default PromptDrawer;
