const jwt = require('jsonwebtoken');

/**
 * Middleware: Verify the x-license-token header is a valid JWT.
 * Attaches decoded payload to req.licensePayload.
 */
function requireLicenseToken(req, res, next) {
  const token = req.headers['x-license-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing license token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.licensePayload = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired license token' });
  }
}

/**
 * Middleware: Simple password-based admin auth via Authorization header.
 * Expected: Authorization: Bearer <ADMIN_PASSWORD>
 */
function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const password = auth.replace('Bearer ', '').trim();
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Admin access denied' });
  }
  next();
}

module.exports = { requireLicenseToken, requireAdmin };
