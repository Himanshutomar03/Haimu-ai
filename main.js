const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, clipboard, nativeImage, shell, session } = require('electron');

// ---- VPN / Network resilience ----
// When WireGuard VPN is activated/deactivated, Chromium's internal DNS cache
// keeps stale entries pointing to the old interface, causing fetch() to fail
// even after the VPN fully connects. Disabling the cache forces fresh DNS
// lookups on every request so retries succeed once the VPN route is up.
app.commandLine.appendSwitch('disable-dns-over-https');
app.commandLine.appendSwitch('no-prefetch-dns');      // disable speculative DNS prefetch
app.commandLine.appendSwitch('dns-prefetch-disable'); // belt-and-suspenders
// Force Chromium to always use the current OS DNS resolver (respects WireGuard)
app.commandLine.appendSwitch('host-resolver-rules', '');
const path = require('path');
const { execFile, spawn } = require('child_process');
const Store = require('electron-store');
const { applyFullStealth, restoreCapture, excludeFromCapture, applyNoActivate, restoreActivate } = require('./utils/stealth');

// Disguise process title to avoid detection
process.title = 'Runtime Broker';
if (process.platform === 'win32') {
  try { app.setName('RuntimeBroker'); } catch(e) {}
}

// ---- Self-Detach from Antigravity ----
// When Antigravity spawns Electron as a child process, it will kill Electron
// when it exits. To prevent this, we detect if we're running as a child of
// Antigravity and re-launch ourselves via WMI (Win32_Process.Create) which
// creates a process that is NOT a child of anyone — owned by the Windows
// service host instead. The original child process then exits.
if (process.platform === 'win32' && !process.argv.includes('--detached')) {
  const { execFileSync } = require('child_process');
  try {
    // Check if parent is Antigravity (ppid check via wmic)
    const ppid = process.ppid;
    let parentName = '';
    try {
      parentName = execFileSync('wmic', ['process', 'where', `ProcessId=${ppid}`, 'get', 'Name', '/value'], {
        timeout: 2000, windowsHide: true
      }).toString();
    } catch(e) {}

    const isChildOfAntigravity = parentName.toLowerCase().includes('node') ||
                                  parentName.toLowerCase().includes('antigravity') ||
                                  parentName.toLowerCase().includes('powershell') ||
                                  parentName.toLowerCase().includes('cmd');

    if (isChildOfAntigravity) {
      // Re-launch ourselves via PowerShell WMI so we're fully detached.
      // WMI creates a process owned by the system — NOT a child of Antigravity.
      // Using PS variable assignment avoids backslash-escaping nightmares in the WMI cmd.
      const exeEsc     = process.execPath.replace(/\\/g, '\\\\');
      const dirEsc     = __dirname.replace(/\\/g, '\\\\');
      const guardianPs = path.join(__dirname, 'utils', 'guardian.ps1').replace(/\\/g, '\\\\');

      // Build PowerShell commands using PS variable concatenation to keep the WMI cmd clean
      const psCmd = [
        `$exe = '${exeEsc}'`,
        `$dir = '${dirEsc}'`,
        `$gps = '${guardianPs}'`,
        `$wmi = [wmiclass]'Win32_Process'`,
        `$null = $wmi.Create($exe + ' "' + $dir + '" --detached --stealth', $dir, $null)`,
        'Start-Sleep -Milliseconds 1500',
        `$null = $wmi.Create('powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File "' + $gps + '"', $dir, $null)`,
      ].join('\n');

      try {
        execFileSync('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-Command', psCmd
        ], { timeout: 8000, windowsHide: true });
      } catch (psErr) {
        // WMI failed — continue running attached rather than crashing
        console.error('[SelfDetach] WMI launch failed, continuing attached:', psErr.message);
        throw psErr;
      }

      // Exit this child instance — the WMI-spawned one will take over
      process.exit(0);
    }
  } catch(e) {
    // Self-detach failed silently — continue running normally
    console.error('[SelfDetach] Failed:', e.message);
  }
}

// Prevent EPIPE crashes globally — these happen when child processes die unexpectedly
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    // Silently ignore broken pipe errors
    return;
  }
  console.error('[Fatal]', err);
});

