# run-as-admin-fix.ps1 - Run this as Administrator to fix the watchdog flash
$vbs = 'C:\Users\msi india\.gemini\antigravity\scratch\scrynai-clone\utils\silent-run.vbs'
$ps1 = 'C:\Users\msi india\.gemini\antigravity\scratch\scrynai-clone\watchdog.ps1'

Write-Host "`n[HaimuAi Flash Fix] Applying fix..." -ForegroundColor Cyan

# Update watchdog to use wscript (zero-flash)
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$ps1`""
Set-ScheduledTask -TaskName 'HaimuAi_Watchdog' -Action $action
Write-Host "[OK] HaimuAi_Watchdog updated to silent wscript launcher" -ForegroundColor Green

# Remove stale duplicate task
Unregister-ScheduledTask -TaskName 'HaimuAI' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] Removed duplicate HaimuAI task" -ForegroundColor Green

# Confirm
Write-Host "`n[DONE] No more flashing terminal! Watchdog runs silently now." -ForegroundColor Green
Write-Host "Current tasks:"
Get-ScheduledTask | Where-Object { $_.TaskName -like "*Haimu*" } | 
    ForEach-Object { $a = $_.Actions[0]; Write-Host "  $($_.TaskName) -> $($a.Execute)" }

Start-Sleep -Seconds 4
