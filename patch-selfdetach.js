// Patch script: replaces the broken self-detach block in main.js
const fs = require('fs');
const path = require('path');

const file = 'main.js';
let content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

// Find start and end line indices (0-based)
const startLine = lines.findIndex(l => l.includes('if (isChildOfAntigravity) {'));
const endLine   = lines.findIndex((l, i) => i > startLine && l.trim() === '}' && lines[i-1].includes('process.exit(0)'));

if (startLine === -1 || endLine === -1) {
  console.error('ERROR: Could not find self-detach block. startLine:', startLine, 'endLine:', endLine);
  process.exit(1);
}

console.log(`Replacing lines ${startLine+1}–${endLine+1}`);

const newBlock = [
  `    if (isChildOfAntigravity) {`,
  `      // Re-launch ourselves via PowerShell WMI so we're fully detached.`,
  `      // WMI creates a process owned by the system — NOT a child of Antigravity.`,
  `      // Using PS variable assignment avoids backslash-escaping nightmares in the WMI cmd.`,
  `      const exeEsc     = process.execPath.replace(/\\\\/g, '\\\\\\\\');`,
  `      const dirEsc     = __dirname.replace(/\\\\/g, '\\\\\\\\');`,
  `      const guardianPs = path.join(__dirname, 'utils', 'guardian.ps1').replace(/\\\\/g, '\\\\\\\\');`,
  ``,
  `      // Build PowerShell commands using PS variable concatenation to keep the WMI cmd clean`,
  "      const psCmd = [",
  "        `$exe = '${exeEsc}'`,",
  "        `$dir = '${dirEsc}'`,",
  "        `$gps = '${guardianPs}'`,",
  "        `$wmi = [wmiclass]'Win32_Process'`,",
  "        `$null = $wmi.Create($exe + ' \"' + $dir + '\" --detached --stealth', $dir, $null)`,",
  "        'Start-Sleep -Milliseconds 1500',",
  "        `$null = $wmi.Create('powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File \"' + $gps + '\"', $dir, $null)`,",
  "      ].join('\\n');",
  ``,
  `      try {`,
  `        execFileSync('powershell.exe', [`,
  `          '-ExecutionPolicy', 'Bypass',`,
  `          '-NonInteractive',`,
  `          '-WindowStyle', 'Hidden',`,
  `          '-Command', psCmd`,
  `        ], { timeout: 8000, windowsHide: true });`,
  `      } catch (psErr) {`,
  `        // WMI failed — continue running attached rather than crashing`,
  `        console.error('[SelfDetach] WMI launch failed, continuing attached:', psErr.message);`,
  `        throw psErr;`,
  `      }`,
  ``,
  `      // Exit this child instance — the WMI-spawned one will take over`,
  `      process.exit(0);`,
  `    }`,
];

// Replace the lines
lines.splice(startLine, endLine - startLine + 1, ...newBlock);

fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('SUCCESS: self-detach block patched.');
