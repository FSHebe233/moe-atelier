import { spawnSync } from 'node:child_process'
import os from 'node:os'

// Cross-platform launcher.
// - On Windows: delegate to start.ps1, which auto-picks a free port
//   (avoiding WSL2/Hyper-V reserved ranges and already-listening ports).
// - On other platforms: start the production server directly.
const isWin = os.platform() === 'win32'

const result = isWin
  ? spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'start.ps1'], {
      stdio: 'inherit',
    })
  : spawnSync('node', ['server.mjs', '--prod'], { stdio: 'inherit' })

process.exit(result.status ?? 0)
