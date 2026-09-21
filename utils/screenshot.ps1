param(
    [string]$OutputPath = ""
)

# ============================================================
# BitBlt Screen Capture — Win32 GDI direct capture
# Uses BitBlt (Graphics Device Interface) to capture the screen
# at the OS/driver level WITHOUT triggering any window events,
# focus changes, or activation signals.
#
# Screen dimensions obtained via GetSystemMetrics (pure Win32)
# — no System.Windows.Forms initialization required.
# ============================================================

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.IO;

public class ScreenCapture {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ReleaseDC(IntPtr hWnd, IntPtr hDC);

    // Pure Win32 screen metrics — no WinForms needed
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int nWidth, int nHeight);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hDestDC, int x, int y, int nWidth, int nHeight,
                                      IntPtr hSrcDC, int xSrc, int ySrc, uint dwRop);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    public const uint SRCCOPY = 0x00CC0020;

    // SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79 → full virtual desktop (all monitors)
    // SM_CXSCREEN=0, SM_CYSCREEN=1 → primary monitor only
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
    public const int SM_XVIRTUALSCREEN  = 76;
    public const int SM_YVIRTUALSCREEN  = 77;

    public static string CaptureToBase64() {
        // Use virtual screen to capture all monitors
        int x      = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int y      = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width  = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        // Fallback to primary screen if virtual screen metrics are invalid
        if (width <= 0 || height <= 0) {
            x = 0; y = 0;
            width  = GetSystemMetrics(0);
            height = GetSystemMetrics(1);
        }

        IntPtr desktopHwnd = GetDesktopWindow();
        IntPtr desktopDC   = GetWindowDC(desktopHwnd);
        IntPtr memDC       = CreateCompatibleDC(desktopDC);
        IntPtr bitmap      = CreateCompatibleBitmap(desktopDC, width, height);
        IntPtr oldBitmap   = SelectObject(memDC, bitmap);

        // BitBlt: copy screen pixels directly at the driver level
        BitBlt(memDC, 0, 0, width, height, desktopDC, x, y, SRCCOPY);

        // Convert GDI bitmap → .NET Bitmap → PNG → Base64
        Bitmap bmp = Image.FromHbitmap(bitmap);
        string base64 = "";
        using (MemoryStream ms = new MemoryStream()) {
            bmp.Save(ms, ImageFormat.Png);
            base64 = Convert.ToBase64String(ms.ToArray());
        }
        bmp.Dispose();

        // Cleanup GDI resources
        SelectObject(memDC, oldBitmap);
        DeleteObject(bitmap);
        DeleteDC(memDC);
        ReleaseDC(desktopHwnd, desktopDC);

        return base64;
    }

    public static void CaptureToFile(string path) {
        int x      = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int y      = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int width  = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        if (width <= 0 || height <= 0) {
            x = 0; y = 0;
            width  = GetSystemMetrics(0);
            height = GetSystemMetrics(1);
        }

        IntPtr desktopHwnd = GetDesktopWindow();
        IntPtr desktopDC   = GetWindowDC(desktopHwnd);
        IntPtr memDC       = CreateCompatibleDC(desktopDC);
        IntPtr bitmap      = CreateCompatibleBitmap(desktopDC, width, height);
        IntPtr oldBitmap   = SelectObject(memDC, bitmap);

        BitBlt(memDC, 0, 0, width, height, desktopDC, x, y, SRCCOPY);

        Bitmap bmp = Image.FromHbitmap(bitmap);
        bmp.Save(path, ImageFormat.Png);
        bmp.Dispose();

        SelectObject(memDC, oldBitmap);
        DeleteObject(bitmap);
        DeleteDC(memDC);
        ReleaseDC(desktopHwnd, desktopDC);
    }
}
"@ -ReferencedAssemblies "System.Drawing" -ErrorAction Stop

try {
    if ($OutputPath -ne "") {
        [ScreenCapture]::CaptureToFile($OutputPath)
        Write-Output "OK:file:$OutputPath"
    } else {
        $b64 = [ScreenCapture]::CaptureToBase64()
        Write-Output "OK:base64:$b64"
    }
} catch {
    Write-Output "ERR:$($_.Exception.Message)"
    exit 1
}
