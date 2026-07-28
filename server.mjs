import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import {
  backendImagesDir,
  backendLogRequests,
  backendPassword,
  backendTasksDir,
  distDir,
  isProd,
  port,
  rootDir,
  DEFAULT_BACKEND_CONFIG,
  DEFAULT_CONCURRENCY,
  DEFAULT_GLOBAL_STATS,
  DEFAULT_TASK_STATS,
  coerceApiFormat,
  pickFormatConfig,
} from './server/config.mjs'
import { pickPort } from './scripts/port-select.mjs'
import {
  logBackendOutbound,
  logBackendRequest,
  logBackendResponse,
  describeFetchError,
} from './server/logger.mjs'
import { addSseClient, removeSseClient, sendSseEvent } from './server/sse.mjs'
import {
  buildBackendStateSnapshot,
  createDefaultTaskState,
  loadBackendCollection,
  loadBackendState,
  loadBackendStateSnapshot,
  loadTaskState,
  loadWorkflowProject,
  normalizeCollectionPayloadForSave,
  normalizeConcurrency,
  normalizeRetryInterval,
  normalizeRetryLimit,
  normalizeTaskName,
  normalizeWorkflowState,
  listWorkflowProjects,
  saveBackendCollection,
  saveBackendState,
  saveTaskState,
  saveWorkflowProject,
  deleteWorkflowProject,
} from './server/storage.mjs'
import { parseMarkdownImage, resolveImageFromResponse } from './server/imageParser.mjs'
import { getMimeFromFilename, saveBackendImageBuffer, saveImageBuffer } from './server/imageStore.mjs'
import {
  buildGeminiPayload,
  buildGoogleGenerateRequest,
  buildNovelAiRequest,
  buildOpenAiBaseUrl,
  buildOpenAiChatUrl,
  buildOpenAiImagesUrl,
  coerceApiFormat as coerceProviderApiFormat,
  extractFirstImageFromNovelAiZip,
  isGoogleApiFormat,
  resolveApiUrl,
} from './src/utils/providerRequests.mjs'

const readRequestBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const ORPHAN_CLEANUP_DELAY_MS = 1500

let orphanCleanupTimer = null

const collectImageKeysFromTask = (taskState) => {
  const keys = new Set()
  const uploads = Array.isArray(taskState?.uploads) ? taskState.uploads : []
  const results = Array.isArray(taskState?.results) ? taskState.results : []
  const workflowNodes = Array.isArray(taskState?.workflow?.nodes)
    ? taskState.workflow.nodes
    : []
  uploads.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  results.forEach((item) => {
    if (!item?.localKey) return
    keys.add(path.basename(item.localKey))
  })
  workflowNodes.forEach((node) => {
    const metadata = node?.metadata || {}
    const localKey = typeof metadata.localKey === 'string' ? metadata.localKey : ''
    const sourceKey = extractBackendImageKeyFromUrl(metadata.sourceUrl || metadata.content)
    const key = localKey || sourceKey
    if (key) keys.add(path.basename(key))
  })
  return keys
}

const getRemovedImageKeys = (prevState, nextState) => {
  const prevKeys = collectImageKeysFromTask(prevState)
  const nextKeys = collectImageKeysFromTask(nextState)
  const removed = []
  for (const key of prevKeys) {
    if (!nextKeys.has(key)) removed.push(key)
  }
  return removed
}

