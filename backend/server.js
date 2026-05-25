const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { OAuth2Client } = require('google-auth-library');
const db = require('./database');
const smm = require('./smmApi');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('../frontend'));

// =============================================
// RAZORPAY SETUP
// =============================================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_HERE',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE',
});

// =============================================
// AUTH ROUTES
// =============================================

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.json({ success: false, message: 'All fields required' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists)
    return res.json({ success: false, message: 'Email already registered' });

  const hash = crypto.createHash('sha256').update(password).digest('hex');
  db.prepare('INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 0)')
    .run(name, email, hash);

  res.json({ success: true, message: 'Registered successfully' });
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND password = ?').get(email, hash);

  if (!user) return res.json({ success: false, message: 'Invalid credentials' });

  // Simple token (use JWT in production)
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role }
  });
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.json({ success: false, message: 'Google credential token is required' });
  }

  try {
    let payload;
    
    // Check if client ID is configured
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && clientId !== 'YOUR_GOOGLE_CLIENT_ID_HERE') {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } else {
      // Light-weight fallback: decode payload from JWT without cryptographic verification for easier local setup
      console.warn('⚠️ GOOGLE_CLIENT_ID is not configured in .env. Decoding token without signature verification.');
      const parts = credential.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT format');
      payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    }

    const { email, name, picture } = payload;
    if (!email) {
      return res.json({ success: false, message: 'Google token does not contain email' });
    }

    // Check if user exists in database
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user) {
      // Auto-register user (random pass since they login with Google)
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(randomPassword).digest('hex');
      
      db.prepare('INSERT INTO users (name, email, password, balance) VALUES (?, ?, ?, 0)')
        .run(name || email.split('@')[0], email, hash);
        
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      console.log(`👤 Automatically registered new Google user: ${email} (Role: ${user.role})`);
    }

    // Generate login token
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        balance: user.balance,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Google Auth Error:', err);
    res.json({ success: false, message: 'Google authentication failed: ' + err.message });
  }
});

// Get profile (auth middleware)
app.get('/api/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, balance, role FROM users WHERE id = ?').get(req.userId);
  res.json({ success: true, user });
});

// Get client-side config parameters
app.get('/api/config', (req, res) => {
  res.json({ google_client_id: process.env.GOOGLE_CLIENT_ID || '' });
});

// =============================================
// SERVICES ROUTES
// =============================================

app.get('/api/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE active = 1').all();
  res.json({ success: true, services });
});

app.get('/api/services/:platform', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE platform = ? AND active = 1').all(req.params.platform);
  res.json({ success: true, services });
});

// =============================================
// ORDER ROUTES
// =============================================

app.post('/api/orders', requireAuth, async (req, res) => {
  const { service_id, link, quantity } = req.body;

  // ── Validate service ──
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  if (!service) return res.json({ success: false, message: 'Service not found' });

  if (quantity < service.min_qty || quantity > service.max_qty)
    return res.json({ success: false, message: `Quantity must be between ${service.min_qty} and ${service.max_qty}` });

  // ── Check balance ──
  const charge = parseFloat(((service.rate * quantity) / 1000).toFixed(2));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (user.balance < charge)
    return res.json({ success: false, message: 'Insufficient balance. Please recharge.' });

  // ── Deduct balance immediately ──
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(charge, req.userId);

  // ── Create order in DB as 'pending' ──
  const result = db.prepare(`
    INSERT INTO orders (user_id, service_id, link, quantity, charge, status, provider_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, datetime('now'))
  `).run(req.userId, service_id, link, quantity, charge);
  const order_id = result.lastInsertRowid;

  // ── Forward to SMM Provider ──
  if (service.provider_service_id) {
    try {
      const smmResult = await smm.placeOrder({
        service_id: service.provider_service_id,
        link,
        quantity,
      });

      if (smmResult.success) {
        // Save provider order ID + mark as processing
        db.prepare(`UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?`)
          .run(smmResult.provider_order_id, order_id);
        console.log(`✅ Order #${order_id} → Provider order #${smmResult.provider_order_id}`);
      } else {
        // Provider failed — refund the user
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(charge, req.userId);
        db.prepare(`UPDATE orders SET status = 'failed', notes = ? WHERE id = ?`)
          .run(smmResult.error, order_id);
        return res.json({ success: false, message: `Provider error: ${smmResult.error}` });
      }
    } catch (err) {
      // Network error — mark for retry
      db.prepare(`UPDATE orders SET status = 'retry', notes = ? WHERE id = ?`)
        .run(err.message, order_id);
      console.error(`⚠️ Order #${order_id} queued for retry:`, err.message);
    }
  } else {
    // No provider mapped yet — stays as manual 'pending'
    console.log(`⚠️ Service ${service_id} has no provider_service_id mapped`);
  }

  res.json({
    success: true,
    message: 'Order placed successfully!',
    order_id,
    charge,
    new_balance: parseFloat((user.balance - charge).toFixed(2)),
  });
});

