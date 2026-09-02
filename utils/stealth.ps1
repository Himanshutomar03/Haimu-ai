param(
    [Parameter(Mandatory=$true)]
    [long]$Hwnd,
    [Parameter(Mandatory=$true)]
    [ValidateSet("hide-alt-tab","exclude-capture","full-stealth","restore-capture","enforce-topmost","no-activate","restore-activate")]
    [string]$Action
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WindowStealth {
    // Window style manipulation
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    // 64-bit compatible versions
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    // Screen capture exclusion (Win10 2004+)
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    // DWM window attribute for cloaking
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    // SetWindowPos — enforce topmost z-order at native level
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    // ShowWindow — force show if hidden
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    // Constants
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_APPWINDOW = 0x00040000;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const uint WDA_NONE = 0x00000000;
    public const uint WDA_MONITOR = 0x00000001;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    // SetWindowPos constants
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    public const int SW_SHOWNOACTIVATE = 4;

    public static void HideFromAltTab(IntPtr hwnd) {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        // Add TOOLWINDOW (hides from Alt+Tab) and remove APPWINDOW
        style = style | WS_EX_TOOLWINDOW;
        style = style & ~WS_EX_APPWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, style);
    }

    public static bool ExcludeFromCapture(IntPtr hwnd) {
        // Try WDA_EXCLUDEFROMCAPTURE first (Win10 2004+) - completely invisible
        bool result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        if (!result) {
            // Fallback to WDA_MONITOR - shows as black rectangle
            result = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
        }
        return result;
    }

    public static bool RestoreCapture(IntPtr hwnd) {
        return SetWindowDisplayAffinity(hwnd, WDA_NONE);
    }

    public static bool EnforceTopmost(IntPtr hwnd) {
        // Force show the window (in case lockdown browser hid it)
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // Set HWND_TOPMOST with SWP_NOACTIVATE so we don't steal exam focus
        return SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    // Prevent window from stealing foreground focus when clicked.
    // The underlying application (e.g. exam browser) remains the active window.
    public static void ApplyNoActivate(IntPtr hwnd) {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        style = style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        style = style & ~WS_EX_APPWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, style);
        // Re-assert topmost with NOACTIVATE so window stays visible but unfocused
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    // Remove WS_EX_NOACTIVATE so the window can take focus normally again.
    public static void RestoreActivate(IntPtr hwnd) {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        style = style & ~WS_EX_NOACTIVATE;
        SetWindowLong(hwnd, GWL_EXSTYLE, style);
    }
}
"@ -ErrorAction SilentlyContinue

$hwndPtr = [IntPtr]$Hwnd

switch ($Action) {
    "hide-alt-tab" {
        [WindowStealth]::HideFromAltTab($hwndPtr)
        Write-Output "OK:hide-alt-tab"
    }
    "exclude-capture" {
        $result = [WindowStealth]::ExcludeFromCapture($hwndPtr)
        Write-Output "OK:exclude-capture:$result"
    }
    "restore-capture" {
        $result = [WindowStealth]::RestoreCapture($hwndPtr)
        Write-Output "OK:restore-capture:$result"
    }
    "enforce-topmost" {
        $result = [WindowStealth]::EnforceTopmost($hwndPtr)
        Write-Output "OK:enforce-topmost:$result"
    }
    "full-stealth" {
        [WindowStealth]::HideFromAltTab($hwndPtr)
        $captureResult = [WindowStealth]::ExcludeFromCapture($hwndPtr)
        $topmostResult = [WindowStealth]::EnforceTopmost($hwndPtr)
        Write-Output "OK:full-stealth:capture=$captureResult,topmost=$topmostResult"
    }
    "no-activate" {
        [WindowStealth]::ApplyNoActivate($hwndPtr)
        Write-Output "OK:no-activate"
    }
    "restore-activate" {
        [WindowStealth]::RestoreActivate($hwndPtr)
        Write-Output "OK:restore-activate"
    }
}