const extractBackendImageKeyFromUrl = (value) => {
  if (typeof value !== 'string') return ''
  const match = value.match(/\/api\/backend\/image\/([^?]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const getCollectionImageKey = (item) => {
  const localKey = typeof item?.localKey === 'string' ? item.localKey : ''
  const imageKey = extractBackendImageKeyFromUrl(item?.image)
  const key = localKey || imageKey
  return key ? path.basename(String(key)) : ''
}

const getTaskFilePath = (taskId) => path.join(backendTasksDir, `${taskId}.json`)

const collectImageKeysFromCollection = (items) => {
  const keys = new Set()
  if (!Array.isArray(items)) return keys
  items.forEach((item) => {
    const key = getCollectionImageKey(item)
    if (!key) return
    keys.add(key)
  })
  return keys
}

const listTaskIds = async () => {
  try {
    const entries = await fs.promises.readdir(backendTasksDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.basename(entry.name, '.json'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

const collectAllReferencedImageKeys = async () => {
  const keys = new Set()
  const taskIds = await listTaskIds()
  for (const taskId of taskIds) {
    const taskState = await loadTaskState(taskId)
    if (!taskState) continue
    const taskKeys = collectImageKeysFromTask(taskState)
    taskKeys.forEach((key) => keys.add(key))
  }
  const collectionItems = await loadBackendCollection()
  const collectionKeys = collectImageKeysFromCollection(collectionItems)
  collectionKeys.forEach((key) => keys.add(key))
  const workflowProjects = await listWorkflowProjects()
  workflowProjects.forEach((project) => {
    collectImageKeysFromTask({ workflow: project.state }).forEach((key) => keys.add(key))
  })
  return keys
}

const cleanupUnusedImages = async (removedKeys = []) => {
  if (!removedKeys.length) return
  const referencedKeys = await collectAllReferencedImageKeys()
  for (const key of removedKeys) {
    const safeKey = path.basename(String(key))
    if (!safeKey || referencedKeys.has(safeKey)) continue
    const filePath = path.join(backendImagesDir, safeKey)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const cleanupOrphanedImages = async () => {
  let entries = []
  try {
    entries = await fs.promises.readdir(backendImagesDir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return
    throw err
  }
  const referencedKeys = await collectAllReferencedImageKeys()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (referencedKeys.has(entry.name)) continue
    const filePath = path.join(backendImagesDir, entry.name)
    await fs.promises.unlink(filePath).catch(() => undefined)
  }
}

const scheduleOrphanCleanup = () => {
  if (orphanCleanupTimer) return
  orphanCleanupTimer = setTimeout(() => {
    orphanCleanupTimer = null
    cleanupOrphanedImages().catch((err) => {
      console.warn('清理后端图片缓存失败:', err)
    })
  }, ORPHAN_CLEANUP_DELAY_MS)
}

const buildResultCollectionKey = (subTaskId, endTime) =>
  `collection:result:${subTaskId}:${endTime}`

const buildUploadCollectionKey = (taskId, uploadKey) =>
  `collection:upload:${taskId}:${uploadKey}`

const buildUploadSignature = (upload) => {
  const name = typeof upload?.name === 'string' ? upload.name : ''
  const size = typeof upload?.size === 'number' ? upload.size : undefined
  const lastModified =
    typeof upload?.lastModified === 'number' ? upload.lastModified : undefined
  const type = typeof upload?.type === 'string' ? upload.type : ''
  if (!name || typeof size !== 'number' || typeof lastModified !== 'number') {
    return ''
  }
  return `${name}:${size}:${lastModified}:${type}`
}

const mergeCollectionItems = (existing, incoming) => {
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seen = new Set()
  const next = []
  incoming.forEach((item) => {
    if (!item?.id || seen.has(item.id)) return
    const merged = byId.has(item.id) ? { ...byId.get(item.id), ...item, id: item.id } : item
    next.push(merged)
    seen.add(item.id)
  })
  existing.forEach((item) => {
    if (!item?.id || seen.has(item.id)) return
    next.push(item)
    seen.add(item.id)
  })
  return next
}

let backendCollectionQueue = Promise.resolve()

const appendBackendCollectionItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) return
  backendCollectionQueue = backendCollectionQueue
    .then(async () => {
      const existing = await loadBackendCollection()
      const next = mergeCollectionItems(existing, items)
      await saveBackendCollection(next)
    })
    .catch((err) => {
      console.warn('后端收藏写入失败:', err)
    })
}

const parseDataUrl = (dataUrl = '') => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return null
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') }
}

const activeControllers = new Map()
const retryTimers = new Map()
const runtimeTaskConfigs = new Map()

const clearRetryTimer = (subTaskId) => {
  const timer = retryTimers.get(subTaskId)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(subTaskId)
  }
}

const abortActiveController = (subTaskId) => {
  const controller = activeControllers.get(subTaskId)
  if (controller) {
    controller.abort()
    activeControllers.delete(subTaskId)
  }
}

const updateStats = (stats, type, duration, count = 1) => {
  const next = { ...stats }
  if (type === 'request') {
    const increment =
      typeof count === 'number' && Number.isFinite(count)
        ? Math.max(0, Math.floor(count))
        : 1
    next.totalRequests += increment
  }
  if (type === 'success') {
    next.successCount += 1
    if (typeof duration === 'number') {
      next.totalTime += duration
      next.fastestTime = next.fastestTime === 0 ? duration : Math.min(next.fastestTime, duration)
      next.slowestTime = Math.max(next.slowestTime, duration)
    }
  }
  return next
}

const updateGlobalStats = async (type, duration, count) => {
  const state = await loadBackendState()
  const stats = updateStats(state.globalStats, type, duration, count)
  await saveBackendState({ ...state, globalStats: stats })
}

const stripEmptyNovelAiOverrides = (overrides) => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {}
  return Object.fromEntries(
    Object.entries(overrides).filter(([key, value]) => {
      if (value === undefined || value === null) return false
      if (typeof value === 'string' && value.trim() === '') return false
      if (key === 'seed' && !Number.isFinite(Number(value))) return false
      if (typeof value === 'number' && !Number.isFinite(value)) return false
      return true
    }),
  )
}

const applyNovelAiOverrides = (config, overrides) => {
  if (coerceProviderApiFormat(config?.apiFormat) !== 'novelai') return config
  const clean = stripEmptyNovelAiOverrides(overrides)
  if (Object.keys(clean).length === 0) return config
  const { uc, ...rest } = clean
  const baseNovelAiConfig = config.novelAiConfig || {}
  const joinedUc = [baseNovelAiConfig.uc, uc]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(', ')
  return {
    ...config,
    novelAiConfig: {
      ...baseNovelAiConfig,
      ...rest,
      ...(uc ? { uc: joinedUc } : {}),
    },
  }
}

const resolveTaskApiConfig = (taskState, backendState, runtimeConfig, options = {}) => {
  const baseConfig = runtimeConfig || backendState?.config || {}
  const profiles = Array.isArray(baseConfig.apiProfiles) ? baseConfig.apiProfiles : []
  const taskProfileId = typeof taskState?.apiProfileId === 'string' ? taskState.apiProfileId : ''
  const matchedProfile = taskProfileId
    ? profiles.find((profile) => profile?.id === taskProfileId)
    : null
  const resolved = matchedProfile
    ? {
        ...baseConfig,
        ...matchedProfile,
      }
    : baseConfig
  return options.applyNovelAiOverrides === false
    ? resolved
    : applyNovelAiOverrides(resolved, taskState?.novelAiOverrides)
}

const buildMessagesForTask = async (taskState) => {
  const content = []
  if (taskState.prompt) {
    content.push({ type: 'text', text: taskState.prompt })
  }
  const uploads = Array.isArray(taskState.uploads) ? taskState.uploads : []
  for (const upload of uploads) {
    if (!upload?.localKey) continue
    const filePath = path.join(backendImagesDir, upload.localKey)
    try {
      const buffer = await fs.promises.readFile(filePath)
      const mime = upload.type || getMimeFromFilename(upload.localKey)
      const base64 = buffer.toString('base64')
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}` },
      })
    } catch (err) {
      console.warn('读取上传图片失败:', err)
    }
  }
  return [{ role: 'user', content }]
}

const readBackendImageAsDataUrl = async (localKey, mimeType) => {
  const safeKey = path.basename(String(localKey || ''))
  if (!safeKey) return ''
  const filePath = path.join(backendImagesDir, safeKey)
  const buffer = await fs.promises.readFile(filePath)
  const resolvedMime = mimeType || getMimeFromFilename(safeKey)
  return `data:${resolvedMime};base64,${buffer.toString('base64')}`
}

const resolveWorkflowReferenceDataUrl = async (reference) => {
  if (!reference || typeof reference !== 'object') return ''
  const explicitDataUrl =
    typeof reference.dataUrl === 'string' && reference.dataUrl.startsWith('data:image')
      ? reference.dataUrl
      : ''
  if (explicitDataUrl) return explicitDataUrl
  const localKey =
    typeof reference.localKey === 'string' && reference.localKey
      ? reference.localKey
      : extractBackendImageKeyFromUrl(reference.sourceUrl)
  if (!localKey) return ''
  try {
    return await readBackendImageAsDataUrl(localKey, reference.type || reference.mimeType)
  } catch (err) {
    console.warn('读取工作流参考图失败:', err)
    return ''
  }
}

const buildMessagesForWorkflow = async ({ prompt, referenceImages }) => {
  const content = []
  const promptText = typeof prompt === 'string' ? prompt.trim() : ''
  if (promptText) {
    content.push({ type: 'text', text: promptText })
  }
  const references = Array.isArray(referenceImages) ? referenceImages : []
  for (const reference of references) {
    const dataUrl = await resolveWorkflowReferenceDataUrl(reference)
    if (!dataUrl) continue
    content.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  return [{ role: 'user', content }]
}

const normalizeWorkflowCount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, Math.min(16, Math.floor(value)))
}

const normalizeWorkflowGenerationOptions = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const options = {}
  ;['size', 'aspectRatio', 'quality'].forEach((key) => {
    const raw = typeof value[key] === 'string' ? value[key].trim() : ''
    if (raw && raw !== 'auto') options[key] = raw
  })
  return options
}

const applyWorkflowGenerationOptions = (config, options) => {
  if (typeof options === 'undefined') return config
  const normalized = normalizeWorkflowGenerationOptions(options)
  if (!Object.keys(normalized).length) {
    return {
      ...config,
      includeImageConfig: false,
      imageConfig: {
        ...(config.imageConfig || {}),
        imageSize: 'auto',
        aspectRatio: 'auto',
      },
    }
  }
  return {
    ...config,
    ...(normalized.quality ? { quality: normalized.quality } : {}),
    includeImageConfig: Boolean(normalized.size || normalized.aspectRatio),
    imageConfig: {
      ...(config.imageConfig || {}),
      imageSize: normalized.size || 'auto',
      aspectRatio: normalized.aspectRatio || 'auto',
    },
  }
}

const appendOpenAiImageOptions = (target, options = {}) => {
  const normalized = normalizeWorkflowGenerationOptions(options)
  const append = (key, value) => {
    if (!value) return
    if (target instanceof FormData) target.append(key, value)
    else target[key] = value
  }
  append('size', normalized.size)
  append('quality', normalized.quality)
}

const generateWorkflowImages = async ({ apiConfig, prompt, referenceImages, count, generationOptions }) => {
  const messages = await buildMessagesForWorkflow({
    prompt,
    referenceImages,
  })
  const normalizedGenerationOptions = normalizeWorkflowGenerationOptions(generationOptions)
  const requestConfig = applyWorkflowGenerationOptions(apiConfig, normalizedGenerationOptions)
  await updateGlobalStats('request', undefined, count)
  const images = []
  for (let index = 0; index < count; index += 1) {
    const startTime = Date.now()
    try {
      const imageUrl = await requestImageUrl(requestConfig, messages, undefined, normalizedGenerationOptions)
      if (!imageUrl) {
        throw new Error('未在响应中找到图片数据')
      }
      const downloaded = await downloadImageBuffer(imageUrl)
      if (!downloaded) {
        throw new Error('图片下载失败')
      }
      const saved = await saveBackendImageBuffer(downloaded.buffer, downloaded.contentType)
      const duration = Date.now() - startTime
      await updateGlobalStats('success', duration)
      images.push({
        status: 'success',
        localKey: saved.fileName,
        sourceUrl: `/api/backend/image/${encodeURIComponent(saved.fileName)}`,
        mimeType: downloaded.contentType,
        bytes: downloaded.buffer.length,
        duration,
      })
    } catch (err) {
      images.push({
        status: 'error',
        error: err?.message || '生成失败',
        duration: Date.now() - startTime,
      })
    }
  }
  scheduleOrphanCleanup()
  return images
}

const buildGeminiContentsFromMessages = (messages = []) => {
  const parts = []
  messages.forEach((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push({ text: part.text })
      }
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url
        if (!url) return
        const parsed = parseDataUrl(url)
        if (parsed?.buffer) {
          parts.push({
            inline_data: {
              mime_type: parsed.contentType || 'image/png',
              data: parsed.buffer.toString('base64'),
            },
          })
        } else if (typeof url === 'string') {
          parts.push({ file_data: { file_uri: url } })
        }
      }
    })
  })
  return [{ role: 'user', parts }]
}

const readGeminiStream = async (response) => {
  const reader = response.body?.getReader()
  if (!reader) {
    return response.json()
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let lastJson = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (!line) continue
      const cleaned = line.replace(/^data:\s*/i, '').trim()
      if (!cleaned || cleaned === '[DONE]') continue
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  const tail = decoder.decode()
  if (tail) buffer += tail
  const remainder = buffer.trim()
  if (remainder) {
    const cleaned = remainder.replace(/^data:\s*/i, '').trim()
    if (cleaned && cleaned !== '[DONE]') {
      try {
        lastJson = JSON.parse(cleaned)
      } catch {
        // ignore
      }
    }
  }

  return lastJson
}

const normalizeErrorText = (value) =>
  typeof value === 'string' ? value.trim() : ''

const trySerializeErrorValue = (value) => {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

const normalizeErrorCompare = (value) =>
  normalizeErrorText(value).replace(/\s+/g, ' ').toLowerCase()

const extractErrorDetail = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || ''
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractErrorDetail(item)
      if (nested) return nested
    }
    return trySerializeErrorValue(value)
  }
  if (!value || typeof value !== 'object') {
    return ''
  }

  const record = value
  const candidates = [
    record.detail,
    record.message,
    record.error_description,
    record.error,
    record.reason,
  ]

  for (const candidate of candidates) {
    const nested = extractErrorDetail(candidate)
    if (nested) return nested
  }

  return trySerializeErrorValue(value)
}

const formatHttpErrorMessage = ({ status, statusText, body, fallback }) => {
  const detail = extractErrorDetail(body)
  const headline = normalizeErrorText(statusText)
  const sameMessage =
    detail && headline && normalizeErrorCompare(detail) === normalizeErrorCompare(headline)
  const suffix = detail && !sameMessage ? detail : ''
  const prefix = typeof status === 'number' ? `[${status}]` : ''

  if (prefix && headline && suffix) {
    return `${prefix} ${headline}: ${suffix}`
  }
  if (prefix && headline) {
    return `${prefix} ${headline}`
  }
  if (prefix && suffix) {
    return `${prefix} ${suffix}`
  }
  if (headline && suffix) {
    return `${headline}: ${suffix}`
  }
  if (headline) {
    return headline
  }
  if (suffix) {
    return suffix
  }
  return fallback
}

const readResponseBodySafely = async (response) => {
  try {
    const text = await response.text()
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch {
    return undefined
  }
}

const readResponseError = async (response) => {
  const fallback = response.statusText || `HTTP ${response.status}`
  const body = await readResponseBodySafely(response)
  return formatHttpErrorMessage({
    status: response.status,
    statusText: response.statusText,
    body,
    fallback,
  })
}

const imageExtensionFromMime = (mime = '') => {
  const lower = String(mime).toLowerCase()
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg'
  if (lower.includes('webp')) return '.webp'
  if (lower.includes('gif')) return '.gif'
  if (lower.includes('bmp')) return '.bmp'
  return '.png'
}

const extractOpenAiImagesPayload = (messages = []) => {
  const promptParts = []
  const images = []
  messages.forEach((message) => {
    const content = Array.isArray(message?.content) ? message.content : []
    content.forEach((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        promptParts.push(part.text)
      }
      if (part?.type === 'image_url') {
        const url = part?.image_url?.url || part?.image_url
        if (typeof url !== 'string') return
        const parsed = parseDataUrl(url)
        if (!parsed?.buffer) return
        images.push(parsed)
      }
    })
  })
  return {
    prompt: promptParts.join('\n\n').trim(),
    images,
  }
}

const requestOpenAiImageEndpoint = async (config, messages, openAiBase, signal, generationOptions) => {
  const { prompt, images } = extractOpenAiImagesPayload(messages)
  const hasReferenceImages = images.length > 0
  const url = buildOpenAiImagesUrl(openAiBase, hasReferenceImages)
  const requestInfo = {
    url,
    model: config.model,
    stream: false,
    endpoint: hasReferenceImages ? 'images-edits' : 'images-generations',
  }
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'x-api-key': config.apiKey,
    Connection: 'close',
  }
  let body
  if (hasReferenceImages) {
    const formData = new FormData()
    formData.append('model', config.model)
    formData.append('prompt', prompt)
    images.forEach((image, index) => {
      const contentType = image.contentType || 'image/png'
      const blob = new Blob([image.buffer], { type: contentType })
      formData.append(
        'image',
        blob,
        `image-${index + 1}${imageExtensionFromMime(contentType)}`,
      )
    })
    appendOpenAiImageOptions(formData, generationOptions)
    body = formData
  } else {
    headers['Content-Type'] = 'application/json'
    const payload = { model: config.model, prompt }
    appendOpenAiImageOptions(payload, generationOptions)
    body = JSON.stringify(payload)
  }

  logBackendOutbound('api-request', requestInfo)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    })
  } catch (err) {
    logBackendOutbound('api-request-error', {
      ...requestInfo,
      error: describeFetchError(err),
    })
    throw err
  }
  logBackendOutbound('api-response', { ...requestInfo, status: response.status })
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendResponse('json-error', { status: response.status, message })
    throw new Error(message)
  }
  const data = await response.json()
  const imageUrl = resolveImageFromResponse(data)
  if (!imageUrl) {
    logBackendResponse('json-response', data)
  }
  return imageUrl
}

const requestNovelAiImageEndpoint = async (config, messages, signal) => {
  const { prompt, images } = extractOpenAiImagesPayload(messages)
  if (images.length > 0) {
    throw new Error('NovelAI v1 暂不支持上传参考图，请移除参考图或使用自定义 JSON 扩展。')
  }
  const built = buildNovelAiRequest(config, { prompt })
  const requestInfo = {
    url: built.url,
    model: config.model,
    stream: false,
    format: 'novelai',
  }
  logBackendOutbound('api-request', requestInfo)
  let response
  try {
    response = await fetch(built.url, {
      method: 'POST',
      headers: { ...built.headers, Connection: 'close' },
      body: JSON.stringify(built.payload),
      signal,
    })
  } catch (err) {
    logBackendOutbound('api-request-error', {
      ...requestInfo,
      error: describeFetchError(err),
    })
    throw err
  }
  logBackendOutbound('api-response', { ...requestInfo, status: response.status })
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendResponse('novelai-error', { status: response.status, message })
    throw new Error(message)
  }
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = await response.json()
    const imageUrl = resolveImageFromResponse(data)
    if (!imageUrl) logBackendResponse('json-response', data)
    return imageUrl
  }
  const image = await extractFirstImageFromNovelAiZip(await response.arrayBuffer())
  return image?.dataUrl || null
}

const requestImageUrl = async (config, messages, signal, generationOptions) => {
  if (!config?.apiKey) {
    throw new Error('API Key 未配置')
  }
  if (!config?.model) {
    throw new Error('模型名称未配置')
  }

  const apiFormat = coerceProviderApiFormat(config?.apiFormat)

  if (isGoogleApiFormat(apiFormat)) {
    const requestInfo = {
      url: '',
      model: config.model,
      stream: Boolean(config.stream),
      format: apiFormat,
    }
    let response
    let data
    try {
      const contents = buildGeminiContentsFromMessages(messages)
      const built = await buildGoogleGenerateRequest(
        { ...config, apiFormat },
        { stream: Boolean(config.stream) },
      )
      const payload = buildGeminiPayload(
        contents,
        applyWorkflowGenerationOptions(config, generationOptions),
      )
      requestInfo.url = built.url
      logBackendOutbound('api-request', requestInfo)
      response = await fetch(built.url, {
        method: 'POST',
        headers: { ...built.headers, Connection: 'close' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok) {
        const message = await readResponseError(response)
        logBackendResponse('json-error', { status: response.status, message })
        throw new Error(message)
      }
      data = config.stream ? await readGeminiStream(response) : await response.json()
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }

    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    const imageUrl = resolveImageFromResponse(data)
    if (!imageUrl) {
      logBackendResponse('json-response', data)
    }
    return imageUrl
  }

  if (apiFormat === 'novelai') {
    return requestNovelAiImageEndpoint(
      applyWorkflowGenerationOptions(config, generationOptions),
      messages,
      signal,
    )
  }

  const apiUrl = resolveApiUrl(config?.apiUrl, 'openai')
  const openAiBase = buildOpenAiBaseUrl(apiUrl, config.apiVersion)
  if (config.openaiEndpointMode === 'images') {
    return requestOpenAiImageEndpoint(config, messages, openAiBase, signal, generationOptions)
  }
  const chatUrl = buildOpenAiChatUrl(openAiBase)
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'x-api-key': config.apiKey,
    'Content-Type': 'application/json',
    Connection: 'close',
  }

  if (config.stream) {
    const requestInfo = {
      url: chatUrl,
      model: config.model,
      stream: true,
    }
    logBackendOutbound('api-request', requestInfo)
    let response
    try {
      response = await fetch(requestInfo.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        signal,
      })
    } catch (err) {
      logBackendOutbound('api-request-error', {
        ...requestInfo,
        error: describeFetchError(err),
      })
      throw err
    }
    logBackendOutbound('api-response', { ...requestInfo, status: response.status })
    if (!response.ok) {
      const message = await readResponseError(response)
      logBackendResponse('stream-error', { status: response.status, message })
      throw new Error(message)
    }
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let generatedText = ''
    let pending = ''
    const consumeLine = (line) => {
      const cleaned = line.replace(/\r$/, '')
      if (!cleaned.startsWith('data:')) return
      const payload = cleaned.slice(5).trimStart()
      if (!payload || payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta
        if (delta?.content) generatedText += delta.content
        if (delta?.reasoning_content) generatedText += delta.reasoning_content
      } catch {
        // ignore chunk parse errors
      }
    }
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex)
          pending = pending.slice(newlineIndex + 1)
          consumeLine(line)
          newlineIndex = pending.indexOf('\n')
        }
      }
      const tail = decoder.decode()
      if (tail) pending += tail
    }
    if (pending) {
      consumeLine(pending)
    }
    const imageUrl = parseMarkdownImage(generatedText)
    if (!imageUrl) {
      logBackendResponse('stream-response', generatedText)
    }
    return imageUrl
  }

  const requestInfo = {
    url: chatUrl,
    model: config.model,
    stream: false,
  }
  logBackendOutbound('api-request', requestInfo)
  let response
  try {
    response = await fetch(requestInfo.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages, stream: false }),
      signal,
    })
  } catch (err) {
    logBackendOutbound('api-request-error', {
      ...requestInfo,
      error: describeFetchError(err),
    })
    throw err
  }
  logBackendOutbound('api-response', { ...requestInfo, status: response.status })
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendResponse('json-error', { status: response.status, message })
    throw new Error(message)
  }
  const data = await response.json()
  const imageUrl = resolveImageFromResponse(data)
  if (!imageUrl) {
    logBackendResponse('json-response', data)
  }
  return imageUrl
}

const downloadImageBuffer = async (imageUrl) => {
  if (!imageUrl) return null
  if (imageUrl.startsWith('data:image')) {
    const parsed = parseDataUrl(imageUrl)
    if (!parsed) return null
    return parsed
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    return null
  }
  let response
  try {
    response = await fetch(imageUrl, { headers: { Connection: 'close' } })
  } catch (err) {
    logBackendOutbound('image-download-error', {
      url: imageUrl,
      error: describeFetchError(err),
    })
    throw err
  }
  if (!response.ok) {
    const message = await readResponseError(response)
    logBackendOutbound('image-download-response', {
      url: imageUrl,
      status: response.status,
      message,
    })
    throw new Error(message)
  }
  const arrayBuffer = await response.arrayBuffer()
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  return { buffer: Buffer.from(arrayBuffer), contentType }
}

const isAutoRetryPending = (item) => item?.status === 'error' && item?.autoRetry === true

const isTaskResultActive = (item) => item?.status === 'loading' || item?.autoRetry === true

const getRetryCount = (item) =>
  typeof item?.retryCount === 'number' && Number.isFinite(item.retryCount)
    ? item.retryCount
    : 0

const canAutoRetry = (retryCount, retryLimit) =>
  retryLimit === -1 || retryCount < retryLimit

const formatRetryIntervalSeconds = (intervalMs) =>
  Number((intervalMs / 1000).toFixed(3)).toString()

const buildRetryErrorMessage = (message, intervalMs) =>
  `${message} (${formatRetryIntervalSeconds(intervalMs)}s后重试...)`

const stripRetryScheduleSuffix = (message) => {
  if (typeof message !== 'string') return ''
  return message.replace(/\s*\([^()]*后重试\.\.\.\)\s*$/, '').trim()
}

const scheduleRetry = (taskId, subTaskId, retryInterval) => {
  if (retryTimers.has(subTaskId)) return
  const timer = setTimeout(async () => {
    retryTimers.delete(subTaskId)
    const taskState = await loadTaskState(taskId)
    if (!taskState) return
    const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
    if (resultIndex === -1) return
    const current = taskState.results[resultIndex]
    if (current?.autoRetry === false) return
    if (!isAutoRetryPending(current)) return
    const retryLimit = normalizeRetryLimit(taskState.retryLimit)
    const currentRetryCount = getRetryCount(current)
    if (!canAutoRetry(currentRetryCount, retryLimit)) {
      taskState.results[resultIndex] = {
        ...current,
        status: 'error',
        error: stripRetryScheduleSuffix(current?.error) || '未知错误',
        endTime: Date.now(),
        autoRetry: false,
      }
      await saveTaskState(taskId, taskState)
      return
    }
    void runSubTask(taskId, subTaskId, { preserveVisibleState: true })
  }, retryInterval)
  retryTimers.set(subTaskId, timer)
}

const runSubTask = async (taskId, subTaskId, options = {}) => {
  const countRequest = options.countRequest !== false
  const preserveVisibleState = options.preserveVisibleState === true
  if (activeControllers.has(subTaskId)) return
  clearRetryTimer(subTaskId)
  const controller = new AbortController()
  activeControllers.set(subTaskId, controller)

  const taskState = await loadTaskState(taskId)
  if (!taskState) {
    activeControllers.delete(subTaskId)
    return
  }
  const requestPrompt = typeof taskState.prompt === 'string' ? taskState.prompt : ''
  const requestUploads = Array.isArray(taskState.uploads) ? taskState.uploads : []

  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) {
    activeControllers.delete(subTaskId)
    return
  }

  const currentResult = taskState.results[resultIndex]
  const startTime =
    typeof currentResult?.startTime === 'number' && Number.isFinite(currentResult.startTime)
      ? currentResult.startTime
      : Date.now()
  const keepVisibleError =
    preserveVisibleState && currentResult?.status === 'error' && currentResult?.autoRetry === true
  taskState.results[resultIndex] = {
    ...currentResult,
    status: keepVisibleError ? 'error' : 'loading',
    error: currentResult?.error,
    startTime,
    endTime: undefined,
    duration: undefined,
    autoRetry: currentResult?.autoRetry !== false,
    savedLocal: false,
  }
  if (countRequest) {
    taskState.stats = updateStats(taskState.stats, 'request')
  }
  await saveTaskState(taskId, taskState)
  if (countRequest) {
    await updateGlobalStats('request')
  }

  try {
    const backendState = await loadBackendState()
    const taskApiConfig = resolveTaskApiConfig(
      taskState,
      backendState,
      runtimeTaskConfigs.get(taskId),
    )
    const shouldCollect = Boolean(backendState?.config?.enableCollection)
    const messages = await buildMessagesForTask(taskState)
    const imageUrl = await requestImageUrl(taskApiConfig, messages, controller.signal)
    if (!imageUrl) {
      throw new Error('未在响应中找到图片数据')
    }
    const downloaded = await downloadImageBuffer(imageUrl)
    if (!downloaded) {
      throw new Error('图片下载失败')
    }
    const saved = await saveBackendImageBuffer(downloaded.buffer, downloaded.contentType)
    const endTime = Date.now()
    const duration = endTime - startTime

    const freshState = await loadTaskState(taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    freshState.results[freshIndex] = {
      ...freshState.results[freshIndex],
      status: 'success',
      error: undefined,
      localKey: saved.fileName,
      sourceUrl: `/api/backend/image/${encodeURIComponent(saved.fileName)}`,
      savedLocal: false,
      autoRetry: false,
      endTime,
      duration,
    }
    freshState.stats = updateStats(freshState.stats, 'success', duration)
    await saveTaskState(taskId, freshState)
    await updateGlobalStats('success', duration)
    if (shouldCollect) {
      const items = []
      const timestamp = endTime
      const taskKey = typeof taskId === 'string' ? taskId : ''
      const prompt = requestPrompt || ''
      if (saved?.fileName) {
        items.push({
          id: buildResultCollectionKey(subTaskId, timestamp),
          prompt,
          timestamp,
          taskId: taskKey,
          localKey: path.basename(String(saved.fileName)),
        })
      }
      if (requestUploads.length > 0) {
        requestUploads.forEach((upload) => {
          const uploadKey =
            typeof upload?.uid === 'string' && upload.uid
              ? upload.uid
              : typeof upload?.localKey === 'string'
                ? upload.localKey
                : ''
          const uploadLocalKey =
            typeof upload?.localKey === 'string' && upload.localKey
              ? path.basename(upload.localKey)
              : ''
          if (!uploadKey || !uploadLocalKey) return
          const signature =
            typeof upload?.sourceSignature === 'string' && upload.sourceSignature
              ? upload.sourceSignature
              : buildUploadSignature(upload)
          items.push({
            id: buildUploadCollectionKey(taskKey, uploadKey),
            prompt,
            timestamp,
            taskId: taskKey,
            localKey: uploadLocalKey,
            sourceSignature: signature || undefined,
          })
        })
      }
      appendBackendCollectionItems(items)
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return
    }
    const errorMessage = err?.message || '未知错误'
    const freshState = await loadTaskState(taskId)
    if (!freshState) return
    const freshIndex = freshState.results.findIndex((item) => item.id === subTaskId)
    if (freshIndex === -1) return
    const current = freshState.results[freshIndex]
    const retryInterval = normalizeRetryInterval(freshState.retryInterval)
    const retryLimit = normalizeRetryLimit(freshState.retryLimit)
    const currentRetryCount = getRetryCount(current)
    const shouldRetry = current?.autoRetry !== false
    if (shouldRetry && canAutoRetry(currentRetryCount, retryLimit)) {
      freshState.results[freshIndex] = {
        ...current,
        status: 'error',
        error: buildRetryErrorMessage(errorMessage, retryInterval),
        retryCount: currentRetryCount + 1,
        autoRetry: true,
      }
      await saveTaskState(taskId, freshState)
      scheduleRetry(taskId, subTaskId, retryInterval)
    } else {
      freshState.results[freshIndex] = {
        ...current,
        status: 'error',
        error: errorMessage,
        endTime: Date.now(),
        autoRetry: false,
      }
      await saveTaskState(taskId, freshState)
    }
  } finally {
    activeControllers.delete(subTaskId)
  }
}

const startGeneration = async (taskId) => {
  const taskState = (await loadTaskState(taskId)) || createDefaultTaskState()
  const previousState = {
    ...taskState,
    results: Array.isArray(taskState.results) ? [...taskState.results] : [],
    uploads: Array.isArray(taskState.uploads) ? [...taskState.uploads] : [],
  }
  taskState.results.forEach((result) => {
    abortActiveController(result.id)
    clearRetryTimer(result.id)
  })
  const concurrency = normalizeConcurrency(taskState.concurrency)
  const startTime = Date.now()
  taskState.results = Array.from({ length: concurrency }).map(() => ({
    id: crypto.randomUUID(),
    status: 'loading',
    retryCount: 0,
    startTime,
    autoRetry: true,
    savedLocal: false,
  }))
  taskState.stats = updateStats(taskState.stats, 'request', undefined, concurrency)
  await saveTaskState(taskId, taskState)
  await updateGlobalStats('request', undefined, concurrency)
  const removedKeys = getRemovedImageKeys(previousState, taskState)
  await cleanupUnusedImages(removedKeys)
  scheduleOrphanCleanup()
  taskState.results.forEach((result) => {
    void runSubTask(taskId, result.id, { countRequest: false })
  })
  return taskState
}

const retrySubTask = async (taskId, subTaskId) => {
  const taskState = await loadTaskState(taskId)
  if (!taskState) return null
  const resultIndex = taskState.results.findIndex((item) => item.id === subTaskId)
  if (resultIndex === -1) return taskState
  const startTime = Date.now()
  const current = taskState.results[resultIndex]
  const removedKey = current?.localKey
  clearRetryTimer(subTaskId)
  taskState.results[resultIndex] = {
    ...current,
    status: 'loading',
    error: undefined,
    retryCount: current.retryCount || 0,
    startTime,
    endTime: undefined,
    duration: undefined,
    localKey: undefined,
    sourceUrl: undefined,
    autoRetry: true,
    savedLocal: false,
  }
  await saveTaskState(taskId, taskState)
  if (removedKey) {
    await cleanupUnusedImages([removedKey])
  }
  scheduleOrphanCleanup()
  void runSubTask(taskId, subTaskId)
  return taskState
}

const normalizeStopMode = (mode) => (mode === 'abort' ? 'abort' : 'pause')

const stopSubTask = async (taskId, subTaskId, mode = 'pause') => {
  const taskState = await loadTaskState(taskId)
  if (!taskState) return null
  const resolvedMode = normalizeStopMode(mode)
  const shouldAbort = resolvedMode === 'abort'
  const targets = subTaskId
    ? taskState.results.filter((item) => item.id === subTaskId)
    : taskState.results

  targets.forEach((target) => {
    if (shouldAbort) {
      abortActiveController(target.id)
    }
    clearRetryTimer(target.id)
  })

  const nextResults = taskState.results.map((item) => {
    if (subTaskId && item.id !== subTaskId) return item
    if (!isTaskResultActive(item)) return item
    return {
      ...item,
      status: 'error',
      error: shouldAbort ? '已停止' : '已暂停重试',
      autoRetry: false,
      endTime: shouldAbort ? Date.now() : item.endTime,
    }
  })
  const nextState = { ...taskState, results: nextResults }
  await saveTaskState(taskId, nextState)
  return nextState
}

const app = express()
const httpServer = createHttpServer(app)

app.use(express.json({ limit: '50mb' }))
if (backendLogRequests) {
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      logBackendRequest('http', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      })
    })
    next()
  })
}

void cleanupOrphanedImages().catch((err) => {
  console.warn('启动时清理后端图片缓存失败:', err)
})

const backendTokens = new Set()
const PROMPT_MANAGER_URL = 'https://prompt.vioaki.xyz/api/gallery'
const NANOBANANA_SUBMIT_ENDPOINTS = [
  'https://nanobanana-website.vercel.app/api/submit',
  'https://bmzxdlj.cn/api/submit',
]
const CATBOX_UPLOAD_URL = 'https://catbox.moe/user/api.php'

const readNanobananaJson = async (response) => {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { success: false, error: text }
  }
}

const postNanobananaSubmission = async (payload) => {
  let lastError = null

  for (const endpoint of NANOBANANA_SUBMIT_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify(payload),
      })
      const body = await readNanobananaJson(response)
      if (response.ok || response.status < 500) {
        return { status: response.status, body }
      }
      lastError = body?.error || response.statusText || `HTTP ${response.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    status: 502,
    body: {
      success: false,
      error: lastError || '投稿服务暂不可用',
    },
  }
}

const parseBase64ImagePayload = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const match = trimmed.match(/^data:([^;]+);base64,(.*)$/)
  const mime = match?.[1] || 'image/png'
  const base64 = match ? match[2] : trimmed
  const cleanBase64 = base64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 === 1) {
    return null
  }
  const buffer = Buffer.from(cleanBase64, 'base64')
  if (!buffer.length) return null
  return { mime, buffer }
}

const resolveCatboxFileName = (mime = 'image/png') => {
  const ext = imageExtensionFromMime(mime).replace('.', '') || 'png'
  return `moe-atelier-${Date.now()}.${ext}`
}

const uploadBufferToCatbox = async ({ buffer, mime }) => {
  const formData = new FormData()
  formData.append('reqtype', 'fileupload')
  formData.append(
    'fileToUpload',
    new Blob([buffer], { type: mime }),
    resolveCatboxFileName(mime),
  )

  const response = await fetch(CATBOX_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  })
  const text = (await response.text()).trim()
  if (response.ok && /^https?:\/\//i.test(text)) {
    return text
  }
  throw new Error(text || response.statusText || '图片上传失败')
}

app.get('/api/prompt-manager', async (_req, res) => {
  try {
    const response = await fetch(PROMPT_MANAGER_URL, {
      headers: { Accept: 'application/json', Connection: 'close' },
    })
    if (!response.ok) {
      const message = await readResponseError(response)
      res.status(response.status).json({ error: message })
      return
    }
    const data = await response.json()
    res.json(data)
  } catch (err) {
    console.error('prompt-manager proxy error:', err)
    res.status(500).json({ error: 'Proxy Error' })
  }
})

app.post('/api/nanobanana/submit', async (req, res) => {
  try {
    const result = await postNanobananaSubmission(req.body || {})
    res.status(result.status).json(result.body)
  } catch (err) {
    console.error('nanobanana submit proxy error:', err)
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : '投稿代理失败',
    })
  }
})