// Get user orders
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, s.name as service_name, s.platform
    FROM orders o
    JOIN services s ON o.service_id = s.id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json({ success: true, orders });
});

// =============================================
// RAZORPAY PAYMENT ROUTES
// =============================================

// Step 1: Create Razorpay order
app.post('/api/payment/create', requireAuth, async (req, res) => {
  const { amount } = req.body; // amount in ₹

  if (!amount || amount < 10)
    return res.json({ success: false, message: 'Minimum recharge is ₹10' });

  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay needs paise
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { user_id: req.userId }
    });

    // Save pending transaction
    db.prepare(`
      INSERT INTO transactions (user_id, razorpay_order_id, amount, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `).run(req.userId, order.id, amount);

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_HERE'
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Payment creation failed' });
  }
});

// Step 2: Verify payment after success
app.post('/api/payment/verify', requireAuth, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const secret = process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET_HERE';
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature)
    return res.json({ success: false, message: 'Payment verification failed' });

  // Get transaction
  const txn = db.prepare('SELECT * FROM transactions WHERE razorpay_order_id = ?').get(razorpay_order_id);
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });

  // Credit wallet
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(txn.amount, req.userId);
  db.prepare('UPDATE transactions SET status = ?, razorpay_payment_id = ? WHERE id = ?')
    .run('paid', razorpay_payment_id, txn.id);

  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.userId);
  res.json({ success: true, message: `₹${txn.amount} added to wallet!`, new_balance: user.balance });
});

// Transaction history
app.get('/api/transactions', requireAuth, (req, res) => {
  const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.userId);
  res.json({ success: true, transactions: txns });
});

// =============================================
// ADMIN ROUTES
// =============================================

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.name as user_name, s.name as service_name
    FROM orders o
    JOIN users u ON o.user_id = u.id
    JOIN services s ON o.service_id = s.id
    ORDER BY o.created_at DESC LIMIT 100
  `).all();
  res.json({ success: true, orders });
});

app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true, message: 'Order status updated' });
});

// List all registered users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare('SELECT id, name, email, balance, role, created_at FROM users').all();
    res.json({ success: true, users });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Adjust any user's balance (credit or debit)
app.post('/api/admin/users/:id/balance', requireAdmin, (req, res) => {
  const { amount, note } = req.body; // positive to credit, negative to debit
  const userId = Number(req.params.id);

  if (amount === undefined || isNaN(amount)) {
    return res.json({ success: false, message: 'Invalid amount' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ success: false, message: 'User not found' });

    // Update balance
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);

    // Record manual transaction history
    const txnType = amount >= 0 ? 'Admin Credit' : 'Admin Debit';
    db.prepare(`
      INSERT INTO transactions (user_id, razorpay_order_id, razorpay_payment_id, amount, status, created_at)
      VALUES (?, NULL, ?, ?, ?, datetime('now'))
    `).run(userId, `ADMIN: ${note || txnType}`, Math.abs(amount), amount >= 0 ? 'paid' : 'debited');

    const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    res.json({
      success: true,
      message: `Successfully adjusted balance by ₹${amount}. New balance: ₹${updatedUser.balance}`,
      new_balance: updatedUser.balance
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// =============================================
// MIDDLEWARE
// =============================================

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Login required' });

  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) return res.status(401).json({ success: false, message: 'Invalid token' });

  req.userId = user.id;
  req.userRole = user.role;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'admin')
      return res.status(403).json({ success: false, message: 'Admin access required' });
    next();
  });
}

// =============================================
// SMM PROVIDER ADMIN ROUTES
// =============================================

// Get provider balance
app.get('/api/admin/provider-balance', requireAdmin, async (req, res) => {
  const result = await smm.getProviderBalance();
  res.json(result);
});

// Import services from provider into DB
app.post('/api/admin/import-services', requireAdmin, async (req, res) => {
  const result = await smm.getProviderServices();
  if (!result.success) return res.json({ success: false, message: result.error });

  let imported = 0;
  for (const s of result.services) {
    // Map provider platform from category name
    const platform = guessPlatform(s.category);
    const exists = db.prepare('SELECT id FROM services WHERE provider_service_id = ?').get(String(s.service));
    if (!exists) {
      db.prepare(`
        INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        platform,
        s.name,
        s.category,
        parseFloat((s.rate * 1.3).toFixed(4)), // Add 30% margin for your profit
        s.min,
        s.max,
        s.average_time || 'Varies',
        String(s.service)
      );
      imported++;
    }
  }
  res.json({ success: true, message: `Imported ${imported} new services`, total: result.services.length });
});

