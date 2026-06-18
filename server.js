require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./models/db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 30 }));
app.use('/api/', rateLimit({ windowMs: 60*1000, max: 2000 }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ERP + SM routes — no auth (internal tools, same domain)
const erpRouter = require('./routes/erp');
app.use('/api', erpRouter);

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/db',      require('./routes/database'));
app.use('/api',         require('./routes/api'));

// Serve static files
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
  // Root → Business Hub (module launcher)
  app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'hub.html')));
  app.get('/hub', (req, res) => res.sendFile(path.join(publicPath, 'hub.html')));
  // Module routes — direct HTML pages
  app.get('/erp', (req, res) => res.sendFile(path.join(publicPath, 'erp.html')));
  app.get('/erp.html', (req, res) => res.sendFile(path.join(publicPath, 'erp.html')));
  app.get('/visitbook', (req, res) => res.sendFile(path.join(publicPath, 'salesmanager.html')));
  app.get('/salesmanager.html', (req, res) => res.sendFile(path.join(publicPath, 'salesmanager.html')));
  app.get('/products', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
  // React app (Product Database / Visit Book entries) — index.html handles its own routing
  // Catch-all: serve React app for non-file routes (React Router handles them)
  app.get('*', (req, res) => {
    if (req.path.includes('.') && !req.path.endsWith('.html')) {
      return res.status(404).end(); // static asset not found
    }
    // React app handles client-side routes
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Shiva Group CRM running on port ${PORT}`);
    console.log(`   Visit Book + Product Database`);
  });
}).catch(err => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});
