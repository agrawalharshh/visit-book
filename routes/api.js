const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../models/db');
const { authenticate, adminOnly } = require('../middleware/auth');

router.use(authenticate);

const sj = (s,f) => { try { return JSON.parse(s); } catch { return f; } };

/* ── CLIENTS ─────────────────────────────────── */
router.get('/clients', async (req, res) => {
  const rows = await all('SELECT * FROM clients ORDER BY created_at DESC');
  res.json(rows.map(r => ({ ...r, orders: sj(r.orders, []) })));
});
router.post('/clients', async (req, res) => {
  const c=req.body, id=uuidv4();
  await run('INSERT INTO clients (id,company,client,phone,address,notes,grade,assigned_to,source,entry_id,orders) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id,c.company||'',c.client||'',c.phone||'',c.address||'',c.notes||'',c.grade||'',c.assignedTo||'',c.source||'manual',c.entryId||'','[]']);
  res.status(201).json({id});
});
router.put('/clients/:id', async (req, res) => {
  const c=req.body;
  await run("UPDATE clients SET company=?,client=?,phone=?,address=?,notes=?,grade=?,assigned_to=?,orders=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [c.company||'',c.client||'',c.phone||'',c.address||'',c.notes||'',c.grade||'',c.assignedTo||'',JSON.stringify(c.orders||[]),req.params.id]);
  res.json({message:'Updated'});
});
router.delete('/clients/:id', async (req, res) => {
  await run('DELETE FROM clients WHERE id=?',[req.params.id]); res.json({message:'Deleted'});
});
router.post('/clients/:id/orders', async (req, res) => {
  const client = await get('SELECT * FROM clients WHERE id=?',[req.params.id]);
  if (!client) return res.status(404).json({error:'Not found'});
  const orders = sj(client.orders,[]);
  const order = {id:uuidv4(),...req.body,createdAt:new Date().toISOString()};
  orders.push(order);
  await run("UPDATE clients SET orders=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[JSON.stringify(orders),req.params.id]);
  res.status(201).json(order);
});
router.delete('/clients/:id/orders/:oid', async (req, res) => {
  const client = await get('SELECT * FROM clients WHERE id=?',[req.params.id]);
  if (!client) return res.status(404).json({error:'Not found'});
  const orders = sj(client.orders,[]).filter(o=>o.id!==req.params.oid);
  await run("UPDATE clients SET orders=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[JSON.stringify(orders),req.params.id]);
  res.json({message:'Deleted'});
});

/* ── MEETINGS ─────────────────────────────────── */
router.get('/meetings', async (req, res) => res.json(await all('SELECT * FROM meetings ORDER BY date DESC')));
router.post('/meetings', async (req, res) => {
  const m=req.body, id=uuidv4();
  await run('INSERT INTO meetings (id,date,time,company,client,phone,location,agenda,status,entry_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id,m.date||'',m.time||'',m.company||'',m.client||'',m.phone||'',m.location||'',m.agenda||'',m.status||'Scheduled',m.entryId||'']);
  res.status(201).json({id});
});
router.put('/meetings/:id', async (req, res) => {
  const m=req.body;
  await run("UPDATE meetings SET date=?,time=?,company=?,client=?,phone=?,location=?,agenda=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [m.date||'',m.time||'',m.company||'',m.client||'',m.phone||'',m.location||'',m.agenda||'',m.status||'Scheduled',req.params.id]);
  res.json({message:'Updated'});
});
router.delete('/meetings/:id', async (req, res) => {
  await run('DELETE FROM meetings WHERE id=?',[req.params.id]); res.json({message:'Deleted'});
});

/* ── SWA DATA ─────────────────────────────────── */
router.get('/swa', async (req, res) => res.json(await all('SELECT * FROM swa_data ORDER BY created_at DESC')));
router.post('/swa', async (req, res) => {
  const s=req.body, id=uuidv4();
  await run('INSERT INTO swa_data (id,company,client,phone,address,remarks,status,wa_sent,selected,selected_date) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id,s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'',s.status||'Pending',s.waSent||'No',s.selected?1:0,s.selectedDate||'']);
  res.status(201).json({id});
});
router.post('/swa/bulk', async (req, res) => {
  const rows=req.body; if (!Array.isArray(rows)) return res.status(400).json({error:'Array expected'});
  for (const s of rows) await run('INSERT INTO swa_data (id,company,client,phone,address,remarks,status,wa_sent) VALUES (?,?,?,?,?,?,?,?)',
    [uuidv4(),s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'','Pending','No']);
  res.status(201).json({inserted:rows.length});
});
router.put('/swa/:id', async (req, res) => {
  const s=req.body;
  await run("UPDATE swa_data SET company=?,client=?,phone=?,address=?,remarks=?,status=?,wa_sent=?,selected=?,selected_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'',s.status||'Pending',s.waSent||'No',s.selected?1:0,s.selectedDate||'',req.params.id]);
  res.json({message:'Updated'});
});
router.delete('/swa/:id', async (req, res) => {
  await run('DELETE FROM swa_data WHERE id=?',[req.params.id]); res.json({message:'Deleted'});
});
router.delete('/swa', async (req, res) => {
  const {ids}=req.body; if(!Array.isArray(ids)) return res.status(400).json({error:'ids required'});
  for (const id of ids) await run('DELETE FROM swa_data WHERE id=?',[id]);
  res.json({message:'Deleted'});
});

/* ── WA LOG ───────────────────────────────────── */
router.get('/walog', async (req, res) => res.json(await all('SELECT * FROM wa_log ORDER BY timestamp DESC LIMIT 500')));
router.post('/walog', async (req, res) => {
  const l=req.body, id=uuidv4();
  await run('INSERT INTO wa_log (id,company,client,phone,type,status,message_preview) VALUES (?,?,?,?,?,?,?)',
    [id,l.company||'',l.client||'',l.phone||'',l.type||'',l.status||'sent',(l.messagePreview||'').slice(0,200)]);
  res.status(201).json({id});
});
router.delete('/walog', async (req, res) => {
  await run('DELETE FROM wa_log'); res.json({message:'Cleared'});
});

/* ── CONFIG ───────────────────────────────────── */
router.get('/config', async (req, res) => {
  const rows = await all('SELECT key,value FROM config');
  const cfg={}; rows.forEach(r => { try { cfg[r.key]=JSON.parse(r.value); } catch { cfg[r.key]=r.value; } });
  res.json(cfg);
});
router.put('/config', async (req, res) => {
  for (const [k,v] of Object.entries(req.body)) {
    const exists = await get('SELECT key FROM config WHERE key=?',[k]);
    if (exists) await run("UPDATE config SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?",[JSON.stringify(v),k]);
    else await run("INSERT INTO config (key,value) VALUES (?,?)",[k,JSON.stringify(v)]);
  }
  res.json({message:'Saved'});
});

/* ── STATS ────────────────────────────────────── */
router.get('/stats', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const q = async (sql,p=[]) => { const r=await get(sql,p); return parseInt(r?.c||r?.['COUNT(*)'||0])||0; };
  res.json({
    totalEntries:  await q('SELECT COUNT(*) as c FROM entries'),
    visited:       await q("SELECT COUNT(*) as c FROM entries WHERE visit='Yes'"),
    converted:     await q("SELECT COUNT(*) as c FROM entries WHERE converted='Yes'"),
    todayFollowups:await q('SELECT COUNT(*) as c FROM entries WHERE followup=? OR followup2=?',[today,today]),
    activeClients: await q('SELECT COUNT(*) as c FROM clients'),
    meetings:      await q('SELECT COUNT(*) as c FROM meetings'),
    swaPending:    await q('SELECT COUNT(*) as c FROM swa_data WHERE selected=0'),
    swaSelected:   await q('SELECT COUNT(*) as c FROM swa_data WHERE selected=1'),
  });
});

/* ── RESET ────────────────────────────────────── */
router.delete('/reset', adminOnly, async (req, res) => {
  for (const t of ['entries','clients','meetings','swa_data','wa_log','config'])
    await run(`DELETE FROM ${t}`);
  res.json({message:'All data cleared'});
});

module.exports = router;