// Map existing service to a provider service ID
app.put('/api/admin/services/:id/map', requireAdmin, (req, res) => {
  const { provider_service_id } = req.body;
  db.prepare('UPDATE services SET provider_service_id = ? WHERE id = ?')
    .run(provider_service_id, req.params.id);
  res.json({ success: true, message: 'Service mapped to provider' });
});

// Manual order status check
app.get('/api/admin/orders/:id/sync', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.checkOrderStatus(order.provider_order_id);
  if (!result.success) return res.json(result);

  const newStatus = mapProviderStatus(result.status);
  db.prepare('UPDATE orders SET status = ?, remains = ? WHERE id = ?')
    .run(newStatus, result.remains, order.id);
  res.json({ success: true, status: newStatus, remains: result.remains });
});

// Cancel order at provider
app.post('/api/admin/orders/:id/cancel', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.cancelOrder(order.provider_order_id);
  if (result.success) {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    // Refund partial amount if needed
  }
  res.json(result);
});

// Refill dropped order
app.post('/api/admin/orders/:id/refill', requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order?.provider_order_id) return res.json({ success: false, message: 'No provider order ID' });

  const result = await smm.refillOrder(order.provider_order_id);
  res.json(result);
});

// =============================================
// AUTO STATUS SYNC — runs every 5 minutes
// =============================================
async function syncOrderStatuses() {
  // Get all active orders that have a provider_order_id
  const activeOrders = db.prepare(`
    SELECT id, provider_order_id FROM orders
    WHERE status IN ('processing', 'pending', 'retry')
    AND provider_order_id IS NOT NULL
    LIMIT 100
  `).all();

  if (!activeOrders.length) return;

  // Batch check (up to 100 at once — JAP supports this)
  const ids = activeOrders.map(o => o.provider_order_id);
  const result = await smm.checkMultipleOrders(ids);
  if (!result.success) {
    console.error('Status sync failed:', result.error);
    return;
  }

  const updateStmt = db.prepare('UPDATE orders SET status = ?, remains = ? WHERE id = ?');
  const syncMany = db.transaction((orders, providerData) => {
    for (const order of orders) {
      const pd = providerData[order.provider_order_id];
      if (!pd) continue;
      const newStatus = mapProviderStatus(pd.status);
      updateStmt.run(newStatus, pd.remains || 0, order.id);
    }
  });

  syncMany(activeOrders, result.orders);
  console.log(`🔄 Synced ${activeOrders.length} orders at ${new Date().toLocaleTimeString()}`);
}

// Retry orders that failed to reach provider
async function retryFailedOrders() {
  const retryOrders = db.prepare(`
    SELECT o.*, s.provider_service_id FROM orders o
    JOIN services s ON o.service_id = s.id
    WHERE o.status = 'retry' AND s.provider_service_id IS NOT NULL
    LIMIT 20
  `).all();

  for (const order of retryOrders) {
    const result = await smm.placeOrder({
      service_id: order.provider_service_id,
      link: order.link,
      quantity: order.quantity,
    });
    if (result.success) {
      db.prepare("UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?")
        .run(result.provider_order_id, order.id);
      console.log(`♻️ Retried order #${order.id} → provider #${result.provider_order_id}`);
    }
  }
}

// ── Helper: map provider status → our status ──
function mapProviderStatus(providerStatus) {
  const map = {
    'Pending': 'pending',
    'In progress': 'processing',
    'Processing': 'processing',
    'Completed': 'completed',
    'Partial': 'partial',
    'Canceled': 'cancelled',
    'Cancelled': 'cancelled',
  };
  return map[providerStatus] || 'processing';
}

// ── Helper: guess platform from category name ──
function guessPlatform(category = '') {
  const c = category.toLowerCase();
  if (c.includes('instagram')) return 'instagram';
  if (c.includes('youtube')) return 'youtube';
  if (c.includes('facebook')) return 'facebook';
  if (c.includes('tiktok') || c.includes('tik tok')) return 'tiktok';
  if (c.includes('twitter') || c.includes('x.com')) return 'twitter';
  if (c.includes('telegram')) return 'telegram';
  return 'other';
}

// Start cron jobs (only in non-serverless environments)
if (process.env.VERCEL !== '1') {
  setInterval(syncOrderStatuses, 5 * 60 * 1000);   // every 5 min
  setInterval(retryFailedOrders, 10 * 60 * 1000);   // every 10 min
  console.log('⏰ Auto-sync started (every 5 min)');
}

// =============================================
// START SERVER (local) / EXPORT (Vercel)
// =============================================

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ BoostGram Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
