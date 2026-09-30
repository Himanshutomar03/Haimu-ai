# ============================================================
# affinity-inject-native.ps1
#
# Full native injection using QueueUserAPC to run code INSIDE
# the target process. Two strategies:
#
# PRIMARY (DLL):
#   VirtualAllocEx + WriteProcessMemory (DLL path string)
#   + QueueUserAPC(LoadLibraryW, thread, remotePath)
#   on every target thread. One thread hits an alertable wait
#   and loads AffHook.dll, which sweeps affinity from inside.
#
# FALLBACK (Shellcode):
#   For each protected window: craft a 34-byte x64 stub that
#   calls SetWindowDisplayAffinity(hwnd, WDA_NONE). Inject via
#   VirtualAllocEx(RWX) + WriteProcessMemory + QueueUserAPC.
#   The stub runs on the target's thread — ownership check passes.
#
# Both approaches are CLR-safe: QueueUserAPC fires at alertable
# wait points (normal, managed-safe), unlike CreateRemoteThread
# which creates a foreign thread that crashes CLR processes.
#
# Arguments:
#   -TargetPid <int>   : Target process PID (0 = auto-detect)
#   -DllPath <string>  : Path to AffHook.dll (empty = shellcode only)
#   -Mode <string>     : 'dll', 'shellcode', 'auto' (default: auto)
#
# Output (for Node.js):
#   OK:dll-injected:<pid>:<threadCount>
#   OK:shellcode-injected:<pid>:<windowCount>
#   OK:noprotection:<pid>
#   ERR:<message>
#
# Logs: %LOCALAPPDATA%\QuickSearch\overlay.log
# ============================================================

param(
    [int]$TargetPid = 0,
    [string]$DllPath = "",
    [ValidateSet("dll","shellcode","auto")]
    [string]$Mode = "auto"
)

$ErrorActionPreference = "Stop"

$logDir = Join-Path $env:LOCALAPPDATA "QuickSearch"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "overlay.log"

function Write-Log {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    try { Add-Content -Path $logPath -Value "[$ts] [affinity] $msg" -ErrorAction SilentlyContinue } catch {}
}

