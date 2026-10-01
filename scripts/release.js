#!/usr/bin/env node
/**
 * HaimuAi Release Script — scripts/release.js
 *
 * Usage:
 *   npm run release              → bumps patch, builds, creates GitHub release
 *   npm run release -- --minor  → bumps minor version
 *   npm run release -- --major  → bumps major version
 *   npm run release -- --dry    → dry run (no git tag, no GitHub release)
 *
 * Requires:
 *   - GitHub CLI (gh) installed and authenticated
 *   - electron-builder installed
 *   - GH_TOKEN or GITHUB_TOKEN env var (gh auth sets this up)
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────
const ROOT       = path.join(__dirname, '..');
const PKG_PATH   = path.join(ROOT, 'package.json');
const DIST_DIR   = path.join(ROOT, 'dist');
const REPO       = 'Himanshutomar03/Haimu-ai';

const args    = process.argv.slice(2);
const isDry   = args.includes('--dry');
const isMinor = args.includes('--minor');
const isMajor = args.includes('--major');

// ── Helpers ───────────────────────────────────────────────────────────
const run = (cmd, opts = {}) => {
  console.log(`\n▶ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
};

const runCapture = (cmd) => {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
};

const checkTool = (name) => {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 && r.error) {
    console.error(`\n❌ "${name}" not found. Please install it:\n   https://cli.github.com/`);
    process.exit(1);
  }
};

// ── Step 1: Read current version ──────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
let [major, minor, patch] = pkg.version.split('.').map(Number);

if (isMajor)      { major++; minor = 0; patch = 0; }
else if (isMinor) { minor++; patch = 0; }
else              { patch++; }

const newVersion = `${major}.${minor}.${patch}`;
const tagName    = `v${newVersion}`;

console.log(`\n🚀 HaimuAi Release Tool`);
console.log(`   Current : v${pkg.version}`);
console.log(`   New     : ${tagName}`);
console.log(`   Dry run : ${isDry}`);
console.log(`   Repo    : ${REPO}\n`);

if (!isDry) {
  checkTool('gh');
}

// ── Step 2: Bump version in package.json ──────────────────────────────
console.log('\n📝 Bumping package.json version...');
pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`   ✅ package.json → ${newVersion}`);

// ── Step 3: Update README badge ──────────────────────────────────────
const readmePath = path.join(ROOT, 'README.md');
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, 'utf8');
  // Badge
  readme = readme.replace(
    /version-[\d.]+(-brightgreen)/,
    `version-${newVersion}$1`
  );
  // "Latest Release:" line
  readme = readme.replace(
    /\*\*Latest Release: v[\d.]+\*\*/,
    `**Latest Release: ${tagName}**`
  );
  // Download links
  readme = readme.replace(
    /download\/v[\d.]+\/HaimuAi-Setup-[\d.]+\.exe/g,
    `download/${tagName}/HaimuAi-Setup-${newVersion}.exe`
  );
  readme = readme.replace(
    /download\/v[\d.]+\/HaimuAi-Portable-[\d.]+\.exe/g,
    `download/${tagName}/HaimuAi-Portable-${newVersion}.exe`
  );
  // Help panel version badge
  readme = readme.replace(/v[\d.]+ · All features/, `${tagName} · All features`);
  fs.writeFileSync(readmePath, readme);
  console.log(`   ✅ README.md download links → ${tagName}`);
}

// ── Step 4: Build ─────────────────────────────────────────────────────
console.log('\n🔨 Building Windows targets (NSIS installer + Portable)...');
if (!isDry) {
  run('npx electron-builder --win --publish never');
} else {
  console.log('   [DRY] would run: electron-builder --win --publish never');
}

// ── Step 5: Verify artifacts ─────────────────────────────────────────
console.log('\n📦 Verifying build artifacts...');
const expectedFiles = [
  `HaimuAi-Setup-${newVersion}.exe`,
  `HaimuAi-Portable-${newVersion}.exe`,
];

const missingFiles = [];
for (const f of expectedFiles) {
  const p = path.join(DIST_DIR, f);
  if (fs.existsSync(p)) {
    const size = (fs.statSync(p).size / 1024 / 1024).toFixed(1);
    console.log(`   ✅ ${f} (${size} MB)`);
  } else {
    console.warn(`   ⚠️  Missing: ${f}`);
    missingFiles.push(f);
  }
}

if (missingFiles.length > 0 && !isDry) {
  console.error('\n❌ Build artifacts missing — aborting release.');
  process.exit(1);
}

if (isDry) {
  console.log('\n✅ DRY RUN complete. Nothing was committed or released.');
  process.exit(0);
}

// ── Step 6: Git commit + tag ─────────────────────────────────────────
console.log('\n📌 Committing version bump and tagging...');
run('git add package.json README.md');
run(`git commit -m "chore: bump version to ${newVersion}"`);
run(`git tag -a ${tagName} -m "Release ${tagName}"`);
run('git push origin main');
run(`git push origin ${tagName}`);

// ── Step 7: Create GitHub Release ────────────────────────────────────
console.log('\n🌐 Creating GitHub release...');
const releaseNotes = `## HaimuAi ${tagName}

### What's New
- 🛡️ **Fully automatic SEB/Respondus/LockDown Browser bypass** — detects within 2s, injects via QueueUserAPC, zero user interaction
- 💉 **AffHook.dll** auto-compiled on first run (cl/gcc/tcc fallback)
- 🔰 **Shellcode fallback** if no compiler found  
- 🎨 **Premium UI upgrade** — glassmorphism panels, richer gradients, glowing accents
- ❓ **Help panel** — full feature reference with search, tabs, shortcuts table, pro tips
- ⌨️ **New shortcut**: \`Ctrl+Shift+F\` — force affinity bypass re-inject

### Download
| File | Description |
|------|-------------|
| \`HaimuAi-Setup-${newVersion}.exe\` | Full installer (recommended) |
| \`HaimuAi-Portable-${newVersion}.exe\` | Portable — no install needed |

### Free Mode
Add your own [free Gemini API key](https://aistudio.google.com/apikey) in Settings → API Keys.
`;

const releaseFile = path.join(ROOT, '.release-notes.md');
fs.writeFileSync(releaseFile, releaseNotes);

const artifacts = expectedFiles
  .map(f => path.join(DIST_DIR, f))
  .filter(p => fs.existsSync(p))
  .join(' ');

run(`gh release create ${tagName} ${artifacts} --title "HaimuAi ${tagName}" --notes-file .release-notes.md --repo ${REPO}`);

// Cleanup
try { fs.unlinkSync(releaseFile); } catch (_) {}

console.log(`\n✅ Release ${tagName} published!`);
console.log(`   🔗 https://github.com/${REPO}/releases/tag/${tagName}`);
