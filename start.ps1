# start.ps1 - moe-atelier launcher (Windows)
# Automatically picks an available port, bypassing system reserved ranges and process conflicts.
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1

$PreferredPorts = @(5173, 8080, 5500, 9000, 50080, 54434)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  moe-atelier start" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[1/3] Checking port availability..." -ForegroundColor Gray

# Parse excluded port ranges
$ExcludedRanges = netsh interface ipv4 show excludedportrange protocol=tcp |
    Select-String -Pattern '^\s*(\d+)\s+(\d+)' |
    ForEach-Object {
        [PSCustomObject]@{
            Start = [int]$_.Matches[0].Groups[1].Value
            End   = [int]$_.Matches[0].Groups[2].Value
        }
    }

function Test-PortExcluded($Port) {
    foreach ($range in $ExcludedRanges) {
        if ($Port -ge $range.Start -and $Port -le $range.End) {
            return $true
        }
    }
    return $false
}

$ChosenPort = $null
foreach ($p in $PreferredPorts) {
    if (Test-PortExcluded $p) {
        Write-Host "  Port $p - excluded by system, skipping" -ForegroundColor DarkYellow
        continue
    }
    $listener = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' } |
        Select-Object -First 1
    if ($listener) {
        $procInfo = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        $procName = if ($procInfo) { $procInfo.ProcessName } else { "unknown" }
        Write-Host "  Port $p - in use by $procName, skipping" -ForegroundColor DarkYellow
        continue
    }
    $ChosenPort = $p
    break
}

if (-not $ChosenPort) {
    Write-Host "  No preferred port available, picking random high port..." -ForegroundColor Yellow
    $Base = Get-Random -Minimum 55000 -Maximum 60000
    for ($i = 0; $i -lt 100; $i++) {
        $candidate = $Base + $i
        if (Test-PortExcluded $candidate) { continue }
        $listener = Get-NetTCPConnection -LocalPort $candidate -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq 'Listen' } |
            Select-Object -First 1
        if ($listener) { continue }
        $ChosenPort = $candidate
        break
    }
}

if (-not $ChosenPort) {
    Write-Host ""
    Write-Host "[ERROR] No available port found!" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "[2/3] Selected port: $ChosenPort" -ForegroundColor Green
Write-Host "      URL: http://localhost:$ChosenPort" -ForegroundColor Green
Write-Host ""
Write-Host "[3/3] Starting server..." -ForegroundColor Gray
Write-Host "      Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

$env:PORT = $ChosenPort
node server.mjs --prod

Write-Host ""
Write-Host "Server stopped." -ForegroundColor Yellow
