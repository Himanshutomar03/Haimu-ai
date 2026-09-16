const express = require('express');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { requireAdmin } = require('../middleware/auth');
const supabase = require('../db/supabase');

const router = express.Router();
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Per-license key cache ────────────────────────────────────────────────────
// licenseKey -> { keys: [string], idx: number, active: bool, cachedAt: number }
const licenseCache = new Map();
const CACHE_TTL_MS = 45 * 1000; // 45 seconds — revoke propagates within this time

async function getLicenseData(licenseKey) {
  const cached = licenseCache.get(licenseKey);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached;
  }

  // Fetch license status + all its active Gemini API keys in parallel
  const [licenseRes, keysRes] = await Promise.all([
    supabase.from('licenses').select('active, expires_at').eq('key', licenseKey).single(),
    supabase.from('license_api_keys').select('api_key').eq('license_key', licenseKey).eq('active', true),
  ]);

  if (licenseRes.error || !licenseRes.data) return null;

  const info = {
    active: licenseRes.data.active,
    expires_at: licenseRes.data.expires_at,
    keys: (keysRes.data || []).map(k => k.api_key),
    idx: (cached?.idx || 0) % Math.max((keysRes.data || []).length, 1),
    cachedAt: Date.now(),
  };

  licenseCache.set(licenseKey, info);
  return info;
}

function invalidateLicenseCache(licenseKey) {
  licenseCache.delete(licenseKey);
}

// Pick next key from the pool (round-robin)
function pickKey(info) {
  if (!info.keys || info.keys.length === 0) return null;
  const key = info.keys[info.idx % info.keys.length];
  info.idx = (info.idx + 1) % info.keys.length;
  return key;
}

// ─── Middleware: validate token + check live license + get keys ───────────────
async function requireActiveLicense(req, res, next) {
  const token = req.headers['x-license-token'];
  if (!token) return res.status(401).json({ error: 'No license token', revoked: true });

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token expired or invalid', revoked: true }); }

  const info = await getLicenseData(payload.licenseKey);

  if (!info) return res.status(401).json({ error: 'License not found', revoked: true });

  if (!info.active) {
    invalidateLicenseCache(payload.licenseKey);
    return res.status(401).json({ error: 'License revoked', revoked: true });
  }

  if (info.expires_at && new Date(info.expires_at) < new Date()) {
    return res.status(401).json({ error: 'License expired', revoked: true });
  }

  if (info.keys.length === 0) {
    return res.status(402).json({
      error: 'No Gemini API keys assigned to your license. Contact the administrator.',
      revoked: false,
    });
  }

  req.licenseKey = payload.licenseKey;
  req.licenseInfo = info;
  next();
}