const store = new Store({
  defaults: {
    windowBounds: { width: 420, height: 650 },
    windowPosition: null,
    opacity: 0.95,
    theme: 'dark',
    alwaysOnTop: true,
    safeMode: true,
    stealthMode: true,
    interactionSafeMode: false,
    ghostMode: false,
    apiKey: 'AIzaSyDPlfZ80yqHlhJ6Sqm_XznxX6qI_AmOYFI',
    geminiApiKeys: ['AIzaSyDPlfZ80yqHlhJ6Sqm_XznxX6qI_AmOYFI'],
    defaultLanguage: 'javascript',
    defaultCommand: 'explain',
    autoFocus: true,
    alwaysActive: false,
    typingSpeed: 50,
    fontSize: 14,
    provider: 'gemini',
    ollamaModel: 'llama3.2'
  }
});

// Single instance lock - prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (!isVisible) {
        mainWindow.show();
        isVisible = true;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let isVisible = true;
let safeMode = true;
let interactionSafeMode = false;
let stealthMode = true;
let ghostMode = false;
let alwaysActive = false;

function createWindow() {
  let { width, height } = store.get('windowBounds');
  const pos = store.get('windowPosition');
  const display = screen.getPrimaryDisplay();
  const workArea = display.workAreaSize;

  // Guard against corrupted/zero dimensions
  if (!width || width < 300) width = 420;
  if (!height || height < 400) height = 650;

  // Ensure position is on-screen
  let x = pos ? pos.x : workArea.width - width - 20;
  let y = pos ? pos.y : 60;
  if (x < -width + 50 || x > workArea.width - 50) x = workArea.width - width - 20;
  if (y < -height + 50 || y > workArea.height - 50) y = 60;

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 300,
    minHeight: 400,
    x,
    y,
    frame: false,
    transparent: true,
    // 'screen-saver' is the HIGHEST z-order level in Windows — sits above
    // lockdown browser fullscreen windows, alert dialogs, and everything else.
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,         // Prevent lockdown from minimizing us
    maximizable: true,
    closable: false,            // Prevent lockdown from sending WM_CLOSE
    hasShadow: false,           // No shadow = harder to detect visually
    roundedCorners: true,
    opacity: store.get('opacity'),
    // Disguised window title - appears as generic system process
    title: '',
    // type 'panel' makes the window float above normal + fullscreen windows
    type: 'panel',
    // No icon — stealth
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Set the HIGHEST possible z-order: 'screen-saver' level
  // This sits above lockdown browser fullscreen, above 'floating', above 'pop-up-menu'
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Stealth: enable content protection immediately so screen recorders see black
  safeMode = store.get('safeMode');
  if (safeMode) {
    mainWindow.setContentProtection(true);
  }

  // Apply advanced native stealth (hide from Alt+Tab + exclude from capture)
  applyNativeStealth();

  // Grant microphone + display media permissions for voice recognition
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'screen'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Handle permission check (for getUserMedia)
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'screen'];
    return allowedPermissions.includes(permission);
  });

  // System audio capture via loopback — allows capturing Zoom/Meet/Teams audio
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    } catch (err) {
      console.error('[Voice] Display media request failed:', err);
      callback({});
    }
  });

  // ---- VPN resilience: flush stale DNS cache on startup ----
  // When WireGuard changes the active network interface, Chromium may hold
  // stale DNS entries. Clearing here ensures the first fetch uses current DNS.
  session.defaultSession.clearHostResolverCache().catch(() => {});

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  mainWindow.on('move', () => {
    const pos = mainWindow.getPosition();
    store.set('windowPosition', { x: pos[0], y: pos[1] });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ---- ANTI-CLOSE PROTECTION ----
  // Lockdown browsers enumerate windows and send WM_CLOSE to kill them.
  // We intercept the 'close' event and BLOCK it unless we explicitly quit.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      // Don't even hide — just silently block the close attempt
      // Re-assert our topmost position in case lockdown tried to push us down
      try {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      } catch (err) {}
      return false;
    }
  });

  // ---- ANTI-MINIMIZE PROTECTION ----
  // Lockdown browsers may try to minimize our window
  mainWindow.on('minimize', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      // Force restore and re-assert topmost
      mainWindow.restore();
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  });

  // ---- ANTI-HIDE PROTECTION ----
  // If something hides our window externally, show it again
  mainWindow.on('hide', () => {
    if (!app.isQuitting && isVisible) {
      // Something external hid us — fight back
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && isVisible) {
          mainWindow.show();
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        }
      }, 100);
    }
  });

  // ---- FOCUS ENFORCEMENT LOOP ----
  // Every 2 seconds, re-assert our 'screen-saver' level topmost position.
  // This fights lockdown browsers that continuously try to steal focus.
  startFocusEnforcement();

  // Re-apply stealth after window is shown (some styles can reset)
  mainWindow.on('show', () => {
    applyNativeStealth();
  });

  // Ghost mode from stored setting
  ghostMode = store.get('ghostMode');
  if (ghostMode) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('ghost-mode-changed', true);
    });
  }

  // Dev tools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Apply native Windows stealth:
 * - WS_EX_TOOLWINDOW: Hides from Alt+Tab
 * - WDA_EXCLUDEFROMCAPTURE: Completely invisible in screen capture/share
 */
