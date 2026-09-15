/**
 * Restore original source files after an obfuscated build.
 * Run this after npm run build to restore your readable source.
 *
 * Usage: node scripts/restore.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'main.js'),
  path.join(ROOT, 'renderer', 'app.js'),
];

console.log('\n[Restore] Restoring original source files...\n');

for (const filePath of TARGETS) {
  const backupPath = filePath + '.original.bak';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    console.log(`[Restore] ✓ Restored: ${path.basename(filePath)}`);
  } else {
    console.warn(`[Restore] No backup found for: ${path.basename(filePath)}`);
  }
}

console.log('\n[Restore] Done.\n');
