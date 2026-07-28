import net from 'node:net'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const DEFAULT_CANDIDATES = [5173, 8080, 5500, 9000, 50080, 54434]

// 环境变量覆盖（用户自定义）：
//   PORT_CANDIDATES="3000,4000,8080"  -> 自定义首选端口列表（逗号/空格分隔）
//   PORT_RANGE="8000-9000"            -> 首选均不可用时，在该区间内顺序扫描
function getEnvCandidates() {
  const raw = process.env.PORT_CANDIDATES
  if (!raw) return null
  const list = raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
  return list.length ? list : null
}

function getEnvRange() {
  const raw = process.env.PORT_RANGE
  if (!raw) return null
  const m = raw.match(/^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/)
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (start <= 0 || end >= 65536 || start > end) return null
  return [start, end]
}

// On Windows, read system reserved (excluded) TCP port ranges via netsh,
// so we can skip them without even attempting to bind (avoids EACCES noise
// from WSL2 / Hyper-V reserved ranges).
function getWindowsExcludedRanges() {
  if (os.platform() !== 'win32') return []
  try {
    const out =
      spawnSync(
        'netsh',
        ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
        { encoding: 'utf8', windowsHide: true },
      ).stdout || ''
    const ranges = []
    const re = /^\s*(\d+)\s+(\d+)/gm
    let m
    while ((m = re.exec(out))) {
      ranges.push([Number(m[1]), Number(m[2])])
    }
    return ranges
  } catch {
    return []
  }
}

function isExcluded(port, ranges) {
  return ranges.some(([start, end]) => port >= start && port <= end)
}

// Cross-platform free-port probe: try to bind; success => free.
// Catches both EADDRINUSE (in use) and EACCES (no permission / reserved).
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    srv.once('error', () => done(false))
    srv.once('listening', () => {
      srv.close(() => done(true))
    })
    srv.listen(port)
  })
}

async function scanRange(start, end, excluded) {
  for (let p = start; p <= end; p++) {
    if (isExcluded(p, excluded)) continue
    if (await isPortFree(p)) return p
  }
  return 0
}

export async function pickPort(candidates = DEFAULT_CANDIDATES) {
  const excluded = getWindowsExcludedRanges()
  const preferred = getEnvCandidates() || candidates
  for (const p of preferred) {
    if (isExcluded(p, excluded)) continue
    if (await isPortFree(p)) return p
  }
  // 首选均不可用：优先用 PORT_RANGE 区间顺序扫描，否则回退 55000-60000 随机段
  const range = getEnvRange()
  if (range) {
    const found = await scanRange(range[0], range[1], excluded)
    if (found) return found
  }
  const base = 55000 + Math.floor(Math.random() * 500)
  for (let i = 0; i < 200; i++) {
    const p = base + i
    if (isExcluded(p, excluded)) continue
    if (await isPortFree(p)) return p
  }
  return 0
}

export { DEFAULT_CANDIDATES }
