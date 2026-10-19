$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'publish\SmartzComputerAgent.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw 'Run Publish.ps1 first; the self-contained application was not found.'
}

$installDirectory = Join-Path $env:LOCALAPPDATA 'Smartz\ComputerAgent\App'
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$destination = Join-Path $installDirectory 'SmartzComputerAgent.exe'
Copy-Item -LiteralPath $source -Destination $destination -Force

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenu 'Smart.z Computer Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $destination
$shortcut.WorkingDirectory = $installDirectory
$shortcut.Description = 'Smart.z Windows computer agent'
$shortcut.Save()

Write-Host "Installed Smart.z Computer Agent: $destination"