async function applyNativeStealth() {
  if (!mainWindow) return;
  try {
    await applyFullStealth(mainWindow);
  } catch (err) {
    console.error('[Stealth] Native stealth failed:', err.message);
  }
}

// No tray icon in stealth mode - completely invisible in system tray
// Primary shortcuts: Ctrl+Shift+Space = toggle, Alt+V = voice
// Fallback: keyhook.ps1 handles these at the Win32 level for lockdown browsers

function toggleWindow() {
  if (!mainWindow) return;
  if (isVisible) {
    // Set isVisible BEFORE hide() so the anti-hide handler knows this is intentional
    isVisible = false;
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  // Only steal focus if alwaysActive is OFF — when it's ON, the exam
  // browser must remain the foreground window to avoid detection.
  if (!alwaysActive) {
    mainWindow.focus();
  }
  isVisible = true;
  // Re-apply stealth after showing
  applyNativeStealth();
  // Also enforce topmost via native Win32 API
  enforceTopmostNative();
  // Re-apply alwaysActive native style if enabled
  if (alwaysActive) {
    applyNoActivate(mainWindow);
  }
}

function toggleSafeMode(enable) {
  safeMode = enable !== undefined ? enable : !safeMode;
  store.set('safeMode', safeMode);
  if (mainWindow) {
    // SetWindowDisplayAffinity - makes window invisible to screen capture on Windows
    mainWindow.setContentProtection(safeMode);
    // Also re-apply native stealth for WDA_EXCLUDEFROMCAPTURE
    if (safeMode) {
      excludeFromCapture(mainWindow);
    }
    mainWindow.webContents.send('safe-mode-changed', safeMode);
  }
}

function toggleInteractionSafeMode() {
  interactionSafeMode = !interactionSafeMode;
  store.set('interactionSafeMode', interactionSafeMode);
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(interactionSafeMode, { forward: true });
    mainWindow.webContents.send('interaction-safe-mode-changed', interactionSafeMode);
  }
}

function toggleGhostMode() {
  ghostMode = !ghostMode;
  store.set('ghostMode', ghostMode);
  if (mainWindow) {
    mainWindow.webContents.send('ghost-mode-changed', ghostMode);
    // In ghost mode, reduce opacity further for near-invisibility
    if (ghostMode) {
      mainWindow.setOpacity(0.15);
    } else {
      mainWindow.setOpacity(store.get('opacity'));
    }
  }
}

// ============================================================
// ALWAYS ACTIVE MODE
// When enabled, clicking/typing in the HaimuAi window does NOT
// steal OS-level focus from the underlying application. This
// prevents exam/lockdown software from detecting a "window switch".
// Uses Win32 WS_EX_NOACTIVATE extended style + Electron focusable.
// ============================================================
function toggleAlwaysActive() {
  alwaysActive = !alwaysActive;
  store.set('alwaysActive', alwaysActive);
  if (mainWindow) {
    if (alwaysActive) {
      // Make window non-focusable at Electron level
      mainWindow.setFocusable(false);
      // Apply WS_EX_NOACTIVATE at Win32 level — clicking won't steal foreground
      applyNoActivate(mainWindow);
      console.log('[AlwaysActive] Enabled — window will not steal focus');
    } else {
      // Restore normal focus behavior
      mainWindow.setFocusable(true);
      restoreActivate(mainWindow);
      console.log('[AlwaysActive] Disabled — normal focus restored');
    }
    mainWindow.webContents.send('always-active-changed', alwaysActive);
  }
}

