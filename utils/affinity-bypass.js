/**
 * Affinity Bypass Module — Full Auto Mode
 *
 * Fully automatic. Zero user interaction required.
 *   1. Starts silently on app boot
 *   2. Compiles AffHook.dll in background (tries cl/gcc/tcc/download-tcc)
 *   3. Every 2s: scans for SEB/lockdown browsers
 *   4. If found + protected: QueueUserAPC DLL injection (primary)
 *      → fallback: per-window x64 shellcode via QueueUserAPC
 *   5. Persistent WMI sweep child re-clears every 1.5s
 *   6. If protection re-applied: re-injects within 2s
 *   7. Cleans itself up on app quit
 *
 * Logs:
 *   %LOCALAPPDATA%\QuickSearch\overlay.log
 *   %TEMP%\AffHook.log  (from DLL, inside target process)
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Targets ───────────────────────────────────────────────────────────
const TARGET_PROCESS_NAMES = [
  'SafeExamBrowser', 'seb', 'SEB',
  'RCBrowserLockDown', 'LockDownBrowser',
  'Respondus', 'respondus',
  'Proctorio', 'proctorio',
  'ExamSoft', 'Examplify',
  'ProctorU', 'Honorlock',
];

// ── State ────────────────────────────────────────────────────────────
let watchdogInterval  = null;
let fastInterval      = null;   // 500ms when SEB active
let targetPid         = null;
let lastProtStatus    = 'unknown';
let injectionCount    = 0;
let dllReady          = false;
let dllCompileAttempt = false;
let statusCallback    = null;
let sweepProcess      = null;
let consecutiveFails  = 0;      // retries before switching strategy

// ── Logging ──────────────────────────────────────────────────────────
const logDir  = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'QuickSearch');
const logPath = path.join(logDir, 'overlay.log');
let logBuffer = [];
let logFlushTimer = null;

function ensureLogDir() {
  try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
}

function log(tag, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${tag}] ${msg}\n`;
  logBuffer.push(line);
  // Batch-flush every 2s to avoid hammering the filesystem
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      ensureLogDir();
      try { fs.appendFileSync(logPath, logBuffer.join('')); } catch (_) {}
      logBuffer = [];
      logFlushTimer = null;
    }, 2000);
  }
  console.log(`[AffinityBypass] [${tag}] ${msg}`);
}

// ── Script Path Resolver (ASAR-safe) ─────────────────────────────────
function getScriptPath(name) {
  // 1. Dev path
  const dev = path.join(__dirname, name);
  if (fs.existsSync(dev)) return dev;

  // 2. Packaged resources path
  const res = path.join(process.resourcesPath || '', 'utils', name);
  if (fs.existsSync(res)) return res;

  // 3. Extract to temp (ASAR bundles scripts as read-only)
  const tmpDir = path.join(os.tmpdir(), 'haimuai-utils');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, name);

  for (const src of [dev, res]) {
    try {
      if (fs.existsSync(src)) { fs.copyFileSync(src, tmp); return tmp; }
    } catch (_) {}
  }
  return null;
}

// ── DLL Management ───────────────────────────────────────────────────
function getDllPath() {
  const candidates = [
    path.join(__dirname, 'AffHook.dll'),
    path.join(process.resourcesPath || '', 'utils', 'AffHook.dll'),
    path.join(os.tmpdir(), 'haimuai-utils', 'AffHook.dll'),
    path.join(os.tmpdir(), 'AffHook.dll'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function compileDll() {
  return new Promise((resolve) => {
    if (dllCompileAttempt) { resolve(getDllPath()); return; }
    dllCompileAttempt = true;

    const existing = getDllPath();
    if (existing) { dllReady = true; resolve(existing); return; }

    const script = getScriptPath('compile-affhook.ps1');
    if (!script) { resolve(null); return; }

    log('compile', 'compiling AffHook.dll in background...');

    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', script,
    ], { windowsHide: true, timeout: 90000 }, (err, stdout) => {
      const out = (stdout || '').trim();
      log('compile', `result: ${err ? err.message : out}`);
      const dll = getDllPath();
      if (dll) { dllReady = true; log('compile', `DLL ready: ${dll}`); }
      resolve(dll);
    });
  });
}

// ── Process Detection ────────────────────────────────────────────────
function detectTarget() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    execFile('tasklist', ['/NH', '/FO', 'CSV'], {
      windowsHide: true, timeout: 4000,
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      for (const line of stdout.split('\n')) {
        const parts = line.split(',');
        if (parts.length < 2) continue;
        const name = parts[0].replace(/"/g, '').trim();
        const pid  = parseInt(parts[1].replace(/"/g, '').trim());
        for (const t of TARGET_PROCESS_NAMES) {
          if (name.toLowerCase().includes(t.toLowerCase())) {
            resolve({ name, pid });
            return;
          }
        }
      }
      resolve(null);
    });
  });
}

// ── Protection Check ─────────────────────────────────────────────────
const AFFCHECK_PS = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AC {
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  public delegate bool EP(IntPtr h,IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb,IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT{public int L,T,R,B;}
  public static int Check(uint pid){
    int c=0;
    EnumWindows((h,l)=>{
      uint p;GetWindowThreadProcessId(h,out p);
      if(p==pid&&IsWindowVisible(h)){RECT r;if(GetWindowRect(h,out r)){
        if((r.R-r.L)>=200||(r.B-r.T)>=200){uint a;if(GetWindowDisplayAffinity(h,out a)&&a!=0)c++;}}}
      return true;},IntPtr.Zero);return c;}}
"@ -EA SilentlyContinue
Write-Output ([AC]::Check(PID_TOKEN))`.trim();

function checkProtection(pid) {
  return new Promise((resolve) => {
    const cmd = AFFCHECK_PS.replace('PID_TOKEN', pid);
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive', '-Command', cmd,
    ], { windowsHide: true, timeout: 7000 }, (err, stdout) => {
      if (err) { resolve(-1); return; }
      const n = parseInt((stdout || '').trim());
      resolve(isNaN(n) ? -1 : n);
    });
  });
}

// ── Native Injection ─────────────────────────────────────────────────
function inject(pid) {
  return new Promise((resolve) => {
    const script = getScriptPath('affinity-inject-native.ps1');
    if (!script) { resolve(false); return; }

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', script,
      '-TargetPid', String(pid),
      '-Mode', 'auto',
    ];
    const dll = getDllPath();
    if (dll) args.push('-DllPath', dll);

    injectionCount++;
    log('inject', `#${injectionCount} → PID ${pid} [${dll ? 'DLL' : 'shellcode'}]`);

    execFile('powershell.exe', args, { windowsHide: true, timeout: 25000 }, (err, stdout) => {
      const out = (stdout || '').trim();
      log('inject', `result: ${err ? err.message : out}`);
      const ok = !err && out.startsWith('OK:');
      if (ok) consecutiveFails = 0;
      else consecutiveFails++;
      resolve(ok);
    });
  });
}

// ── Persistent Sweep (WMI-orphaned, survives kills) ──────────────────
function launchSweep(pid) {
  if (sweepProcess && !sweepProcess.killed) {
    try { sweepProcess.kill(); } catch (_) {}
  }
  const script = getScriptPath('affinity-sweep.ps1');
  if (!script) return;

  sweepProcess = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-NonInteractive',
    '-File', script,
    '-TargetPid', String(pid),
    '-Iterations', '240',   // 6 min
    '-IntervalMs', '1200',  // tighter interval
  ], { windowsHide: true, detached: true, stdio: 'ignore' });

  sweepProcess.on('exit', () => { sweepProcess = null; });
  sweepProcess.on('error', () => {});
  sweepProcess.unref();
  log('sweep', `launched for PID ${pid}`);
}

// ── Switch to fast-tick when SEB is active ───────────────────────────
function startFastMode() {
  if (fastInterval) return;
  fastInterval = setInterval(watchdogTick, 800); // 800ms when active
}
function stopFastMode() {
  if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
}

// ── Main watchdog tick ────────────────────────────────────────────────
async function watchdogTick() {
  try {
    const target = await detectTarget();

    if (!target) {
      if (lastProtStatus !== 'no-target') {
        lastProtStatus = 'no-target';
        targetPid = null;
        stopFastMode();
        log('watch', 'no target — scanning every 2s');
        if (statusCallback) statusCallback({ status: 'no-target', pid: null });
      }
      return;
    }

    targetPid = target.pid;

    // Switch to fast 800ms polling when we have a target
    startFastMode();

    const protCount = await checkProtection(target.pid);

    if (protCount > 0) {
      log('watch', `protected (${protCount} windows) PID ${target.pid} — injecting`);
      lastProtStatus = 'injecting';

      await inject(target.pid);

      // Kick persistent sweep
      if (!sweepProcess || sweepProcess.killed) launchSweep(target.pid);

      if (statusCallback) statusCallback({
        status: 'injecting',
        pid: target.pid,
        protectedWindows: protCount,
        injectionCount,
        dllReady,
      });

    } else if (protCount === 0) {
      if (lastProtStatus !== 'cleared') {
        log('watch', `cleared PID ${target.pid} ✓`);
        lastProtStatus = 'cleared';
      }
      if (statusCallback) statusCallback({
        status: 'cleared',
        pid: target.pid,
        injectionCount,
        dllReady,
      });

    } else {
      // checkProtection returned -1 (PS error) — still report target found
      if (statusCallback) statusCallback({
        status: 'active',
        pid: target.pid,
        injectionCount,
        dllReady,
      });
    }
  } catch (e) {
    log('watch', `tick error: ${e.message}`);
  }
}

// ── Capture ───────────────────────────────────────────────────────────
function captureTargetWindow(pid) {
  return new Promise((resolve, reject) => {
    const script = getScriptPath('capture-window.ps1');
    if (!script) { reject(new Error('capture-window.ps1 not found')); return; }

    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-NonInteractive',
      '-File', script,
    ];
    if (pid) args.push('-TargetPid', String(pid));

    let out = '';
    const ps = spawn('powershell.exe', args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    ps.stdout.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      const s = out.trim();
      if (s.startsWith('OK:')) resolve('data:image/png;base64,' + s.slice(3));
      else reject(new Error(s.replace(/^ERR:/, '') || 'capture failed'));
    });
    ps.on('error', reject);
    const t = setTimeout(() => { try { ps.kill(); } catch (_) {} reject(new Error('Timeout')); }, 15000);
    ps.on('close', () => clearTimeout(t));
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Starts the fully-automatic bypass watchdog.
 * Call once on app boot — no further interaction needed.
 */
