$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'Smartz.ComputerAgent.csproj'
$output = Join-Path $PSScriptRoot 'publish'

dotnet publish $project `
  --configuration Release `
  --runtime win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  --output $output

if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

Write-Host "Published Windows app to $output"
