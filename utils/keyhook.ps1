# ============================================================
# HaimuAi Low-Level Keyboard Hook
# KEY BINDINGS:
#   Ctrl + Shift + Space  -> TOGGLE (show/hide)  <- ONLY SHORTCUT
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$host.UI.RawUI.WindowTitle = "Runtime Service"

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class LowLevelKeyHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN     = 0x0100;
    private const int WM_KEYUP       = 0x0101;
    private const int WM_SYSKEYDOWN  = 0x0104;
    private const int WM_SYSKEYUP    = 0x0105;

    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_LSHIFT   = 0xA0;
    private const int VK_RSHIFT   = 0xA1;
    private const int VK_SPACE    = 0x20;
    private const int VK_LMENU    = 0xA4;  // Left Alt
    private const int VK_RMENU    = 0xA5;  // Right Alt
    private const int VK_L        = 0x4C;  // L key
    private const int VK_A        = 0x41;  // A key

    private static IntPtr hookId       = IntPtr.Zero;
    private static bool   shiftHeld    = false;
    private static bool   ctrlHeld     = false;
    private static bool   altHeld      = false;
    private static bool   leftAltHeld  = false;
    private static bool   rightAltHeld = false;


    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public int    vkCode;
        public int    scanCode;
        public int    flags;
        public int    time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd;
        public uint   message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint   time;
        public POINT  pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    private static LowLevelKeyboardProc hookProc = HookCallback;

    private static void Emit(string cmd) {
        Console.WriteLine(cmd);
        Console.Out.Flush();
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = (int)wParam;
            KBDLLHOOKSTRUCT kbd = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int vk = kbd.vkCode;

            bool isDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
            bool isUp   = (msg == WM_KEYUP   || msg == WM_SYSKEYUP);

            // Track Shift
            if (vk == VK_LSHIFT || vk == VK_RSHIFT) {
                if (isDown) shiftHeld = true;
                if (isUp)   shiftHeld = false;
            }
            // Track Ctrl
            if (vk == VK_LCONTROL || vk == VK_RCONTROL) {
                if (isDown) ctrlHeld = true;
                if (isUp)   ctrlHeld = false;
            }
            // Track Alt
            if (vk == VK_LMENU) {
                if (isDown) { leftAltHeld = true; altHeld = true; }
                if (isUp)   { leftAltHeld = false; altHeld = (rightAltHeld); }
            }
            if (vk == VK_RMENU) {
                if (isDown) { rightAltHeld = true; altHeld = true; }
                if (isUp)   { rightAltHeld = false; altHeld = (leftAltHeld); }
            }

            // Ctrl + Shift + Space -> TOGGLE
            if (vk == VK_SPACE && ctrlHeld && shiftHeld && isDown) {
                Emit("TOGGLE");
                return (IntPtr)1;
            }

            // Alt + L -> LISTEN (system audio)
            if (vk == VK_L && altHeld && isDown) {
                Emit("LISTEN");
                return (IntPtr)1;
            }

            // Ctrl + Shift + A -> ALWAYSACTIVE (no focus stealing)
            if (vk == VK_A && ctrlHeld && shiftHeld && isDown) {
                Emit("ALWAYSACTIVE");
                return (IntPtr)1;
            }

            // Right Alt + A (or Alt + A) -> ANSWER (screenshot & answer)
            if (vk == VK_A && altHeld && !ctrlHeld && !shiftHeld && isDown) {
                Emit("ANSWER");
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Start() {
        using (Process p = Process.GetCurrentProcess())
        using (ProcessModule m = p.MainModule) {
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, GetModuleHandle(m.ModuleName), 0);
        }

        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("Failed to install hook");
            return;
        }

        Console.Error.WriteLine("Hook active: Ctrl+Shift+Space=toggle, Ctrl+Shift+A=alwaysActive");
        Console.Error.Flush();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        UnhookWindowsHookEx(hookId);
    }
}
"@ -ReferencedAssemblies @() -IgnoreWarnings

[LowLevelKeyHook]::Start()
