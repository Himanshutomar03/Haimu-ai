/**
 * Pre-build obfuscation script.
 * Runs javascript-obfuscator on main.js and renderer/app.js
 * before electron-builder packages them into app.asar.
 *
 * Usage: npm run obfuscate
 * The obfuscated files are written to dist-obfuscated/ and then
 * electron-builder picks them up via the `files` config override.
 *
 * For now: we obfuscate in-place into temporary copies that
 * electron-builder will package. The originals are never touched.
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TARGETS = [
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'renderer', 'app.js'),
];

const OPTIONS = {
  compact: true,
  controlFlowFlattening: false,        // keep false — breaks Electron IPC
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: true,           // removes all console.log in production
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,                 // keep false — Electron globals must stay
  rotateStringArray: true,
  selfDefending: false,                 // breaks in Electron context
  shuffleStringArray: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
};

console.log('\n[Obfuscate] Starting pre-build obfuscation...\n');

for (const filePath of TARGETS) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[Obfuscate] Skipping (not found): ${filePath}`);
    continue;
  }

  const source = fs.readFileSync(filePath, 'utf-8');
  const result = JavaScriptObfuscator.obfuscate(source, OPTIONS);
  const obfuscated = result.getObfuscatedCode();

  // Backup original
  const backupPath = filePath + '.original.bak';
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, source, 'utf-8');
    console.log(`[Obfuscate] Backed up: ${path.basename(filePath)} → ${path.basename(backupPath)}`);
  }

  // Write obfuscated version in place (electron-builder will package this)
  fs.writeFileSync(filePath, obfuscated, 'utf-8');
  const savings = ((1 - obfuscated.length / source.length) * 100).toFixed(1);
  console.log(`[Obfuscate] ✓ ${path.basename(filePath)} (${source.length} → ${obfuscated.length} chars, ${savings < 0 ? '+' : '-'}${Math.abs(savings)}%)`);
}

console.log('\n[Obfuscate] Done. Run electron-builder to package.\n');
console.log('[Obfuscate] ⚠️  After build, restore originals with: node scripts/restore.js\n');
