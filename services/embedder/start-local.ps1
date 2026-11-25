param(
  [Parameter(Mandatory=$true)][string]$PythonPath,
  [Parameter(Mandatory=$true)][string]$ModelPath,
  [Parameter(Mandatory=$true)][string]$Revision,
  [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
  [int]$Port = 8092,
  [int]$CpuThreads = 8,
  [ValidateRange(1,300)][int]$StartupTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$python = (Resolve-Path -LiteralPath $PythonPath).Path
$weights = (Resolve-Path -LiteralPath $ModelPath).Path
$manifest = Join-Path $weights 'deployment-weights.json'
if (!(Test-Path -LiteralPath $manifest)) { throw 'A verified download manifest is required' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use" }
New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
$runtime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$env:EMBEDDER_MODEL = 'BAAI/bge-m3'
$env:EMBEDDER_MODEL_PATH = $weights
$env:EMBEDDER_WEIGHT_MANIFEST = $manifest
$env:EMBEDDER_REVISION = $Revision
$env:EMBEDDER_DEVICE = 'cpu'
$env:EMBEDDER_CPU_THREADS = [string][Math]::Clamp($CpuThreads, 1, 32)
$env:EMBEDDER_BATCH = '4'
$env:EMBEDDER_MAX_TOKENS = '1024'
$env:EMBEDDER_HOST = '127.0.0.1'
$env:EMBEDDER_PORT = [string]$Port
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:TOKENIZERS_PARALLELISM = 'false'
$server = Join-Path $PSScriptRoot 'server.py'
$launchId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$stdout = Join-Path $runtime "embedder-$launchId.stdout.log"
$stderr = Join-Path $runtime "embedder-$launchId.stderr.log"
$metadata = Join-Path $runtime "embedder-$launchId.json"
$record = [ordered]@{schema='zhiheng-embedder-launch/1';launchId=$launchId;startedAt=[DateTime]::UtcNow.ToString('o');status='starting';port=$Port;model='BAAI/bge-m3';revision=$Revision;device='cpu';stdout=$stdout;stderr=$stderr;metadata=$metadata;launcherPid=$null;pid=$null}
$owned = @{}
$process = $null
function Save-LaunchRecord {
  [IO.File]::WriteAllText($metadata, ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  # This is only a pointer; per-launch logs and records are never overwritten.
  [IO.File]::WriteAllText((Join-Path $runtime 'embedder.latest.json'), ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
}
function Remember-StartupChildren {
  $snapshot = @(Get-CimInstance Win32_Process)
  do {
    $added = $false
    foreach ($child in $snapshot) {
      $key = [string]$child.ProcessId
      $parent = $owned[[string]$child.ParentProcessId]
      if (!$owned.ContainsKey($key) -and $parent -and $child.CreationDate -ge $parent.CreationDate) {
        # A reused parent PID must not adopt an unrelated process into cleanup.
        $liveParent = $snapshot | Where-Object ProcessId -eq $parent.ProcessId | Select-Object -First 1
        if ($liveParent -and $liveParent.CreationDate -eq $parent.CreationDate) {
          $owned[$key] = $child
          $added = $true
        }
      }
    }
  } while ($added)
}
try {
  Save-LaunchRecord
  $process = Start-Process -FilePath $python -ArgumentList ('"' + $server + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $record.launcherPid = $process.Id
  $launchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
  if ($launchProcess) { $owned[[string]$process.Id] = $launchProcess }
  $process.Id | Set-Content -LiteralPath (Join-Path $runtime 'embedder.launcher.pid')
  Save-LaunchRecord
  # Windows venv python can be a redirector; record the actual listener as well.
  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    Remember-StartupChildren
    if ($process.HasExited) { throw "Embedder launcher exited with code $($process.ExitCode)" }
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 1) { throw 'Unexpected listener count' }
    if ($listeners.Count -eq 1) {
      $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
      $expected = $owned[[string]$serverProcess.ProcessId]
      if (!$expected -or $expected.CreationDate -ne $serverProcess.CreationDate) { throw 'Unexpected listener owner' }
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5 -NoProxy
      if ($health.ready -and $health.verifiedWeights -and $health.revision -eq $Revision -and $health.model -eq 'BAAI/bge-m3') {
        $record.status = 'ready'; $record.pid = $serverProcess.ProcessId; $record.readyAt = [DateTime]::UtcNow.ToString('o')
        $record.health = $health
        Save-LaunchRecord
        $serverProcess.ProcessId | Set-Content -LiteralPath (Join-Path $runtime 'embedder.pid')
        Write-Output ($record | ConvertTo-Json -Depth 6 -Compress)
        exit 0
      }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Embedder did not become ready before the startup deadline'
} catch {
  $failure = $_
  try { Remember-StartupChildren } catch { }
  $stopped = @()
  # Only this launch and captured descendants qualify. Recheck creation time
  # immediately before process-tree termination to avoid killing a reused PID.
  foreach ($entry in @($owned.Values | Sort-Object CreationDate)) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.ProcessId)" -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $entry.CreationDate) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$entry.ProcessId) /T /F 2>$null | Out-Null
      $stopped += $entry.ProcessId
    }
  }
  $record.status = 'failed'; $record.failedAt = [DateTime]::UtcNow.ToString('o'); $record.error = $failure.Exception.Message
  $record.cleanupRootPids = $stopped; $record.ownedPids = @($owned.Values | ForEach-Object ProcessId)
  foreach ($pidFile in @('embedder.pid','embedder.launcher.pid')) {
    $pidPath = Join-Path $runtime $pidFile
    if (Test-Path -LiteralPath $pidPath) {
      $stored = [IO.File]::ReadAllText($pidPath).Trim()
      if ($owned.ContainsKey($stored)) { Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue }
    }
  }
  Save-LaunchRecord
  throw $failure
}
