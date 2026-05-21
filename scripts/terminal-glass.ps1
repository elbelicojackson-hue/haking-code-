$settingsPath = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if (!(Test-Path $settingsPath)) {
    $settingsPath = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json"
}
if (!(Test-Path $settingsPath)) { Write-Host "Windows Terminal not found." -ForegroundColor Red; exit 1 }

$content = Get-Content $settingsPath -Raw
$newDefaults = '"defaults": { "useAcrylic": true, "acrylicOpacity": 0.85, "opacity": 85 }'

if ($content -match '"defaults"\s*:\s*\{[^}]*\}') {
    $content = $content -replace '"defaults"\s*:\s*\{[^}]*\}', $newDefaults
}
else {
    $content = $content -replace '("profiles"\s*:\s*\{)', "`$1 $newDefaults,"
}

Set-Content $settingsPath -Value $content -Encoding UTF8
Write-Host "Done! Acrylic glass enabled (85%). Restart terminal." -ForegroundColor Cyan
