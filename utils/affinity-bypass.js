/**
 * Affinity Bypass Module — Full Native Injection
 *
 * Orchestrates SetWindowDisplayAffinity bypass using:
 *   1. Try to compile AffHook.dll (native C DLL) on first run
 *   2. DLL injection via LoadLibraryW + QueueUserAPC (primary)
 *   3. Shellcode injection via QueueUserAPC (fallback)
 *   4. Watchdog: re-checks every 2s, re-injects if protection reappears
 *
 * The injection runs code INSIDE the target process, which is the ONLY
 * way to call SetWindowDisplayAffinity — the kernel enforces that only
 * the owning process may modify its window's display affinity.
 *
 * Logging:
 *   %LOCALAPPDATA%\QuickSearch\overlay.log  — injection events
 *   %TEMP%\AffHook.log                      — DLL worker (inside target)
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Process names to target ──────────────────────────────────────────
const TARGET_PROCESS_NAMES = [
  'SafeExamBrowser', 'seb', 'SEB',
  'RCBrowserLockDown', 'LockDownBrowser',
  'Respondus', 'respondus',
  'Proctorio', 'proctorio',
  'ExamSoft', 'Examplify',
  'ProctorU', 'Honorlock',
];

// ── State ────────────────────────────────────────────────────────────
let watchdogInterval = null;
let targetPid = null;
let lastProtectionStatus = 'unknown';
let injectionCount = 0;
let dllReady = false;
let dllCompileAttempted = false;
let statusCallback = null;
let sweepProcess = null;

// ── Logging ──────────────────────────────────────────────────────────
const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'QuickSearch');
const logPath = path.join(logDir, 'overlay.log');

function ensureLogDir() {
  try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
}

function log(tag, msg) {
  ensureLogDir();
  const ts = new Date().toISOString();
  try { fs.appendFileSync(logPath, `[${ts}] [${tag}] ${msg}\n`); } catch (e) {}
  console.log(`[AffinityBypass] [${tag}] ${msg}`);
}

// ── Script Path Resolver (ASAR-safe) ─────────────────────────────────
function getScriptPath(name) {
  const devPath = path.join(__dirname, name);
  if (fs.existsSync(devPath)) return devPath;

  const resourcePath = path.join(process.resourcesPath || '', 'utils', name);
  if (fs.existsSync(resourcePath)) return resourcePath;

  const tmpDir = path.join(os.tmpdir(), 'haimuai');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, name);

  for (const src of [devPath, resourcePath]) {
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpPath);
        return tmpPath;
      }
    } catch (e) {}
  }
  return null;
}

// ── DLL Compilation ──────────────────────────────────────────────────
function getDllPath() {
  const devPath = path.join(__dirname, 'AffHook.dll');
  if (fs.existsSync(devPath)) return devPath;

  const resourcePath = path.join(process.resourcesPath || '', 'utils', 'AffHook.dll');
  if (fs.existsSync(resourcePath)) return resourcePath;

  return null;
}

function compileDll() {
  return new Promise((resolve) => {
    if (dllCompileAttempted) { resolve(getDllPath()); return; }
    dllCompileAttempted = true;

    const compileScript = getScriptPath('compile-affhook.ps1');
    if (!compileScript) {
      log('compile', 'compile-affhook.ps1 not found');
      resolve(null);
      return;
    }

    log('compile', 'attempting to compile AffHook.dll...');

    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', compileScript
    ], { windowsHide: true, timeout: 60000 }, (err, stdout) => {
      const output = (stdout || '').trim();
      if (err) {
        log('compile', `compilation failed: ${err.message}`);
      } else {
        log('compile', `compilation result: ${output}`);
      }
      const dll = getDllPath();
      if (dll) {
        dllReady = true;
        log('compile', `DLL ready at: ${dll}`);
      }
      resolve(dll);
    });
  });
}

// ── Detect Target Process ────────────────────────────────────────────
function detectTargetProcess() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }

    execFile('tasklist', ['/NH', '/FO', 'CSV'], {
      windowsHide: true, timeout: 5000,
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const lines = stdout.split('\n');
      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 2) continue;
        const procName = parts[0].replace(/"/g, '').trim();
        const pid = parseInt(parts[1].replace(/"/g, '').trim());
        for (const target of TARGET_PROCESS_NAMES) {
          if (procName.toLowerCase().includes(target.toLowerCase())) {
            resolve({ name: procName, pid });
            return;
          }
        }
      }
      resolve(null);
    });
  });
}

// ── Check Protection Status (cross-process read — legal) ─────────────
function checkTargetProtection(pid) {
  return new Promise((resolve) => {
    const psCmd = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AffCheck {
    [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    public delegate bool EP(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    public static int Check(uint pid) {
        int c = 0;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h)) {
                RECT r; if (GetWindowRect(h, out r)) {
                    if ((r.R-r.L)>=200||(r.B-r.T)>=200) {
                        uint a; if (GetWindowDisplayAffinity(h, out a) && a!=0) c++;
                    }
                }
            }
            return true;
        }, IntPtr.Zero);
        return c;
    }
}
"@ -ErrorAction SilentlyContinue
Write-Output ([AffCheck]::Check(${pid}))
`.trim();

    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-Command', psCmd
    ], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) { resolve(-1); return; }
      const count = parseInt((stdout || '').trim());
      resolve(isNaN(count) ? -1 : count);
    });
  });
}

// ── Native Injection (DLL + Shellcode) ───────────────────────────────
function launchNativeInjection(pid) {
  return new Promise((resolve) => {
    const injectScript = getScriptPath('affinity-inject-native.ps1');
    if (!injectScript) {
      log('affinity', 'ERROR: affinity-inject-native.ps1 not found');
      resolve(false);
      return;
    }

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', injectScript,
      '-TargetPid', pid.toString(),
      '-Mode', 'auto',
    ];

    // Pass DLL path if available
    const dllPath = getDllPath();
    if (dllPath) {
      args.push('-DllPath', dllPath);
    }

    injectionCount++;
    log('affinity', `APC queued — native injection #${injectionCount} for PID ${pid} (DLL: ${dllPath ? 'yes' : 'shellcode-only'})`);

    execFile('powershell.exe', args, {
      windowsHide: true, timeout: 30000,
    }, (err, stdout, stderr) => {
      const output = (stdout || '').trim();
      if (err) {
        log('affinity', `injection error: ${err.message}`);
        resolve(false);
      } else {
        log('affinity', `injection result: ${output}`);
        resolve(output.startsWith('OK:'));
      }
    });
  });
}

// ── Launch Persistent Sweep (keeps re-clearing in target) ────────────
function launchPersistentSweep(pid) {
  if (sweepProcess && !sweepProcess.killed) {
    try { sweepProcess.kill(); } catch (e) {}
  }

  const sweepScript = getScriptPath('affinity-sweep.ps1');
  if (!sweepScript) return;

  sweepProcess = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-NonInteractive',
    '-File', sweepScript,
    '-TargetPid', pid.toString(),
    '-Iterations', '120',
    '-IntervalMs', '1500',
  ], {
    windowsHide: true, detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  sweepProcess.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) log('sweep', line);
  });
  sweepProcess.stderr.on('data', () => {});
  sweepProcess.on('exit', () => { sweepProcess = null; });
  sweepProcess.on('error', () => {});
  sweepProcess.unref();
  log('affinity', `persistent sweep launched for PID ${pid}`);
}

// ── Capture Target Window via PrintWindow ────────────────────────────
function captureTargetWindow(pid) {
  return new Promise((resolve, reject) => {
    const captureScript = getScriptPath('capture-window.ps1');
    if (!captureScript) { reject(new Error('capture-window.ps1 not found')); return; }

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', captureScript,
    ];
    if (pid) args.push('-TargetPid', pid.toString());

    let stdout = '';
    const ps = spawn('powershell.exe', args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });

    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.on('close', (code) => {
      const out = stdout.trim();
      if (out.startsWith('OK:')) {
        resolve('data:image/png;base64,' + out.slice(3));
      } else {
        reject(new Error(out.replace(/^ERR:/, '') || `capture exited ${code}`));
      }
    });
    ps.on('error', (err) => reject(err));
    setTimeout(() => { try { ps.kill(); } catch (_) {} reject(new Error('Timeout')); }, 15000);
  });
}

// ── Watchdog Loop ────────────────────────────────────────────────────
async function watchdogTick() {
  try {
    const target = await detectTargetProcess();

    if (!target) {
      if (lastProtectionStatus !== 'no-target') {
        lastProtectionStatus = 'no-target';
        targetPid = null;
        log('affinity', 'no target process detected');
        if (statusCallback) statusCallback({ status: 'no-target', pid: null });
      }
      return;
    }

    targetPid = target.pid;
    const protectedCount = await checkTargetProtection(target.pid);

    if (protectedCount > 0) {
      log('affinity', `re-protected detected on PID ${target.pid} (${protectedCount} windows) — re-arming APC`);
      lastProtectionStatus = 'protected';

      // Launch native injection (DLL + shellcode)
      await launchNativeInjection(target.pid);

      // Also ensure persistent sweep is running
      if (!sweepProcess || sweepProcess.killed) {
        launchPersistentSweep(target.pid);
      }

      if (statusCallback) statusCallback({
        status: 'injecting',
        pid: target.pid,
        protectedWindows: protectedCount,
        injectionCount,
        dllReady,
      });
    } else if (protectedCount === 0) {
      if (lastProtectionStatus !== 'cleared') {
        log('affinity', `protection cleared on PID ${target.pid}`);
        lastProtectionStatus = 'cleared';
      }
      if (statusCallback) statusCallback({
        status: 'cleared',
        pid: target.pid,
        injectionCount,
        dllReady,
      });
    } else {
      if (statusCallback) statusCallback({
        status: 'error',
        pid: target.pid,
        error: 'Could not read affinity',
      });
    }
  } catch (err) {
    log('affinity', `watchdog error: ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the affinity bypass watchdog.
 * On first run, attempts to compile AffHook.dll for maximum effectiveness.
 */
