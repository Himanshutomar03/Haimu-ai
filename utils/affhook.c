/*
 * AffHook.dll — Injected into target process via QueueUserAPC(LoadLibraryW)
 *
 * Once loaded inside the target, this DLL:
 *   1. DllMain only spawns a worker thread (never work under loader lock)
 *   2. Worker enumerates visible ≥200px top-level windows owned by THIS process
 *   3. Calls SetWindowDisplayAffinity(hwnd, WDA_NONE) — LEGAL because the
 *      caller now owns the window (we're inside the target process)
 *   4. Re-sweeps every 1.5s × 120 iterations (~3 min) to handle
 *      windows that get recreated or re-protected
 *
 * Compile (pick one):
 *   cl  /LD /O2 /MT affhook.c /Fe:AffHook.dll user32.lib kernel32.lib
 *   gcc -shared -O2 -s -o AffHook.dll affhook.c -luser32 -lkernel32
 *   tcc -shared -o AffHook.dll affhook.c -luser32 -lkernel32
 *
 * Logging: %TEMP%\AffHook.log
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>

/* ── Logging ─────────────────────────────────────────────────────────── */

static void AffLog(const char* fmt, ...) {
    char path[MAX_PATH];
    char buf[1024];
    SYSTEMTIME st;
    FILE* f;
    va_list args;

    GetTempPathA(MAX_PATH, path);
    lstrcatA(path, "AffHook.log");

    f = fopen(path, "a");
    if (!f) return;

    GetLocalTime(&st);
    fprintf(f, "[%04d-%02d-%02d %02d:%02d:%02d.%03d] ",
        st.wYear, st.wMonth, st.wDay,
        st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

    va_start(args, fmt);
    vfprintf(f, fmt, args);
    va_end(args);

    fprintf(f, "\r\n");
    fclose(f);
}

/* ── Sweep callback ──────────────────────────────────────────────────── */

typedef struct {
    DWORD pid;
    int   cleared;
    int   total_checked;
} SweepData;

static BOOL CALLBACK SweepCallback(HWND hwnd, LPARAM lParam) {
    SweepData* data = (SweepData*)lParam;
    DWORD wndPid = 0;
    RECT rect;
    int w, h;
    DWORD affinity;

    GetWindowThreadProcessId(hwnd, &wndPid);

    if (wndPid != data->pid)    return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;

    if (!GetWindowRect(hwnd, &rect)) return TRUE;

    w = rect.right  - rect.left;
    h = rect.bottom - rect.top;

    /* Only target sizeable windows (≥200 px either dim) */
    if (w < 200 && h < 200) return TRUE;

    data->total_checked++;

    if (GetWindowDisplayAffinity(hwnd, &affinity) && affinity != 0) {
        if (SetWindowDisplayAffinity(hwnd, 0 /* WDA_NONE */)) {
            data->cleared++;
            AffLog("  cleared hwnd=0x%p (%dx%d) aff=0x%X -> 0",
                   (void*)hwnd, w, h, affinity);
        } else {
            AffLog("  FAILED hwnd=0x%p err=%lu", (void*)hwnd, GetLastError());
        }
    }

    return TRUE;
}

/* ── Worker thread — runs the sweep loop ─────────────────────────────── */

static DWORD WINAPI SweepThread(LPVOID param) {
    HMODULE hSelf = (HMODULE)param;
    DWORD   pid   = GetCurrentProcessId();
    int     totalCleared = 0;
    int     i;
    SweepData data;

    AffLog("loaded — PID %lu, module=0x%p", pid, (void*)hSelf);

    /* Small settle delay — let any pending DLL_PROCESS_ATTACH chain finish */
    Sleep(150);

    for (i = 0; i < 120; i++) {
        data.pid           = pid;
        data.cleared       = 0;
        data.total_checked = 0;

        EnumWindows(SweepCallback, (LPARAM)&data);

        if (data.cleared > 0) {
            totalCleared += data.cleared;
            AffLog("native-sweep value=%d (iter %d/%d, checked=%d, total=%d)",
                   data.cleared, i, 120, data.total_checked, totalCleared);
        }

        Sleep(1500);
    }

    AffLog("native-resweep-done (total cleared: %d)", totalCleared);

    /*
     * Clean exit: decrement our DLL ref-count and terminate this thread.
     * FreeLibraryAndExitThread is the SAFE way to do both — calling
     * FreeLibrary followed by ExitThread would race because FreeLibrary
     * could unmap our code before ExitThread runs.
     */
    FreeLibraryAndExitThread(hSelf, 0);

    /* unreachable */
    return 0;
}

/* ── DllMain ─────────────────────────────────────────────────────────── */

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID reserved) {
    HANDLE hThread;

    switch (reason) {
    case DLL_PROCESS_ATTACH:
        /* Disable DLL_THREAD_ATTACH/DETACH notifications — perf. */
        DisableThreadLibraryCalls(hModule);

        /* NEVER do real work under loader lock!
         * Spawn a worker thread that does the actual sweep. */
        hThread = CreateThread(NULL, 0, SweepThread, (LPVOID)hModule, 0, NULL);
        if (hThread) {
            CloseHandle(hThread);  /* we don't need the handle */
        }
        break;

    case DLL_PROCESS_DETACH:
        /* nothing to clean up */
        break;
    }

    return TRUE;
}
