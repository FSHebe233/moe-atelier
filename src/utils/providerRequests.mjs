import JSZip from 'jszip';

export const API_FORMATS = [
  'openai',
  'gemini',
  'vertex',
  'novelai',
];

export const GOOGLE_API_FORMATS = ['gemini', 'vertex'];

export const API_VERSION_OPTIONS = ['v1', 'v1beta', 'v1beta1'];

export const DEFAULT_API_BASES = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com',
  novelai: 'https://image.novelai.net',
};

const VERSION_REGEX = /^v1(?:beta1|beta)?$/i;
const API_MARKER_SEGMENTS = new Set(['projects', 'locations', 'publishers', 'models']);
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const DEFAULT_VERTEX_LOCATION = 'us-central1';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_LOCATION_MAP_CACHE = new WeakMap();
const GOOGLE_TOKEN_CACHE = new Map();

export const isSupportedApiFormat = (value) => API_FORMATS.includes(value);

export const coerceApiFormat = (value) => {
  if (value === 'vertex-express') return 'vertex';
  return isSupportedApiFormat(value) ? value : 'openai';
};

export const isGoogleApiFormat = (value) => GOOGLE_API_FORMATS.includes(value);

export const isVersionSegment = (value) => VERSION_REGEX.test(String(value || ''));

const ensureProtocol = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;

const trimUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const withoutActionSuffix = (value) =>
  String(value || '').replace(/:(?:streamGenerateContent|generateContent)$/i, '');

export const resolveApiUrl = (apiUrl, apiFormat) => {
  const trimmed = trimUrl(apiUrl);
  return trimmed || DEFAULT_API_BASES[coerceApiFormat(apiFormat)];
};

export const normalizeApiBase = (apiUrl = '') => {
  const cleaned = withoutActionSuffix(trimUrl(apiUrl));
  if (!cleaned) return { origin: '', segments: [], host: '' };
  try {
    const url = new URL(ensureProtocol(cleaned));
    return {
      origin: `${url.protocol}//${url.host}`,
      segments: url.pathname.split('/').filter(Boolean),
      host: url.host.toLowerCase(),
    };
  } catch {
    return { origin: cleaned, segments: [], host: '' };
  }
};

export const inferApiVersionFromUrl = (apiUrl = '') => {
  const cleaned = trimUrl(apiUrl);
  if (!cleaned) return null;
  try {
    const url = new URL(ensureProtocol(cleaned));
    const segments = url.pathname.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (isVersionSegment(segments[index])) return segments[index];
    }
    return null;
  } catch {
    const segments = cleaned.split('/').filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (isVersionSegment(segments[index])) return segments[index];
    }
    return null;
  }
};

export const resolveApiVersion = (apiUrl, apiVersion, fallback) => {
  const inferred = inferApiVersionFromUrl(apiUrl);
  if (inferred) return inferred;
  const trimmed = String(apiVersion || '').trim();
  return trimmed || fallback;
};

export const extractVertexProjectId = (apiUrl = '') => {
  const { segments } = normalizeApiBase(apiUrl);
  const index = segments.indexOf('projects');
  if (index < 0) return null;
  const candidate = segments[index + 1];
  if (!candidate) return null;
  if (API_MARKER_SEGMENTS.has(candidate)) return null;
  if (isVersionSegment(candidate)) return null;
  return candidate;
};

export const getApiVersionFallback = (apiFormat) => {
  switch (apiFormat) {
    case 'gemini':
      return 'v1beta';
    case 'vertex':
      return 'v1beta1';
    case 'openai':
      return 'v1';
    default:
      return '';
  }
};

const getVertexAuthMode = (config = {}) =>
  config.vertexAuthMode === 'apiKey' ? 'apiKey' : 'json';

export const normalizeVertexModelName = (model = '') => {
  const segments = String(model || '').trim().split('/').filter(Boolean);
  const modelIndex = segments.lastIndexOf('models');
  return modelIndex >= 0 ? segments.slice(modelIndex + 1).join('/') : segments.join('/');
};

