// routes/orders.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Get all orders (with line items) for an active client
router.get('/', (req, res) => {
  const { active_client_id } = req.query;
  if (!active_client_id) return res.status(400).json({ error: 'active_client_id required' });
  const orders = db.prepare('SELECT * FROM orders WHERE active_client_id = ? ORDER BY order_date DESC, id DESC').all(active_client_id);
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const withItems = orders.map(o => ({ ...o, items: itemStmt.all(o.id) }));
  res.json(withItems);
});

// Create an order with line items
// body: { active_client_id, bill_no, order_date, notes, items: [{product, qty, rate}] }
router.post('/', (req, res) => {
  const { active_client_id, bill_no, order_date, notes, items } = req.body;
  if (!active_client_id || !order_date) return res.status(400).json({ error: 'active_client_id and order_date required' });
  const lineItems = Array.isArray(items) ? items.filter(i => i.product) : [];
  const total = lineItems.reduce((sum, i) => sum + (parseFloat(i.qty) || 0) * (parseFloat(i.rate) || 0), 0);

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO orders (active_client_id, bill_no, order_date, total_amount, notes) VALUES (?, ?, ?, ?, ?)`)
      .run(active_client_id, bill_no || '', order_date, total, notes || '');
    const orderId = info.lastInsertRowid;
    const itemStmt = db.prepare('INSERT INTO order_items (order_id, product, qty, rate, amount) VALUES (?, ?, ?, ?, ?)');
    for (const item of lineItems) {
      const qty = parseFloat(item.qty) || 0;
      const rate = parseFloat(item.rate) || 0;
      itemStmt.run(orderId, item.product, qty, rate, qty * rate);
    }
    return orderId;
  });

  const orderId = tx();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  res.status(201).json({ ...order, items: orderItems });
});

router.delete('/:id', (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ success: true });
});

module.exports = router;
