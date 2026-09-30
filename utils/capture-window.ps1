# ============================================================
# Target Window Capture via PrintWindow
#
# Captures a specific window using the Win32 PrintWindow API.
# This captures the window content directly, bypassing normal
# screen composition. Works even when the window is partially
# occluded by other windows.
#
# Usage:
#   .\capture-window.ps1 -TargetPid <pid>
#   .\capture-window.ps1 -TargetHwnd <hwnd>
#
# Output: OK:<base64_png> or ERR:<message>
# ============================================================

param(
    [long]$TargetHwnd = 0,
    [int]$TargetPid = 0
)

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.IO;
using System.Collections.Generic;

public class WindowCapture {
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int w, int h);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hDest, int x, int y, int w, int h,
                                      IntPtr hSrc, int sx, int sy, uint rop);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public const uint SRCCOPY = 0x00CC0020;
    // PW_RENDERFULLCONTENT — captures DWM-rendered content including DirectX
    public const uint PW_RENDERFULLCONTENT = 0x00000002;

    /// <summary>
    /// Find the largest visible window belonging to a process.
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
                    int w = rect.Right - rect.Left;
                    int h = rect.Bottom - rect.Top;
                    int area = w * h;
                    if (area > bestArea && w >= 250 && h >= 250) {
                        bestArea = area;
                        best = hWnd;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        return best;
    }

    /// <summary>
    /// Capture a specific window using PrintWindow API.
    /// Returns base64 PNG, or null on failure.
    /// </summary>
    public static string CaptureWindow(IntPtr hwnd) {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return null;

        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return null;

        using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                // PW_RENDERFULLCONTENT gives us the actual rendered content
                bool ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                g.ReleaseHdc(hdc);

                if (!ok) {
                    // Fallback: try without PW_RENDERFULLCONTENT
                    hdc = g.GetHdc();
                    ok = PrintWindow(hwnd, hdc, 0);
                    g.ReleaseHdc(hdc);
                }

                if (!ok) return null;
            }

            using (MemoryStream ms = new MemoryStream()) {
                bmp.Save(ms, ImageFormat.Png);
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }

    /// <summary>
    /// Full virtual-screen BitBlt capture (our overlay stays visible but is
    /// excluded from capture by its own WDA_EXCLUDEFROMCAPTURE).
    /// </summary>
    public static string CaptureFullScreen() {
        int x = GetSystemMetrics(76);  // SM_XVIRTUALSCREEN
        int y = GetSystemMetrics(77);  // SM_YVIRTUALSCREEN
        int w = GetSystemMetrics(78);  // SM_CXVIRTUALSCREEN
        int h = GetSystemMetrics(79);  // SM_CYVIRTUALSCREEN

        if (w <= 0 || h <= 0) {
            x = 0; y = 0;
            w = GetSystemMetrics(0);
            h = GetSystemMetrics(1);
        }

        IntPtr desk = GetDesktopWindow();
        IntPtr dc = GetWindowDC(desk);
        IntPtr mdc = CreateCompatibleDC(dc);
        IntPtr bmp = CreateCompatibleBitmap(dc, w, h);
        IntPtr old = SelectObject(mdc, bmp);

        BitBlt(mdc, 0, 0, w, h, dc, x, y, SRCCOPY);

        Bitmap bitmap = Image.FromHbitmap(bmp);
        string b64;
        using (MemoryStream ms = new MemoryStream()) {
            bitmap.Save(ms, ImageFormat.Png);
            b64 = Convert.ToBase64String(ms.ToArray());
        }
        bitmap.Dispose();
        SelectObject(mdc, old);
        DeleteObject(bmp);
        DeleteDC(mdc);
        ReleaseDC(desk, dc);

        return b64;
    }
}
"@ -ReferencedAssemblies "System.Drawing" -ErrorAction Stop

try {
    $hwnd = [IntPtr]::Zero

    if ($TargetHwnd -ne 0) {
        $hwnd = [IntPtr]$TargetHwnd
    } elseif ($TargetPid -ne 0) {
        $hwnd = [WindowCapture]::FindMainWindow([uint32]$TargetPid)
    } else {
        # Auto-detect SEB
        $sebNames = @('SafeExamBrowser','seb','SEB','RCBrowserLockDown','LockDownBrowser','Respondus','Proctorio','ExamSoft','Examplify')
        foreach ($name in $sebNames) {
            $proc = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($proc) {
                $hwnd = [WindowCapture]::FindMainWindow([uint32]$proc.Id)
                if ($hwnd -ne [IntPtr]::Zero) { break }
            }
        }
    }

    if ($hwnd -eq [IntPtr]::Zero) {
        # No specific target — fall back to full-screen BitBlt
        $b64 = [WindowCapture]::CaptureFullScreen()
        if ($b64) {
            Write-Output "OK:$b64"
        } else {
            Write-Output "ERR:FullScreenCaptureFailed"
        }
        exit 0
    }

    # Try PrintWindow on the target
    $b64 = [WindowCapture]::CaptureWindow($hwnd)
    if ($b64) {
        Write-Output "OK:$b64"
    } else {
        # PrintWindow failed — fallback to full-screen BitBlt
        $b64 = [WindowCapture]::CaptureFullScreen()
        if ($b64) {
            Write-Output "OK:$b64"
        } else {
            Write-Output "ERR:AllCaptureFailed"
        }
    }
} catch {
    Write-Output "ERR:$($_.Exception.Message)"
    exit 1
}
