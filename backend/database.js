const fs = require('fs');
const path = require('path');

let dbPath = path.join(__dirname, 'db.json');

// Check if running on Vercel or a serverless/production environment
if (process.env.VERCEL || process.env.NODE_ENV === 'production' || !__dirname.startsWith('c:')) {
  const tempPath = path.join('/tmp', 'db.json');
  try {
    if (!fs.existsSync(tempPath)) {
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, tempPath);
      } else {
        fs.writeFileSync(tempPath, JSON.stringify({
          users: [],
          services: [],
          orders: [],
          transactions: []
        }, null, 2), 'utf8');
      }
    }
    dbPath = tempPath;
    console.log('📦 Redirected JSON DB to writable /tmp path:', dbPath);
  } catch (err) {
    console.error('⚠️ Could not redirect to /tmp, using default path:', err);
  }
}

// Helper to read/write JSON with Cloud KV sync
function readData() {
  const crypto = require('crypto');
  const { execSync } = require('child_process');
  let data;
  
  // Try loading from Vercel KV first (REST API)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      console.log('☁️ Fetching SMM database from Vercel KV...');
      const url = `${process.env.KV_REST_API_URL}/get/db_json`;
      const token = process.env.KV_REST_API_TOKEN;
      const stdout = execSync(`curl -s -H "Authorization: Bearer ${token}" "${url}"`, { 
        timeout: 8000,
        maxBuffer: 10 * 1024 * 1024
      }).toString().trim();
      
      if (stdout && stdout.startsWith('{')) {
        const wrapper = JSON.parse(stdout);
        if (wrapper && wrapper.result) {
          const parsed = typeof wrapper.result === 'string' ? JSON.parse(wrapper.result) : wrapper.result;
          if (parsed && typeof parsed === 'object') {
            data = parsed;
            console.log('☁️ Successfully loaded SMM database from Vercel KV!');
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Vercel KV fetch failed, falling back:', err.message);
    }
  }

  // Fallback to older Cloud KV if Vercel KV not present or failed
  if (!data) {
    try {
      console.log('☁️ Fetching SMM database from Cloud KV...');
      const stdout = execSync('curl -s https://kvdb.io/JS9f9tqBYYq46Qkqi8Z21s/db_json', { 
        timeout: 8000,
        maxBuffer: 10 * 1024 * 1024
      }).toString().trim();
      if (stdout && stdout.startsWith('{') && stdout.endsWith('}')) {
        data = JSON.parse(stdout);
        console.log('☁️ Successfully loaded SMM database from Cloud KV!');
      }
    } catch (err) {
      console.error('⚠️ Cloud KV fetch failed, falling back to local file:', err.message);
    }
  }

  // Fallback to local db.json if Cloud KV failed or is empty
  if (!data) {
    if (!fs.existsSync(dbPath)) {
      data = {
        users: [],
        services: [],
        orders: [],
        transactions: []
      };
    } else {
      try {
        data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      } catch (err) {
        data = {
          users: [],
          services: [],
          orders: [],
          transactions: []
        };
      }
    }
  }

  // ── Self-healing: Remove duplicate services (by provider_service_id or by name + platform) ──
  if (data.services && Array.isArray(data.services)) {
    const seenProviderIds = new Set();
    const uniqueMap = new Map();
    let cleaned = false;

    for (const s of data.services) {
      // 1. Skip if already seen this exact provider service ID
      if (s.provider_service_id) {
        const pId = String(s.provider_service_id).trim();
        if (seenProviderIds.has(pId)) {
          cleaned = true;
          continue; // Skip duplicate provider ID
        }
        seenProviderIds.add(pId);
      }

      // 2. Filter duplicate platform + name (keep the one with the lower rate/price)
      const nameKey = `${s.platform}_${s.name.trim().toLowerCase()}`;
      if (uniqueMap.has(nameKey)) {
        cleaned = true;
        const existing = uniqueMap.get(nameKey);
        // Keep the one with the lowest rate (best price for client)
        if (s.rate < existing.rate) {
          uniqueMap.set(nameKey, s);
        }
      } else {
        uniqueMap.set(nameKey, s);
      }
    }

    if (cleaned) {
      const uniqueServices = Array.from(uniqueMap.values());
      console.log(`🧹 Database Self-Healing: Cleaned ${data.services.length - uniqueServices.length} duplicate services!`);
      data.services = uniqueServices;
      
      // Re-assign database IDs sequentially (1, 2, 3...) to guarantee database integrity
      data.services.forEach((s, idx) => {
        s.id = idx + 1;
      });

      // Write cleaned database back locally
      try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.error('⚠️ Could not save self-healed DB locally:', e);
      }
      
      // Sync self-healed DB to Vercel KV if online
      if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        const url = `${process.env.KV_REST_API_URL}/set/db_json`;
        const token = process.env.KV_REST_API_TOKEN;
        fetch(url, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(JSON.stringify(data))
        }).then(res => {
          if (res.ok) console.log('☁️ Vercel KV sync of self-healed DB successful!');
        }).catch(err => {});
      }
    }
  }

  // Guarantee that aruljothiarasu620@gmail.com exists as an admin with password '123456'
  const adminEmail = 'aruljothiarasu620@gmail.com';
  const adminHash = crypto.createHash('sha256').update('123456').digest('hex');
  
  if (!data.users) data.users = [];
  let adminUser = data.users.find(u => u.email.toLowerCase() === adminEmail);
  if (!adminUser) {
    adminUser = {
      id: data.users.length > 0 ? Math.max(...data.users.map(u => u.id)) + 1 : 1,
      name: 'Arul Admin',
      email: adminEmail,
      password: adminHash,
      balance: 100000, // Pre-fund admin
      token: null,
      role: 'admin',
      created_at: new Date().toISOString()
    };
    data.users.push(adminUser);
    try {
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
  } else {
    if (adminUser.role !== 'admin' || adminUser.password !== adminHash) {
      adminUser.role = 'admin';
      adminUser.password = adminHash;
      try {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {}
    }
  }

  return data;
}

let disableWrite = false;
let pendingSyncPromise = null;
let syncLogs = [];

function logSync(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  syncLogs.push(line);
  if (syncLogs.length > 50) syncLogs.shift();
}

function writeData(data) {
  if (disableWrite) {
    cachedData = data;
    return;
  }
  
  // Write locally first for instant responses
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logSync(`⚠️ Error writing local database: ${err.message}`);
  }
  cachedData = data;

  // Sync to Vercel KV in the background (asynchronous)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    pendingSyncPromise = fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', 'db_json', JSON.stringify(data)])
    }).then(async res => {
      const text = await res.text();
      if (res.ok) {
        try {
          const body = JSON.parse(text);
          if (body && body.error) {
            logSync(`⚠️ Vercel KV Redis command error: ${body.error}`);
          } else {
            logSync('☁️ Vercel KV sync successful!');
          }
        } catch (e) {
          logSync('☁️ Vercel KV sync successful (non-JSON response)!');
        }
      } else {
        logSync(`⚠️ Vercel KV sync returned status ${res.status}: ${text}`);
      }
      pendingSyncPromise = null;
    }).catch(err => {
      logSync(`⚠️ Vercel KV sync failed: ${err.message}`);
      pendingSyncPromise = null;
    });
  } else {
    // Fallback to Cloud KV in the background (asynchronous) natively using node fetch
    pendingSyncPromise = fetch('https://kvdb.io/JS9f9tqBYYq46Qkqi8Z21s/db_json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(async res => {
      if (res.ok) {
        logSync('☁️ SMM Cloud KV sync successful!');
      } else {
        const text = await res.text();
        logSync(`⚠️ SMM Cloud KV sync returned status ${res.status}: ${text}`);
      }
      pendingSyncPromise = null;
    }).catch(err => {
      logSync(`⚠️ SMM Cloud KV sync failed: ${err.message}`);
      pendingSyncPromise = null;
    });
  }
}

