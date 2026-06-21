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
  await dbModule.init(); // must finish before any route touches the DB

  const { requireAuth, requirePermission } = require('./middleware/auth');
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
  app.get('/api/health', (req, res) => {
    let persistent = false;
    try { persistent = dbModule.getDb().isTursoEnabled; } catch (e) { /* db not ready yet */ }
    res.json({ ok: true, time: new Date().toISOString(), persistentStorage: persistent });
  });

  // ── Protected API routes — gated by role permission, not just login ──
  app.use('/api/visit-clients', requireAuth, requirePermission('view_data'), makeCrudRouter('visit_clients', [
    'name', 'company', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'last_visit', 'status', 'lead_status', 'remarks', 'follow_up_date'
  ], (row) => {
    // If the client was created with remarks already filled in (typed straight into
    // the Add Client form, not via "Log a Visit"), preserve that as the first entry
    // in their visit history — otherwise the very next "Log a Visit" would silently
    // overwrite it with no record it ever existed.
    if (row.remarks && row.remarks.trim()) {
      const db = require('./db/init');
      db.prepare(`INSERT INTO visit_logs (client_id, client_table, visit_date, next_follow_up_date, lead_status, remarks)
        VALUES (?, 'visit_clients', ?, ?, ?, ?)`)
        .run(row.id, row.last_visit || row.created_at.split(' ')[0], row.follow_up_date || null, row.lead_status || null, row.remarks);
    }
  }, 'edit_data', 'delete_data'));
  app.use('/api/active-clients', requireAuth, requirePermission('view_data'), makeCrudRouter('active_clients', [
    'name', 'company', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'monthly_value', 'status', 'grade', 'converted_by', 'remarks'
  ], null, 'edit_data', 'delete_data'));
  app.use('/api/meetings', requireAuth, requirePermission('view_data'), require('./routes/meetings'));
  app.use('/api/followups', requireAuth, requirePermission('view_data'), require('./routes/followups'));
  app.use('/api/swa', requireAuth, requirePermission('view_swa'), require('./routes/swa'));
  app.use('/api/whatsapp', requireAuth, waRouter); // mixed permissions handled inside the router itself (settings = manage_settings, send = send_whatsapp)
  app.use('/api/reports', requireAuth, requirePermission('view_reports'), require('./routes/reports'));
  app.use('/api/visit-logs', requireAuth, requirePermission('edit_data'), require('./routes/visitLogs'));
  app.use('/api/orders', requireAuth, requirePermission('edit_data'), require('./routes/orders'));
  app.use('/api/ai', requireAuth, require('./routes/ai')); // mostly read/insight features, available to view_data+ roles; mutating bits double-checked inside
  app.use('/api/executives', requireAuth, requirePermission('manage_settings'), require('./routes/executives'));
  app.use('/api/backup', requireAuth, requirePermission('manage_settings'), require('./routes/backup'));
  app.use('/api/targets', requireAuth, requirePermission('view_reports'), require('./routes/targets'));
  app.use('/api/wa-defaults', requireAuth, requirePermission('manage_settings'), require('./routes/waDefaults'));
  app.use('/api/users', requireAuth, requirePermission('manage_users'), require('./routes/users'));

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

  // Safety-net periodic sync to Turso, in case the process is ever killed without
  // a chance to run the graceful shutdown handler below. Every individual write
  // already schedules a sync (see db/libsql-wrapper.js), this is belt-and-suspenders.
  setInterval(() => {
    try { dbModule.getDb().syncNow(); } catch (e) { /* not ready yet, ignore */ }
  }, 10000).unref();

  // WhatsApp retry queue — picks up any message that failed for a transient reason
  // (rate limit, network blip, momentary Meta API error) and re-attempts it on a
  // backoff schedule, so a message is never silently dropped due to a temporary issue.
  const waService = require('./services/whatsapp');
  setInterval(() => {
    waService.processRetryQueue().catch(err => console.error('Retry queue error:', err));
  }, 60 * 1000).unref();

  // Push any pending writes to Turso BEFORE the process exits — this matters even
  // more now than with local-file storage, since Render's free tier wipes the local
  // disk on every redeploy; if the last few writes never made it to Turso, they're
  // gone for good. Waits (with a hard timeout) for the sync to actually finish rather
  // than firing it and exiting immediately.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — syncing to Turso and shutting down...`);
    try {
      await Promise.race([
        dbModule.getDb().syncNow(),
        new Promise(resolve => setTimeout(resolve, 4000)), // don't hang forever if Turso is unreachable
      ]);
    } catch (e) {
      console.error('Sync on shutdown failed:', e);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