function startAffinityBypass(onStatus) {
  if (process.platform !== 'win32') return;
  if (watchdogInterval) return;           // already running

  statusCallback = onStatus || null;
  log('watch', '=== AUTO BYPASS STARTED (DLL+shellcode mode) ===');

  // Compile DLL immediately in background — non-blocking
  compileDll().then(dll => {
    if (dll) {
      log('watch', `DLL compiled and ready: ${dll}`);
      dllReady = true;
    } else {
      log('watch', 'no compiler found — shellcode-only mode active');
    }
  }).catch(() => {});

  // First tick immediately
  watchdogTick();

  // Slow background tick (fast mode kicks in automatically when SEB detected)
  watchdogInterval = setInterval(watchdogTick, 2000);
}

function stopAffinityBypass() {
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
  stopFastMode();
  if (sweepProcess && !sweepProcess.killed) {
    try { sweepProcess.kill(); } catch (_) {}
    sweepProcess = null;
  }
  // flush remaining logs
  if (logBuffer.length) {
    ensureLogDir();
    try { fs.appendFileSync(logPath, logBuffer.join('')); } catch (_) {}
    logBuffer = [];
  }
  targetPid = null;
  lastProtStatus = 'unknown';
  injectionCount = 0;
  statusCallback = null;
  log('watch', 'stopped');
}

function getAffinityStatus() {
  return {
    active: !!watchdogInterval,
    fastMode: !!fastInterval,
    targetPid,
    status: lastProtStatus,
    injectionCount,
    dllReady,
    sweepRunning: !!(sweepProcess && !sweepProcess.killed),
  };
}

async function forceReInject() {
  if (!targetPid) {
    const t = await detectTarget();
    if (t) targetPid = t.pid;
  }
  if (!targetPid) return false;
  log('inject', `manual re-inject → PID ${targetPid}`);
  await inject(targetPid);
  launchSweep(targetPid);
  return true;
}

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
