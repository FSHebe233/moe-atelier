import net from 'node:net'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const DEFAULT_CANDIDATES = [5173, 8080, 5500, 9000, 50080, 54434]

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

export async function pickPort(candidates = DEFAULT_CANDIDATES) {
  const excluded = getWindowsExcludedRanges()
  for (const p of candidates) {
    if (isExcluded(p, excluded)) continue
    if (await isPortFree(p)) return p
  }
  // Fallback: random high port (55000-60000)
  const base = 55000 + Math.floor(Math.random() * 500)
  for (let i = 0; i < 200; i++) {
    const p = base + i
    if (isExcluded(p, excluded)) continue
    if (await isPortFree(p)) return p
  }
  return 0
}

export { DEFAULT_CANDIDATES }
