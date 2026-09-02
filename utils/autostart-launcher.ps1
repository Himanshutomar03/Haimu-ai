$ExePath = 'C:\Users\msi india\.gemini\antigravity\scratch\scrynai-clone\dist\HaimuAi-Portable.exe'
$AppDir  = 'C:\Users\msi india\.gemini\antigravity\scratch\scrynai-clone\dist'
$ErrorActionPreference = 'SilentlyContinue'
if (Test-Path $ExePath) {
    $wmi = [wmiclass]'Win32_Process'
    $wmi.Create(""$ExePath" --stealth", $AppDir, $null) | Out-Null
}
