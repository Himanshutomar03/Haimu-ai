# ============================================================
# Affinity Injection Script
#
# Injects affinity-clearing code into a target process using
# multiple techniques to maximize compatibility:
#
# 1. PRIMARY: Launch a hidden PowerShell process that runs
#    affinity-sweep.ps1 with the target PID. This works because
#    SetWindowDisplayAffinity reads are cross-process legal,
#    but WRITES require ownership. We use a separate approach:
#    run the sweep from OUR process which calls the Win32 API
#    targeting the remote process's windows.
#
# 2. ENHANCED: For processes that protect aggressively, spawn
#    the sweep script via WMI so it runs as a fully independent
#    process, harder for the target to detect/kill.
#
# Arguments:
#   -TargetPid    : PID of the target process (0 = auto-detect)
#   -SweepScript  : Path to affinity-sweep.ps1
#   -Mode         : 'direct' (default), 'wmi', 'both'
#
# Output (stdout, for Node.js consumption):
#   OK:injected:<pid>
#   OK:cleared:<count>
#   ERR:<message>
# ============================================================

param(
    [int]$TargetPid = 0,
    [string]$SweepScript = "",
    [ValidateSet("direct","wmi","both")]
    [string]$Mode = "direct"
)

$logDir = Join-Path $env:LOCALAPPDATA "QuickSearch"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "overlay.log"

function Write-OverlayLog {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    try { Add-Content -Path $logPath -Value "[$ts] [affinity] $msg" -ErrorAction SilentlyContinue } catch {}
}

# ---- Load Win32 Types ----
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class AffinityInject {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    // OpenProcess for reading target process info
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public const uint WDA_NONE = 0x00000000;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;

    /// <summary>
    /// Check if any window of the target process has capture protection.
    /// Returns: 0 = no protection, 1+ = number of protected windows.
    /// </summary>
    public static int CheckProtection(uint targetPid) {
        int protectedCount = 0;

        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid && IsWindowVisible(hWnd)) {
                RECT rect;
                if (GetWindowRect(hWnd, out rect)) {
                    int w = rect.Right - rect.Left;
                    int h = rect.Bottom - rect.Top;
                    if (w >= 200 || h >= 200) {
                        uint aff;
                        if (GetWindowDisplayAffinity(hWnd, out aff) && aff != WDA_NONE) {
                            protectedCount++;
                        }
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        return protectedCount;
    }

    /// <summary>
    /// Attempt to clear affinity on target windows from the calling process.
    /// NOTE: This will only work if the calling process owns the windows.
    /// For cross-process, this will fail with ERROR_ACCESS_DENIED.
    /// Returns number of windows where clearing succeeded.
    /// </summary>
    public static int TryClearDirect(uint targetPid) {
        int cleared = 0;
        var windows = new List<IntPtr>();

        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid && IsWindowVisible(hWnd)) {
                RECT rect;
                if (GetWindowRect(hWnd, out rect)) {
                    int w = rect.Right - rect.Left;
                    int h = rect.Bottom - rect.Top;
                    if (w >= 200 || h >= 200) {
                        windows.Add(hWnd);
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        foreach (var hwnd in windows) {
            uint aff;
            if (GetWindowDisplayAffinity(hwnd, out aff) && aff != WDA_NONE) {
                // Try to clear — this may fail cross-process
                try {
                    if (SetWindowDisplayAffinity(hwnd, WDA_NONE)) cleared++;
                } catch {}
            }
        }

        return cleared;
    }
}
"@ -ErrorAction Stop

# ---- Auto-detect target process ----
$sebNames = @(
    'SafeExamBrowser', 'seb', 'SEB',
    'RCBrowserLockDown', 'LockDownBrowser',
    'Respondus', 'respondus',
    'Proctorio', 'proctorio',
    'ExamSoft', 'Examplify',
    'ProctorU', 'Honorlock'
)

if ($TargetPid -eq 0) {
    foreach ($name in $sebNames) {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        if ($procs) {
            # Wait for process to be > 3 seconds old (init protection)
            $targetProc = $procs | Where-Object {
                ((Get-Date) - $_.StartTime).TotalSeconds -gt 3
            } | Sort-Object StartTime | Select-Object -First 1
            
            if ($targetProc) {
                $TargetPid = $targetProc.Id
                break
            }
        }
    }
}

if ($TargetPid -eq 0) {
    Write-Output "ERR:NoTarget"
    exit 1
}

# ---- Wait for visible main window ≥250px ----
Write-OverlayLog "found target PID $TargetPid — waiting for main window..."

$mainWindowFound = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $protCount = [AffinityInject]::CheckProtection([uint32]$TargetPid)
    # Even 0 protection means windows exist, just not protected
    # We just need any visible window
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $mainWindowFound = $true
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $mainWindowFound) {
    Write-OverlayLog "WARNING: no main window found after 15s, proceeding anyway"
}

# ---- Check current protection status ----
$protectedWindows = [AffinityInject]::CheckProtection([uint32]$TargetPid)
Write-OverlayLog "target PID $TargetPid has $protectedWindows protected windows"

if ($protectedWindows -eq 0) {
    Write-Output "OK:noprotection:$TargetPid"
    exit 0
}

# ---- Attempt 1: Direct cross-process clear (may fail) ----
$directCleared = [AffinityInject]::TryClearDirect([uint32]$TargetPid)
Write-OverlayLog "direct clear attempt: $directCleared windows cleared"

if ($directCleared -gt 0) {
    Write-Output "OK:cleared:$directCleared"
    exit 0
}

# ---- Attempt 2: Launch sweep script targeting the PID ----
# Since cross-process SetWindowDisplayAffinity fails, we need
# code running INSIDE the target. For now, we launch the sweep
# script which will try to set affinity (may also fail cross-process).
# The real solution requires DLL injection — see affinity-bypass.js.

if ($SweepScript -ne "" -and (Test-Path $SweepScript)) {
    Write-OverlayLog "launching sweep script for PID $TargetPid"
    
    if ($Mode -eq "wmi" -or $Mode -eq "both") {
        # WMI spawn — fully orphaned process
        try {
            $escapedScript = $SweepScript.Replace('\', '\\')
            $wmiArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File `"$escapedScript`" -TargetPid $TargetPid"
            $wmi = [wmiclass]'Win32_Process'
            $result = $wmi.Create("powershell.exe $wmiArgs", (Split-Path $SweepScript), $null)
            Write-OverlayLog "WMI sweep launched (return: $($result.ReturnValue), PID: $($result.ProcessId))"
            Write-Output "OK:wmi-launched:$($result.ProcessId)"
        } catch {
            Write-OverlayLog "WMI launch failed: $($_.Exception.Message)"
        }
    }
    
    if ($Mode -eq "direct" -or $Mode -eq "both") {
        # Direct spawn
        try {
            $sweepProc = Start-Process -FilePath "powershell.exe" `
                -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-NonInteractive", "-File", $SweepScript, "-TargetPid", $TargetPid) `
                -WindowStyle Hidden -PassThru
            Write-OverlayLog "direct sweep launched (PID: $($sweepProc.Id))"
            Write-Output "OK:sweep-launched:$($sweepProc.Id)"
        } catch {
            Write-OverlayLog "direct sweep launch failed: $($_.Exception.Message)"
            Write-Output "ERR:sweep-failed:$($_.Exception.Message)"
        }
    }
} else {
    Write-OverlayLog "no sweep script path provided or not found"
    Write-Output "ERR:no-sweep-script"
}
