const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, persist } = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

const parse = row => row ? { ...row,
  visitNotes: safeJSON(row.visit_notes, []),
  visitCount: row.visit_count,
  convertedBy: row.converted_by,
  reminderSentDate: row.reminder_sent_date,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

router.get('/', (req, res) => {
  res.json(all('SELECT * FROM entries ORDER BY created_at DESC').map(parse));
});

router.get('/:id', (req, res) => {
  const e = get('SELECT * FROM entries WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json(parse(e));
});

router.post('/', (req, res) => {
  const e = req.body; const id = uuidv4();
  run(`INSERT INTO entries (id,date,visit,company,client,client2,phone,phone2,address,remarks,
    followup,followup2,converted,converted_by,sample,grade,agent,visit_count,visit_notes,reminder_sent_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, e.date||'', e.visit||'No', e.company||'', e.client||'', e.client2||'',
     e.phone||'', e.phone2||'', e.address||'', e.remarks||'',
     e.followup||'', e.followup2||'', e.converted||'No', e.convertedBy||'',
     e.sample||'No', e.grade||'', e.agent||'', e.visitCount||0,
     JSON.stringify(e.visitNotes||[]), e.reminderSentDate||'', req.user.id]);
  if (e.converted === 'Yes') syncClient({ ...e, id });
  persist();
  res.status(201).json({ id });
});

router.put('/:id', (req, res) => {
  const e = req.body;
  run(`UPDATE entries SET date=?,visit=?,company=?,client=?,client2=?,phone=?,phone2=?,
    address=?,remarks=?,followup=?,followup2=?,converted=?,converted_by=?,sample=?,
    grade=?,agent=?,visit_count=?,visit_notes=?,reminder_sent_date=?,updated_at=datetime('now')
    WHERE id=?`,
    [e.date||'', e.visit||'No', e.company||'', e.client||'', e.client2||'',
     e.phone||'', e.phone2||'', e.address||'', e.remarks||'',
     e.followup||'', e.followup2||'', e.converted||'No', e.convertedBy||'',
     e.sample||'No', e.grade||'', e.agent||'', e.visitCount||0,
     JSON.stringify(e.visitNotes||[]), e.reminderSentDate||'', req.params.id]);
  if (e.converted === 'Yes') syncClient({ ...e, id: req.params.id });
  persist();
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  run('DELETE FROM entries WHERE id = ?', [req.params.id]);
  persist();
  res.json({ message: 'Deleted' });
});

router.delete('/', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  ids.forEach(id => run('DELETE FROM entries WHERE id = ?', [id]));
  persist();
  res.json({ message: `Deleted ${ids.length}` });
});

function syncClient(e) {
  const existing = get('SELECT id FROM clients WHERE entry_id = ?', [e.id]);
  if (!existing) {
    run(`INSERT INTO clients (id,company,client,phone,address,grade,entry_id,source) VALUES (?,?,?,?,?,?,?,'entry')`,
      [uuidv4(), e.company||'', e.client||'', e.phone||'', e.address||'', e.grade||'', e.id]);
  }
}
function safeJSON(s, f) { try { return JSON.parse(s); } catch { return f; } }

module.exports = router;
