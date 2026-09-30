# ============================================================
# AffHook Sweep — Clears SetWindowDisplayAffinity on target windows
#
# This script is designed to run INSIDE the target process context.
# It enumerates all visible top-level windows belonging to the
# current process and calls SetWindowDisplayAffinity(hwnd, WDA_NONE)
# to remove screen capture protection.
#
# Re-sweeps every 1.5s × 120 iterations (~3 min) because the target
# application may recreate or re-protect its windows.
#
# Logging: %TEMP%\AffHook.log
# ============================================================

param(
    [int]$TargetPid = 0,
    [int]$Iterations = 120,
    [int]$IntervalMs = 1500
)

$logPath = Join-Path $env:TEMP "AffHook.log"

function Write-AffLog {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    try { Add-Content -Path $logPath -Value "[$ts] $msg" -ErrorAction SilentlyContinue } catch {}
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class AffinityHook {
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

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public const uint WDA_NONE = 0x00000000;
    public const uint WDA_MONITOR = 0x00000001;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    /// <summary>
    /// Find all visible top-level windows for a given process and clear their affinity.
    /// Returns the number of windows whose affinity was cleared.
    /// </summary>
    public static int SweepProcess(uint targetPid) {
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
                    // Only target windows >= 200px in either dimension
                    if (w >= 200 || h >= 200) {
                        windows.Add(hWnd);
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        foreach (var hwnd in windows) {
            uint currentAffinity;
            if (GetWindowDisplayAffinity(hwnd, out currentAffinity)) {
                if (currentAffinity != WDA_NONE) {
                    bool result = SetWindowDisplayAffinity(hwnd, WDA_NONE);
                    if (result) cleared++;
                }
            }
        }

        return cleared;
    }

    /// <summary>
    /// Read the display affinity of a specific window (cross-process reads are allowed).
    /// Returns the affinity value, or 0xFFFFFFFF on failure.
    /// </summary>
    public static uint ReadAffinity(IntPtr hwnd) {
        uint aff;
        if (GetWindowDisplayAffinity(hwnd, out aff)) return aff;
        return 0xFFFFFFFF;
    }

    /// <summary>
    /// Find the main window of a process (largest visible window).
    /// </summary>
    public static IntPtr FindMainWindow(uint pid) {
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;

        EnumWindows((hWnd, lParam) => {
            uint wPid;
            GetWindowThreadProcessId(hWnd, out wPid);
            if (wPid == pid && IsWindowVisible(hWnd)) {
                RECT rect;
                if (GetWindowRect(hWnd, out rect)) {
                    int area = (rect.Right - rect.Left) * (rect.Bottom - rect.Top);
                    if (area > bestArea) {
                        bestArea = area;
                        best = hWnd;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        return best;
    }
}
"@ -ErrorAction Stop

# Determine target PID
if ($TargetPid -eq 0) {
    # If no PID given, try to find SEB / lockdown browser
    $sebNames = @(
        'SafeExamBrowser', 'seb', 'SEB',
        'RCBrowserLockDown', 'LockDownBrowser',
        'Respondus', 'respondus',
        'Proctorio', 'proctorio',
        'ExamSoft', 'Examplify',
        'ProctorU', 'Honorlock'
    )
    
    $targetProc = $null
    foreach ($name in $sebNames) {
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        if ($procs) {
            $targetProc = $procs | Sort-Object StartTime | Select-Object -First 1
            break
        }
    }
    
    if (-not $targetProc) {
        Write-AffLog "ERROR: No target process found"
        Write-Output "ERR:NoTarget"
        exit 1
    }
    
    $TargetPid = $targetProc.Id
}

Write-AffLog "loaded — targeting PID $TargetPid"
Write-Output "OK:loaded:$TargetPid"

# Sweep loop
$totalCleared = 0
for ($i = 0; $i -lt $Iterations; $i++) {
    try {
        $cleared = [AffinityHook]::SweepProcess([uint32]$TargetPid)
        if ($cleared -gt 0) {
            $totalCleared += $cleared
            Write-AffLog "native-sweep value=$cleared (iteration $i, total=$totalCleared)"
        }
    } catch {
        Write-AffLog "sweep-error: $($_.Exception.Message)"
    }
    
    # Check if target process still exists
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-AffLog "target process $TargetPid exited — stopping sweep"
        break
    }
    
    Start-Sleep -Milliseconds $IntervalMs
}

Write-AffLog "native-resweep-done (total cleared: $totalCleared)"
Write-Output "OK:done:$totalCleared"