app.post('/api/nanobanana/upload-image', async (req, res) => {
  try {
    const parsed = parseBase64ImagePayload(req.body?.image)
    if (!parsed) {
      res.status(400).json({ success: false, error: '没有收到可上传的图片' })
      return
    }
    const url = await uploadBufferToCatbox(parsed)
    res.json({ success: true, url })
  } catch (err) {
    console.error('nanobanana image upload proxy error:', err)
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : '图片上传失败',
    })
  }
})

const requireBackendAuth = (req, res, next) => {
  const headerToken = req.headers['x-backend-token']
  const queryToken = req.query?.token
  const token = Array.isArray(headerToken)
    ? headerToken[0]
    : (headerToken || queryToken)
  if (!token || !backendTokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

const applyBackendConfigPayload = async (payload = {}) => {
  if (!payload?.config && !payload?.configByFormat) return null
  const current = await loadBackendState()
  const next = { ...current }
  if (payload?.configByFormat) {
    const incoming = payload.configByFormat
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      next.configByFormat = { ...next.configByFormat, ...incoming }
    }
  }
  if (payload?.config) {
    next.config = { ...DEFAULT_BACKEND_CONFIG, ...payload.config }
    const apiFormat = coerceApiFormat(next.config.apiFormat)
    next.config.apiFormat = apiFormat
    next.configByFormat = {
      ...next.configByFormat,
      [apiFormat]: pickFormatConfig(next.config),
    }
  }
  await saveBackendState(next)
  return next
}

app.post('/api/backend/auth', async (req, res) => {
  if (!backendPassword) {
    res.status(500).json({ error: 'BACKEND_PASSWORD not set' })
    return
  }
  const { password } = req.body || {}
  if (!password || password !== backendPassword) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }
  const token = crypto.randomBytes(16).toString('hex')
  backendTokens.add(token)
  res.json({ token })
})