// ─── Helper: call Gemini with key rotation on 429/quota errors ────────────────
async function geminiWithFallback(endpoint, body, licenseInfo) {
  const tried = new Set();
  const allKeys = [...licenseInfo.keys];

  for (let i = 0; i < allKeys.length; i++) {
    const key = pickKey(licenseInfo);
    if (tried.has(key)) continue;
    tried.add(key);

    const url = `${GEMINI_BASE}/${endpoint}?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // If quota/rate limit — try next key
    if (response.status === 429 || (response.status === 403 && i < allKeys.length - 1)) {
      continue;
    }
    return response;
  }

  // All keys failed
  return null;
}

// ─── Helper: parse client messages array into { message, history } ────────────
// Client sends: { messages: [{role, content}, ...], systemPrompt, model }
// The last item is the current user message; everything before is history.
function parseMessages(body) {
  const msgs = body.messages || [];

  // Fallback: client may also send legacy { message, history } format
  if (msgs.length === 0) {
    return { message: body.message || '', history: body.history || [] };
  }

  const last = msgs[msgs.length - 1];
  const message = last?.content || '';
  const history = msgs.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  return { message, history };
}

// ─── POST /api/ai/chat ────────────────────────────────────────────────────────
router.post('/chat', requireActiveLicense, async (req, res) => {
  const { message, history } = parseMessages(req.body);
  const { command = 'general', language = 'javascript', systemPrompt } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const sysPrompt = systemPrompt || buildSystemPrompt(command, language);
  const contents = [
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const geminiBody = {
    contents,
    systemInstruction: { parts: [{ text: sysPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };

  try {
    const geminiRes = await geminiWithFallback('gemini-2.5-flash:generateContent', geminiBody, req.licenseInfo);

    if (!geminiRes) {
      return res.status(503).json({ error: 'All API keys are temporarily exhausted. Try again in a moment.' });
    }
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

// ─── POST /api/ai/vision ──────────────────────────────────────────────────────
// Accepts new client format: { imageBase64, prompt, messages, systemPrompt, model }
// Also supports legacy format: { images: [...], question, language }
router.post('/vision', requireActiveLicense, async (req, res) => {
  const { language = 'javascript', systemPrompt } = req.body;

  // Resolve image(s) and question from either client format
  let images, question;

  if (req.body.imageBase64) {
    // New format from ai-chat.js: single base64 string + prompt text
    images = [req.body.imageBase64];
    question = req.body.prompt || 'What do you see?';
  } else if (req.body.images && Array.isArray(req.body.images)) {
    // Legacy format
    images = req.body.images;
    question = req.body.question || 'What do you see?';
  } else {
    return res.status(400).json({ error: 'imageBase64 or images array required' });
  }

  if (images.length === 0) {
    return res.status(400).json({ error: 'No images provided' });
  }

  const imageParts = images.map(img => ({
    inlineData: { mimeType: 'image/jpeg', data: img.replace(/^data:image\/\w+;base64,/, '') },
  }));

  // Include recent conversation context if provided
  const historyContents = (req.body.messages || []).slice(-6).map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));

  const geminiBody = {
    contents: [
      ...historyContents,
      { role: 'user', parts: [...imageParts, { text: question }] },
    ],
    systemInstruction: { parts: [{ text: systemPrompt || buildSystemPrompt('explain', language) }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  };

  try {
    const geminiRes = await geminiWithFallback('gemini-2.5-flash:generateContent', geminiBody, req.licenseInfo);
    if (!geminiRes) return res.status(503).json({ error: 'All API keys exhausted.' });
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: errText });
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    supabase.rpc('increment_usage', { license_key: req.licenseKey }).catch(() => {});
    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/stream ──────────────────────────────────────────────────────
router.post('/stream', requireActiveLicense, async (req, res) => {
  const { message, history } = parseMessages(req.body);
  const { command = 'general', language = 'javascript', systemPrompt } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const sysPrompt = systemPrompt || buildSystemPrompt(command, language);
  const contents = [
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const geminiBody = {
    contents,
    systemInstruction: { parts: [{ text: sysPrompt }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const key = pickKey(req.licenseInfo);
  if (!key) {
    res.write(`data: ${JSON.stringify({ error: 'No API keys available' })}\n\n`);
    return res.end();
  }

  try {
    const url = `${GEMINI_BASE}/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${key}`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!geminiRes.ok) {
      res.write(`data: ${JSON.stringify({ error: 'Gemini request failed' })}\n\n`);
      return res.end();
    }
    geminiRes.body.on('data', chunk => { try { res.write(chunk); } catch (e) {} });
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

// ─── Admin: License key pool status ──────────────────────────────────────────
router.get('/keys/status', requireAdmin, async (req, res) => {
  const { data: licenses } = await supabase
    .from('licenses')
    .select('key, user_email, active')
    .order('created_at', { ascending: false });

  const { data: apiKeys } = await supabase
    .from('license_api_keys')
    .select('license_key, id, active');

  const keyCounts = {};
  (apiKeys || []).forEach(k => {
    if (!keyCounts[k.license_key]) keyCounts[k.license_key] = { total: 0, active: 0 };
    keyCounts[k.license_key].total++;
    if (k.active) keyCounts[k.license_key].active++;
  });

  const keys = (licenses || []).map(l => ({
    licenseKey: l.key,
    userEmail: l.user_email,
    active: l.active,
    apiKeyCount: keyCounts[l.key]?.active || 0,
    apiKeyTotal: keyCounts[l.key]?.total || 0,
  }));

  res.json({ totalLicenses: keys.length, keys });
});

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(command, language = 'javascript') {
  const base = `You are HaimuAI, an expert coding assistant. Be concise, accurate, and helpful. Default language: ${language}.`;
  const prompts = {
    explain:  `${base} Explain code clearly with examples. Break down complex concepts step by step.`,
    debug:    `${base} Find and fix bugs. Explain root cause clearly. Provide corrected code.`,
    generate: `${base} Generate clean, well-commented, production-ready code. Follow best practices.`,
    practice: `${base} Create practice problems and interview questions. Give hints before full solutions.`,
    general:  base,
  };
  return prompts[command] || base;
}

module.exports = router;
