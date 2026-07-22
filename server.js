// 🩸 鹽水獅子會捐血叫號系統（PostgreSQL 版）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');

// ── 資料庫 ───────────────────────────────────
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ 無 DATABASE_URL，無法初始化資料庫');
    return;
  }
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS blood_data (
        id SERIAL PRIMARY KEY,
        current_call INTEGER DEFAULT 0,
        event_image TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: 確保 event_image 欄位存在
    try {
      const colCheck = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='blood_data' AND column_name='event_image'`
      );
      if (colCheck.rows.length === 0) {
        await client.query(`ALTER TABLE blood_data ADD COLUMN event_image TEXT`);
        console.log('✅ event_image 欄位已新增');
      }
    } catch(e) { /* ignore */ }

    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL DEFAULT 'admin',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'normal',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: 確保 role 欄位存在（舊資料庫）
    try {
      const roleCheck = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='role'`
      );
      if (roleCheck.rows.length === 0) {
        await client.query(`ALTER TABLE admin ADD COLUMN role TEXT NOT NULL DEFAULT 'normal'`);
      }
    } catch(e) { /* ignore */ }

    // Migration: 確保 username 欄位存在
    try {
      const userCheck = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='username'`
      );
      if (userCheck.rows.length === 0) {
        await client.query(`ALTER TABLE admin ADD COLUMN username TEXT UNIQUE NOT NULL DEFAULT 'admin'`);
      }
    } catch(e) { /* ignore */ }

    const c = await client.query('SELECT COUNT(*) FROM blood_data');
    if (parseInt(c.rows[0].count) === 0) {
      await client.query('INSERT INTO blood_data (current_call) VALUES (0)');
    }
    const a = await client.query('SELECT COUNT(*) FROM announcements');
    if (parseInt(a.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO announcements (content, sort_order) VALUES
        ('歡迎來到鹽水獅子會捐血活動！', 1),
        ('請已登記的朋友留意叫號通知', 2),
        ('LINE Bot 輸入「幾號」查詢叫號進度', 3)
      `);
    }
    const ad = await client.query('SELECT COUNT(*) FROM admin');
    if (parseInt(ad.rows[0].count) === 0) {
      const hash = crypto.createHash('sha256').update('0000').digest('hex');
      await client.query('INSERT INTO admin (username, password_hash, role) VALUES ($1, $2, $3)', ['admin', hash, 'super']);
    }
    console.log('✅ 資料庫初始化完成');
  } finally {
    client.release();
  }
}

function verifyPassword(input, storedHash) {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash === storedHash;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/json',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath, mime) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function authenticateAdmin(req) {
  // 從 request body 中解析密碼
  // 實際驗證在 handleAPI 中透過 pool query 處理
  return true;
}

async function handleAPI(req, res, url) {
  const u = new URL(url, 'http://x');
  const pathname = u.pathname;
  const body = await parseBody(req);
  let json = {};
  try { json = JSON.parse(body || '{}'); } catch {}

  // 通用密碼驗證
  const checkAuth = async (pwd, requireSuper) => {
    if (!process.env.DATABASE_URL) return { ok: true, role: 'super' };
    const p = getPool();
    const r = await p.query('SELECT password_hash, role FROM admin LIMIT 1');
    if (r.rows.length === 0) return { ok: false, role: null };
    const match = verifyPassword(pwd, r.rows[0].password_hash);
    if (!match) return { ok: false, role: null };
    if (requireSuper && r.rows[0].role !== 'super') return { ok: false, role: 'normal', message: '需要超級管理者權限' };
    return { ok: true, role: r.rows[0].role };
  };

  // GET /api/data — 公開
  if (req.method === 'GET' && pathname === '/api/data') {
    if (!process.env.DATABASE_URL) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentCall: 0, announcements: [], lastUpdated: null }));
      return;
    }
    try {
      const p = getPool();
      const [callRes, annRes] = await Promise.all([
        p.query('SELECT current_call, event_image, last_updated FROM blood_data ORDER BY id DESC LIMIT 1'),
        p.query('SELECT id, content FROM announcements ORDER BY sort_order, id'),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        currentCall: callRes.rows[0]?.current_call || 0,
        eventImage: callRes.rows[0]?.event_image || '',
        lastUpdated: callRes.rows[0]?.last_updated,
        announcements: annRes.rows.map(r => ({ id: r.id, content: r.content })),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/login
  if (req.method === 'POST' && pathname === '/api/login') {
    const { password } = json;
    const auth = await checkAuth(password, false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: auth.ok, message: auth.message || (auth.ok ? '登入成功' : '密碼錯誤'), role: auth.role }));
    return;
  }

  // POST /api/update-call — 所有管理者可用
  if (req.method === 'POST' && pathname === '/api/update-call') {
    const { call, password: pwd } = json;
    const auth = await checkAuth(pwd, false);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '密碼錯誤' }));
      return;
    }
    const p = getPool();
    await p.query('UPDATE blood_data SET current_call=$1, last_updated=NOW() WHERE id=1', [parseInt(call) || 0]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, currentCall: parseInt(call) }));
    return;
  }

  // POST /api/update-event-image — 需超級管理者
  if (req.method === 'POST' && pathname === '/api/update-event-image') {
    const { eventImage, password: pwd } = json;
    const auth = await checkAuth(pwd, true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const p = getPool();
    await p.query('UPDATE blood_data SET event_image=$1, last_updated=NOW() WHERE id=1', [eventImage || '']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/update-announcements — 需超級管理者
  if (req.method === 'POST' && pathname === '/api/update-announcements') {
    const { announcements: anns, password: pwd } = json;
    const auth = await checkAuth(pwd, true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const p = getPool();
    await p.query('DELETE FROM announcements');
    for (let i = 0; i < anns.length; i++) {
      const v = (anns[i] || '').trim();
      if (v) await p.query('INSERT INTO announcements (content, sort_order) VALUES ($1, $2)', [v, i + 1]);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/update-password — 需超級管理者
  if (req.method === 'POST' && pathname === '/api/update-password') {
    const { newPassword, oldPassword, password: pwd } = json;
    const auth = await checkAuth(pwd, true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    if (!newPassword || newPassword.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '新密碼至少4位' }));
      return;
    }
    const p = getPool();
    const hash = crypto.createHash('sha256').update(newPassword).digest('hex');
    await p.query('UPDATE admin SET password_hash=$1', [hash]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: '密碼已更改' }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    await handleAPI(req, res, req.url);
    return;
  }
  if (url === '/' || url === '/index.html') {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (url === '/admin' || url === '/admin.html' || url === '/admin/') {
    serveFile(res, path.join(ADMIN_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  const ext = path.extname(url);
  const mime = MIME[ext] || 'application/octet-stream';
  const filePath = path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(res, filePath, mime);
});

(async () => {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('🩸 捐血叫號系統已啟動（PostgreSQL 版）');
    console.log('📋 公開網站：http://0.0.0.0:' + PORT + '/');
    console.log('🔧 管理後台：http://0.0.0.0:' + PORT + '/admin');
  });
})();