// Time-based and forced caching layer to maintain consistency across Vercel serverless containers
let cachedData = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 1500; // Cache for 1.5 seconds to avoid multiple fetches during a single API request

function getFreshData(force = false) {
  // If we are in the middle of a transaction, return cachedData immediately to preserve transactional state
  if (disableWrite && cachedData) {
    return cachedData;
  }

  const now = Date.now();
  if (force || !cachedData || (now - lastFetchTime > CACHE_TTL_MS)) {
    cachedData = readData();
    lastFetchTime = now;
  }
  return cachedData;
}

class Statement {
  constructor(sql) {
    this.sql = sql.trim().replace(/\s+/g, ' ');
  }

  get(...params) {
    const data = getFreshData();
    // 1. SELECT id FROM users WHERE email = ?
    if (this.sql.includes('SELECT id FROM users WHERE email = ?')) {
      const email = params[0];
      const user = data.users.find(u => u.email === email);
      return user ? { id: user.id } : undefined;
    }
    // 2. SELECT * FROM users WHERE email = ? AND password = ?
    if (this.sql.includes('SELECT * FROM users WHERE email = ? AND password = ?')) {
      const [email, password] = params;
      const user = data.users.find(u => u.email === email && u.password === password);
      return user ? { ...user } : undefined;
    }
    // 3. SELECT id, name, email, balance, role FROM users WHERE id = ?
    if (this.sql.includes('SELECT id, name, email, balance, role FROM users WHERE id = ?')) {
      const id = params[0];
      const user = data.users.find(u => u.id === id);
      return user ? { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role } : undefined;
    }
    // 4. SELECT * FROM services WHERE id = ?
    if (this.sql.includes('SELECT * FROM services WHERE id = ?')) {
      const id = params[0];
      const svc = data.services.find(s => s.id === Number(id));
      return svc ? { ...svc } : undefined;
    }
    // 5. SELECT * FROM users WHERE id = ?
    if (this.sql.includes('SELECT * FROM users WHERE id = ?')) {
      const id = params[0];
      const user = data.users.find(u => u.id === id);
      return user ? { ...user } : undefined;
    }
    // 6. SELECT * FROM transactions WHERE razorpay_order_id = ?
    if (this.sql.includes('SELECT * FROM transactions WHERE razorpay_order_id = ?')) {
      const orderId = params[0];
      const txn = data.transactions.find(t => t.razorpay_order_id === orderId);
      return txn ? { ...txn } : undefined;
    }
    // 7. SELECT * FROM users WHERE token = ?
    if (this.sql.includes('SELECT * FROM users WHERE token = ?')) {
      const token = params[0];
      const user = data.users.find(u => u.token === token);
      return user ? { ...user } : undefined;
    }
    // 8. SELECT COUNT(*) as c FROM services
    if (this.sql.includes('SELECT COUNT(*) as c FROM services')) {
      return { c: data.services.length };
    }
    // 9. SELECT * FROM orders WHERE id = ?
    if (this.sql.includes('SELECT * FROM orders WHERE id = ?')) {
      const id = params[0];
      const order = data.orders.find(o => o.id === Number(id));
      return order ? { ...order } : undefined;
    }

    // 10. SELECT id FROM services WHERE provider_service_id = ?
    if (this.sql.includes('SELECT id FROM services WHERE provider_service_id = ?')) {
      const pId = String(params[0]).trim();
      const svc = data.services.find(s => s.provider_service_id && String(s.provider_service_id).trim() === pId);
      return svc ? { id: svc.id } : undefined;
    }

    // 11. SELECT id, rate FROM services WHERE platform = ? AND LOWER(name) = ?
    if (this.sql.includes('SELECT id, rate FROM services WHERE platform = ? AND LOWER(name) = ?')) {
      const [platform, name] = params;
      const svc = data.services.find(s => s.platform === platform && s.name.trim().toLowerCase() === name.trim().toLowerCase());
      return svc ? { id: svc.id, rate: svc.rate } : undefined;
    }

    console.log('UNHANDLED GET QUERY:', this.sql, params);
    return undefined;
  }

