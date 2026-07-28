import { spawnSync } from 'node:child_process'
import { pickPort } from './port-select.mjs'

// Universal launcher: auto-picks a free port (cross-platform, no PowerShell
// dependency) and starts server.mjs with that port. Works for dev/preview/start.
const mode = process.argv.includes('--dev') ? '--dev' : '--prod'

const main = async () => {
  const port = await pickPort()
  if (!port) {
    console.error('[start] No available port found!')
    process.exit(1)
  }
  console.log(`[start] Selected port ${port} -> http://localhost:${port}`)
  const result = spawnSync('node', ['server.mjs', mode], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
  })
  process.exit(result.status ?? 0)
}

main()
