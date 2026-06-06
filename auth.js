const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all, persist } = require('../models/db');
const { authenticate, adminOnly } = require('../middleware/auth');

router.use(authenticate);

const sj = (s,f) => { try { return JSON.parse(s); } catch { return f; } };

/* CLIENTS */
router.get('/clients', (req, res) => res.json(all('SELECT * FROM clients ORDER BY created_at DESC').map(r => ({...r, orders: sj(r.orders,[])}))));
router.post('/clients', (req, res) => {
  const c=req.body, id=uuidv4();
  run('INSERT INTO clients (id,company,client,phone,address,notes,grade,assigned_to,source,entry_id,orders) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id,c.company||'',c.client||'',c.phone||'',c.address||'',c.notes||'',c.grade||'',c.assignedTo||'',c.source||'manual',c.entryId||'','[]']);
  persist(); res.status(201).json({id});
});
router.put('/clients/:id', (req, res) => {
  const c=req.body;
  run("UPDATE clients SET company=?,client=?,phone=?,address=?,notes=?,grade=?,assigned_to=?,orders=?,updated_at=datetime('now') WHERE id=?",
    [c.company||'',c.client||'',c.phone||'',c.address||'',c.notes||'',c.grade||'',c.assignedTo||'',JSON.stringify(c.orders||[]),req.params.id]);
  persist(); res.json({message:'Updated'});
});
router.delete('/clients/:id', (req, res) => { run('DELETE FROM clients WHERE id=?',[req.params.id]); persist(); res.json({message:'Deleted'}); });

router.post('/clients/:id/orders', (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?',[req.params.id]);
  if (!client) return res.status(404).json({error:'Not found'});
  const orders = sj(client.orders,[]);
  const order = {id:uuidv4(),...req.body, createdAt:new Date().toISOString()};
  orders.push(order);
  run("UPDATE clients SET orders=?,updated_at=datetime('now') WHERE id=?",[JSON.stringify(orders),req.params.id]);
  persist(); res.status(201).json(order);
});
router.delete('/clients/:id/orders/:oid', (req, res) => {
  const client = get('SELECT * FROM clients WHERE id=?',[req.params.id]);
  if (!client) return res.status(404).json({error:'Not found'});
  const orders = sj(client.orders,[]).filter(o=>o.id!==req.params.oid);
  run("UPDATE clients SET orders=?,updated_at=datetime('now') WHERE id=?",[JSON.stringify(orders),req.params.id]);
  persist(); res.json({message:'Deleted'});
});

/* MEETINGS */
router.get('/meetings', (req, res) => res.json(all('SELECT * FROM meetings ORDER BY date DESC')));
router.post('/meetings', (req, res) => {
  const m=req.body, id=uuidv4();
  run('INSERT INTO meetings (id,date,time,company,client,phone,location,agenda,status,entry_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id,m.date||'',m.time||'',m.company||'',m.client||'',m.phone||'',m.location||'',m.agenda||'',m.status||'Scheduled',m.entryId||'']);
  persist(); res.status(201).json({id});
});
router.put('/meetings/:id', (req, res) => {
  const m=req.body;
  run("UPDATE meetings SET date=?,time=?,company=?,client=?,phone=?,location=?,agenda=?,status=?,updated_at=datetime('now') WHERE id=?",
    [m.date||'',m.time||'',m.company||'',m.client||'',m.phone||'',m.location||'',m.agenda||'',m.status||'Scheduled',req.params.id]);
  persist(); res.json({message:'Updated'});
});
router.delete('/meetings/:id', (req, res) => { run('DELETE FROM meetings WHERE id=?',[req.params.id]); persist(); res.json({message:'Deleted'}); });

/* SWA DATA */
router.get('/swa', (req, res) => res.json(all('SELECT * FROM swa_data ORDER BY created_at DESC')));
router.post('/swa', (req, res) => {
  const s=req.body, id=uuidv4();
  run('INSERT INTO swa_data (id,company,client,phone,address,remarks,status,wa_sent,selected,selected_date) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id,s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'',s.status||'Pending',s.waSent||'No',s.selected?1:0,s.selectedDate||'']);
  persist(); res.status(201).json({id});
});
router.post('/swa/bulk', (req, res) => {
  const rows = req.body; if (!Array.isArray(rows)) return res.status(400).json({error:'Array expected'});
  rows.forEach(s => run('INSERT INTO swa_data (id,company,client,phone,address,remarks,status,wa_sent) VALUES (?,?,?,?,?,?,?,?)',
    [uuidv4(),s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'','Pending','No']));
  persist(); res.status(201).json({inserted:rows.length});
});
router.put('/swa/:id', (req, res) => {
  const s=req.body;
  run("UPDATE swa_data SET company=?,client=?,phone=?,address=?,remarks=?,status=?,wa_sent=?,selected=?,selected_date=?,updated_at=datetime('now') WHERE id=?",
    [s.company||'',s.client||'',s.phone||'',s.address||'',s.remarks||'',s.status||'Pending',s.waSent||'No',s.selected?1:0,s.selectedDate||'',req.params.id]);
  persist(); res.json({message:'Updated'});
});
router.delete('/swa/:id', (req, res) => { run('DELETE FROM swa_data WHERE id=?',[req.params.id]); persist(); res.json({message:'Deleted'}); });
router.delete('/swa', (req, res) => {
  const {ids}=req.body; if (!Array.isArray(ids)) return res.status(400).json({error:'ids required'});
  ids.forEach(id => run('DELETE FROM swa_data WHERE id=?',[id])); persist(); res.json({message:'Deleted'});
});

/* WA LOG */
router.get('/walog', (req, res) => res.json(all('SELECT * FROM wa_log ORDER BY timestamp DESC LIMIT 500')));
router.post('/walog', (req, res) => {
  const l=req.body, id=uuidv4();
  run('INSERT INTO wa_log (id,company,client,phone,type,status,message_preview) VALUES (?,?,?,?,?,?,?)',
    [id,l.company||'',l.client||'',l.phone||'',l.type||'',l.status||'sent',(l.messagePreview||'').slice(0,200)]);
  persist(); res.status(201).json({id});
});
router.delete('/walog', (req, res) => { run('DELETE FROM wa_log'); persist(); res.json({message:'Cleared'}); });

/* CONFIG */
router.get('/config', (req, res) => {
  const rows = all('SELECT key,value FROM config');
  const cfg = {}; rows.forEach(r => { try { cfg[r.key]=JSON.parse(r.value); } catch { cfg[r.key]=r.value; } });
  res.json(cfg);
});
router.put('/config', (req, res) => {
  Object.entries(req.body).forEach(([k,v]) => {
    const exists = get('SELECT key FROM config WHERE key=?',[k]);
    if (exists) run("UPDATE config SET value=?,updated_at=datetime('now') WHERE key=?",[JSON.stringify(v),k]);
    else run("INSERT INTO config (key,value) VALUES (?,?)",[k,JSON.stringify(v)]);
  });
  persist(); res.json({message:'Saved'});
});

/* STATS */
router.get('/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json({
    totalEntries: parseInt(get('SELECT COUNT(*) as c FROM entries').c)||0,
    visited: parseInt(get("SELECT COUNT(*) as c FROM entries WHERE visit='Yes'").c)||0,
    converted: parseInt(get("SELECT COUNT(*) as c FROM entries WHERE converted='Yes'").c)||0,
    todayFollowups: parseInt(get('SELECT COUNT(*) as c FROM entries WHERE followup=? OR followup2=?',[today,today]).c)||0,
    activeClients: parseInt(get('SELECT COUNT(*) as c FROM clients').c)||0,
    meetings: parseInt(get('SELECT COUNT(*) as c FROM meetings').c)||0,
    swaPending: parseInt(get('SELECT COUNT(*) as c FROM swa_data WHERE selected=0').c)||0,
    swaSelected: parseInt(get('SELECT COUNT(*) as c FROM swa_data WHERE selected=1').c)||0,
  });
});

/* RESET */
router.delete('/reset', adminOnly, (req, res) => {
  ['entries','clients','meetings','campaigns','swa_data','wa_log','config'].forEach(t => run(`DELETE FROM ${t}`));
  persist(); res.json({message:'All data cleared'});
});

module.exports = router;
