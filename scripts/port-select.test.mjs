import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import { pickPort, DEFAULT_CANDIDATES } from './port-select.mjs'

// 用真实监听占用端口，验证 pickPort 的跳过/回退行为（无需 mock）。
function occupy(port) {
  const srv = net.createServer()
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, () => resolve(srv))
  })
}

const held = []
async function hold(port) {
  const s = await occupy(port)
  held.push(s)
  return s
}
afterEach(async () => {
  for (const s of held) {
    await new Promise((r) => s.close(r))
  }
  held.length = 0
})
const withEnv = async (key, val, fn) => {
  const prev = process.env[key]
  if (val === null) delete process.env[key]
  else process.env[key] = val
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

describe('pickPort', () => {
  it('returns a free port from the default candidates', async () => {
    const p = await pickPort()
    expect(p).toBeGreaterThan(0)
    expect(DEFAULT_CANDIDATES).toContain(p)
  })

  it('skips an occupied candidate and picks the next', async () => {
    await hold(DEFAULT_CANDIDATES[0])
    const p = await pickPort()
    expect(p).not.toBe(DEFAULT_CANDIDATES[0])
    expect(DEFAULT_CANDIDATES).toContain(p)
  })

  it('respects PORT_CANDIDATES override', async () => {
    await hold(3000)
    const p = await withEnv('PORT_CANDIDATES', '3000,4000', () => pickPort())
    expect(p).toBe(4000)
  })

  it('falls back to PORT_RANGE when all preferred are occupied', async () => {
    for (const c of DEFAULT_CANDIDATES) await hold(c)
    const p = await withEnv('PORT_RANGE', '48000-48020', () => pickPort())
    expect(p).toBeGreaterThanOrEqual(48000)
    expect(p).toBeLessThanOrEqual(48020)
  })

  it('falls back to default when PORT_CANDIDATES is invalid', async () => {
    const p = await withEnv('PORT_CANDIDATES', 'abc,12x', () => pickPort())
    expect(p).toBeGreaterThan(0)
    expect(DEFAULT_CANDIDATES).toContain(p)
  })

  // Windows 上 5173 常在系统保留段内，pickPort 必须跳过它。
  it.skipIf(process.platform !== 'win32')(
    'skips system-reserved ports on win32',
    async () => {
      const p = await withEnv('PORT_CANDIDATES', '5173,8080', () => pickPort())
      expect(p).toBe(8080)
    },
  )
})
