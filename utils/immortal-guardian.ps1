# ============================================================
# HaimuAi Immortal Guardian v2
#
# Multi-layer survival system:
#   Layer 1 - 5-second heartbeat loop (not 2-min Task Scheduler)
#   Layer 2 - Self-resurrection: spawns a child that watches the parent
#   Layer 3 - Detects lockdown browsers and respawns before they finish
#   Layer 4 - Registers itself into Run registry so it survives reboots
#   Layer 5 - Runs as detached WMI process (no parent = unkillable via parent kill)
#
# Process disguise: appears as "RuntimeBroker" or "SearchIndexer"
# ============================================================

$host.UI.RawUI.WindowTitle = "SearchIndexer"
$ErrorActionPreference = "SilentlyContinue"

# ── Paths ────────────────────────────────────────────────────
$ScriptPath  = $MyInvocation.MyCommand.Path
$AppDir      = Split-Path -Parent (Split-Path -Parent $ScriptPath)
$DevElectron = Join-Path $AppDir "node_modules\electron\dist\electron.exe"
$BuiltExe    = Join-Path $AppDir "dist\HaimuAi-Portable.exe"
$MainJs      = Join-Path $AppDir "main.js"
$SilentVbs   = Join-Path $AppDir "utils\silent-run.vbs"
$QuitFlag    = Join-Path $AppDir ".haimu_quit"  # forceQuit() creates this

# ── Self-register in registry (survives reboot, runs before lockdown) ──
# Uses wscript.exe + silent-run.vbs to avoid terminal flash on startup
try {
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $vbsArg  = "`"$SilentVbs`" `"$ScriptPath`""
    Set-ItemProperty -Path $regPath -Name "WindowsSearchHelper" -Value "wscript.exe $vbsArg" -ErrorAction SilentlyContinue
} catch {}

# ── Determine app exe ────────────────────────────────────────
function Get-AppExe {
    if (Test-Path $BuiltExe)    { return $BuiltExe }
    if (Test-Path $DevElectron) { return $DevElectron }
    return $null
}

# ── Is HaimuAi running? ──────────────────────────────────────
function Is-HaimuRunning {
    # Check built exe
    $built = Get-Process -Name "HaimuAi*" -ErrorAction SilentlyContinue
    if ($built) { return $true }

    # Check electron processes belonging to our directory
    try {
        $dirLow = $AppDir.ToLower()
        $ep = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $ep) {
            $cmd = ($p.CommandLine + "").ToLower()
            if ($cmd -like "*$dirLow*" -or $cmd -like "*scrynai*" -or $cmd -like "*haimuai*") {
                return $true
            }
        }

        # Also check RuntimeBroker (our disguise name)
        $rb = Get-CimInstance Win32_Process -Filter "Name='RuntimeBroker.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $rb) {
            $cmd = ($p.CommandLine + "").ToLower()
            if ($cmd -like "*$dirLow*" -or $cmd -like "*electron*") {
                return $true
            }
        }
    } catch {}

    return $false
}

# ── Detect lockdown browser running ─────────────────────────
$LockdownProcessNames = @(
    "RCBrowserLockDown", "LockDownBrowser", "SafeExamBrowser",
    "seb", "respondus", "proctorio", "testudo", "examity",
    "ProctorU", "Honorlock", "Kryterion", "ExamSoft", "Examplify"
)

function Is-LockdownActive {
    foreach ($name in $LockdownProcessNames) {
        $p = Get-Process -Name "*$name*" -ErrorAction SilentlyContinue
        if ($p) { return $true }
    }
    return $false
}

# ── Launch HaimuAi via WMI (no parent — immortal) ───────────
function Launch-HaimuAi {
    $exe = Get-AppExe
    if (-not $exe) {
        # Fallback: npm start
        $wmi = [wmiclass]"Win32_Process"
        $wmi.Create("cmd.exe /c cd `"$AppDir`" && npm start", $AppDir, $null) | Out-Null
        return
    }

    $args = if ($exe -like "*HaimuAi*") { "--stealth" } else { "`"$AppDir`" --detached --stealth" }
    $cmd  = "`"$exe`" $args"

    $wmi    = [wmiclass]"Win32_Process"
    $result = $wmi.Create($cmd, $AppDir, $null)

    if ($result.ReturnValue -ne 0) {
        # WMI failed — try Start-Process as fallback
        Start-Process -FilePath $exe -ArgumentList $args.Split(" ") -WindowStyle Hidden -WorkingDirectory $AppDir
    }
}

# ── Spawn a sibling guardian (watches THIS process) ─────────
# If this process is killed, the sibling relaunches both HaimuAi AND a new guardian
function Spawn-SiblingGuardian {
    $myPid   = $PID
    $sibling = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$host.UI.RawUI.WindowTitle = 'SearchIndexer'
while (`$true) {
    Start-Sleep -Seconds 3
    `$alive = Get-Process -Id $myPid -ErrorAction SilentlyContinue
    if (-not `$alive) {
        # Parent guardian was killed — relaunch guardian + app via wscript (no terminal flash)
        `$vbs = '$SilentVbs'
        `$wmi = [wmiclass]'Win32_Process'
        `$wmi.Create('wscript.exe ""' + `$vbs + '"" ""$ScriptPath""', '$AppDir', `$null) | Out-Null
        break
    }
}
"@
    $tmpScript = "$env:TEMP\wsh_helper_$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).ps1"
    Set-Content -Path $tmpScript -Value $sibling -Encoding UTF8

    # Launch sibling via wscript.exe (zero terminal flash) instead of raw powershell.exe
    $wmi = [wmiclass]"Win32_Process"
    $wmi.Create("wscript.exe `"$SilentVbs`" `"$tmpScript`"", $AppDir, $null) | Out-Null
}

# ── Main immortality loop ────────────────────────────────────
# Spawn sibling watcher first
Spawn-SiblingGuardian

$lastLockdownWarning = [DateTime]::MinValue
$respawnCooldown     = [DateTime]::MinValue

while ($true) {
    try {
        # ── Quit flag check — forceQuit() writes this file ──
        if (Test-Path $QuitFlag) {
            # Remove registry entry so we don't restart on reboot
            Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WindowsSearchHelper" -ErrorAction SilentlyContinue
            Remove-Item $QuitFlag -Force -ErrorAction SilentlyContinue
            exit 0
        }

        $lockdown = Is-LockdownActive

        if (-not (Is-HaimuRunning)) {
            $now = Get-Date
            # Cooldown: don't spam-respawn (min 4 seconds between relaunches)
            if (($now - $respawnCooldown).TotalSeconds -ge 4) {
                $respawnCooldown = $now

                # Double-check quit flag before respawning
                if (Test-Path $QuitFlag) { exit 0 }

                if ($lockdown) {
                    Start-Sleep -Milliseconds (Get-Random -Minimum 200 -Maximum 800)
                }

                Launch-HaimuAi
            }
        }

        $sleepMs = if ($lockdown) { 3000 } else { 8000 }
        Start-Sleep -Milliseconds $sleepMs

    } catch {
        Start-Sleep -Seconds 2
    }
}
