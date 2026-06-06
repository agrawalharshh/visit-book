require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDb } = require('./models/db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 30 }));
app.use('/api/', rateLimit({ windowMs: 60*1000, max: 500 }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api', require('./routes/api'));

// Serve built React frontend
const distPath = path.join(__dirname, 'public');
app.use(express.static(distPath));
app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));

// Better error handler — shows actual error in logs
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VisitBook CRM running on port ${PORT}`);
    console.log(`   Login: admin / admin123`);
  });
}).catch(err => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});