app.get('/api/backend/stream', requireBackendAuth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 2000\n\n')
  addSseClient(res)
  req.on('close', () => {
    removeSseClient(res)
  })
  try {
    const state = await loadBackendStateSnapshot()
    sendSseEvent(res, 'state', state)
  } catch (err) {
    console.warn('初始化事件流状态失败:', err)
  }
})

app.get('/api/backend/state', requireBackendAuth, async (_req, res) => {
  try {
    const state = await loadBackendStateSnapshot()
    res.json(state)
  } catch (err) {
    console.error('backend state error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.patch('/api/backend/state', requireBackendAuth, async (req, res) => {
  try {
    const current = await loadBackendState()
    const next = { ...current }
    if (req.body?.configByFormat) {
      const incoming = req.body.configByFormat
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        next.configByFormat = { ...next.configByFormat, ...incoming }
      }
    }
    if (req.body?.config) {
      next.config = { ...DEFAULT_BACKEND_CONFIG, ...req.body.config }
      const apiFormat = coerceApiFormat(next.config.apiFormat)
      next.config.apiFormat = apiFormat
      next.configByFormat = {
        ...next.configByFormat,
        [apiFormat]: pickFormatConfig(next.config),
      }
    }
    if (Array.isArray(req.body?.tasksOrder)) {
      next.tasksOrder = Array.from(new Set(req.body.tasksOrder.filter((id) => typeof id === 'string')))
    }
    if (req.body?.globalStats) {
      next.globalStats = { ...DEFAULT_GLOBAL_STATS, ...req.body.globalStats }
    }
    await saveBackendState(next)
    res.json(buildBackendStateSnapshot(next))
  } catch (err) {
    console.error('backend state write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/collection', requireBackendAuth, async (_req, res) => {
  try {
    const items = await loadBackendCollection()
    res.json(items)
  } catch (err) {
    console.error('backend collection read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/collection', requireBackendAuth, async (req, res) => {
  try {
    const previous = await loadBackendCollection()
    const items = normalizeCollectionPayloadForSave(req.body)
    await saveBackendCollection(items)
    const prevKeys = collectImageKeysFromCollection(previous)
    const nextKeys = collectImageKeysFromCollection(items)
    const removedKeys = []
    for (const key of prevKeys) {
      if (!nextKeys.has(key)) removedKeys.push(key)
    }
    await cleanupUnusedImages(removedKeys)
    scheduleOrphanCleanup()
    res.json(items)
  } catch (err) {
    console.error('backend collection write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const taskId = req.params.id
    const taskState = await loadTaskState(taskId)
    if (!taskState) {
      const backendState = await loadBackendState()
      if (backendState.tasksOrder.includes(taskId)) {
        const next = createDefaultTaskState()
        await saveTaskState(taskId, next)
        res.json(next)
        return
      }
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(taskState)
  } catch (err) {
    console.error('backend task read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.put('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const previous = await loadTaskState(req.params.id)
    const next = {
      ...createDefaultTaskState(),
      ...payload,
      name: normalizeTaskName(payload?.name),
      concurrency: normalizeConcurrency(payload?.concurrency),
      retryInterval: normalizeRetryInterval(payload?.retryInterval),
      retryLimit: normalizeRetryLimit(payload?.retryLimit),
      stats: { ...DEFAULT_TASK_STATS, ...(payload?.stats || {}) },
      results: Array.isArray(payload?.results) ? payload.results : [],
      uploads: Array.isArray(payload?.uploads) ? payload.uploads : [],
      workflow: normalizeWorkflowState(payload?.workflow),
    }
    await saveTaskState(req.params.id, next)
    if (previous) {
      const removedKeys = getRemovedImageKeys(previous, next)
      await cleanupUnusedImages(removedKeys)
    }
    scheduleOrphanCleanup()
    res.json(next)
  } catch (err) {
    console.error('backend task write error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.patch('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    const current = (await loadTaskState(req.params.id)) || createDefaultTaskState()
    const next = {
      ...current,
      name: Object.prototype.hasOwnProperty.call(payload, 'name')
        ? normalizeTaskName(payload.name)
        : current.name,
      prompt: typeof payload.prompt === 'string' ? payload.prompt : current.prompt,
      concurrency: normalizeConcurrency(payload?.concurrency, current.concurrency || DEFAULT_CONCURRENCY),
      enableSound: typeof payload.enableSound === 'boolean' ? payload.enableSound : current.enableSound,
	      retryInterval: normalizeRetryInterval(payload?.retryInterval, current.retryInterval),
	      retryLimit: normalizeRetryLimit(payload?.retryLimit, current.retryLimit),
	      apiProfileId: typeof payload.apiProfileId === 'string' ? payload.apiProfileId : current.apiProfileId,
	      novelAiOverrides: Object.prototype.hasOwnProperty.call(payload, 'novelAiOverrides')
	        ? stripEmptyNovelAiOverrides(payload.novelAiOverrides)
	        : current.novelAiOverrides,
	      uploads: Array.isArray(payload?.uploads) ? payload.uploads : current.uploads,
      results: Array.isArray(payload?.results) ? payload.results : current.results,
      stats: payload?.stats ? { ...DEFAULT_TASK_STATS, ...payload.stats } : current.stats,
      workflow: Object.prototype.hasOwnProperty.call(payload, 'workflow')
        ? normalizeWorkflowState(payload.workflow)
        : current.workflow,
    }
    await saveTaskState(req.params.id, next)
    const removedKeys = getRemovedImageKeys(current, next)
    await cleanupUnusedImages(removedKeys)
    scheduleOrphanCleanup()
    res.json(next)
  } catch (err) {
    console.error('backend task patch error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

const findWorkflowTaskLinkConflict = async (linkedTaskId, currentWorkflowId = '') => {
  if (typeof linkedTaskId !== 'string' || !linkedTaskId) return null
  const projects = await listWorkflowProjects()
  return projects.find(
    (project) => project.linkedTaskId === linkedTaskId && project.id !== currentWorkflowId,
  ) || null
}

const sendWorkflowTaskLinkConflict = (res, project) => {
  res.status(409).json({
    error: 'Task Already Linked',
    workflowId: project.id,
    workflowTitle: project.title,
  })
}

app.get('/api/backend/workflows', requireBackendAuth, async (_req, res) => {
  try {
    res.json(await listWorkflowProjects())
  } catch (err) {
    console.error('backend workflows list error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.post('/api/backend/workflows', requireBackendAuth, async (req, res) => {
  try {
    const now = new Date().toISOString()
    const id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : crypto.randomUUID()
    const linkedTaskId = typeof req.body?.linkedTaskId === 'string' ? req.body.linkedTaskId : undefined
    const conflict = await findWorkflowTaskLinkConflict(linkedTaskId, id)
    if (conflict) {
      sendWorkflowTaskLinkConflict(res, conflict)
      return
    }
    const project = await saveWorkflowProject(id, {
      id,
      title: typeof req.body?.title === 'string' ? req.body.title : '未命名画布',
      linkedTaskId,
      createdAt: now,
      updatedAt: now,
      state: normalizeWorkflowState(req.body?.state),
    })
    res.json(project)
  } catch (err) {
    console.error('backend workflow create error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.get('/api/backend/workflow/:id', requireBackendAuth, async (req, res) => {
  try {
    const project = await loadWorkflowProject(req.params.id)
    if (!project) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.json(project)
  } catch (err) {
    console.error('backend workflow read error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.patch('/api/backend/workflow/:id', requireBackendAuth, async (req, res) => {
  try {
    const current = await loadWorkflowProject(req.params.id)
    if (!current) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    const payload = req.body || {}
    const nextLinkedTaskId = Object.prototype.hasOwnProperty.call(payload, 'linkedTaskId')
      ? (typeof payload.linkedTaskId === 'string' && payload.linkedTaskId ? payload.linkedTaskId : undefined)
      : current.linkedTaskId
    const conflict = await findWorkflowTaskLinkConflict(nextLinkedTaskId, current.id)
    if (conflict) {
      sendWorkflowTaskLinkConflict(res, conflict)
      return
    }
    const patch = {
      ...current,
      title: typeof payload.title === 'string' ? payload.title : current.title,
      linkedTaskId: nextLinkedTaskId,
      state: Object.prototype.hasOwnProperty.call(payload, 'state')
        ? normalizeWorkflowState(payload.state)
        : current.state,
    }
    res.json(await saveWorkflowProject(req.params.id, patch))
  } catch (err) {
    console.error('backend workflow patch error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

app.delete('/api/backend/workflow/:id', requireBackendAuth, async (req, res) => {
  try {
    const current = await loadWorkflowProject(req.params.id)
    if (current) {
      await deleteWorkflowProject(req.params.id)
      await cleanupUnusedImages(getRemovedImageKeys({ workflow: current.state }, { workflow: undefined }))
    }
    scheduleOrphanCleanup()
    res.json({ ok: true })
  } catch (err) {
    console.error('backend workflow delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/workflow/:id/generate', requireBackendAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const count = normalizeWorkflowCount(body.count)
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (!prompt.trim() && !Array.isArray(body.referenceImages)) {
      res.status(400).json({ error: 'Missing prompt or referenceImages' })
      return
    }
    const backendState = await loadBackendState()
	    const apiConfig = resolveTaskApiConfig(
	      {
	        apiProfileId:
	          typeof body.apiProfileId === 'string' ? body.apiProfileId : backendState.config?.activeApiProfileId,
	      },
	      backendState,
	      body.runtimeConfig,
	      { applyNovelAiOverrides: false },
	    )
    const images = await generateWorkflowImages({
      apiConfig,
      prompt,
      referenceImages: body.referenceImages,
      count,
      generationOptions: body.generationOptions,
    })
    res.json({ images })
  } catch (err) {
    console.error('backend workflow generate error:', err)
    res.status(500).json({ error: err?.message || 'Workflow Generate Error' })
  }
})

app.post('/api/backend/task/:id/workflow/generate', requireBackendAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const count = normalizeWorkflowCount(body.count)
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (!prompt.trim() && !Array.isArray(body.referenceImages)) {
      res.status(400).json({ error: 'Missing prompt or referenceImages' })
      return
    }
    const taskState = (await loadTaskState(req.params.id)) || createDefaultTaskState()
    const backendState = await loadBackendState()
	    const taskApiConfig = resolveTaskApiConfig(
	      {
	        ...taskState,
	        apiProfileId:
	          typeof body.apiProfileId === 'string' ? body.apiProfileId : taskState.apiProfileId,
	      },
	      backendState,
	      body.runtimeConfig,
	      { applyNovelAiOverrides: false },
	    )
    const images = await generateWorkflowImages({
        apiConfig: taskApiConfig,
        prompt,
        referenceImages: body.referenceImages,
        count,
        generationOptions: body.generationOptions,
      })
    res.json({ images })
  } catch (err) {
    console.error('backend task workflow generate error:', err)
    res.status(500).json({ error: err?.message || 'Workflow Generate Error' })
  }
})

app.delete('/api/backend/task/:id', requireBackendAuth, async (req, res) => {
  try {
    runtimeTaskConfigs.delete(req.params.id)
    const existing = await loadTaskState(req.params.id)
    const removedKeys = existing ? Array.from(collectImageKeysFromTask(existing)) : []
    if (existing?.results) {
      existing.results.forEach((result) => {
        const controller = activeControllers.get(result.id)
        if (controller) {
          controller.abort()
          activeControllers.delete(result.id)
        }
        clearRetryTimer(result.id)
      })
    }
    await fs.promises.unlink(getTaskFilePath(req.params.id)).catch(() => undefined)
    const state = await loadBackendState()
    const next = {
      ...state,
      tasksOrder: state.tasksOrder.filter((id) => id !== req.params.id),
    }
    await saveBackendState(next)
    await cleanupUnusedImages(removedKeys)
    await cleanupOrphanedImages()
    res.json({ ok: true })
  } catch (err) {
    console.error('backend task delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/task/:id/generate', requireBackendAuth, async (req, res) => {
  try {
    if (req.body?.runtimeConfig) {
      runtimeTaskConfigs.set(req.params.id, req.body.runtimeConfig)
    }
    await startGeneration(req.params.id)
    res.status(204).end()
  } catch (err) {
    console.error('backend generate error:', err)
    res.status(500).json({ error: 'Generate Error' })
  }
})

app.post('/api/backend/task/:id/retry', requireBackendAuth, async (req, res) => {
  try {
    const { subTaskId } = req.body || {}
    if (!subTaskId) {
      res.status(400).json({ error: 'Missing subTaskId' })
      return
    }
    if (req.body?.runtimeConfig) {
      runtimeTaskConfigs.set(req.params.id, req.body.runtimeConfig)
    }
    const state = await retrySubTask(req.params.id, subTaskId)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.status(204).end()
  } catch (err) {
    console.error('backend retry error:', err)
    res.status(500).json({ error: 'Retry Error' })
  }
})

app.post('/api/backend/task/:id/stop', requireBackendAuth, async (req, res) => {
  try {
    const { subTaskId, mode } = req.body || {}
    const state = await stopSubTask(req.params.id, subTaskId, mode)
    if (!state) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.status(204).end()
  } catch (err) {
    console.error('backend stop error:', err)
    res.status(500).json({ error: 'Stop Error' })
  }
})

app.post(
  '/api/backend/upload',
  requireBackendAuth,
  express.raw({ type: '*/*', limit: '50mb' }),
  async (req, res) => {
    try {
      const buffer = req.body
      if (!buffer || !buffer.length) {
        res.status(400).json({ error: 'Empty Body' })
        return
      }
      const contentType = req.headers['content-type'] || 'application/octet-stream'
      const result = await saveBackendImageBuffer(buffer, contentType)
      res.json({
        key: result.fileName,
        url: `/api/backend/image/${encodeURIComponent(result.fileName)}`,
      })
    } catch (err) {
      console.error('backend upload error:', err)
      res.status(500).json({ error: 'Upload Error' })
    }
  },
)

app.get('/api/backend/image/:key', requireBackendAuth, async (req, res) => {
  try {
    const safeName = path.basename(req.params.key)
    const filePath = path.join(backendImagesDir, safeName)
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Not Found' })
      return
    }
    res.sendFile(filePath)
  } catch (err) {
    console.error('backend image error:', err)
    res.status(500).json({ error: 'Read Error' })
  }
})

app.delete('/api/backend/image/:key', requireBackendAuth, async (req, res) => {
  try {
    const safeName = path.basename(req.params.key)
    if (!safeName) {
      res.status(400).json({ error: 'Missing Key' })
      return
    }
    const filePath = path.join(backendImagesDir, safeName)
    await fs.promises.unlink(filePath).catch(() => undefined)
    res.json({ ok: true })
  } catch (err) {
    console.error('backend image delete error:', err)
    res.status(500).json({ error: 'Delete Error' })
  }
})

app.post('/api/backend/images/cleanup', requireBackendAuth, async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : []
    const normalized = keys
      .map((key) => path.basename(String(key)))
      .filter((key) => key)
    await cleanupUnusedImages(normalized)
    scheduleOrphanCleanup()
    res.json({ ok: true })
  } catch (err) {
    console.error('backend image cleanup error:', err)
    res.status(500).json({ error: 'Cleanup Error' })
  }
})

app.post('/api/save-image', async (req, res) => {
  try {
    const buffer = await readRequestBody(req)
    if (!buffer.length) {
      res.status(400).json({ error: 'Empty Body' })
      return
    }

    const typeHeader = req.headers['x-image-type']
    const contentType = Array.isArray(typeHeader)
      ? typeHeader[0]
      : (typeHeader || req.headers['content-type'] || '')

    const result = await saveImageBuffer(buffer, String(contentType))
    res.json(result)
  } catch (err) {
    console.error('save-image error:', err)
    res.status(500).json({ error: 'Write Error' })
  }
})

if (isProd) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: rootDir,
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      watch: {
        ignored: ['**/server-data/**', '**/saved-images/**', '**/dist/**'],
      },
    },
    appType: 'custom',
  })

  app.use(vite.middlewares)
  app.get('*', async (req, res) => {
    try {
      const templatePath = path.join(rootDir, 'index.html')
      const template = await fs.promises.readFile(templatePath, 'utf-8')
      const html = await vite.transformIndexHtml(req.originalUrl, template)
      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (err) {
      vite.ssrFixStacktrace(err)
      res.status(500).end(err.message)
    }
  })
}

// 端口自动规避：被占用(EADDRINUSE)时顺延到下一端口；被保留/无权限(EACCES，常见于
// Windows WSL2/Hyper-V 保留段)时改用 pickPort 跳过保留段后重绑。通过启动器
// (scripts/start.mjs) 运行时 PORT 已是空闲端口，不会触发以下分支。
const MAX_PORT_ATTEMPTS = 20
let actualPort = port
let portAttempt = 0

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (portAttempt < MAX_PORT_ATTEMPTS) {
      const nextPort = actualPort + 1
      console.warn(
        `[server] Port ${actualPort} is already in use, trying ${nextPort}...`,
      )
      actualPort = nextPort
      portAttempt += 1
      httpServer.listen(actualPort)
      return
    }
    console.error(
      `[server] Could not bind a free port after ${MAX_PORT_ATTEMPTS} ` +
        `attempts starting from ${port}. Set a free port, e.g. ` +
        `PORT=${port + MAX_PORT_ATTEMPTS + 1} npm run dev`,
    )
  } else if (err.code === 'EACCES') {
    console.warn(
      `[server] No permission to bind port ${actualPort} ` +
        `(on Windows WSL2/Hyper-V this port may be reserved by the system). ` +
        `Falling back to auto-pick a free port...`,
    )
    pickPort()
      .then((freePort) => {
        if (freePort) {
          actualPort = freePort
          httpServer.listen(actualPort)
        } else {
          console.error(
            `[server] No free port available. Run "npm run start" or set ` +
              `PORT to a free one.`,
          )
          process.exit(1)
        }
      })
      .catch((e) => {
        console.error(`[server] Failed to auto-pick a port:`, e)
        process.exit(1)
      })
    return
  } else {
    throw err
  }
  process.exit(1)
})

httpServer.listen(actualPort, () => {
  console.log(
    `[server] http://localhost:${actualPort} (${isProd ? 'prod' : 'dev'})`,
  )
})


