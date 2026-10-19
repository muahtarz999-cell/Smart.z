$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Smartz\ComputerAgent\App'
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Smart.z Computer Agent.lnk'

if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
  Remove-Item -LiteralPath $shortcutPath -Force
}
if (Test-Path -LiteralPath $installDirectory -PathType Container) {
  Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

Write-Host 'The application was removed. Encrypted pairing settings were retained.'
