require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const licenseRouter = require('./routes/license');
const aiRouter = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-license-token', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' })); // 50MB for base64 screenshots

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Download Route ────────────────────────────────────────────────────────
// Single permanent link for users. Update DOWNLOAD_URL to change the version.
const DOWNLOAD_URL = process.env.DOWNLOAD_URL ||
  'https://github.com/Himanshutomar03/Haimu-ai/releases/latest/download/HaimuAi-Portable.exe';

// /download — direct redirect to the .exe (the ONE link you share with users)
app.get('/download', (req, res) => {
  res.redirect(302, DOWNLOAD_URL);
});

// / — beautiful landing page with download button
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HaimuAI — AI Desktop Assistant</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: #07070f;
      color: #e8e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      background-image: radial-gradient(ellipse at 50% 0%, rgba(124,106,247,0.18) 0%, transparent 60%);
    }
    .badge {
      background: rgba(124,106,247,0.15);
      border: 1px solid rgba(124,106,247,0.35);
      color: #a78bfa;
      border-radius: 20px;
      padding: 5px 16px;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 28px;
      letter-spacing: 0.03em;
    }
    h1 {
      font-size: clamp(36px, 6vw, 64px);
      font-weight: 800;
      text-align: center;
      line-height: 1.1;
      margin-bottom: 20px;
      background: linear-gradient(135deg, #fff 0%, #a78bfa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      font-size: 18px;
      color: #9090b0;
      text-align: center;
      max-width: 520px;
      line-height: 1.6;
      margin-bottom: 44px;
    }
    .download-btn {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      background: linear-gradient(135deg, #7c6af7, #5b4fd4);
      color: #fff;
      text-decoration: none;
      font-size: 17px;
      font-weight: 700;
      padding: 16px 36px;
      border-radius: 14px;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 0 40px rgba(124,106,247,0.35);
      margin-bottom: 16px;
    }
    .download-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 0 60px rgba(124,106,247,0.5);
    }
    .download-btn svg { flex-shrink: 0; }
    .meta {
      font-size: 13px;
      color: #555570;
      margin-top: 8px;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      max-width: 600px;
      width: 100%;
      margin-top: 56px;
    }
    .feature {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      font-size: 13px;
      color: #8080a0;
    }
    .feature-icon { font-size: 22px; margin-bottom: 8px; }
    .key-note {
      margin-top: 40px;
      background: rgba(124,106,247,0.08);
      border: 1px solid rgba(124,106,247,0.2);
      border-radius: 12px;
      padding: 18px 24px;
      font-size: 14px;
      color: #9090b0;
      text-align: center;
      max-width: 480px;
    }
    .key-note strong { color: #a78bfa; }
  </style>
</head>
<body>
  <div class="badge">✦ AI-Powered Desktop Assistant</div>
  <h1>HaimuAI</h1>
  <p>Your stealth AI coding assistant. Screenshot analysis, voice input, real-time AI — always one hotkey away.</p>

  <a class="download-btn" href="/download">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download for Windows
  </a>
  <div class="meta">Portable · No installation · 74 MB · Windows 10/11 x64</div>

  <div class="features">
    <div class="feature"><div class="feature-icon">🤖</div>Gemini AI</div>
    <div class="feature"><div class="feature-icon">📸</div>Screenshot Analysis</div>
    <div class="feature"><div class="feature-icon">👻</div>Stealth Mode</div>
    <div class="feature"><div class="feature-icon">🎙️</div>Voice Input</div>
    <div class="feature"><div class="feature-icon">⚡</div>Always On Top</div>
    <div class="feature"><div class="feature-icon">🔒</div>License Protected</div>
  </div>

  <div class="key-note">
    🔑 A <strong>license key</strong> is required to use HaimuAI.<br>
    Contact us to get your activation key.
  </div>
</body>
</html>`);
});

// ─── API Routes ───────────────────────────────────────────────────────────
app.use('/api/license', licenseRouter);
app.use('/api/ai', aiRouter);

// ─── Admin Dashboard (Static HTML) ────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

// ─── 404 Handler ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start + Auto-migrate ─────────────────────────────────────────────────
async function startServer() {
  const supabase = require('./db/supabase');

  // Auto-migration: ensure gemini_api_key column exists
  try {
    // We can't run DDL via PostgREST, so we do a safe check-and-insert approach:
    // Just attempt to select the column. If it errors, log instructions.
    const { error } = await supabase.from('licenses').select('gemini_api_key').limit(1);
    if (error && error.message.includes('gemini_api_key')) {
      console.warn('[Migration] gemini_api_key column not found.');
      console.warn('[Migration] Run this in Supabase SQL Editor:');
      console.warn('[Migration] ALTER TABLE licenses ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;');
    } else {
      console.log('[Migration] gemini_api_key column OK');
    }
  } catch (e) {
    console.warn('[Migration] Could not check schema:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`[HaimuAI Server] Running on port ${PORT}`);
    console.log(`[HaimuAI Server] Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`[HaimuAI Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer();

module.exports = app;