# ── Win32 API Declarations ────────────────────────────────────────────

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class NativeInjector {

    // ── Process ──
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    // ── Memory ──
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(
        IntPtr hProcess, IntPtr addr, uint size, uint allocType, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualFreeEx(
        IntPtr hProcess, IntPtr addr, uint size, uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(
        IntPtr hProcess, IntPtr baseAddr, byte[] buffer, uint size, out int written);

    // ── Modules ──
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetModuleHandleA(string moduleName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    // ── APC ──
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint QueueUserAPC(IntPtr pfnAPC, IntPtr hThread, IntPtr dwData);

    // ── Threads (Toolhelp32) ──
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint pid);

    [DllImport("kernel32.dll")]
    public static extern bool Thread32First(IntPtr hSnap, ref THREADENTRY32 lpte);

    [DllImport("kernel32.dll")]
    public static extern bool Thread32Next(IntPtr hSnap, ref THREADENTRY32 lpte);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);

    // ── Window APIs ──
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

    // ── Structs ──
    [StructLayout(LayoutKind.Sequential)]
    public struct THREADENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ThreadID;
        public uint th32OwnerProcessID;
        public int  tpBasePri;
        public int  tpDeltaPri;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    // ── Constants ──
    public const uint PROCESS_ALL_ACCESS        = 0x001FFFFF;
    public const uint PROCESS_VM_OPERATION      = 0x0008;
    public const uint PROCESS_VM_WRITE          = 0x0020;
    public const uint PROCESS_VM_READ           = 0x0010;
    public const uint PROCESS_CREATE_THREAD     = 0x0002;
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;

    public const uint MEM_COMMIT  = 0x00001000;
    public const uint MEM_RESERVE = 0x00002000;
    public const uint MEM_RELEASE = 0x00008000;

    public const uint PAGE_READWRITE       = 0x04;
    public const uint PAGE_EXECUTE_READWRITE = 0x40;

    public const uint TH32CS_SNAPTHREAD = 0x00000004;

    public const uint THREAD_SET_CONTEXT    = 0x0010;
    public const uint THREAD_SUSPEND_RESUME = 0x0002;
    public const uint THREAD_QUERY_INFORMATION = 0x0040;

    public const uint WDA_NONE = 0x00000000;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    // ── Helper: Get all thread IDs for a process ──
    public static List<uint> GetProcessThreadIds(uint pid) {
        var threadIds = new List<uint>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return threadIds;

        THREADENTRY32 te = new THREADENTRY32();
        te.dwSize = (uint)Marshal.SizeOf(typeof(THREADENTRY32));

        if (Thread32First(snap, ref te)) {
            do {
                if (te.th32OwnerProcessID == pid) {
                    threadIds.Add(te.th32ThreadID);
                }
            } while (Thread32Next(snap, ref te));
        }

        CloseHandle(snap);
        return threadIds;
    }

    // ── Helper: Find protected windows of a process ──
    public static List<IntPtr> FindProtectedWindows(uint pid) {
        var result = new List<IntPtr>();

        EnumWindows((hWnd, lParam) => {
            uint wPid;
            GetWindowThreadProcessId(hWnd, out wPid);
            if (wPid == pid && IsWindowVisible(hWnd)) {
                RECT r;
                if (GetWindowRect(hWnd, out r)) {
                    int w = r.Right - r.Left;
                    int h = r.Bottom - r.Top;
                    if (w >= 200 || h >= 200) {
                        uint aff;
                        if (GetWindowDisplayAffinity(hWnd, out aff) && aff != WDA_NONE) {
                            result.Add(hWnd);
                        }
                    }
                }
            }
            return true;
        }, IntPtr.Zero);

        return result;
    }

    // ── Helper: Count protected windows ──
    public static int CountProtectedWindows(uint pid) {
        return FindProtectedWindows(pid).Count;
    }

    // ── DLL Injection via LoadLibraryW + QueueUserAPC ──
    public static int InjectDll(uint pid, string dllPath) {
        // Get LoadLibraryW address (same across processes per-session ASLR)
        IntPtr kernel32 = GetModuleHandleA("kernel32.dll");
        IntPtr loadLibAddr = GetProcAddress(kernel32, "LoadLibraryW");
        if (loadLibAddr == IntPtr.Zero) return -1;

        // Open target process
        IntPtr hProc = OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_CREATE_THREAD,
            false, pid);
        if (hProc == IntPtr.Zero) return -2;

        // Allocate memory for DLL path (Unicode)
        byte[] pathBytes = System.Text.Encoding.Unicode.GetBytes(dllPath + "\0");
        IntPtr remoteMem = VirtualAllocEx(hProc, IntPtr.Zero,
            (uint)pathBytes.Length, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (remoteMem == IntPtr.Zero) { CloseHandle(hProc); return -3; }

        // Write DLL path
        int written;
        if (!WriteProcessMemory(hProc, remoteMem, pathBytes, (uint)pathBytes.Length, out written)) {
            CloseHandle(hProc); return -4;
        }

        // Queue APC on every thread
        var threadIds = GetProcessThreadIds(pid);
        int apcCount = 0;
        foreach (uint tid in threadIds) {
            IntPtr hThread = OpenThread(THREAD_SET_CONTEXT, false, tid);
            if (hThread != IntPtr.Zero) {
                uint result = QueueUserAPC(loadLibAddr, hThread, remoteMem);
                if (result != 0) apcCount++;
                CloseHandle(hThread);
            }
        }

        // Deliberately NOT freeing remoteMem — the target loads async.
        // Freeing before LoadLibraryW fires would crash the target.
        CloseHandle(hProc);
        return apcCount;
    }

    // ── Shellcode Injection via QueueUserAPC ──
    //
    // x64 stub (34 bytes) calls SetWindowDisplayAffinity(hwnd, WDA_NONE):
    //
    //   sub rsp, 0x28             ; shadow space + alignment
    //   mov rcx, <hwnd_8bytes>    ; first param: HWND
    //   xor edx, edx              ; second param: 0 (WDA_NONE)
    //   mov rax, <fn_addr_8bytes> ; SetWindowDisplayAffinity address
    //   call rax
    //   add rsp, 0x28
    //   ret
    //
    // HWND patched at offset 6, fn_addr patched at offset 19.

    private static readonly byte[] ShellcodeTemplate = new byte[] {
        0x48, 0x83, 0xEC, 0x28,                                     // sub rsp, 0x28
        0x48, 0xB9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // mov rcx, <hwnd>
        0x48, 0x31, 0xD2,                                            // xor rdx, rdx
        0x48, 0xB8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // mov rax, <fn_addr>
        0xFF, 0xD0,                                                   // call rax
        0x48, 0x83, 0xC4, 0x28,                                      // add rsp, 0x28
        0xC3                                                          // ret
    };

    public static int InjectShellcode(uint pid, IntPtr[] protectedHwnds) {
        // Get SetWindowDisplayAffinity address (same in all processes)
        IntPtr user32 = GetModuleHandleA("user32.dll");
        IntPtr fnAddr = GetProcAddress(user32, "SetWindowDisplayAffinity");
        if (fnAddr == IntPtr.Zero) return -1;

        // Open target process
        IntPtr hProc = OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_CREATE_THREAD,
            false, pid);
        if (hProc == IntPtr.Zero) return -2;

        var threadIds = GetProcessThreadIds(pid);
        if (threadIds.Count == 0) { CloseHandle(hProc); return -3; }

        int injectedCount = 0;

        foreach (IntPtr hwnd in protectedHwnds) {
            // Build shellcode for this specific HWND
            byte[] shellcode = (byte[])ShellcodeTemplate.Clone();

            // Patch HWND at offset 6 (8 bytes, little-endian)
            byte[] hwndBytes = BitConverter.GetBytes(hwnd.ToInt64());
            Array.Copy(hwndBytes, 0, shellcode, 6, 8);

            // Patch fn_addr at offset 19 (8 bytes, little-endian)
            byte[] fnBytes = BitConverter.GetBytes(fnAddr.ToInt64());
            Array.Copy(fnBytes, 0, shellcode, 19, 8);

            // Allocate RWX memory in target
            IntPtr remoteMem = VirtualAllocEx(hProc, IntPtr.Zero,
                (uint)shellcode.Length, MEM_COMMIT | MEM_RESERVE,
                PAGE_EXECUTE_READWRITE);
            if (remoteMem == IntPtr.Zero) continue;

            // Write shellcode
            int written;
            if (!WriteProcessMemory(hProc, remoteMem, shellcode,
                (uint)shellcode.Length, out written)) continue;

            // Queue APC on every thread — one will fire at alertable wait
            foreach (uint tid in threadIds) {
                IntPtr hThread = OpenThread(THREAD_SET_CONTEXT, false, tid);
                if (hThread != IntPtr.Zero) {
                    // dwData is unused by our shellcode but must be set
                    QueueUserAPC(remoteMem, hThread, IntPtr.Zero);
                    CloseHandle(hThread);
                }
            }

            injectedCount++;
            // Deliberately NOT freeing remoteMem — the APC fires async
        }

        CloseHandle(hProc);
        return injectedCount;
    }
}
"@ -ErrorAction Stop

