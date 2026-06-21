// routes/waDefaults.js — per-page WhatsApp send presets, set once in Settings,
// auto-applied everywhere so the person sending never has to pick a template or
// type a number on every single send.
const express = require('express');
const db = require('../db/init');

const router = express.Router();

const VALID_PAGES = ['visit_clients', 'active_clients', 'meetings', 'followups', 'swa_move', 'swa_individual'];

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM wa_page_defaults').all();
  const out = {};
  for (const page of VALID_PAGES) {
    const row = rows.find(r => r.page_key === page);
    out[page] = row ? {
      template_name: row.template_name,
      language: row.language,
      variable_mapping: row.variable_mapping_json ? JSON.parse(row.variable_mapping_json) : {},
      default_number: row.default_number,
    } : null;
  }
  res.json(out);
});

router.get('/:page', (req, res) => {
  const { page } = req.params;
  if (!VALID_PAGES.includes(page)) return res.status(400).json({ error: 'Unknown page key' });
  const row = db.prepare('SELECT * FROM wa_page_defaults WHERE page_key = ?').get(page);
  if (!row) return res.json(null);
  res.json({
    template_name: row.template_name,
    language: row.language,
    variable_mapping: row.variable_mapping_json ? JSON.parse(row.variable_mapping_json) : {},
    default_number: row.default_number,
  });
});

router.post('/:page', (req, res) => {
  const { page } = req.params;
  if (!VALID_PAGES.includes(page)) return res.status(400).json({ error: 'Unknown page key' });
  const { template_name, language, variable_mapping, default_number } = req.body;
  if (!template_name) return res.status(400).json({ error: 'template_name required' });

  db.prepare(`INSERT INTO wa_page_defaults (page_key, template_name, language, variable_mapping_json, default_number, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(page_key) DO UPDATE SET
      template_name = excluded.template_name, language = excluded.language,
      variable_mapping_json = excluded.variable_mapping_json, default_number = excluded.default_number,
      updated_at = datetime('now')`)
    .run(page, template_name, language || 'en', JSON.stringify(variable_mapping || {}), default_number || null);

  res.json({ success: true });
});

router.delete('/:page', (req, res) => {
  db.prepare('DELETE FROM wa_page_defaults WHERE page_key = ?').run(req.params.page);
  res.json({ success: true });
});

module.exports = router;
