const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { requireAdmin } = require('../middleware/auth');
const supabase = require('../db/supabase');

const router = express.Router();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── In-memory license cache (TTL: 60s) ──────────────────────────────────────
// Avoids hitting Supabase on every single AI token. Revoke propagates within 60s.
const licenseCache = new Map(); // licenseKey -> { active, gemini_api_key, cachedAt }
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function getLicenseInfo(licenseKey) {
  const cached = licenseCache.get(licenseKey);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from('licenses')
    .select('active, gemini_api_key, expires_at')
    .eq('key', licenseKey)
    .single();

  if (error || !data) return null;

  const info = {
    active: data.active,
    gemini_api_key: data.gemini_api_key,
    expires_at: data.expires_at,
    cachedAt: Date.now(),
  };

  licenseCache.set(licenseKey, info);
  return info;
}

// Invalidate cache immediately when revoke happens (called from heartbeat responses)
function invalidateCache(licenseKey) {
  licenseCache.delete(licenseKey);
}

// ─── Middleware: validate token + check license live ────────────────────────
async function requireActiveLicense(req, res, next) {
  const token = req.headers['x-license-token'];
  if (!token) {
    return res.status(401).json({ error: 'No license token', revoked: true });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token expired or invalid', revoked: true });
  }

  // Live check against Supabase (cached 60s)
  const info = await getLicenseInfo(payload.licenseKey);

  if (!info) {
    return res.status(401).json({ error: 'License not found', revoked: true });
  }

  if (!info.active) {
    // Immediately clear cache so next request also fails
    invalidateCache(payload.licenseKey);
    return res.status(401).json({ error: 'License revoked', revoked: true });
  }

  if (info.expires_at && new Date(info.expires_at) < new Date()) {
    return res.status(401).json({ error: 'License expired', revoked: true });
  }

  if (!info.gemini_api_key) {
    return res.status(402).json({
      error: 'No API key assigned to your license. Please contact the administrator.',
      revoked: false,
    });
  }

  // Attach to request for route handlers
  req.licenseKey = payload.licenseKey;
  req.geminiApiKey = info.gemini_api_key;
  next();
}

// ─── POST /api/ai/chat ────────────────────────────────────────────────────────
router.post('/chat', requireActiveLicense, async (req, res) => {
  const { message, history = [], command = 'general', language = 'javascript', systemPrompt } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const sysPrompt = systemPrompt || buildSystemPrompt(command, language);

  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: sysPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };

  try {
    const url = `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${req.geminiApiKey}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini error: ${errText}` });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Increment usage counter asynchronously
    supabase.rpc('increment_usage', { license_key: req.licenseKey }).catch(() => {});

    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/vision ─────────────────────────────────────────────────────
router.post('/vision', requireActiveLicense, async (req, res) => {
  const { images, question = 'What do you see?', language = 'javascript' } = req.body;

  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Images array required' });
  }

  const imageParts = images.map(img => ({
    inlineData: {
      mimeType: 'image/jpeg',
      data: img.replace(/^data:image\/\w+;base64,/, ''),
    },
  }));

  const body = {
    contents: [{
      role: 'user',
      parts: [
        ...imageParts,
        { text: question },
      ],
    }],
    systemInstruction: {
      parts: [{ text: buildSystemPrompt('explain', language) }],
    },
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  };

  try {
    const url = `${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${req.geminiApiKey}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini error: ${errText}` });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    supabase.rpc('increment_usage', { license_key: req.licenseKey }).catch(() => {});
    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/stream ─────────────────────────────────────────────────────
router.post('/stream', requireActiveLicense, async (req, res) => {
  const { message, history = [], command = 'general', language = 'javascript' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const sysPrompt = buildSystemPrompt(command, language);
  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: sysPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const url = `${GEMINI_BASE}/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${req.geminiApiKey}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!geminiRes.ok) {
      res.write(`data: ${JSON.stringify({ error: 'Gemini request failed' })}\n\n`);
      return res.end();
    }

    geminiRes.body.on('data', chunk => {
      try { res.write(chunk); } catch (e) {}
    });
    geminiRes.body.on('end', () => {
      supabase.rpc('increment_usage', { license_key: req.licenseKey }).catch(() => {});
      res.end();
    });
    geminiRes.body.on('error', () => res.end());
    req.on('close', () => geminiRes.body.destroy());
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── Admin: Key Pool Status (now shows per-license info) ─────────────────────
router.get('/keys/status', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('licenses')
    .select('key, user_email, active, gemini_api_key')
    .order('created_at', { ascending: false });

  const keys = (data || []).map(l => ({
    licenseKey: l.key,
    userEmail: l.user_email,
    active: l.active,
    hasGeminiKey: !!l.gemini_api_key,
    keyPreview: l.gemini_api_key ? '...' + l.gemini_api_key.slice(-8) : 'NOT SET',
  }));

  res.json({ totalLicenses: keys.length, keys });
});

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(command, language = 'javascript') {
  const base = `You are HaimuAI, an expert coding assistant. Be concise, accurate, and helpful. Default language: ${language}.`;
  const prompts = {
    explain: `${base} Explain code clearly with examples. Break down complex concepts step by step.`,
    debug: `${base} Find and fix bugs. Explain root cause clearly. Provide corrected code.`,
    generate: `${base} Generate clean, well-commented, production-ready code. Follow best practices.`,
    practice: `${base} Create practice problems and interview questions. Give hints before full solutions.`,
    general: base,
  };
  return prompts[command] || base;
}

module.exports = router;