function startAffinityBypass(onStatus) {
  if (process.platform !== 'win32') return;
  if (watchdogInterval) return;

  statusCallback = onStatus || null;
  log('affinity', 'watchdog started (native injection mode)');

  // Try to compile DLL on first startup (async, non-blocking)
  compileDll().then((dllPath) => {
    if (dllPath) {
      log('affinity', `DLL available: ${dllPath}`);
      dllReady = true;
    } else {
      log('affinity', 'DLL not available — will use shellcode injection only');
    }
  }).catch(() => {});

  // Immediate first check
  watchdogTick();

  // Then every 2 seconds
  watchdogInterval = setInterval(watchdogTick, 2000);
}

/**
 * Stop the affinity bypass watchdog.
 */
function stopAffinityBypass() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (sweepProcess && !sweepProcess.killed) {
    try { sweepProcess.kill(); } catch (e) {}
    sweepProcess = null;
  }
  targetPid = null;
  lastProtectionStatus = 'unknown';
  injectionCount = 0;
  statusCallback = null;
  log('affinity', 'watchdog stopped');
}

/**
 * Get current bypass status.
 */
function getAffinityStatus() {
  return {
    active: watchdogInterval !== null,
    targetPid,
    status: lastProtectionStatus,
    injectionCount,
    dllReady,
    sweepRunning: sweepProcess && !sweepProcess.killed,
  };
}

/**
 * Force an immediate re-injection attempt.
 */
async function forceReInject() {
  if (!targetPid) {
    const target = await detectTargetProcess();
    if (target) targetPid = target.pid;
  }
  if (targetPid) {
    log('affinity', `manual re-inject triggered for PID ${targetPid}`);
    await launchNativeInjection(targetPid);
    launchPersistentSweep(targetPid);
    return true;
  }
  return false;
}

/**
 * Capture the target window (uses PrintWindow).
 */
async function captureTarget() {
  return captureTargetWindow(targetPid);
}

module.exports = {
  startAffinityBypass,
  stopAffinityBypass,
  getAffinityStatus,
  forceReInject,
  captureTarget,
  captureTargetWindow,
};