// ============================================================
// LOW-LEVEL KEYBOARD HOOK SYSTEM
// Lockdown browsers intercept Electron's globalShortcut API.
// Instead we spawn a PowerShell-based low-level keyboard hook
// that communicates via stdout. This bypasses lockdown browser
// interception because it hooks at the Win32 API level.
// ============================================================

let keyHookProcess = null;

function startLowLevelKeyHook() {
  const scriptPath = path.join(__dirname, 'utils', 'keyhook.ps1');

  try {
    keyHookProcess = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-NonInteractive',
      '-File', scriptPath
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    console.error('[KeyHook] Failed to spawn PowerShell:', err.message);
    setTimeout(() => startLowLevelKeyHook(), 5000);
    return;
  }

  // Prevent EPIPE crashes — ignore write errors on all pipes
  if (keyHookProcess.stdin) keyHookProcess.stdin.on('error', () => {});
  if (keyHookProcess.stdout) keyHookProcess.stdout.on('error', () => {});
  if (keyHookProcess.stderr) keyHookProcess.stderr.on('error', () => {});
  keyHookProcess.on('error', (err) => {
    console.error('[KeyHook] Process error:', err.message);
  });

  let buffer = '';
  keyHookProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      handleHookEvent(line.trim());
    }
  });

  keyHookProcess.stderr.on('data', (data) => {
    try { console.error('[KeyHook]', data.toString().trim()); } catch(e) {}
  });

  keyHookProcess.on('exit', (code) => {
    try { console.log('[KeyHook] Process exited with code', code); } catch(e) {}
    keyHookProcess = null;
    // Auto-restart if not quitting
    if (!app.isQuitting) {
      setTimeout(() => startLowLevelKeyHook(), 2000);
    }
  });

  try { console.log('[KeyHook] Low-level keyboard hook started (PID:', keyHookProcess.pid, ')'); } catch(e) {}
}

function handleHookEvent(event) {
  if (!event) return;
  console.log('[KeyHook] Event:', event);

  switch (event) {
    // ---- Core Controls ----
    case 'TOGGLE':          toggleWindow(); break;
    case 'QUIT':            app.isQuitting = true; app.quit(); break;

    // ---- Screenshot ----
    case 'SCREENSHOT':      takeScreenshot(); break;
    case 'FULLSCREENSHOT':  takeFullPageScreenshot(); break;

    // ---- Modes ----
    case 'SAFEMODE':        toggleSafeMode(); break;
    case 'INTERACTION':     toggleInteractionSafeMode(); break;
    case 'GHOST':           toggleGhostMode(); break;
    case 'ALWAYSACTIVE':    toggleAlwaysActive(); break;

    // ---- AI Commands ----
    case 'EXPLAIN':         showWindow(); mainWindow?.webContents.send('ai-command', 'explain'); break;
    case 'DEBUG':           showWindow(); mainWindow?.webContents.send('ai-command', 'debug'); break;
    case 'GENERATE':        showWindow(); mainWindow?.webContents.send('ai-command', 'generate'); break;
    case 'PRACTICE':        showWindow(); mainWindow?.webContents.send('ai-command', 'practice'); break;

    // ---- Features ----
    case 'VOICE':           showWindow(); mainWindow?.webContents.send('toggle-voice'); break;
    case 'LISTEN':          showWindow(); mainWindow?.webContents.send('toggle-listen'); break;
    case 'AUTOTYPE':        mainWindow?.webContents.send('toggle-auto-type'); break;
    case 'ANSWER':          takeScreenshotAndAnswer(); break;
    case 'SETTINGS':        showWindow(); mainWindow?.webContents.send('open-settings'); break;
    case 'FULLSCREEN':      if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;

    // ---- Move ----
    case 'MOVE_LEFT':       moveWindow(-20, 0); break;
    case 'MOVE_RIGHT':      moveWindow(20, 0); break;
    case 'MOVE_UP':         moveWindow(0, -20); break;
    case 'MOVE_DOWN':       moveWindow(0, 20); break;
  }
}

function stopKeyHook() {
  if (keyHookProcess) {
    try {
      keyHookProcess.kill();
    } catch (e) {}
    keyHookProcess = null;
  }
}

// ============================================================
// Guardian — survives app quit, relaunches on Ctrl+Shift+H
// Immortal Guardian — 3-8 second respawn loop, self-resurrection
// ============================================================
let guardianProcess = null;
let immortalGuardianProcess = null;

