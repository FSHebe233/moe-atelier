import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
const isProd = process.argv.includes('--prod')
const port = Number(process.env.PORT) || 5173
const saveDir = path.resolve(rootDir, 'saved-images')
const distDir = path.resolve(rootDir, 'dist')

const getExtensionFromType = (contentType = '') => {
  const normalized = contentType.toLowerCase()
  const mapping = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  }
  const matched = Object.keys(mapping).find((key) => normalized.includes(key))
  return matched ? mapping[matched] : '.bin'
}

const readRequestBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const findExistingFile = async (hash) => {
  try {
    const files = await fs.promises.readdir(saveDir)
    return files.find((name) => name.startsWith(hash)) || null
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

const saveImageBuffer = async (buffer, contentType) => {
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const extension = getExtensionFromType(contentType)
  const fileName = `${fileHash}${extension}`
  const filePath = path.join(saveDir, fileName)

  await fs.promises.mkdir(saveDir, { recursive: true })
  const matched = await findExistingFile(fileHash)
  if (matched) {
    return { saved: false, exists: true, fileName: matched }
  }

  await fs.promises.writeFile(filePath, buffer)
  return { saved: true, exists: false, fileName }
}

const app = express()

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
    server: { middlewareMode: true },
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

app.listen(port, () => {
  console.log(`[server] http://localhost:${port} (${isProd ? 'prod' : 'dev'})`)
})