# ── Auto-detect target process ────────────────────────────────────────

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
            # Wait for process > 3s old (init protection)
            $targetProc = $procs | Where-Object {
                try { ((Get-Date) - $_.StartTime).TotalSeconds -gt 3 } catch { $false }
            } | Sort-Object StartTime | Select-Object -First 1

            if ($targetProc) {
                $TargetPid = $targetProc.Id
                Write-Log "auto-detected target: $($targetProc.ProcessName) PID $TargetPid"
                break
            }
        }
    }
}

if ($TargetPid -eq 0) {
    Write-Output "ERR:NoTarget"
    exit 1
}

# ── Wait for visible main window ≥250px ──────────────────────────────
Write-Log "targeting PID $TargetPid — waiting for main window..."

for ($wait = 0; $wait -lt 30; $wait++) {
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
}

# ── Check protection status ──────────────────────────────────────────
$protectedCount = [NativeInjector]::CountProtectedWindows([uint32]$TargetPid)
Write-Log "PID $TargetPid has $protectedCount protected windows"

if ($protectedCount -eq 0) {
    Write-Output "OK:noprotection:$TargetPid"
    exit 0
}

# ── Resolve DLL path ─────────────────────────────────────────────────
if ($DllPath -eq "") {
    $DllPath = Join-Path $PSScriptRoot "AffHook.dll"
}
$dllExists = Test-Path $DllPath

