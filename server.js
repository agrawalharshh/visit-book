// server.js — Visit Book CRM backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const dbModule = require('./db/init');

// Express 4's synchronous error middleware does NOT catch errors thrown inside
// `async (req, res) => {...}` handlers — those become unhandled promise rejections.
// Several routes in this app use that pattern directly, so these two handlers are
// the real safety net that keeps one bad request from taking down the whole server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (request likely failed silently):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stays up):', err);
});

async function start() {
  await dbModule.init(); // sql.js is async to load its WASM binary — must finish before any route touches the DB

  const { requireAuth } = require('./middleware/auth');
  const makeCrudRouter = require('./routes/crud');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Public routes ──
  app.use('/api/auth', require('./routes/auth'));

  // Meta calls /api/whatsapp/webhook directly with no auth header, so that single path
  // must be reachable before requireAuth runs. Everything else under /api/whatsapp is protected.
  const waRouter = require('./routes/whatsapp');
  app.get('/api/whatsapp/webhook', waRouter.webhookVerify);
  app.post('/api/whatsapp/webhook', waRouter.webhookReceive);

  // ── Health check (for Render) ──
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // ── Protected API routes ──
  app.use('/api/visit-clients', requireAuth, makeCrudRouter('visit_clients', [
    'name', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'last_visit', 'status', 'lead_status', 'remarks', 'follow_up_date'
  ]));
  app.use('/api/active-clients', requireAuth, makeCrudRouter('active_clients', [
    'name', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'monthly_value', 'status', 'remarks'
  ]));
  app.use('/api/meetings', requireAuth, require('./routes/meetings'));
  app.use('/api/followups', requireAuth, require('./routes/followups'));
  app.use('/api/swa', requireAuth, require('./routes/swa'));
  app.use('/api/whatsapp', requireAuth, waRouter); // settings/templates/send/log (webhook above is separately mounted, unauth)
  app.use('/api/reports', requireAuth, require('./routes/reports'));
  app.use('/api/visit-logs', requireAuth, require('./routes/visitLogs'));
  app.use('/api/orders', requireAuth, require('./routes/orders'));
  app.use('/api/ai', requireAuth, require('./routes/ai'));

  // ── Serve frontend (single-file app) ──
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ── Global error handler — last line of defense so a thrown error in any
  //    route never takes the whole process down; it just becomes a 500 response. ──
  app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`✓ Visit Book CRM backend running on port ${PORT}`);
  });

  // Safety-net periodic save, in case the process is ever killed without
  // a chance to run the graceful shutdown handler below.
  setInterval(() => {
    try { dbModule.getDb().saveNow(); } catch (e) { /* not ready yet, ignore */ }
  }, 10000).unref();

  // Flush any pending in-memory DB writes to disk before the process exits,
  // so a deploy/restart on Render never silently drops the last few writes.
  function shutdown(signal) {
    console.log(`\n${signal} received — saving database and shutting down...`);
    try { dbModule.getDb().saveNow(); } catch (e) { console.error('Save on shutdown failed:', e); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
