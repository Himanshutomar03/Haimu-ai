const express = require('express');
const fetch = require('node-fetch');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Server-level Gemini key pool (from GEMINI_API_KEYS env var) ──────────────
// Comma-separated list: KEY1,KEY2,KEY3
// Keys rotate round-robin. On quota error they cool down for 1 hour.
const _rawKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const serverKeys = _rawKeys.map(k => ({ key: k, cooledUntil: 0 }));
let _keyIdx = 0;

function getActiveKey() {
  const now = Date.now();
  // Try up to N keys to find one not in cooldown
  for (let i = 0; i < serverKeys.length; i++) {
    const entry = serverKeys[(_keyIdx + i) % serverKeys.length];
    if (entry.cooledUntil <= now) {
      _keyIdx = (_keyIdx + i + 1) % serverKeys.length;
      return entry.key;
    }
  }
  // All keys in cooldown — use first one anyway (best effort)
  _keyIdx = (_keyIdx + 1) % serverKeys.length;
  return serverKeys[(_keyIdx - 1 + serverKeys.length) % serverKeys.length]?.key || null;
}

function cooldownKey(key) {
  const entry = serverKeys.find(e => e.key === key);
  if (entry) entry.cooledUntil = Date.now() + 60 * 60 * 1000; // 1 hour cooldown
}

// ─── Helper: call Gemini with key rotation on quota errors ────────────────────
async function geminiWithFallback(endpoint, body) {
  const tried = new Set();

  for (let i = 0; i < serverKeys.length; i++) {
    const key = getActiveKey();
    if (!key) break;
    if (tried.has(key)) continue;
    tried.add(key);

    const url = `${GEMINI_BASE}/${endpoint}?key=${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Quota/rate-limit → cool down this key and try next
    if (response.status === 429 || (response.status === 403 && i < serverKeys.length - 1)) {
      console.warn(`[KeyPool] Key quota hit (${response.status}). Cooling down and rotating.`);
      cooldownKey(key);
      continue;
    }
    return response;
  }

  return null; // all keys failed
}

// ─── Helper: parse client messages array into { message, history } ────────────
function parseMessages(body) {
  const msgs = body.messages || [];
  if (msgs.length === 0) {
    return { message: body.message || '', history: body.history || [] };
  }
  const last = msgs[msgs.length - 1];
  const message = last?.content || '';
  const history = msgs.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  return { message, history };
}

// ─── POST /api/ai/chat ────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
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
    const geminiRes = await geminiWithFallback('gemini-2.5-flash:generateContent', geminiBody);
    if (!geminiRes) {
      return res.status(503).json({ error: 'All API keys are temporarily exhausted. Try again in a moment.' });
    }
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini error: ${errText}` });
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/vision ──────────────────────────────────────────────────────
router.post('/vision', async (req, res) => {
  const { language = 'javascript', systemPrompt } = req.body;

  let images, question;
  if (req.body.imageBase64) {
    images = [req.body.imageBase64];
    question = req.body.prompt || 'What do you see?';
  } else if (req.body.images && Array.isArray(req.body.images)) {
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
    const geminiRes = await geminiWithFallback('gemini-2.5-flash:generateContent', geminiBody);
    if (!geminiRes) return res.status(503).json({ error: 'All API keys exhausted.' });
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: errText });
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/stream ──────────────────────────────────────────────────────
router.post('/stream', async (req, res) => {
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

  const key = getActiveKey();
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
    geminiRes.body.on('end', () => res.end());
    geminiRes.body.on('error', () => res.end());
    req.on('close', () => geminiRes.body.destroy());
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── POST /api/ai/transcribe ─────────────────────────────────────────────────
router.post('/transcribe', async (req, res) => {
  const { audioBase64, mimeType = 'audio/webm' } = req.body;

  if (!audioBase64) {
    return res.status(400).json({ error: 'audioBase64 is required' });
  }

  const body = {
    contents: [{
      parts: [
        { text: 'Transcribe this audio accurately. Return ONLY the spoken words, nothing else. If no speech is detected return an empty string.' },
        { inline_data: { mime_type: mimeType, data: audioBase64 } }
      ]
    }],
    generationConfig: { temperature: 0 }
  };

  try {
    const geminiRes = await geminiWithFallback('gemini-2.5-flash:generateContent', body);
    if (!geminiRes) {
      return res.status(503).json({ error: 'All API keys are temporarily exhausted. Try again in a moment.' });
    }
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: `Gemini transcription error: ${errText}` });
    }
    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.json({ text: text.trim() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ai/keys/status (Admin only) ────────────────────────────────────
router.get('/keys/status', requireAdmin, (req, res) => {
  const now = Date.now();
  res.json({
    totalKeys: serverKeys.length,
    keys: serverKeys.map((e, i) => ({
      index: i,
      keyPreview: e.key.slice(0, 8) + '...',
      status: e.cooledUntil > now ? 'cooldown' : 'active',
      cooledUntilMs: e.cooledUntil > now ? e.cooledUntil : null,
    })),
  });
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
