param([string]$Command = "install")
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$InstallRoot = if ($env:DIFFUSE_INSTALL_ROOT) { $env:DIFFUSE_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Diffuse" }
$BinDir = if ($env:DIFFUSE_BIN_DIR) { $env:DIFFUSE_BIN_DIR } else { Join-Path $env:USERPROFILE "bin" }
$BinPath = Join-Path $BinDir "diffuse.exe"

function Need($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Check-Requirements {
  Need git
  Need just
  Need zig
  Need node
  Need pnpm
}

function Require-Path($Path) {
  if (-not (Test-Path $Path)) {
    throw "Missing build artifact: $Path. Run just build first."
  }
}

function Install-Diffuse {
  Check-Requirements
  Require-Path (Join-Path $Root "core\zig-out\bin\diffuse.exe")
  Require-Path (Join-Path $Root "app\out\main\main.js")
  Require-Path (Join-Path $Root "app\out\renderer\index.html")
  Require-Path (Join-Path $Root "app\node_modules\electron")

  New-Item -ItemType Directory -Force $InstallRoot, (Join-Path $InstallRoot "app"), (Join-Path $InstallRoot "core"), $BinDir | Out-Null
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $InstallRoot "app\out"), (Join-Path $InstallRoot "app\node_modules")
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $InstallRoot "app\package.json"), (Join-Path $InstallRoot "core\diffuse.exe"), $BinPath
  Copy-Item -Recurse -Force (Join-Path $Root "app\out") (Join-Path $InstallRoot "app\out")
  Copy-Item -Recurse -Force (Join-Path $Root "app\node_modules") (Join-Path $InstallRoot "app\node_modules")
  Copy-Item -Force (Join-Path $Root "app\package.json") (Join-Path $InstallRoot "app\package.json")
  Copy-Item -Force (Join-Path $Root "core\zig-out\bin\diffuse.exe") (Join-Path $InstallRoot "core\diffuse.exe")
  Copy-Item -Force (Join-Path $Root "core\zig-out\bin\diffuse.exe") $BinPath
  Ensure-Path
  Install-Completions
  Write-Host "Installed Diffuse to $InstallRoot"
  Write-Host "Command: $BinPath"
}

function Ensure-Path {
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if ($Entries -contains $BinDir) { return }
  $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
  $env:Path = "$env:Path;$BinDir"
  Write-Host "Added $BinDir to the user PATH. Restart terminals for the change to apply everywhere."
}

function Install-Completions {
  New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null
  $Line = 'Register-ArgumentCompleter -Native -CommandName diffuse -ScriptBlock { param($wordToComplete, $commandAst, $cursorPosition) ''update'',''install'',''completion'',''list-versions'',''--help'',''--version'' | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, ''ParameterValue'', $_) } }'
  if ((Test-Path $PROFILE) -and (Select-String -Path $PROFILE -Pattern 'Register-ArgumentCompleter -Native -CommandName diffuse' -Quiet)) { return }
  Add-Content -Path $PROFILE -Value $Line
  Write-Host "Installed PowerShell completion in $PROFILE"
}

function Uninstall-Diffuse {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $InstallRoot
  Remove-Item -Force -ErrorAction SilentlyContinue $BinPath
  Write-Host "Uninstalled Diffuse"
}

switch ($Command) {
  "install" { Install-Diffuse }
  "uninstall" { Uninstall-Diffuse }
  "completions" { Install-Completions }
  default { throw "Unknown install command: $Command" }
}
