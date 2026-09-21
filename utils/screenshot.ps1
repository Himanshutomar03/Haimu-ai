param(
    [string]$OutputPath = ""
)

# ============================================================
# BitBlt Screen Capture — Win32 GDI direct capture
# Uses BitBlt (Graphics Device Interface) to capture the screen
# at the OS/driver level WITHOUT triggering any window events,
# focus changes, or activation signals.
#
# This completely bypasses Electron desktopCapturer so no
# window hide/show is needed — zero detection surface.
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

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, ref RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public const uint SRCCOPY = 0x00CC0020;

    public static string CaptureToBase64() {
        // Get primary screen dimensions
        int screenWidth  = System.Windows.Forms.Screen.PrimaryScreen.Bounds.Width;
        int screenHeight = System.Windows.Forms.Screen.PrimaryScreen.Bounds.Height;

        IntPtr desktopHwnd = GetDesktopWindow();
        IntPtr desktopDC   = GetWindowDC(desktopHwnd);
        IntPtr memDC       = CreateCompatibleDC(desktopDC);
        IntPtr bitmap      = CreateCompatibleBitmap(desktopDC, screenWidth, screenHeight);
        IntPtr oldBitmap   = SelectObject(memDC, bitmap);

        // BitBlt: copy screen pixels directly into our memory DC
        BitBlt(memDC, 0, 0, screenWidth, screenHeight, desktopDC, 0, 0, SRCCOPY);

        // Convert GDI bitmap to .NET Bitmap and encode as PNG
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
        int screenWidth  = System.Windows.Forms.Screen.PrimaryScreen.Bounds.Width;
        int screenHeight = System.Windows.Forms.Screen.PrimaryScreen.Bounds.Height;

        IntPtr desktopHwnd = GetDesktopWindow();
        IntPtr desktopDC   = GetWindowDC(desktopHwnd);
        IntPtr memDC       = CreateCompatibleDC(desktopDC);
        IntPtr bitmap      = CreateCompatibleBitmap(desktopDC, screenWidth, screenHeight);
        IntPtr oldBitmap   = SelectObject(memDC, bitmap);

        BitBlt(memDC, 0, 0, screenWidth, screenHeight, desktopDC, 0, 0, SRCCOPY);

        Bitmap bmp = Image.FromHbitmap(bitmap);
        bmp.Save(path, ImageFormat.Png);
        bmp.Dispose();

        SelectObject(memDC, oldBitmap);
        DeleteObject(bitmap);
        DeleteDC(memDC);
        ReleaseDC(desktopHwnd, desktopDC);
    }
}
"@ -ReferencedAssemblies "System.Windows.Forms","System.Drawing" -ErrorAction Stop

try {
    if ($OutputPath -ne "") {
        # Save to file mode
        [ScreenCapture]::CaptureToFile($OutputPath)
        Write-Output "OK:file:$OutputPath"
    } else {
        # Base64 stdout mode
        $b64 = [ScreenCapture]::CaptureToBase64()
        Write-Output "OK:base64:$b64"
    }
} catch {
    Write-Output "ERR:$($_.Exception.Message)"
    exit 1
}
