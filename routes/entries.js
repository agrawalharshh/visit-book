const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const parse = row => !row ? null : {
  ...row,
  visitNotes:       safeJSON(row.visit_notes, []),
  visitCount:       row.visit_count,
  convertedBy:      row.converted_by,
  reminderSentDate: row.reminder_sent_date,
  createdBy:        row.created_by,
  createdAt:        row.created_at,
  updatedAt:        row.updated_at,
};

router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM entries ORDER BY created_at DESC');
    res.json(rows.map(parse));
  } catch(e) { res.status(500).json({ error: 'Failed to load entries' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const e = await get('SELECT * FROM entries WHERE id = ?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(parse(e));
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

router.post('/', async (req, res) => {
  try {
    const e = req.body; const id = uuidv4();
    await run(`INSERT INTO entries (id,date,visit,company,client,client2,phone,phone2,address,remarks,
      followup,followup2,converted,converted_by,sample,grade,agent,visit_count,visit_notes,reminder_sent_date,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, e.date||'', e.visit||'No', e.company||'', e.client||'', e.client2||'',
       e.phone||'', e.phone2||'', e.address||'', e.remarks||'',
       e.followup||'', e.followup2||'', e.converted||'No', e.convertedBy||'',
       e.sample||'No', e.grade||'', e.agent||'', e.visitCount||0,
       JSON.stringify(e.visitNotes||[]), e.reminderSentDate||'', req.user.id]);
    if (e.converted === 'Yes') await syncClient({ ...e, id });
    res.status(201).json({ id });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Failed to save entry' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const e = req.body;
    await run(`UPDATE entries SET date=?,visit=?,company=?,client=?,client2=?,phone=?,phone2=?,
      address=?,remarks=?,followup=?,followup2=?,converted=?,converted_by=?,sample=?,
      grade=?,agent=?,visit_count=?,visit_notes=?,reminder_sent_date=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`,
      [e.date||'', e.visit||'No', e.company||'', e.client||'', e.client2||'',
       e.phone||'', e.phone2||'', e.address||'', e.remarks||'',
       e.followup||'', e.followup2||'', e.converted||'No', e.convertedBy||'',
       e.sample||'No', e.grade||'', e.agent||'', e.visitCount||0,
       JSON.stringify(e.visitNotes||[]), e.reminderSentDate||'', req.params.id]);
    if (e.converted === 'Yes') await syncClient({ ...e, id: req.params.id });
    res.json({ message: 'Updated' });
  } catch(e) { res.status(500).json({ error: 'Failed to update' }); }
});

router.delete('/:id', async (req, res) => {
  try { await run('DELETE FROM entries WHERE id = ?', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch(e) { res.status(500).json({ error: 'Failed' }); }
});

router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
    for (const id of ids) await run('DELETE FROM entries WHERE id = ?', [id]);
    res.json({ message: `Deleted ${ids.length}` });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

async function syncClient(e) {
  const existing = await get('SELECT id FROM clients WHERE entry_id = ?', [e.id]);
  if (!existing) {
    await run(`INSERT INTO clients (id,company,client,phone,address,grade,entry_id,source) VALUES (?,?,?,?,?,?,?,'entry')`,
      [uuidv4(), e.company||'', e.client||'', e.phone||'', e.address||'', e.grade||'', e.id]);
  }
}
function safeJSON(s, f) { try { return JSON.parse(s); } catch { return f; } }

module.exports = router;
