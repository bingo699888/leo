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
  if (!process.env.DATABASE_URL) { console.log('⚠️ 無 DATABASE_URL'); return; }
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
    try {
      const col = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='blood_data' AND column_name='event_image'`);
      if (col.rows.length === 0) await client.query(`ALTER TABLE blood_data ADD COLUMN event_image TEXT`);
    } catch(e) {}

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
        role TEXT NOT NULL DEFAULT 'super',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
      const roleCol = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='role'`);
      if (roleCol.rows.length === 0) await client.query(`ALTER TABLE admin ADD COLUMN role TEXT NOT NULL DEFAULT 'super'`);
    } catch(e) {}
    try {
      const userCol = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='username'`);
      if (userCol.rows.length === 0) await client.query(`ALTER TABLE admin ADD COLUMN username TEXT UNIQUE NOT NULL DEFAULT 'admin'`);
    } catch(e) {}

    // 確保密碼 0000 的帳號是 super
    const hash0000 = crypto.createHash('sha256').update('0000').digest('hex');
    try {
      const r = await client.query(`SELECT id, role FROM admin WHERE password_hash=$1`, [hash0000]);
      if (r.rows.length > 0 && r.rows[0].role !== 'super') {
        await client.query(`UPDATE admin SET role='super' WHERE password_hash=$1`, [hash0000]);
        console.log('✅ 已將 admin 角色設為 super');
      }
    } catch(e) {}

    const c = await client.query('SELECT COUNT(*) FROM blood_data');
    if (parseInt(c.rows[0].count) === 0) await client.query('INSERT INTO blood_data (current_call) VALUES (0)');

    const a = await client.query('SELECT COUNT(*) FROM announcements');
    if (parseInt(a.rows[0].count) === 0) {
      await client.query(`INSERT INTO announcements (content, sort_order) VALUES ('歡迎來到鹽水獅子會捐血活動！',1),('請已登記的朋友留意叫號通知',2),('LINE Bot 輸入「幾號」查詢叫號進度',3)`);
    }

    const ad = await client.query('SELECT COUNT(*) FROM admin');
    if (parseInt(ad.rows[0].count) === 0) {
      await client.query('INSERT INTO admin (username, password_hash, role) VALUES ($1,$2,$3)', ['admin', hash0000, 'super']);
    }
    console.log('✅ 資料庫初始化完成');
  } finally {
    client.release();
  }
}

function verifyPassword(input, storedHash) {
  return crypto.createHash('sha256').update(input).digest('hex') === storedHash;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
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

// 簡單的 multipart 解析（用於圖片上傳）
function parseMultipart(body, boundary) {
  const parts = body.split('--' + boundary).filter(p => p.trim() && !p.startsWith('--'));
  const result = {};
  for (const part of parts) {
    const [header, ...bodyParts] = part.split('\r\n\r\n');
    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]+)"/);
    if (nameMatch) {
      const name = nameMatch[1];
      const content = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');
      if (filenameMatch) {
        result[name] = { filename: filenameMatch[1], content, binary: true };
      } else {
        result[name] = content;
      }
    }
  }
  return result;
}

async function handleAPI(req, res, url) {
  const u = new URL(url, 'http://x');
  const pathname = u.pathname;
  const body = await parseBody(req);

  // ── 圖片上傳（ multipart/form-data ）─
  const contentType = req.headers['content-type'] || '';
  let json = {};
  let formData = {};

  if (contentType.includes('multipart/form-data')) {
    const boundary = contentType.split('boundary=')[1];
    if (boundary) formData = parseMultipart(body, boundary);
  } else {
    try { json = JSON.parse(body || '{}'); } catch {}
  }

  // 從 multipart 或 json 中取 admin密碼
  const adminPwd = formData.admin_password || json.admin_password || '';
  const checkAuth = async (requireSuper) => {
    if (!process.env.DATABASE_URL) return { ok: true, role: 'super' };
    const p = getPool();
    const r = await p.query('SELECT password_hash, role FROM admin LIMIT 1');
    if (r.rows.length === 0) return { ok: false, role: null };
    const match = verifyPassword(adminPwd, r.rows[0].password_hash);
    if (!match) return { ok: false, role: null };
    if (requireSuper && r.rows[0].role !== 'super') return { ok: false, role: 'normal', message: '需要超級管理者權限' };
    return { ok: true, role: r.rows[0].role };
  };

  // GET /api/data
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
    const pwd = json.password || '';
    const auth = await checkAuth(false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: auth.ok, message: auth.ok ? '登入成功' : '密碼錯誤', role: auth.role }));
    return;
  }

  // POST /api/update-call（所有管理者）
  if (req.method === 'POST' && pathname === '/api/update-call') {
    const auth = await checkAuth(false);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '密碼錯誤' }));
      return;
    }
    const call = formData.call || json.call || 0;
    const p = getPool();
    await p.query('UPDATE blood_data SET current_call=$1, last_updated=NOW() WHERE id=1', [parseInt(call) || 0]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, currentCall: parseInt(call) }));
    return;
  }

  // POST /api/upload-image（超級管理者，multipart）
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    const auth = await checkAuth(true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const file = formData.image;
    if (!file || !file.binary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '沒有上傳圖片' }));
      return;
    }
    // 使用 imgbb 免費圖床
    const imgbbKey = process.env.IMGBB_KEY || '0dfa6b64c5366eda8fd5e8a5e9b3d12c';
    const FormData = require('form-data');
    const form = new FormData();
    form.append('image', Buffer.from(file.content), {
      filename: file.filename || 'upload.jpg',
      contentType: 'application/octet-stream',
    });
    try {
      const axios = require('axios');
      const resp = await axios.post('https://api.imgbb.com/1/upload?key=' + imgbbKey, form, {
        headers: form.getHeaders(),
        maxBodyLength: 10 * 1024 * 1024,
      });
      const imageUrl = resp.data?.data?.url || '';
      if (imageUrl) {
        const p = getPool();
        await p.query('UPDATE blood_data SET event_image=$1, last_updated=NOW() WHERE id=1', [imageUrl]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: imageUrl }));
      } else {
        throw new Error('imgbb 無回傳網址');
      }
    } catch(e) {
      console.error('imgbb upload error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '上傳失敗：' + e.message }));
    }
    return;
  }

  // POST /api/update-event-image（超級管理者）
  if (req.method === 'POST' && pathname === '/api/update-event-image') {
    const auth = await checkAuth(true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const img = formData.event_image || json.eventImage || '';
    const p = getPool();
    await p.query('UPDATE blood_data SET event_image=$1, last_updated=NOW() WHERE id=1', [img]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/update-announcements（超級管理者）
  if (req.method === 'POST' && pathname === '/api/update-announcements') {
    const auth = await checkAuth(true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const anns = formData.announcements || json.announcements || [];
    const p = getPool();
    await p.query('DELETE FROM announcements');
    for (let i = 0; i < anns.length; i++) {
      const v = String(anns[i]).trim();
      if (v) await p.query('INSERT INTO announcements (content, sort_order) VALUES ($1, $2)', [v, i + 1]);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/update-password（超級管理者）
  if (req.method === 'POST' && pathname === '/api/update-password') {
    const auth = await checkAuth(true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const newPwd = json.newPassword || '';
    if (!newPwd || newPwd.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '新密碼至少4位' }));
      return;
    }
    const p = getPool();
    const hash = crypto.createHash('sha256').update(newPwd).digest('hex');
    await p.query('UPDATE admin SET password_hash=$1', [hash]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: '密碼已更改' }));
    return;
  }

  // GET /api/admin/users（超級管理者）
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const pwd = u.searchParams.get('admin_password') || '';
    const auth2 = async () => {
      if (!process.env.DATABASE_URL) return { ok: true, role: 'super' };
      const p = getPool();
      const r = await p.query('SELECT password_hash, role FROM admin LIMIT 1');
      if (r.rows.length === 0) return { ok: false, role: null };
      const match = verifyPassword(pwd, r.rows[0].password_hash);
      if (!match) return { ok: false, role: null };
      if (r.rows[0].role !== 'super') return { ok: false, role: 'normal', message: '需要超級管理者權限' };
      return { ok: true, role: r.rows[0].role };
    };
    const auth = await auth2();
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授權' }));
      return;
    }
    const p = getPool();
    const r = await p.query('SELECT id, username, role, created_at FROM admin ORDER BY id');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: r.rows }));
    return;
  }

  // POST /api/admin/users（超級管理者）
  if (req.method === 'POST' && pathname === '/api/admin/users') {
    const auth = await checkAuth(true);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' }));
      return;
    }
    const username = json.username || '';
    const newPwd = json.password || '';
    const role = json.role || 'normal';
    if (!username || username.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '帳號至少2個字元' }));
      return;
    }
    if (!newPwd || newPwd.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '密碼至少4位' }));
      return;
    }
    if (!['normal', 'super'].includes(role)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '角色必須是 normal 或 super' }));
      return;
    }
    const newHash = crypto.createHash('sha256').update(newPwd).digest('hex');
    const p = getPool();
    try {
      await p.query('INSERT INTO admin (username, password_hash, role) VALUES ($1, $2, $3)', [username, newHash, role]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '管理者已新增' }));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '帳號已存在' }));
    }
    return;
  }

  // DELETE /api/admin/users/:id（超級管理者）
  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
    const pwd = u.searchParams.get('admin_password') || '';
    const auth2 = async () => {
      if (!process.env.DATABASE_URL) return { ok: true, role: 'super' };
      const p = getPool();
      const r = await p.query('SELECT password_hash, role FROM admin LIMIT 1');
      if (r.rows.length === 0) return { ok: false, role: null };
      const match = verifyPassword(pwd, r.rows[0].password_hash);
      if (!match) return { ok: false, role: null };
      if (r.rows[0].role !== 'super') return { ok: false, role: 'normal', message: '需要超級管理者權限' };
      return { ok: true, role: r.rows[0].role };
    };
    const auth = await auth2();
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '密碼錯誤' }));
      return;
    }
    const id = pathname.split('/').pop();
    const p = getPool();
    await p.query('DELETE FROM admin WHERE id=$1', [id]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { await handleAPI(req, res, req.url); return; }
  if (url === '/' || url === '/index.html') { serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8'); return; }
  if (url === '/admin' || url === '/admin.html' || url === '/admin/') { serveFile(res, path.join(ADMIN_DIR, 'index.html'), 'text/html; charset=utf-8'); return; }
  const ext = path.extname(url);
  const mime = MIME[ext] || 'application/octet-stream';
  const filePath = path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
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
