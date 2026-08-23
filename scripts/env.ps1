[CmdletBinding()]
param(
    [switch]$RequireNode,
    [switch]$RequireRust,
    [switch]$RequireBuildTools
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$LocalTooling = Join-Path $ProjectRoot '.tooling\windows'
$SiblingTooling = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\qq_codex\.tooling\windows'))
$ToolingRoot = $null

foreach ($Candidate in @($LocalTooling, $SiblingTooling)) {
    if (Test-Path -LiteralPath $Candidate -PathType Container) {
        $ToolingRoot = $Candidate
        break
    }
}

$NpmCommand = $null
$CargoCommand = $null

if ($ToolingRoot) {
    $NodeRoot = Join-Path $ToolingRoot 'node'
    $CargoHome = Join-Path $ToolingRoot 'cargo'
    $RustupHome = Join-Path $ToolingRoot 'rustup'
    $NpmCommand = Join-Path $NodeRoot 'npm.cmd'
    $CargoCommand = Join-Path $CargoHome 'bin\cargo.exe'
    $env:CARGO_HOME = $CargoHome
    $env:RUSTUP_HOME = $RustupHome
    $env:PATH = "$NodeRoot;$CargoHome\bin;$env:PATH"
}

if (-not $NpmCommand -or -not (Test-Path -LiteralPath $NpmCommand -PathType Leaf)) {
    $SystemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($SystemNpm) { $NpmCommand = $SystemNpm.Source }
}

if (-not $CargoCommand -or -not (Test-Path -LiteralPath $CargoCommand -PathType Leaf)) {
    $SystemCargo = Get-Command cargo.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($SystemCargo) { $CargoCommand = $SystemCargo.Source }
}

$CacheRoot = Join-Path $ProjectRoot '.cache\windows'
$env:NPM_CONFIG_CACHE = Join-Path $CacheRoot 'npm'
$env:CARGO_TARGET_DIR = Join-Path $CacheRoot 'cargo-target'
New-Item -ItemType Directory -Path $env:NPM_CONFIG_CACHE -Force | Out-Null
New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null

if ($RequireNode -and (-not $NpmCommand -or -not (Test-Path -LiteralPath $NpmCommand))) {
    throw 'Windows Node/npm was not found. Run setup-windows.cmd in the sibling qq_codex project first.'
}

if ($RequireRust -and (-not $CargoCommand -or -not (Test-Path -LiteralPath $CargoCommand))) {
    throw 'Windows Rust/Cargo was not found. Run setup-windows.cmd in the sibling qq_codex project first.'
}

function Import-VsDeveloperEnvironment {
    $Candidates = New-Object System.Collections.Generic.List[string]
    if (${env:ProgramFiles(x86)}) {
        $Candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'))
    }
    if ($env:ProgramFiles) {
        $Candidates.Add((Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'))
    }
    if ($ToolingRoot) {
        $Candidates.Insert(0, (Join-Path $ToolingRoot 'vs-build-tools\Common7\Tools\VsDevCmd.bat'))
    }

    $DevCmd = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $DevCmd) {
        if ($RequireBuildTools) { throw 'Visual Studio C++ Build Tools were not found.' }
        return
    }

    $Lines = @(& $env:ComSpec /d /s /c ('call "{0}" -no_logo -arch=x64 -host_arch=x64 >nul && set' -f $DevCmd))
    if ($LASTEXITCODE -ne 0) { throw "Failed to load the MSVC environment: $DevCmd" }
    foreach ($Line in $Lines) {
        $Separator = $Line.IndexOf('=')
        if ($Separator -le 0) { continue }
        $Name = $Line.Substring(0, $Separator)
        $Value = $Line.Substring($Separator + 1)
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

if ($RequireBuildTools) { Import-VsDeveloperEnvironment }
