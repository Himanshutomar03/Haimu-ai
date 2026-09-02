const { execFile } = require('child_process');
const path = require('path');

/**
 * Get the HWND (native window handle) as a string for PowerShell consumption.
 * Handles both 32-bit and 64-bit architectures.
 */
function getHwndString(window) {
  const buf = window.getNativeWindowHandle();
  if (buf.length >= 8) {
    // 64-bit process — read as BigUInt64
    const val = buf.readBigUInt64LE(0);
    return val.toString();
  }
  return buf.readUInt32LE(0).toString();
}

/**
 * Run the stealth PowerShell script with the given action.
 */
function runStealthAction(window, action) {
  return new Promise((resolve) => {
    try {
      const hwnd = getHwndString(window);
      const scriptPath = path.join(__dirname, 'stealth.ps1');

      execFile('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-NonInteractive',
        '-File', scriptPath,
        '-Hwnd', hwnd,
        '-Action', action
      ], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[Stealth] ${action} failed:`, err.message);
          resolve(false);
        } else {
          const output = stdout.trim();
          console.log(`[Stealth] ${output}`);
          resolve(true);
        }
      });
    } catch (err) {
      console.error(`[Stealth] Error in ${action}:`, err.message);
      resolve(false);
    }
  });
}

/**
 * Apply full stealth to the window:
 * - Hides from Alt+Tab (WS_EX_TOOLWINDOW)
 * - Excludes from screen capture (WDA_EXCLUDEFROMCAPTURE)
 * - Window becomes completely invisible to screen recording/sharing
 */
async function applyFullStealth(window) {
  return runStealthAction(window, 'full-stealth');
}

/**
 * Hide window from Alt+Tab switcher only.
 */
async function hideFromAltTab(window) {
  return runStealthAction(window, 'hide-alt-tab');
}

/**
 * Exclude window from screen capture (completely invisible, not even black).
 * Uses WDA_EXCLUDEFROMCAPTURE on Win10 2004+, falls back to WDA_MONITOR.
 */
async function excludeFromCapture(window) {
  return runStealthAction(window, 'exclude-capture');
}

/**
 * Temporarily restore capture visibility (needed for self-screenshot).
 */
async function restoreCapture(window) {
  return runStealthAction(window, 'restore-capture');
}

/**
 * Apply WS_EX_NOACTIVATE — clicking the window won't steal focus from
 * the underlying application (e.g. exam browser). The OS still considers
 * the previous window as the "active" foreground window, so no window-switch
 * event is generated.
 */
async function applyNoActivate(window) {
  return runStealthAction(window, 'no-activate');
}

/**
 * Remove WS_EX_NOACTIVATE so the window can take focus normally again.
 */
async function restoreActivate(window) {
  return runStealthAction(window, 'restore-activate');
}

module.exports = {
  applyFullStealth,
  hideFromAltTab,
  excludeFromCapture,
  restoreCapture,
  applyNoActivate,
  restoreActivate
};
