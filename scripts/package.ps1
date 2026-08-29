[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireBuildTools
Set-Location $ProjectRoot

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\.bin\vite.cmd') -PathType Leaf)) {
    & $NpmCommand install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $NpmCommand run tauri -- build --no-bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$BuiltExecutable = Join-Path $env:CARGO_TARGET_DIR 'release\sql-viewer.exe'
if (-not (Test-Path -LiteralPath $BuiltExecutable -PathType Leaf)) {
    throw "Built executable was not found: $BuiltExecutable"
}

$ReleaseDirectory = Join-Path $ProjectRoot 'release'
$ReleaseExecutable = Join-Path $ReleaseDirectory 'SQL Viewer.exe'
New-Item -ItemType Directory -Path $ReleaseDirectory -Force | Out-Null
Copy-Item -LiteralPath $BuiltExecutable -Destination $ReleaseExecutable -Force

$SizeMb = [Math]::Round((Get-Item -LiteralPath $ReleaseExecutable).Length / 1MB, 1)
Write-Host "Packaged executable: $ReleaseExecutable ($SizeMb MB)"
