// routes/users.js — admin-only user management (create staff accounts, assign roles)
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { ROLES } = require('../middleware/auth');

const router = express.Router();

function sanitizeUser(u) {
  if (!u) return u;
  const { password_hash, failed_login_count, locked_until, ...safe } = u;
  return { ...safe, is_locked: !!(locked_until && new Date(locked_until.replace(' ', 'T') + 'Z') > new Date()) };
}

router.get('/', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY active DESC, name ASC').all();
  res.json(users.map(sanitizeUser));
});

router.get('/roles', (req, res) => {
  res.json(ROLES.map(r => ({
    value: r,
    label: { admin: 'Admin', data_entry: 'Data Entry', crm: 'CRM', mis: 'MIS', ea: 'E.A.' }[r] || r,
  })));
});

router.post('/', (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, username, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'That username is already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users (name, username, password_hash, role, created_by, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1)`).run(name.trim(), username.trim(), hash, role, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(sanitizeUser(user));
});

router.put('/:id', (req, res) => {
  const { name, role, active } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Guard rail: never allow the last active admin account to be demoted or deactivated —
  // that would lock everyone out of Settings/user management permanently with no recovery path.
  if (target.role === 'admin' && (role !== undefined && role !== 'admin' || active === false || active === 0)) {
    const otherActiveAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(req.params.id).c;
    if (otherActiveAdmins === 0) {
      return res.status(400).json({ error: 'Cannot remove admin rights or deactivate the last active admin account.' });
    }
  }

  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });

  db.prepare(`UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?`)
    .run(name, role, active === undefined ? undefined : (active ? 1 : 0), req.params.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  res.json(sanitizeUser(user));
});

// Admin resets someone else's password (e.g. they forgot it) — forces a change on next login
router.post('/:id/reset-password', (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(hash, req.params.id);
  res.json({ success: true });
});

// Manually unlock an account before its automatic lockout window expires
router.post('/:id/unlock', (req, res) => {
  db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const otherActiveAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(req.params.id).c;
    if (otherActiveAdmins === 0) return res.status(400).json({ error: 'Cannot delete the last active admin account.' });
  }
  // Soft-delete (deactivate) rather than hard-delete — preserves audit trail / history
  // attribution (e.g. who created which visit logs) instead of breaking it.
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/login-audit', (req, res) => {
  const { username, limit } = req.query;
  let sql = 'SELECT * FROM login_audit_log WHERE 1=1';
  const params = [];
  if (username) { sql += ' AND username = ?'; params.push(username); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(parseInt(limit) || 100);
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
