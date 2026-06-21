param(
  [string]$Version = $env:DIFFUSE_VERSION,
  [string]$Repo = $(if ($env:DIFFUSE_GITHUB_REPO) { $env:DIFFUSE_GITHUB_REPO } else { "CrazyCatViking/diffuse" })
)
$ErrorActionPreference = "Stop"

if (-not $Version) { $Version = "latest" }
$InstallRoot = if ($env:DIFFUSE_INSTALL_ROOT) { $env:DIFFUSE_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Diffuse" }
$BinDir = if ($env:DIFFUSE_BIN_DIR) { $env:DIFFUSE_BIN_DIR } else { Join-Path $env:USERPROFILE "bin" }

$Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture) {
  "X64" { "x64" }
  "Arm64" { "arm64" }
  default { throw "Unsupported architecture: $_" }
}

if ($Version -eq "latest") {
  $Latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $Latest.tag_name
}
if (-not $Version) { throw "Could not resolve Diffuse release version." }

$Tag = $Version
$PlainVersion = $Version.TrimStart("v")
$Asset = "diffuse-$PlainVersion-win-$Arch.zip"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force $Temp | Out-Null

try {
  $Archive = Join-Path $Temp $Asset
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Archive
  Expand-Archive -Force $Archive (Join-Path $Temp "app")

  New-Item -ItemType Directory -Force $InstallRoot, $BinDir | Out-Null
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $InstallRoot "Diffuse")
  $AppExe = Get-ChildItem -Path (Join-Path $Temp "app") -Recurse -Include "diffuse.exe", "Diffuse.exe" | Where-Object { $_.Directory.Name -ne "resources" } | Select-Object -First 1
  if (-not $AppExe) { throw "Could not find Diffuse.exe in $Asset" }
  Copy-Item -Recurse -Force $AppExe.Directory.FullName (Join-Path $InstallRoot "Diffuse")

  $Launcher = Join-Path $BinDir "diffuse.ps1"
  $Exe = Join-Path (Join-Path $InstallRoot "Diffuse") $AppExe.Name
  $Core = Join-Path $InstallRoot "Diffuse\resources\diffuse.exe"
  Set-Content -Path $Launcher -Value @"
`$exe = '$Exe'
`$core = '$Core'
if (`$args.Count -eq 0) { Start-Process -FilePath `$exe; exit 0 }
switch (`$args[0]) {
  'update' { Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/$Repo/main/scripts/install-release.ps1'); exit `$LASTEXITCODE }
  'install' { if (`$args.Count -lt 2) { Write-Error 'Usage: diffuse install <version>'; exit 2 }; `$env:DIFFUSE_VERSION = `$args[1]; Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/$Repo/main/scripts/install-release.ps1'); exit `$LASTEXITCODE }
  { `$_ -in @('--help','--version','version','completion','list-versions','rpc','files','diff') } { & `$core @args; exit `$LASTEXITCODE }
  default { `$repoPath = try { (Resolve-Path -LiteralPath `$args[0]).Path } catch { `$args[0] }; Start-Process -FilePath `$exe -ArgumentList @('--open-repository', `$repoPath); exit 0 }
}
"@
  Set-Content -Path (Join-Path $BinDir "diffuse.cmd") -Value "@powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" %*`r`n"

  $Programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  New-Item -ItemType Directory -Force $Programs | Out-Null
  $Shortcut = Join-Path $Programs "Diffuse.lnk"
  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut($Shortcut)
  $Link.TargetPath = $Exe
  $Link.WorkingDirectory = Split-Path $Exe
  $Link.Description = "Review and inspect repository diffs"
  $Link.Save()

  Set-Content -Path (Join-Path $InstallRoot "metadata.json") -Value (@{
    version = $PlainVersion
    source = "github-release"
    tag = $Tag
  } | ConvertTo-Json)

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if ($Entries -notcontains $BinDir) {
    $NewPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    $env:Path = "$env:Path;$BinDir"
    Write-Host "Added $BinDir to the user PATH. Restart terminals for the change to apply everywhere."
  }

  Write-Host "Installed Diffuse $Tag"
  Write-Host "Command: $Launcher"
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
