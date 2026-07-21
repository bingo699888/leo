// ==========================================
// 🩸 鹽水獅子會捐血叫號系統 - 完整版
// ==========================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');

// ── 資料庫初始化 ──────────────────────────────
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ 沒有 DATABASE_URL，使用唯讀模式');
    return;
  }
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS blood_call (
        id SERIAL PRIMARY KEY,
        current_call INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin (
        id SERIAL PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // 初始化一筆叫號資料
    const r = await client.query('SELECT COUNT(*) FROM blood_call');
    if (parseInt(r.rows[0].count) === 0) {
      await client.query('INSERT INTO blood_call (current_call) VALUES (0)');
    }
    // 初始化公告
    const a = await client.query('SELECT COUNT(*) FROM announcements');
    if (parseInt(a.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO announcements (content, sort_order) VALUES
        ('歡迎來到鹽水獅子會捐血活動！', 1),
        ('請已登記的朋友留意叫號通知', 2),
        ('可用 LINE Bot 查詢：「幾號」', 3)
      `);
    }
    // 初始化管理員密碼（預設 0000）
    const ad = await client.query('SELECT COUNT(*) FROM admin');
    if (parseInt(ad.rows[0].count) === 0) {
      const hash = crypto.createHash('sha256').update('0000').digest('hex');
      await client.query('INSERT INTO admin (password_hash) VALUES ($1)', [hash]);
    }
    console.log('✅ 資料庫初始化完成');
  } finally {
    client.release();
  }
}

// ── 密碼驗證 ──────────────────────────────────
function verifyPassword(input, storedHash) {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash === storedHash;
}

// ── MIME 類型 ──────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// ── 請求處理 ──────────────────────────────────
function serveFile(res, filePath, mime) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function serveJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleAPI(req, res, url) {
  const u = new URL(url, 'http://x');
  const pathname = u.pathname;

  // GET /api/data - 公開取得叫號 + 公告
  if (req.method === 'GET' && pathname === '/api/data') {
    if (!process.env.DATABASE_URL) {
      // 無 DB，回傳預設
      serveJSON(res, { currentCall: 0, announcements: ['歡迎來到鹽水獅子會！'] });
      return;
    }
    try {
      const p = getPool();
      const [callRes, annRes, regRes] = await Promise.all([
        p.query('SELECT current_call, last_updated FROM blood_call ORDER BY id DESC LIMIT 1'),
        p.query('SELECT id, content FROM announcements ORDER BY sort_order'),
        p.query('SELECT COUNT(*) FROM users'),
      ]);
      serveJSON(res, {
        currentCall: callRes.rows[0]?.current_call || 0,
        lastUpdated: callRes.rows[0]?.last_updated,
        announcements: annRes.rows.map(r => ({ id: r.id, content: r.content })),
        registeredCount: parseInt(regRes.rows[0]?.count || 0),
      });
    } catch (e) {
      console.error('DB error:', e.message);
      serveJSON(res, { error: e.message }, 500);
    }
    return;
  }

  // POST /api/login - 管理員登入
  if (req.method === 'POST' && pathname === '/api/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { password } = JSON.parse(body || '{}');
      if (!process.env.DATABASE_URL) {
        // 簡單驗證
        const ok = password === '0000';
        serveJSON(res, { ok, message: ok ? '登入成功' : '密碼錯誤' });
        return;
      }
      try {
        const p = getPool();
        const r = await p.query('SELECT password_hash FROM admin LIMIT 1');
        if (r.rows.length === 0) { serveJSON(res, { ok: false, message: '無管理者' }, 401); return; }
        const ok = verifyPassword(password, r.rows[0].password_hash);
        serveJSON(res, { ok, message: ok ? '登入成功' : '密碼錯誤' });
      } catch (e) {
        serveJSON(res, { ok: false, message: e.message }, 500);
      }
    });
    return;
  }

  // POST /api/update-call - 更新叫號
  if (req.method === 'POST' && pathname === '/api/update-call') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { call, password } = JSON.parse(body || '{}');
      if (!process.env.DATABASE_URL) {
        serveJSON(res, { ok: true });
        return;
      }
      try {
        const p = getPool();
        const r = await p.query('SELECT password_hash FROM admin LIMIT 1');
        if (!verifyPassword(password, r.rows[0]?.password_hash)) {
          serveJSON(res, { ok: false, message: '密碼錯誤' }, 401); return;
        }
        await p.query('UPDATE blood_call SET current_call=$1, last_updated=NOW() WHERE id=1', [parseInt(call) || 0]);
        serveJSON(res, { ok: true, currentCall: parseInt(call) });
      } catch (e) {
        serveJSON(res, { ok: false, message: e.message }, 500);
      }
    });
    return;
  }

  // POST /api/update-announcements - 更新公告
  if (req.method === 'POST' && pathname === '/api/update-announcements') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { announcements, password } = JSON.parse(body || '{}');
      if (!process.env.DATABASE_URL) {
        serveJSON(res, { ok: true });
        return;
      }
      try {
        const p = getPool();
        const r = await p.query('SELECT password_hash FROM admin LIMIT 1');
        if (!verifyPassword(password, r.rows[0]?.password_hash)) {
          serveJSON(res, { ok: false, message: '密碼錯誤' }, 401); return;
        }
        await p.query('DELETE FROM announcements');
        for (let i = 0; i < announcements.length; i++) {
          await p.query('INSERT INTO announcements (content, sort_order) VALUES ($1, $2)', [announcements[i], i + 1]);
        }
        serveJSON(res, { ok: true });
      } catch (e) {
        serveJSON(res, { ok: false, message: e.message }, 500);
      }
    });
    return;
  }

  // 404
  res.writeHead(404); res.end('404');
}

// ── HTTP 伺服器 ────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // API 路由
  if (url.startsWith('/api/')) {
    await handleAPI(req, res, req.url);
    return;
  }

  // 公開頁面
  if (url === '/' || url === '/index.html') {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (url === '/admin' || url === '/admin.html') {
    serveFile(res, path.join(ADMIN_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // 靜態資源
  const ext = path.extname(url);
  const mime = MIME[ext] || 'application/octet-stream';
  const filePath = path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, filePath, mime);
});

(async () => {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🩸 捐血叫號系統已啟動：http://0.0.0.0:${PORT}`);
    console.log(`📋 公開網站：http://0.0.0.0:${PORT}/`);
    console.log(`🔧 管理後台：http://0.0.0.0:${PORT}/admin`);
  });
})();
