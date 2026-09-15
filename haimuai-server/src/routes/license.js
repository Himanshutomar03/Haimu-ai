const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── POST /api/license/validate ─────────────────────────────────────────────
// Called by the Electron app on startup and after entering a license key.
// Validates the key against Supabase, returns a short-lived JWT token.
router.post('/validate', async (req, res) => {
  const { key, hwid } = req.body;

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ valid: false, error: 'License key is required' });
  }

  const normalizedKey = key.trim().toUpperCase();

  // Fetch license from Supabase
  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', normalizedKey)
    .single();

  if (error || !license) {
    return res.status(404).json({ valid: false, error: 'License key not found' });
  }

  // Check if active
  if (!license.active) {
    return res.status(403).json({ valid: false, error: 'License has been revoked' });
  }

  // Check expiry
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ valid: false, error: 'License has expired' });
  }

  // HWID locking: if a HWID is already bound and it's different, reject
  if (license.hwid && hwid && license.hwid !== hwid) {
    return res.status(403).json({ valid: false, error: 'License is locked to a different machine' });
  }

  // Bind HWID on first activation if not already set
  if (!license.hwid && hwid) {
    await supabase
      .from('licenses')
      .update({ hwid, last_seen: new Date().toISOString() })
      .eq('key', normalizedKey);
  } else {
    // Just update last_seen
    await supabase
      .from('licenses')
      .update({ last_seen: new Date().toISOString() })
      .eq('key', normalizedKey);
  }

  // Issue a JWT (24h expiry — renewed on each heartbeat)
  const token = jwt.sign(
    {
      licenseKey: normalizedKey,
      plan: license.plan,
      userEmail: license.user_email,
    },
    process.env.JWT_SECRET,
    { expiresIn: '25h' } // slightly longer than heartbeat window
  );

  return res.json({
    valid: true,
    token,
    plan: license.plan,
    userEmail: license.user_email,
    userName: license.user_name,
  });
});

// ─── GET /api/license/heartbeat ──────────────────────────────────────────────
// Called by the app every 5 minutes. Returns { active: false } to kill the app.
router.get('/heartbeat', async (req, res) => {
  const token = req.headers['x-license-token'];
  if (!token) {
    return res.json({ active: false, reason: 'No token' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.json({ active: false, reason: 'Token expired or invalid' });
  }

  // Re-check Supabase for live status (handles real-time revocation)
  const { data: license } = await supabase
    .from('licenses')
    .select('active, expires_at')
    .eq('key', payload.licenseKey)
    .single();

  if (!license || !license.active) {
    return res.json({ active: false, reason: 'License revoked' });
  }

  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.json({ active: false, reason: 'License expired' });
  }

  // Update last_seen + usage_count
  await supabase
    .from('licenses')
    .update({
      last_seen: new Date().toISOString(),
      usage_count: (license.usage_count || 0) + 1,
    })
    .eq('key', payload.licenseKey);

  // Issue a fresh token to extend the session
  const newToken = jwt.sign(
    { licenseKey: payload.licenseKey, plan: payload.plan, userEmail: payload.userEmail },
    process.env.JWT_SECRET,
    { expiresIn: '25h' }
  );

  return res.json({ active: true, token: newToken });
});

// ─── POST /admin/licenses ────────────────────────────────────────────────────
// Admin: Create a new license key
router.post('/create', requireAdmin, async (req, res) => {
  const { userEmail, userName, plan = 'basic', expiresAt, geminiApiKey } = req.body;

  // Gemini API key is REQUIRED
  if (!geminiApiKey || typeof geminiApiKey !== 'string' || geminiApiKey.trim().length < 10) {
    return res.status(400).json({ error: 'A valid Gemini API key is required to create a license.' });
  }

  // Generate key: HAIMU-XXXX-YYYY-ZZZZ
  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  const key = `HAIMU-${segment()}-${segment()}-${segment()}`;

  const { data, error } = await supabase
    .from('licenses')
    .insert({
      key,
      user_email: userEmail || null,
      user_name: userName || null,
      plan,
      expires_at: expiresAt || null,
      active: true,
      gemini_api_key: geminiApiKey.trim(),
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const safeData = { ...data, gemini_api_key: maskApiKey(data.gemini_api_key) };
  return res.json({ success: true, license: safeData });
});

// --- PATCH /api/license/set-gemini-key ---
// Admin: Assign or update Gemini API key for an existing license
router.patch('/set-gemini-key', requireAdmin, async (req, res) => {
  const { key, geminiApiKey } = req.body;
  if (!key) return res.status(400).json({ error: 'License key required' });
  if (!geminiApiKey || geminiApiKey.trim().length < 10) {
    return res.status(400).json({ error: 'Valid Gemini API key required (min 10 chars)' });
  }
  const { error } = await supabase
    .from('licenses')
    .update({ gemini_api_key: geminiApiKey.trim() })
    .eq('key', key.trim().toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `Gemini key updated for ${key}.` });
});


// ─── POST /admin/licenses/revoke ────────────────────────────────────────────
// Admin: Revoke a license (flip active=false)
router.post('/revoke', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });

  const { error } = await supabase
    .from('licenses')
    .update({ active: false })
    .eq('key', key.trim().toUpperCase());

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `License ${key} revoked. App will die within 5 minutes.` });
});

// ─── POST /admin/licenses/restore ───────────────────────────────────────────
// Admin: Re-enable a revoked license
router.post('/restore', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });

  const { error } = await supabase
    .from('licenses')
    .update({ active: true })
    .eq('key', key.trim().toUpperCase());

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `License ${key} restored.` });
});

// ─── GET /admin/licenses/list ────────────────────────────────────────────────
// Admin: Get all licenses
router.get('/list', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Mask gemini_api_key — show only last 8 chars
  const masked = (data || []).map(l => ({
    ...l,
    gemini_api_key: maskApiKey(l.gemini_api_key),
  }));
  return res.json({ licenses: masked });
});

// Helper: mask API key for display (last 8 chars only)
function maskApiKey(key) {
  if (!key) return null;
  return '...' + key.slice(-8);
}


// ─── DELETE /admin/licenses/reset-hwid ──────────────────────────────────────
// Admin: Clear HWID lock (allow user to switch machines)
router.post('/reset-hwid', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });

  const { error } = await supabase
    .from('licenses')
    .update({ hwid: null })
    .eq('key', key.trim().toUpperCase());

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `HWID reset for ${key}. User can activate on a new machine.` });
});

module.exports = router;