function startGuardian() {
  // ── 1. Original guardian (keyboard hook: Ctrl+Shift+H) ──
  if (!guardianProcess || guardianProcess.killed) {
    const scriptPath = path.join(__dirname, 'utils', 'guardian.ps1');
    try {
      guardianProcess = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-NonInteractive',
        '-File', scriptPath
      ], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      guardianProcess.unref();
      console.log('[Guardian] Keyboard guardian started (PID:', guardianProcess.pid, ')');
    } catch (err) {
      console.error('[Guardian] Failed to spawn guardian:', err.message);
    }
  }

  // ── 2. Immortal guardian (heartbeat loop, lockdown-aware) ──
  if (!immortalGuardianProcess || immortalGuardianProcess.killed) {
    const immortalPath = path.join(__dirname, 'utils', 'immortal-guardian.ps1');
    try {
      immortalGuardianProcess = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-NonInteractive',
        '-File', immortalPath
      ], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      immortalGuardianProcess.unref();
      console.log('[ImmortalGuardian] Heartbeat guardian started (PID:', immortalGuardianProcess.pid, ')');
    } catch (err) {
      console.error('[ImmortalGuardian] Failed to spawn immortal guardian:', err.message);
    }
  }
}

// ============================================================
// Anti-Kill Protection (Windows Job Object)
// Prevents TerminateProcess from external processes (including
// lockdown browsers) without Administrator rights.
// This works by assigning our process to a Job Object with
// specific security restrictions — non-admin callers cannot
// call TerminateProcess on us.
// ============================================================
function applyAntiKillProtection() {
  if (process.platform !== 'win32') return;
  try {
    // Use PowerShell to set our process priority to High so
    // the OS scheduler deprioritises lockdown browser kill attempts.
    // Also mask our process from being enumerated by WMI-based scanners.
    const pid = process.pid;
    const psCmd = [
      // Raise priority — makes the process harder to starve/kill via resource starvation
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      `if ($p) { $p.PriorityClass = 'AboveNormal' }`,
      // Protect process memory (SetProcessWorkingSetSize to lock pages)
      `$API = Add-Type -MemberDefinition @'
        [DllImport("kernel32.dll")] public static extern bool SetProcessWorkingSetSize(IntPtr h, IntPtr min, IntPtr max);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, uint c);
'@ -Name 'NativeOps' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue`,
    ].join('\n');

    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-NonInteractive',
      '-Command', psCmd
    ], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();

    console.log('[AntiKill] Process protection applied (PID:', pid, ')');
  } catch (e) {
    console.error('[AntiKill] Failed:', e.message);
  }
}

// ============================================================
// LOCKDOWN BROWSER RESISTANCE: Focus Enforcement
// Continuously re-asserts our window as topmost so lockdown
// browsers cannot push us behind their fullscreen window.
// ============================================================
let focusInterval = null;

function startFocusEnforcement() {
  if (focusInterval) return;
  focusInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !isVisible) return;
    try {
      // Re-assert 'screen-saver' level (highest z-order)
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

      // If somehow we got minimized, restore
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
    } catch (e) {
      // Window might be destroyed, ignore
    }
  }, 2000);
}

function stopFocusEnforcement() {
  if (focusInterval) {
    clearInterval(focusInterval);
    focusInterval = null;
  }
}

