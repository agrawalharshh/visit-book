// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/init');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function logAttempt(username, success, reason, req) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    db.prepare(`INSERT INTO login_audit_log (username, success, ip_address, reason) VALUES (?, ?, ?, ?)`)
      .run(username, success ? 1 : 0, String(ip).slice(0, 100), reason);
  } catch (e) { /* logging failure should never block login */ }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) {
    logAttempt(username, false, 'no_such_user', req);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!user.active) {
    logAttempt(username, false, 'account_inactive', req);
    return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
  }

  // Account lockout — blocks brute-force password guessing
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until.replace(' ', 'T') + 'Z');
    if (lockedUntil > new Date()) {
      const minsLeft = Math.ceil((lockedUntil - new Date()) / 60000);
      logAttempt(username, false, 'account_locked', req);
      return res.status(423).json({ error: `Too many failed attempts. Try again in ${minsLeft} minute(s).` });
    }
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    const newCount = (user.failed_login_count || 0) + 1;
    if (newCount >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?`).run(newCount, lockUntil, user.id);
      logAttempt(username, false, 'locked_out_now', req);
      return res.status(423).json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
    }
    db.prepare(`UPDATE users SET failed_login_count = ? WHERE id = ?`).run(newCount, user.id);
    logAttempt(username, false, 'wrong_password', req);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Successful login — reset lockout counters, record last login
  db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  logAttempt(username, true, 'success', req);

  // Defensive fallback: `name` should always be set, but if a row's name is ever
  // missing or empty (e.g. data imported from elsewhere under a different column),
  // fall back to the username rather than showing a blank/null name in the UI —
  // this is what previously caused the user avatar to show "?" with no name at all.
  const displayName = (user.name && String(user.name).trim()) || user.username;

  const token = jwt.sign({ id: user.id, username: user.username, name: displayName, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({
    token,
    user: { id: user.id, name: displayName, username: user.username, role: user.role, must_change_password: !!user.must_change_password },
  });
});

router.post('/change-password', (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) return res.status(401).json({ error: 'Old password incorrect' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(hash, user.id);
  res.json({ success: true });
});

// Lets the currently logged-in user (ANY role) verify their own current account
// data — role, active status, must_change_password — straight from the database,
// rather than trusting whatever got cached in the browser at login time. Used on
// every app boot so a stale localStorage entry (e.g. from before roles existed,
// or after an admin changed someone's role) can never cause silent, unexplained
// permission failures again.
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, username, role, active, must_change_password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Account not found — it may have been removed.' });
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated.' });
  const displayName = (user.name && String(user.name).trim()) || user.username;
  res.json({ id: user.id, name: displayName, username: user.username, role: user.role, must_change_password: !!user.must_change_password });
});

module.exports = router;
