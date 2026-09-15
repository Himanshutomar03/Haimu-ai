const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── POST /api/license/validate ─────────────────────────────────────────────
router.post('/validate', async (req, res) => {
  const { key, hwid } = req.body;
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ valid: false, error: 'License key is required' });
  }

  const normalizedKey = key.trim().toUpperCase();

  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', normalizedKey)
    .single();

  if (error || !license) {
    return res.status(404).json({ valid: false, error: 'License key not found' });
  }
  if (!license.active) {
    return res.status(403).json({ valid: false, error: 'License has been revoked' });
  }
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.status(403).json({ valid: false, error: 'License has expired' });
  }
  if (license.hwid && hwid && license.hwid !== hwid) {
    return res.status(403).json({ valid: false, error: 'License is locked to a different machine' });
  }

  if (!license.hwid && hwid) {
    await supabase.from('licenses').update({ hwid, last_seen: new Date().toISOString() }).eq('key', normalizedKey);
  } else {
    await supabase.from('licenses').update({ last_seen: new Date().toISOString() }).eq('key', normalizedKey);
  }

  const token = jwt.sign(
    { licenseKey: normalizedKey, plan: license.plan, userEmail: license.user_email },
    process.env.JWT_SECRET,
    { expiresIn: '25h' }
  );

  return res.json({ valid: true, token, plan: license.plan, userEmail: license.user_email, userName: license.user_name });
});

// ─── GET /api/license/heartbeat ──────────────────────────────────────────────
router.get('/heartbeat', async (req, res) => {
  const token = req.headers['x-license-token'];
  if (!token) return res.json({ active: false, reason: 'No token' });

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.json({ active: false, reason: 'Token expired or invalid' }); }

  const { data: license } = await supabase
    .from('licenses')
    .select('active, expires_at')
    .eq('key', payload.licenseKey)
    .single();

  if (!license || !license.active) return res.json({ active: false, reason: 'License revoked' });
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.json({ active: false, reason: 'License expired' });
  }

  await supabase.from('licenses').update({
    last_seen: new Date().toISOString(),
    usage_count: (license.usage_count || 0) + 1,
  }).eq('key', payload.licenseKey);

  const newToken = jwt.sign(
    { licenseKey: payload.licenseKey, plan: payload.plan, userEmail: payload.userEmail },
    process.env.JWT_SECRET,
    { expiresIn: '25h' }
  );

  return res.json({ active: true, token: newToken });
});

// ─── POST /api/license/create ────────────────────────────────────────────────
// Admin: Create a new license key
router.post('/create', requireAdmin, async (req, res) => {
  const { userEmail, userName, plan = 'basic', expiresAt } = req.body;

  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  const key = `HAIMU-${segment()}-${segment()}-${segment()}`;

  const { data, error } = await supabase
    .from('licenses')
    .insert({ key, user_email: userEmail || null, user_name: userName || null, plan, expires_at: expiresAt || null, active: true })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, license: data });
});

// ─── POST /api/license/revoke ────────────────────────────────────────────────
router.post('/revoke', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const { error } = await supabase.from('licenses').update({ active: false }).eq('key', key.trim().toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `License ${key} revoked. App will shut down within 30 seconds.` });
});

// ─── POST /api/license/restore ───────────────────────────────────────────────
router.post('/restore', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const { error } = await supabase.from('licenses').update({ active: true }).eq('key', key.trim().toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `License ${key} restored.` });
});

// ─── GET /api/license/list ───────────────────────────────────────────────────
router.get('/list', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // For each license, also count how many API keys it has
  const keys = await supabase
    .from('license_api_keys')
    .select('license_key, id')
    .eq('active', true);

  const keyCounts = {};
  (keys.data || []).forEach(k => {
    keyCounts[k.license_key] = (keyCounts[k.license_key] || 0) + 1;
  });

  const result = (data || []).map(l => ({
    ...l,
    api_key_count: keyCounts[l.key] || 0,
  }));

  return res.json({ licenses: result });
});

// ─── POST /api/license/reset-hwid ───────────────────────────────────────────
router.post('/reset-hwid', requireAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const { error } = await supabase.from('licenses').update({ hwid: null }).eq('key', key.trim().toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: `HWID reset for ${key}.` });
});

// ════════════════════════════════════════════════════════════════════════════
// PER-LICENSE API KEY MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /api/license/api-keys/:licenseKey ───────────────────────────────────
// Admin: List all Gemini API keys for a specific license
router.get('/api-keys/:licenseKey', requireAdmin, async (req, res) => {
  const licenseKey = req.params.licenseKey.trim().toUpperCase();

  const { data, error } = await supabase
    .from('license_api_keys')
    .select('id, label, api_key, active, created_at')
    .eq('license_key', licenseKey)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // Mask the key — show only last 8 chars
  const masked = (data || []).map(k => ({
    ...k,
    api_key_masked: '...' + k.api_key.slice(-8),
  }));

  return res.json({ licenseKey, keys: masked });
});

// ─── POST /api/license/api-keys ─────────────────────────────────────────────
// Admin: Add a Gemini API key to a license
router.post('/api-keys', requireAdmin, async (req, res) => {
  const { licenseKey, apiKey, label } = req.body;

  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' });
  if (!apiKey || apiKey.trim().length < 10) return res.status(400).json({ error: 'Valid Gemini API key required' });

  const normalizedKey = licenseKey.trim().toUpperCase();

  // Verify license exists
  const { data: license } = await supabase.from('licenses').select('key').eq('key', normalizedKey).single();
  if (!license) return res.status(404).json({ error: 'License not found' });

  const { data, error } = await supabase
    .from('license_api_keys')
    .insert({
      license_key: normalizedKey,
      api_key: apiKey.trim(),
      label: label || `Key ${Date.now()}`,
      active: true,
    })
    .select('id, label, active, created_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, key: data });
});

// ─── DELETE /api/license/api-keys/:id ───────────────────────────────────────
// Admin: Remove a specific API key from a license
router.delete('/api-keys/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('license_api_keys').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─── PATCH /api/license/api-keys/:id ────────────────────────────────────────
// Admin: Enable/disable a specific API key
router.patch('/api-keys/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { active, label } = req.body;
  const update = {};
  if (active !== undefined) update.active = active;
  if (label !== undefined) update.label = label;

  const { error } = await supabase.from('license_api_keys').update(update).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

module.exports = router;