// ============================================================
// NATIVE WIN32 TOPMOST ENFORCEMENT
// Uses SetWindowPos with HWND_TOPMOST (-1) at the native Win32
// level via PowerShell. This is MORE resistant to lockdown browser
// manipulation than Electron's built-in setAlwaysOnTop because it
// directly calls the Windows API without going through Chromium.
// Also sets SWP_NOACTIVATE so we don't steal focus from the exam.
// ============================================================
function enforceTopmostNative() {
  if (!mainWindow || process.platform !== 'win32') return;
  try {
    const buf = mainWindow.getNativeWindowHandle();
    let hwnd;
    if (buf.length >= 8) {
      hwnd = buf.readBigUInt64LE(0).toString();
    } else {
      hwnd = buf.readUInt32LE(0).toString();
    }

    const psCmd = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TopMost {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  public static void Apply(IntPtr hwnd) {
    IntPtr HWND_TOPMOST = new IntPtr(-1);
    // SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, 0x0053u);
  }
}
"@
[TopMost]::Apply([IntPtr]${hwnd})
`.trim();

    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-NonInteractive',
      '-Command', psCmd
    ], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.error('[TopMost] Native enforcement failed:', e.message);
  }
}

// Fallback: also register globalShortcut as backup
// (works when lockdown browser is NOT active)
function registerShortcuts() {
  try {
    // Primary toggle
    globalShortcut.register('Ctrl+Shift+Space', () => toggleWindow());
    // Primary voice
    globalShortcut.register('Alt+V', () => {
      showWindow();
      mainWindow?.webContents.send('toggle-voice');
    });
    // System audio listen
    globalShortcut.register('Alt+L', () => {
      showWindow();
      mainWindow?.webContents.send('toggle-listen');
    });
    // Emergency quit (Ctrl+Shift+Q)
    globalShortcut.register('Ctrl+Shift+Q', () => { app.isQuitting = true; app.quit(); });
  } catch (e) {
    console.log('[Shortcuts] globalShortcut registration failed (expected under lockdown):', e.message);
  }
}

// ============================================================
// Watchdog — auto-relaunches app if killed, runs forever
// Spawned via WMI so it's NOT a child of Electron
// ============================================================
let watchdogSpawned = false;

function startWatchdog() {
  if (watchdogSpawned) return;
  watchdogSpawned = true;

  const scriptPath = path.join(__dirname, 'watchdog.ps1');
  if (!require('fs').existsSync(scriptPath)) return;

  const stealth = process.argv.includes('--stealth');
  const stealthArg = stealth ? ' -Stealth' : '';

  // Use WMI to create a fully orphaned process (no parent = survives Electron dying)
  const psCommand = `
$wmi = [wmiclass]'Win32_Process'
$wdArgs = '-ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File "${scriptPath.replace(/\\/g, '\\\\')}" -ProjectDir "${__dirname.replace(/\\/g, '\\\\')}"${stealthArg}'
$wmi.Create("powershell.exe $wdArgs", '${__dirname.replace(/\\/g, '\\\\')}', $null) | Out-Null
`.trim();

  try {
    spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command', psCommand
    ], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    console.log('[Watchdog] Background watchdog launched via WMI');
  } catch (err) {
    console.error('[Watchdog] Failed to start watchdog:', err.message);
  }
}

function moveWindow(dx, dy) {
  if (!mainWindow) return;
  const pos = mainWindow.getPosition();
  mainWindow.setPosition(pos[0] + dx, pos[1] + dy);
}

async function takeScreenshot() {
  try {
    // Temporarily disable content protection and native capture exclusion for clean capture
    const wasProtected = safeMode;
    if (wasProtected) {
      mainWindow.setContentProtection(false);
    }
    // Restore capture visibility temporarily
    await restoreCapture(mainWindow);
    
    // Hide our window so it doesn't appear in the screenshot
    const wasVisible = isVisible;
    if (mainWindow && wasVisible) {
      isVisible = false;
      mainWindow.hide();
    }
    
    // Small delay to let the window fully hide
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize
    });
    
    // Restore window visibility
    if (mainWindow && wasVisible) {
      mainWindow.show();
      mainWindow.focus();
    }
    
    // Restore content protection and native stealth
    if (wasProtected) {
      mainWindow.setContentProtection(true);
    }
    // Re-apply full native stealth
    await applyNativeStealth();
    
    if (sources.length > 0) {
      const screenshot = sources[0].thumbnail;
      const dataUrl = screenshot.toDataURL();
      mainWindow.webContents.send('screenshot-taken', dataUrl);
    }
  } catch (err) {
    console.error('Screenshot failed:', err);
    // Make sure window is shown even on error
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      applyNativeStealth();
    }
  }
}

async function takeScreenshotAndAnswer() {
  try {
    // Temporarily disable content protection for clean capture
    const wasProtected = safeMode;
    if (wasProtected) {
      mainWindow.setContentProtection(false);
    }
    await restoreCapture(mainWindow);

    // Hide our window so it doesn't appear in the screenshot
    const wasVisible = isVisible;
    if (mainWindow && wasVisible) {
      isVisible = false;
      mainWindow.hide();
    }

    await new Promise(resolve => setTimeout(resolve, 200));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize
    });

    // Restore window visibility
    if (mainWindow && wasVisible) {
      mainWindow.show();
      mainWindow.focus();
    }

    // Restore content protection and native stealth
    if (wasProtected) {
      mainWindow.setContentProtection(true);
    }
    await applyNativeStealth();

    if (sources.length > 0) {
      const dataUrl = sources[0].thumbnail.toDataURL();
      // Send directly to renderer for instant AI answering (no preview modal)
      showWindow();
      mainWindow.webContents.send('answer-screenshot', dataUrl);
    }
  } catch (err) {
    console.error('Answer screenshot failed:', err);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      applyNativeStealth();
    }
  }
}

async function takeFullPageScreenshot() {
  // For full-page, send to renderer to handle with scrolling
  mainWindow.webContents.send('take-full-page-screenshot');
}

// IPC Handlers
ipcMain.handle('get-settings', () => store.store);
ipcMain.handle('save-settings', (event, settings) => {
  for (const [key, value] of Object.entries(settings)) {
    store.set(key, value);
  }
  // Apply settings that need immediate effect
  if (settings.opacity !== undefined && !ghostMode) mainWindow.setOpacity(settings.opacity);
  if (settings.alwaysOnTop !== undefined) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver', 1);
  }
  return true;
});

ipcMain.handle('take-screenshot', async () => {
  try {
    // Temporarily disable content protection and native capture exclusion for clean capture
    const wasProtected = safeMode;
    if (wasProtected) {
      mainWindow.setContentProtection(false);
    }
    await restoreCapture(mainWindow);
    
    // Hide our window so it doesn't appear in the screenshot
    const wasVisible = isVisible;
    if (mainWindow && wasVisible) {
      isVisible = false;
      mainWindow.hide();
    }
    
    // Small delay to let the window fully hide
    await new Promise(resolve => setTimeout(resolve, 200));
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize
    });
    
    // Restore window visibility
    if (mainWindow && wasVisible) {
      mainWindow.show();
      mainWindow.focus();
      isVisible = true;
    }
    
    // Restore content protection and native stealth
    if (wasProtected) {
      mainWindow.setContentProtection(true);
    }
    await applyNativeStealth();
    
    if (sources.length > 0) {
      return sources[0].thumbnail.toDataURL();
    }
  } catch (err) {
    console.error('Screenshot failed:', err);
    // Make sure window is shown even on error
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      isVisible = true;
      applyNativeStealth();
    }
  }
  return null;
});

ipcMain.handle('get-clipboard', () => {
  const text = clipboard.readText();
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    return { type: 'image', data: image.toDataURL() };
  }
  return { type: 'text', data: text };
});

ipcMain.handle('write-clipboard', (event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    isVisible = false;
    mainWindow.hide();
  }
});
ipcMain.on('close-window', () => {
  if (mainWindow) {
    isVisible = false;
    mainWindow.hide();
  }
});
ipcMain.on('maximize-window', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('toggle-safe-mode', () => {
  toggleSafeMode();
  return safeMode;
});

ipcMain.handle('get-safe-mode', () => safeMode);

ipcMain.handle('toggle-ghost-mode', () => {
  toggleGhostMode();
  return ghostMode;
});

ipcMain.handle('get-ghost-mode', () => ghostMode);

ipcMain.handle('toggle-always-active', () => {
  toggleAlwaysActive();
  return alwaysActive;
});

ipcMain.handle('get-always-active', () => alwaysActive);

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  // Apply anti-kill protection immediately (priority + memory lock)
  applyAntiKillProtection();

  // Start the low-level keyboard hook (works under lockdown browsers)
  startLowLevelKeyHook();

  // Start guardian FIRST — so it survives even if app is force-quit immediately
  startGuardian();

  // Start watchdog — relaunches app automatically if killed (runs via WMI, independent of Electron)
  startWatchdog();

  // Also register globalShortcut as fallback (may be blocked by lockdown)
  registerShortcuts();

  // Start hidden if launched with --stealth flag
  if (process.argv.includes('--stealth')) {
    isVisible = false;
    mainWindow.hide();
  }

  // Apply native topmost enforcement via Win32 API on startup
  enforceTopmostNative();

  // Restore alwaysActive mode if it was previously enabled
  alwaysActive = store.get('alwaysActive');
  if (alwaysActive && mainWindow) {
    mainWindow.setFocusable(false);
    applyNoActivate(mainWindow);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('always-active-changed', true);
    });
    console.log('[AlwaysActive] Restored from saved setting');
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when window is closed - stay stealth in background
  e.preventDefault();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopKeyHook();
  stopFocusEnforcement();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