  run(...params) {
    const data = disableWrite ? cachedData : getFreshData(true);
    let lastInsertRowid = 0;
    let changes = 0;

    // 1. INSERT INTO users (name, email, password, balance)
    if (this.sql.includes('INSERT INTO users (name, email, password, balance)')) {
      const [name, email, password] = params;
      const id = data.users.length > 0 ? Math.max(...data.users.map(u => u.id)) + 1 : 1;
      const role = email.toLowerCase() === 'aruljothiarasu620@gmail.com' ? 'admin' : 'user';
      data.users.push({
        id,
        name,
        email,
        password,
        balance: 0,
        token: null,
        role,
        created_at: new Date().toISOString()
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 2. UPDATE users SET token = ? WHERE id = ?
    else if (this.sql.includes('UPDATE users SET token = ? WHERE id = ?')) {
      const [token, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) {
        user.token = token;
        changes = 1;
      }
    }
    // 3. UPDATE users SET balance = balance - ? WHERE id = ?
    else if (this.sql.includes('UPDATE users SET balance = balance - ? WHERE id = ?')) {
      const [charge, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) {
        user.balance = parseFloat((user.balance - charge).toFixed(2));
        changes = 1;
      }
    }
    // 4. UPDATE users SET balance = balance + ? WHERE id = ?
    else if (this.sql.includes('UPDATE users SET balance = balance + ? WHERE id = ?')) {
      const [amount, id] = params;
      const user = data.users.find(u => u.id === id);
      if (user) {
        user.balance = parseFloat((user.balance + amount).toFixed(2));
        changes = 1;
      }
    }
    // 5. INSERT INTO orders
    else if (this.sql.includes('INSERT INTO orders (user_id, service_id, link, quantity, charge, status, provider_order_id, created_at)')) {
      const [user_id, service_id, link, quantity, charge] = params;
      const id = data.orders.length > 0 ? Math.max(...data.orders.map(o => o.id)) + 1 : 1;
      data.orders.push({
        id,
        user_id,
        service_id,
        link,
        quantity,
        charge,
        status: 'pending',
        provider_order_id: null,
        remains: 0,
        notes: null,
        created_at: new Date().toISOString()
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 6. UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?
    else if (this.sql.includes("UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?")) {
      const [provider_order_id, id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) {
        order.provider_order_id = provider_order_id;
        order.status = 'processing';
        changes = 1;
      }
    }
    // 7. UPDATE orders SET status = 'failed', notes = ? WHERE id = ?
    else if (this.sql.includes("UPDATE orders SET status = 'failed', notes = ? WHERE id = ?")) {
      const [notes, id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) {
        order.status = 'failed';
        order.notes = notes;
        changes = 1;
      }
    }
    // 8. UPDATE orders SET status = 'retry', notes = ? WHERE id = ?
    else if (this.sql.includes("UPDATE orders SET status = 'retry', notes = ? WHERE id = ?")) {
      const [notes, id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) {
        order.status = 'retry';
        order.notes = notes;
        changes = 1;
      }
    }
    // 9. INSERT INTO transactions
    else if (this.sql.includes('INSERT INTO transactions (user_id, razorpay_order_id, amount, status, created_at)')) {
      const [user_id, razorpay_order_id, amount] = params;
      const id = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.id)) + 1 : 1;
      data.transactions.push({
        id,
        user_id,
        razorpay_order_id,
        razorpay_payment_id: null,
        amount,
        status: 'pending',
        created_at: new Date().toISOString()
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 9b. INSERT INTO transactions with custom payment ID (e.g. manual admin)
    else if (this.sql.includes('INSERT INTO transactions (user_id, razorpay_order_id, razorpay_payment_id, amount, status, created_at)')) {
      const [user_id, razorpay_order_id, razorpay_payment_id, amount, status] = params;
      const id = data.transactions.length > 0 ? Math.max(...data.transactions.map(t => t.id)) + 1 : 1;
      data.transactions.push({
        id,
        user_id,
        razorpay_order_id,
        razorpay_payment_id,
        amount,
        status,
        created_at: new Date().toISOString()
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 10. UPDATE transactions SET status = ?, razorpay_payment_id = ? WHERE id = ?
    else if (this.sql.includes('UPDATE transactions SET status = ?, razorpay_payment_id = ? WHERE id = ?')) {
      const [status, razorpay_payment_id, id] = params;
      const txn = data.transactions.find(t => t.id === id);
      if (txn) {
        txn.status = status;
        txn.razorpay_payment_id = razorpay_payment_id;
        changes = 1;
      }
    }
    // 11. UPDATE orders SET status = ? WHERE id = ?
    else if (this.sql.includes('UPDATE orders SET status = ? WHERE id = ?')) {
      const [status, id] = params;
      const order = data.orders.find(o => o.id === Number(id));
      if (order) {
        order.status = status;
        changes = 1;
      }
    }
    // 12. UPDATE services SET provider_service_id = ? WHERE id = ?
    else if (this.sql.includes('UPDATE services SET provider_service_id = ? WHERE id = ?')) {
      const [provider_service_id, id] = params;
      const svc = data.services.find(s => s.id === Number(id));
      if (svc) {
        svc.provider_service_id = provider_service_id;
        changes = 1;
      }
    }
    // 13. UPDATE orders SET status = ?, remains = ? WHERE id = ?
    else if (this.sql.includes('UPDATE orders SET status = ?, remains = ? WHERE id = ?')) {
      const [status, remains, id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) {
        order.status = status;
        order.remains = remains;
        changes = 1;
      }
    }
    // 14. UPDATE orders SET status = 'cancelled' WHERE id = ?
    else if (this.sql.includes("UPDATE orders SET status = 'cancelled' WHERE id = ?")) {
      const [id] = params;
      const order = data.orders.find(o => o.id === id);
      if (order) {
        order.status = 'cancelled';
        changes = 1;
      }
    }
    // 16. INSERT INTO services with 9 columns (importing services)
    else if (this.sql.includes('INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active)')) {
      const [platform, name, description, rate, min_qty, max_qty, delivery_time, provider_service_id, active] = params;
      const id = data.services.length > 0 ? Math.max(...data.services.map(s => s.id)) + 1 : 1;
      data.services.push({
        id,
        platform,
        name,
        description,
        rate,
        min_qty,
        max_qty,
        delivery_time,
        provider_service_id,
        active: active !== undefined ? active : 1
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 15. INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time)
    else if (this.sql.includes('INSERT INTO services (platform, name, description, rate, min_qty, max_qty, delivery_time')) {
      const [platform, name, description, rate, min_qty, max_qty, delivery_time] = params;
      const id = data.services.length > 0 ? Math.max(...data.services.map(s => s.id)) + 1 : 1;
      data.services.push({
        id,
        platform,
        name,
        description,
        rate,
        min_qty,
        max_qty,
        delivery_time,
        provider_service_id: null,
        active: 1
      });
      lastInsertRowid = id;
      changes = 1;
    }
    // 17. UPDATE services SET rate = ?, provider_service_id = ? WHERE id = ?
    else if (this.sql.includes('UPDATE services SET rate = ?, provider_service_id = ? WHERE id = ?')) {
      const [rate, provider_service_id, id] = params;
      const svc = data.services.find(s => s.id === Number(id));
      if (svc) {
        svc.rate = rate;
        svc.provider_service_id = provider_service_id;
        changes = 1;
      }
    }

    writeData(data);
    return { lastInsertRowid, changes };
  }

  all(...params) {
    const data = getFreshData();
    // 1. SELECT * FROM services WHERE active = 1
    if (this.sql.includes('SELECT * FROM services WHERE active = 1')) {
      return data.services.filter(s => s.active === 1);
    }
    // 2. SELECT * FROM services WHERE platform = ? AND active = 1
    if (this.sql.includes('SELECT * FROM services WHERE platform = ? AND active = 1')) {
      const platform = params[0];
      return data.services.filter(s => s.platform === platform && s.active === 1);
    }
    // 3. SELECT o.*, s.name as service_name, s.platform FROM orders
    if (this.sql.includes('SELECT o.*, s.name as service_name, s.platform FROM orders o JOIN services s ON o.service_id = s.id WHERE o.user_id = ?')) {
      const userId = params[0];
      return data.orders
        .filter(o => o.user_id === userId)
        .map(o => {
          const s = data.services.find(svc => svc.id === o.service_id);
          return {
            ...o,
            service_name: s ? s.name : 'Unknown Service',
            platform: s ? s.platform : 'other'
          };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    // 4. SELECT * FROM transactions WHERE user_id = ?
    if (this.sql.includes('SELECT * FROM transactions WHERE user_id = ?')) {
      const userId = params[0];
      return data.transactions
        .filter(t => t.user_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    // 5. SELECT o.*, u.name as user_name, s.name as service_name FROM orders
    if (this.sql.includes('SELECT o.*, u.name as user_name, s.name as service_name FROM orders o JOIN users u ON o.user_id = u.id JOIN services s ON o.service_id = s.id')) {
      return data.orders
        .map(o => {
          const u = data.users.find(usr => usr.id === o.user_id);
          const s = data.services.find(svc => svc.id === o.service_id);
          return {
            ...o,
            user_name: u ? u.name : 'Unknown User',
            service_name: s ? s.name : 'Unknown Service'
          };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    // 6. SELECT id, provider_order_id FROM orders WHERE status IN ('processing', 'pending', 'retry')
    if (this.sql.includes("SELECT id, provider_order_id FROM orders WHERE status IN ('processing', 'pending', 'retry') AND provider_order_id IS NOT NULL")) {
      return data.orders
        .filter(o => ['processing', 'pending', 'retry'].includes(o.status) && o.provider_order_id !== null)
        .map(o => ({ id: o.id, provider_order_id: o.provider_order_id }));
    }
    // 7. SELECT o.*, s.provider_service_id FROM orders o JOIN services s ON o.service_id = s.id WHERE o.status = 'retry'
    if (this.sql.includes("SELECT o.*, s.provider_service_id FROM orders o JOIN services s ON o.service_id = s.id WHERE o.status = 'retry'")) {
      return data.orders
        .filter(o => o.status === 'retry')
        .map(o => {
          const s = data.services.find(svc => svc.id === o.service_id);
          return {
            ...o,
            provider_service_id: s ? s.provider_service_id : null
          };
        })
        .filter(o => o.provider_service_id !== null);
    }

    // 7b. SELECT id, name, email, balance, role, created_at FROM users
    if (this.sql.includes('SELECT id, name, email, balance, role, created_at FROM users')) {
      return data.users.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        balance: u.balance,
        role: u.role,
        created_at: u.created_at
      })).sort((a, b) => b.id - a.id);
    }

    console.log('UNHANDLED ALL QUERY:', this.sql, params);
    return [];
  }
}

const db = {
  pragma: (stmt) => {},
  exec: (stmt) => {},
  prepare: (sql) => new Statement(sql),
  getSyncLogs: () => syncLogs,
  dangerouslyResetServices: () => {
    const data = getFreshData(true); // Force fresh load
    data.services = [];
    writeData(data);
  },
  syncCloud: async () => {
    if (pendingSyncPromise) {
      console.log('⏳ Awaiting pending Vercel KV cloud sync...');
      await pendingSyncPromise;
    }
  },
  transaction: (fn) => {
    return (...args) => {
      // Ensure we have the latest state before beginning transaction
      getFreshData(true);
      const snapshot = JSON.stringify(cachedData);
      const prevDisableWrite = disableWrite;
      disableWrite = true;
      try {
        const result = fn(...args);
        disableWrite = prevDisableWrite;
        // Commit: write to disk exactly once
        writeData(cachedData);
        return result;
      } catch (err) {
        disableWrite = prevDisableWrite;
        // Rollback
        cachedData = JSON.parse(snapshot);
        throw err;
      }
    };
  }
};

module.exports = db;