const getVertexLocationMap = (items) => {
  if (!Array.isArray(items)) return null;
  const cached = VERTEX_LOCATION_MAP_CACHE.get(items);
  if (cached) return cached;
  const map = new Map();
  items.forEach((item) => {
    const model = normalizeVertexModelName(item?.model);
    const location = String(item?.location || '').trim();
    if (model && location) map.set(model, location);
  });
  VERTEX_LOCATION_MAP_CACHE.set(items, map);
  return map;
};

export const resolveVertexLocation = (config = {}, model = '') => {
  const modelLocation = getVertexLocationMap(config.vertexModelLocations)?.get(
    normalizeVertexModelName(model),
  );
  return (
    modelLocation ||
    String(config.vertexDefaultLocation || config.vertexLocation || '').trim() ||
    DEFAULT_VERTEX_LOCATION
  );
};

const parseServiceAccount = (value) => {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) throw new Error('服务账号 JSON 未配置');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('服务账号 JSON 格式不正确');
  }
};

const base64UrlEncodeBytes = (bytes) => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64ToBytes = (value) => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
};

const encodeJson = (value) => base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));

const importPrivateKey = async (pem) => {
  const body = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(body),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
};

const signServiceAccountJwt = async (serviceAccount) => {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(serviceAccount.private_key_id ? { kid: serviceAccount.private_key_id } : {}),
  };
  const claim = {
    iss: serviceAccount.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${encodeJson(header)}.${encodeJson(claim)}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
};

export const getGoogleAccessToken = async (serviceAccountJson) => {
  const serviceAccount = parseServiceAccount(serviceAccountJson);
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('服务账号 JSON 缺少 client_email 或 private_key');
  }
  const cacheKey = `${serviceAccount.client_email}:${serviceAccount.private_key_id || ''}`;
  const cached = GOOGLE_TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const assertion = await signServiceAccountJwt(serviceAccount);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`获取 Google access token 失败: ${response.status}`);
  const data = await response.json();
  if (!data?.access_token) throw new Error('Google token 响应缺少 access_token');
  GOOGLE_TOKEN_CACHE.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) * 1000),
  });
  return data.access_token;
};

const addBearerPrefix = (apiKey = '') => {
  const trimmed = String(apiKey || '').trim();
  if (!trimmed) return '';
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
};

const insertVersionIfMissing = (segments, version) => {
  if (!version || segments.some(isVersionSegment)) return;
  const markerIndex = segments.findIndex((segment) => API_MARKER_SEGMENTS.has(segment));
  if (markerIndex >= 0) {
    segments.splice(markerIndex, 0, version);
  } else {
    segments.push(version);
  }
};

const ensureMarkerValue = (segments, marker, value) => {
  const index = segments.indexOf(marker);
  if (index === -1) {
    if (!value) return false;
    segments.push(marker, value);
    return true;
  }
  const next = segments[index + 1];
  if (!next || API_MARKER_SEGMENTS.has(next) || isVersionSegment(next)) {
    if (!value) return false;
    segments.splice(index + 1, 0, value);
    return true;
  }
  return true;
};

