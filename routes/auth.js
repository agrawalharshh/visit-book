const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, persist } = require('../models/db');
const { authenticate, adminOnly } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = get('SELECT * FROM users WHERE username = ?', [username.trim()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

router.put('/password', authenticate, (req, res) => {
  const { current, newPassword } = req.body;
  if (!current || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user || !bcrypt.compareSync(current, user.password_hash))
    return res.status(401).json({ error: 'Current password incorrect' });
  run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
    [bcrypt.hashSync(newPassword, 10), req.user.id]);
  persist();
  res.json({ message: 'Password updated' });
});

router.get('/users', authenticate, adminOnly, (req, res) => {
  res.json(all('SELECT id, username, role, created_at FROM users'));
});

router.post('/users', authenticate, adminOnly, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const exists = get('SELECT id FROM users WHERE username = ?', [username]);
  if (exists) return res.status(409).json({ error: 'Username already exists' });
  const id = uuidv4();
  run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
    [id, username.trim(), bcrypt.hashSync(password, 10), role || 'user']);
  persist();
  res.status(201).json({ id, username, role: role || 'user' });
});

router.delete('/users/:id', authenticate, adminOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  run('DELETE FROM users WHERE id = ?', [req.params.id]);
  persist();
  res.json({ message: 'User deleted' });
});

module.exports = router;
