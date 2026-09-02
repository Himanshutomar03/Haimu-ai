# ============================================================
# HaimuAi Guardian — Survives app quit, relaunches on hotkeys
#
# Hotkeys:
#   Ctrl + Shift + H  -> Relaunch / show HaimuAi (ONLY this one)
#
# NOTE: Ctrl+Shift+Space is intentionally NOT handled here.
#       It is exclusively managed by keyhook.ps1 (child of the
#       live Electron app) which sends TOGGLE to the running app.
#       Having guardian also intercept it caused the OLD stale
#       SearchApp.exe copy to be launched instead of the current app.
#
# This process is spawned with detached:true + unref() so it
# persists even after Electron is force-quit.
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$host.UI.RawUI.WindowTitle = "Runtime Service Helper"

# Path to relaunch (same directory as this script's parent)
$AppDir     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ElectronExe = Join-Path $AppDir "node_modules\.bin\electron.cmd"
$DevElectron = Join-Path $AppDir "node_modules\electron\dist\electron.exe"
$SafeExe     = "C:\ProgramData\Microsoft\WindowsSearchService\SearchApp.exe"
$MainJs      = Join-Path $AppDir "main.js"

function Is-HaimuRunning {
    $builtProc = Get-Process -Name "HaimuAi*" -ErrorAction SilentlyContinue
    if ($builtProc) { return $true }
    $safeProc  = Get-Process -Name "SearchApp" -ErrorAction SilentlyContinue |
                 Where-Object { $_.Path -like "*WindowsSearchService*" }
    if ($safeProc) { return $true }
    try {
        $edir = $AppDir.ToLower()
        $ep   = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $ep) {
            $cmd = $p.CommandLine
            if ($cmd -and ($cmd.ToLower() -like "*$edir*" -or $cmd.ToLower() -like "*scrynai*" -or $cmd.ToLower() -like "*haimuai*")) {
                return $true
            }
        }
    } catch {}
    return $false
}

# Show-Or-Launch-HaimuAi removed — Ctrl+Shift+Space is handled exclusively
# by keyhook.ps1 (child of live app). Guardian only relaunches dead apps.

function Launch-HaimuAi {
    $isRunning = Is-HaimuRunning
    if ($isRunning) { return }

    $exePath = if (Test-Path $SafeExe) { $SafeExe }
               elseif (Test-Path $DevElectron) { $DevElectron }
               else { $null }

    if ($exePath) {
        try {
            $wmi    = [wmiclass]"Win32_Process"
            $result = $wmi.Create("`"$exePath`" `"$AppDir`" --detached", $AppDir, $null)
            if ($result.ReturnValue -ne 0) {
                # Fallback: npm start
                Start-Process -FilePath "cmd.exe" `
                    -ArgumentList "/c npm run start" `
                    -WorkingDirectory $AppDir `
                    -WindowStyle Hidden
            }
        } catch {
            Start-Process -FilePath "cmd.exe" `
                -ArgumentList "/c npm run start" `
                -WorkingDirectory $AppDir `
                -WindowStyle Hidden
        }
    } else {
        # Fallback: use electron.cmd
        try {
            Start-Process -FilePath "cmd.exe" `
                -ArgumentList "/c `"$ElectronExe`" `"$MainJs`"" `
                -WorkingDirectory $AppDir `
                -WindowStyle Hidden
        } catch {}
    }
}

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class GuardianHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN     = 0x0100;
    private const int WM_SYSKEYDOWN  = 0x0104;
    private const int WM_KEYUP       = 0x0101;
    private const int WM_SYSKEYUP    = 0x0105;

    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_LSHIFT   = 0xA0;
    private const int VK_RSHIFT   = 0xA1;
    private const int VK_H        = 0x48;
    // VK_SPACE removed — Ctrl+Shift+Space is handled exclusively by keyhook.ps1

    private static IntPtr hookId    = IntPtr.Zero;
    private static bool   shiftHeld = false;
    private static bool   ctrlHeld  = false;

    public static Action OnRelaunch    = null;
    // OnToggleShow removed — Ctrl+Shift+Space no longer handled by guardian

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

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = (int)wParam;
            KBDLLHOOKSTRUCT kbd = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int vk = kbd.vkCode;

            bool isDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
            bool isUp   = (msg == WM_KEYUP   || msg == WM_SYSKEYUP);

            if (vk == VK_LSHIFT || vk == VK_RSHIFT) {
                shiftHeld = isDown ? true : (isUp ? false : shiftHeld);
            }
            if (vk == VK_LCONTROL || vk == VK_RCONTROL) {
                ctrlHeld = isDown ? true : (isUp ? false : ctrlHeld);
            }

            // Ctrl + Shift + H -> Relaunch HaimuAi (only if fully dead)
            if (vk == VK_H && ctrlHeld && shiftHeld && isDown) {
                if (OnRelaunch != null) OnRelaunch();
                return (IntPtr)1;
            }
            // NOTE: Ctrl+Shift+Space intentionally NOT handled here.
            // keyhook.ps1 (child of live Electron app) exclusively owns that shortcut.
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Start() {
        using (Process p = Process.GetCurrentProcess())
        using (ProcessModule m = p.MainModule) {
            hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, GetModuleHandle(m.ModuleName), 0);
        }

        if (hookId == IntPtr.Zero) { return; }

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0)) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        UnhookWindowsHookEx(hookId);
    }
}
"@ -ReferencedAssemblies @() -IgnoreWarnings

# Wire up callbacks — only Ctrl+Shift+H relaunch is active
[GuardianHook]::OnRelaunch   = [Action]{ Launch-HaimuAi }

# Start the hook message loop (blocks forever — intentional)
[GuardianHook]::Start()