const applyModelPath = (segments, modelValue) => {
  const modelSegments = modelValue.split('/').filter(Boolean);
  const geminiModelIsPath = modelSegments[0] === 'models';
  const modelIndex = segments.indexOf('models');
  if (geminiModelIsPath) {
    if (modelIndex >= 0) {
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

const setVertexOriginLocation = (origin, host, location) => {
  if (!location || location === 'global' || host !== 'aiplatform.googleapis.com') return origin;
  return origin.replace('//aiplatform.googleapis.com', `//${location}-aiplatform.googleapis.com`);
};

const replaceWithFullModelPath = (segments, version, modelSegments) => {
  segments.splice(0);
  if (version) segments.push(version);
  segments.push(...modelSegments);
};

export const buildGoogleGenerateRequest = async (config = {}, options = {}) => {
  const apiFormat = coerceApiFormat(config.apiFormat);
  if (!isGoogleApiFormat(apiFormat)) {
    throw new Error(`Unsupported Google API format: ${apiFormat}`);
  }

  const apiUrl = resolveApiUrl(config.apiUrl, apiFormat);
  const baseInfo = normalizeApiBase(apiUrl);
  let baseOrigin = baseInfo.origin || trimUrl(apiUrl);
  const version =
    apiFormat === 'vertex' && getVertexAuthMode(config) === 'apiKey'
      ? 'v1'
      : resolveApiVersion(apiUrl, config.apiVersion, getApiVersionFallback(apiFormat));
  const segments = [...baseInfo.segments];
  insertVersionIfMissing(segments, version);

  const modelValue = String(config.model || '').trim();
  if (!modelValue) throw new Error('Model is required');

  const modelSegments = modelValue.split('/').filter(Boolean);
  const modelHasProjectPath = modelSegments.includes('projects');
  const publisher = String(config.vertexPublisher || '').trim() || 'google';

  if (apiFormat === 'gemini') {
    applyModelPath(segments, modelValue);
  } else {
    const vertexAuthMode = getVertexAuthMode(config);
    const location = resolveVertexLocation(config, modelValue);
    baseOrigin = setVertexOriginLocation(baseOrigin, baseInfo.host, location);
    if (vertexAuthMode === 'apiKey') {
      ensureMarkerValue(segments, 'publishers', publisher);
      applyModelPath(segments, modelValue.replace(/^models\//, ''));
    } else {
      const serviceAccount =
        config.vertexAccessToken || config.vertexProjectId ? null : parseServiceAccount(config.apiKey);
      const projectId =
        String(config.vertexProjectId || '').trim() ||
        serviceAccount?.project_id ||
        extractVertexProjectId(apiUrl) ||
        '';
      if (modelHasProjectPath) {
        replaceWithFullModelPath(segments, version, modelSegments);
      } else {
        if (!projectId && !segments.includes('projects')) {
          throw new Error('项目 ID 未配置');
        }
        ensureMarkerValue(segments, 'projects', projectId);
        ensureMarkerValue(segments, 'locations', location);
        ensureMarkerValue(segments, 'publishers', publisher);
        applyModelPath(segments, modelValue.replace(/^models\//, ''));
      }
    }
  }

  const suffix = options.stream ? ':streamGenerateContent' : ':generateContent';
  let url = `${baseOrigin}${segments.length ? `/${segments.join('/')}` : ''}${suffix}`;
  const headers = { 'Content-Type': 'application/json' };
  const isOfficialGemini =
    apiFormat === 'gemini' && baseInfo.host === 'generativelanguage.googleapis.com';
  const isVertexApiKey =
    apiFormat === 'vertex' && getVertexAuthMode(config) === 'apiKey';

  if (isOfficialGemini || isVertexApiKey) {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.apiKey || '')}`;
  } else if (apiFormat === 'vertex' && getVertexAuthMode(config) === 'json') {
    headers.Authorization = addBearerPrefix(
      config.vertexAccessToken || await getGoogleAccessToken(config.apiKey),
    );
  } else {
    headers.Authorization = addBearerPrefix(config.apiKey);
  }

  return { url, headers };
};

export const buildGoogleModelsRequest = async (config = {}) => {
  const apiFormat = coerceApiFormat(config.apiFormat);
  if (!isGoogleApiFormat(apiFormat)) {
    throw new Error(`Unsupported Google API format: ${apiFormat}`);
  }
  const apiUrl = resolveApiUrl(config.apiUrl, apiFormat);
  const baseInfo = normalizeApiBase(apiUrl);
  let baseOrigin = baseInfo.origin || trimUrl(apiUrl);
  const version =
    apiFormat === 'vertex' && getVertexAuthMode(config) === 'apiKey'
      ? 'v1'
      : resolveApiVersion(apiUrl, config.apiVersion, getApiVersionFallback(apiFormat));
  const segments = [...baseInfo.segments];
  insertVersionIfMissing(segments, version);
  const headers = {};

  if (apiFormat === 'gemini') {
    const modelIndex = segments.indexOf('models');
    if (modelIndex >= 0) segments.splice(modelIndex + 1);
    else segments.push('models');
    let url = `${baseOrigin}/${segments.join('/')}`;
    if (baseInfo.host === 'generativelanguage.googleapis.com') {
      url += `?key=${encodeURIComponent(config.apiKey || '')}`;
    } else {
      headers.Authorization = addBearerPrefix(config.apiKey);
    }
    return { url, headers };
  }

  const publisher = String(config.vertexPublisher || '').trim() || 'google';
  const location = resolveVertexLocation(config, config.model);
  baseOrigin = setVertexOriginLocation(baseOrigin, baseInfo.host, location);
  if (getVertexAuthMode(config) === 'apiKey') {
    ensureMarkerValue(segments, 'publishers', publisher);
    const modelIndex = segments.indexOf('models');
    if (modelIndex >= 0) segments.splice(modelIndex + 1);
    else segments.push('models');
    return {
      url: `${baseOrigin}/${segments.join('/')}?key=${encodeURIComponent(config.apiKey || '')}`,
      headers,
    };
  }

  const serviceAccount =
    config.vertexAccessToken || config.vertexProjectId ? null : parseServiceAccount(config.apiKey);
  const projectId =
    String(config.vertexProjectId || '').trim() ||
    serviceAccount?.project_id ||
    extractVertexProjectId(apiUrl) ||
    '';
  if (!projectId && !segments.includes('projects')) throw new Error('项目 ID 未配置');
  ensureMarkerValue(segments, 'projects', projectId);
  ensureMarkerValue(segments, 'locations', location);
  ensureMarkerValue(segments, 'publishers', publisher);
  const modelIndex = segments.indexOf('models');
  if (modelIndex >= 0) segments.splice(modelIndex + 1);
  else segments.push('models');
  headers.Authorization = addBearerPrefix(
    config.vertexAccessToken || await getGoogleAccessToken(config.apiKey),
  );
  return { url: `${baseOrigin}/${segments.join('/')}`, headers };
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));

export const buildGeminiGenerationConfig = (config = {}) => {
  const generationConfig = {};
  if (config.includeImageConfig) {
    const imageSize = config.imageConfig?.imageSize || 'auto';
    const aspectRatio = config.imageConfig?.aspectRatio || 'auto';
    const imageConfig = {};
    if (imageSize && imageSize !== 'auto') {
      imageConfig.imageSize = imageSize;
    }
    if (aspectRatio && aspectRatio !== 'auto') {
      imageConfig.aspectRatio = aspectRatio;
    }
    if (Object.keys(imageConfig).length > 0) {
      generationConfig.imageConfig = imageConfig;
    }
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

export const buildGeminiSafetySettings = (config = {}) => {
  if (!config.includeSafetySettings || !config.safety) return null;
  const entries = Object.entries(config.safety).filter(
    ([, threshold]) => threshold && threshold !== 'OFF',
  );
  if (entries.length === 0) return null;
  return entries.map(([category, threshold]) => ({ category, threshold }));
};

const parseCustomJson = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const mergeGeminiCustomJson = (payload, config = {}) => {
  const custom = parseCustomJson(config.customJson);
  if (!custom) return payload;
  const mergedGenerationConfig = {
    ...(payload.generationConfig || {}),
    ...(custom.generationConfig || {}),
  };
  return {
    ...payload,
    ...custom,
    generationConfig:
      Object.keys(mergedGenerationConfig).length > 0 ? mergedGenerationConfig : undefined,
    safetySettings: custom.safetySettings ?? payload.safetySettings,
  };
};

export const buildGeminiPayload = (contents, config = {}) => {
  const payload = { contents };
  const generationConfig = buildGeminiGenerationConfig(config);
  if (generationConfig) payload.generationConfig = generationConfig;
  const safetySettings = buildGeminiSafetySettings(config);
  if (safetySettings) payload.safetySettings = safetySettings;
  return mergeGeminiCustomJson(payload, config);
};

export const buildOpenAiBaseUrl = (apiUrl, apiVersion) => {
  const baseInfo = normalizeApiBase(apiUrl);
  const basePath = baseInfo.origin
    ? `${baseInfo.origin}${baseInfo.segments.length ? `/${baseInfo.segments.join('/')}` : ''}`
    : trimUrl(apiUrl);
  const version = resolveApiVersion(apiUrl, apiVersion, 'v1');
  return inferApiVersionFromUrl(apiUrl) ? basePath : `${basePath}/${version}`;
};

export const buildOpenAiChatUrl = (openAiBase) =>
  String(openAiBase || '').endsWith('/chat/completions')
    ? openAiBase
    : `${String(openAiBase || '').replace(/\/+$/, '')}/chat/completions`;

export const buildOpenAiImagesUrl = (openAiBase, hasReferenceImages) => {
  const normalized = String(openAiBase || '').replace(/\/+$/, '');
  if (/\/images(?:\/(?:generations|edits))?$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/images/${hasReferenceImages ? 'edits' : 'generations'}`;
};

const getPositiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
};

const getOptionalSeed = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
};

const NEGATIVE_PROMPT_MARKER =
  /(负面提示词|反向提示词|Negative\s+Prompt|Undesired\s+Content|UC)\s*[:：]/i;

export const splitNovelAiPrompt = (prompt = '') => {
  const text = String(prompt || '').trim();
  const match = NEGATIVE_PROMPT_MARKER.exec(text);
  if (!match) return { input: text, uc: '' };
  return {
    input: text.slice(0, match.index).trim(),
    uc: text.slice(match.index + match[0].length).trim(),
  };
};

const joinNovelAiUc = (...items) =>
  items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(', ');

export const buildNovelAiRequest = (config = {}, options = {}) => {
  const apiUrl = resolveApiUrl(config.apiUrl, 'novelai');
  const base = trimUrl(apiUrl);
  const url = /\/ai\/generate-image$/i.test(base) ? base : `${base}/ai/generate-image`;
  const novelAiConfig = config.novelAiConfig && typeof config.novelAiConfig === 'object'
    ? config.novelAiConfig
    : {};
  const prompt = splitNovelAiPrompt(options.prompt);
  const seed = getOptionalSeed(novelAiConfig.seed);
  const custom = parseCustomJson(config.customJson) || {};
  const customParameters =
    custom.parameters && typeof custom.parameters === 'object' && !Array.isArray(custom.parameters)
      ? custom.parameters
      : {};
  const uc = joinNovelAiUc(novelAiConfig.uc, prompt.uc);
  const parameters = {
	    params_version: 3,
	    width: getPositiveInt(novelAiConfig.width, 1024),
	    height: getPositiveInt(novelAiConfig.height, 1024),
    scale: typeof novelAiConfig.scale === 'number' ? novelAiConfig.scale : 5,
    sampler: novelAiConfig.sampler || 'k_euler_ancestral',
    steps: getPositiveInt(novelAiConfig.steps, 28),
    n_samples: 1,
    ucPreset: typeof novelAiConfig.ucPreset === 'number' ? novelAiConfig.ucPreset : 0,
    ...(uc ? { uc } : {}),
    qualityToggle:
      typeof novelAiConfig.qualityToggle === 'boolean' ? novelAiConfig.qualityToggle : true,
    dynamic_thresholding:
      typeof novelAiConfig.dynamicThresholding === 'boolean'
        ? novelAiConfig.dynamicThresholding
        : false,
    sm: Boolean(novelAiConfig.sm),
    sm_dyn: Boolean(novelAiConfig.smDyn),
    cfg_rescale: typeof novelAiConfig.cfgRescale === 'number' ? novelAiConfig.cfgRescale : 0,
    noise_schedule: novelAiConfig.noiseSchedule || 'native',
    ...(seed === null ? {} : { seed }),
    legacy: false,
    add_original_image: false,
    ...customParameters,
  };
  const basePayload = {
    input: prompt.input,
    model: String(config.model || '').trim(),
    action: 'generate',
    parameters,
  };
  const { parameters: _parameters, ...topLevelCustom } = custom;
  const payload = {
    ...basePayload,
    ...topLevelCustom,
    parameters: {
      ...parameters,
      ...(topLevelCustom.parameters || {}),
    },
  };
  return {
    url,
    headers: {
      Authorization: addBearerPrefix(config.apiKey),
      'Content-Type': 'application/json',
    },
    payload,
  };
};

const mimeFromFilename = (filename = '') => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
};

const isImageZipEntry = (entry) => {
  if (!entry || entry.dir) return false;
  const lower = entry.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

export const extractFirstImageFromNovelAiZip = async (arrayBuffer) => {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entry = Object.values(zip.files).find(isImageZipEntry);
  if (!entry) return null;
  const base64 = await entry.async('base64');
  return {
    dataUrl: `data:${mimeFromFilename(entry.name)};base64,${base64}`,
    filename: entry.name,
    mimeType: mimeFromFilename(entry.name),
  };
};
