# Render every poster in this folder to a 3840x2160 PNG (2x of the 1920x1080 layout) with headless Chrome or Edge.
# Usage: .\docs\landing\render.ps1            (all posters)
#        .\docs\landing\render.ps1 v1-tree    (one poster, name without .html)
param([string]$Name = "")
$browser = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw "Chrome or Edge not found." }
$pattern = if ($Name) { "$Name.html" } else { "v*.html" }
foreach ($file in Get-ChildItem -Path $PSScriptRoot -Filter $pattern) {
  $png = [IO.Path]::ChangeExtension($file.FullName, ".png")
  & $browser --headless --disable-gpu --hide-scrollbars --window-size=1920,1080 --force-device-scale-factor=2 `
    --virtual-time-budget=5000 --screenshot="$png" ("file:///" + ($file.FullName -replace '\\', '/')) 2>$null | Out-Null
  Write-Output "rendered $png"
}
