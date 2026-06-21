// routes/backup.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Triggers an immediate backup snapshot and streams the current database file
// down as a downloadable .sqlite — the "Download Backup" button in Settings.
router.get('/download', (req, res) => {
  try {
    const buffer = db.forceBackup();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="visitbook-backup-${stamp}.sqlite"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// Lists backup snapshots already on disk (the automatic rolling ones)
router.get('/list', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const dir = path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'db', 'visitbook.sqlite')), 'backups');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, created_at: stat.mtime };
      })
      .sort((a, b) => b.created_at - a.created_at);
    res.json(files);
  } catch (err) {
    res.json([]); // no backups directory yet is not an error condition
  }
});

module.exports = router;
