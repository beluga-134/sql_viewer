[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireBuildTools
Set-Location $ProjectRoot

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\.bin\vite.cmd') -PathType Leaf)) {
    & $NpmCommand install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $NpmCommand run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $CargoCommand test --manifest-path src-tauri\Cargo.toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $CargoCommand check --manifest-path src-tauri\Cargo.toml
exit $LASTEXITCODE