# ── Strategy: DLL injection (primary) ────────────────────────────────
if (($Mode -eq "dll" -or $Mode -eq "auto") -and $dllExists) {
    Write-Log "injecting DLL: $DllPath"

    $apcCount = [NativeInjector]::InjectDll([uint32]$TargetPid, $DllPath)

    if ($apcCount -gt 0) {
        Write-Log "APC queued x$apcCount on PID $TargetPid threads"
        Write-Output "OK:dll-injected:${TargetPid}:${apcCount}"

        # Wait a moment for APC to fire, then verify
        Start-Sleep -Seconds 3
        $remaining = [NativeInjector]::CountProtectedWindows([uint32]$TargetPid)
        if ($remaining -eq 0) {
            Write-Log "DLL injection SUCCESS — all protection cleared"
        } else {
            Write-Log "DLL injection partial — $remaining windows still protected"
            # Fall through to shellcode if auto mode
            if ($Mode -eq "auto") {
                Write-Log "falling through to shellcode fallback..."
                $Mode = "shellcode"  # force shellcode below
            }
        }
        if ($Mode -ne "shellcode") { exit 0 }
    } else {
        Write-Log "DLL injection failed (result=$apcCount), falling back to shellcode"
        if ($Mode -eq "dll") {
            Write-Output "ERR:dll-inject-failed:$apcCount"
            exit 1
        }
    }
}

# ── Strategy: Shellcode injection (fallback) ─────────────────────────
if ($Mode -eq "shellcode" -or $Mode -eq "auto") {
    # Re-check protected windows (may have changed after DLL attempt)
    $protectedHwnds = [NativeInjector]::FindProtectedWindows([uint32]$TargetPid)

    if ($protectedHwnds.Count -eq 0) {
        Write-Log "no protected windows remaining (cleared by DLL?)"
        Write-Output "OK:cleared:$TargetPid"
        exit 0
    }

    Write-Log "shellcode injection: $($protectedHwnds.Count) protected windows on PID $TargetPid"

    $hwndArray = $protectedHwnds.ToArray()
    $injected = [NativeInjector]::InjectShellcode([uint32]$TargetPid, $hwndArray)

    if ($injected -gt 0) {
        Write-Log "shellcode injected for $injected windows, APCs queued on all threads"
        Write-Output "OK:shellcode-injected:${TargetPid}:${injected}"

        # Wait and verify
        Start-Sleep -Seconds 2
        $remaining = [NativeInjector]::CountProtectedWindows([uint32]$TargetPid)
        Write-Log "post-shellcode: $remaining windows still protected"
    } else {
        Write-Log "shellcode injection failed (result=$injected)"
        Write-Output "ERR:shellcode-failed:$injected"
        exit 1
    }
}
