// 🩸 捐血叫號系統 - 加入圖片上傳功能
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 確保上傳資料夾存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
      const rc = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='role'`);
      if (rc.rows.length === 0) await client.query(`ALTER TABLE admin ADD COLUMN role TEXT NOT NULL DEFAULT 'super'`);
    } catch(e) {}
    try {
      const uc = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='admin' AND column_name='username'`);
      if (uc.rows.length === 0) await client.query(`ALTER TABLE admin ADD COLUMN username TEXT UNIQUE NOT NULL DEFAULT 'admin'`);
    } catch(e) {}

    const hash0000 = crypto.createHash('sha256').update('0000').digest('hex');
    try {
      const r = await client.query(`SELECT id, role FROM admin WHERE password_hash=$1`, [hash0000]);
      if (r.rows.length > 0 && r.rows[0].role !== 'super') {
        await client.query(`UPDATE admin SET role='super' WHERE password_hash=$1`, [hash0000]);
        console.log('✅ 已設為 super');
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
  '.jpeg': 'image/jpeg',
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

// 讀取原始 body（文字用）
// 統一用 binary 讀取，再自行解碼
function getReqBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function handleAPI(req, res, url) {
  const u = new URL(url, 'http://x');
  const pathname = u.pathname;
  const rawBody = await getReqBody(req);
  const contentType = req.headers['content-type'] || '';
  const body = rawBody.toString('utf8');
  let json = {};
  try { json = JSON.parse(body || '{}'); } catch {}

  const adminPwd = json.admin_password || json.password || '';

  const checkAuth = async (requireSuper) => {
    if (!process.env.DATABASE_URL) return { ok: true, role: 'super' };
    const p = getPool();
    const r = await p.query('SELECT password_hash, role FROM admin ORDER BY CASE WHEN role=$1 THEN 0 ELSE 1 END LIMIT 1', ['super']);
    if (r.rows.length === 0) return { ok: false, role: null };
    const match = verifyPassword(adminPwd, r.rows[0].password_hash);
    if (!match) return { ok: false, role: null };
    if (requireSuper && r.rows[0].role !== 'super') return { ok: false, role: 'normal', message: '需要超級管理者權限' };
    return { ok: true, role: r.rows[0].role };
  };

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
      let imageUrl = callRes.rows[0]?.event_image || '';
      // 如果是本地檔案路徑，補上完整 URL
      if (imageUrl && imageUrl.startsWith('/uploads/')) {
        imageUrl = 'https://leo-production-b7b3.up.railway.app' + imageUrl;
      }
      res.end(JSON.stringify({
        currentCall: callRes.rows[0]?.current_call || 0,
        eventImage: imageUrl,
        lastUpdated: callRes.rows[0]?.last_updated,
        announcements: annRes.rows.map(r => ({ id: r.id, content: r.content })),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const loginPwd = json.password || '';
    // 依帳號名稱查詢（支援多帳號）
    if (!process.env.DATABASE_URL) {
      const ok = loginPwd === '0000';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, message: ok ? '登入成功' : '密碼錯誤', role: ok ? 'super' : null }));
      return;
    }
    const p = getPool();
    // 先用 username 查（如果有的話），否則查第一筆
    let r;
    if (json.username) {
      r = await p.query('SELECT password_hash, role FROM admin WHERE username=$1 LIMIT 1', [json.username]);
    }
    if (!r || r.rows.length === 0) {
      r = await p.query('SELECT password_hash, role FROM admin LIMIT 1');
    }
    if (r.rows.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '帳號不存在', role: null }));
      return;
    }
    const match = verifyPassword(loginPwd, r.rows[0].password_hash);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: match, message: match ? '登入成功' : '密碼錯誤', role: match ? r.rows[0].role : null }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/update-call') {
    const auth = await checkAuth(false);
    if (!auth.ok) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: '密碼錯誤' })); return; }
    const p = getPool();
    await p.query('UPDATE blood_data SET current_call=$1, last_updated=NOW() WHERE id=1', [parseInt(json.call) || 0]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, currentCall: parseInt(json.call) }));
    return;
  }

  // POST /api/upload-image — 直接存 Railway 本地（二進制安全）
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    let pwdForAuth = '';
    let imageData = null;
    let imageFilename = 'event.jpg';

    // 從 header 取得 boundary
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'no boundary' })); return; }
    const boundaryBuffer = Buffer.from('--' + boundary);
    const boundaryEnd = Buffer.from('--' + boundary + '--');

    // 找各個 part
    let start = 0;
    while (start < rawBody.length) {
      let idx = rawBody.indexOf(boundaryBuffer, start);
      if (idx === -1) break;
      idx += boundaryBuffer.length + 2; // skip \r\n

      let end = rawBody.indexOf(boundaryBuffer, idx);
      if (end === -1) break;
      const partData = rawBody.slice(idx, end - 2); // trim ending \r\n

      // 找 header 和 body 分隔
      const headerEndIdx = partData.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEndIdx === -1) { start = end; continue; }
      const headerStr = partData.slice(0, headerEndIdx).toString('utf8');
      const bodyData = partData.slice(headerEndIdx + 4);

      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      if (!nameMatch) { start = end; continue; }
      const fieldName = nameMatch[1];

      if (fieldName === 'admin_password') {
        pwdForAuth = bodyData.toString('utf8').trim();
      } else if (fieldName === 'image' && filenameMatch) {
        imageData = bodyData;
        const fn = filenameMatch[1];
        const ext = fn.match(/\.([^.]+)$/);
        imageFilename = 'event_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + (ext ? '.' + ext[1] : '.jpg');
      }
      start = end;
    }

    // 用讀到的密碼做驗證
    const pForAuth = getPool();
    const authRow = await pForAuth.query('SELECT password_hash, role FROM admin LIMIT 1');
    if (authRow.rows.length === 0 || !verifyPassword(pwdForAuth, authRow.rows[0].password_hash) || authRow.rows[0].role !== 'super') {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, message: '密碼錯誤' })); return;
    }
    if (!imageData) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '沒有圖片' })); return; }

    const filePath = path.join(UPLOAD_DIR, imageFilename);
    fs.writeFileSync(filePath, imageData);
    const imageUrl = '/uploads/' + imageFilename;

    const p = getPool();
    await p.query('UPDATE blood_data SET event_image=$1, last_updated=NOW() WHERE id=1', [imageUrl]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: imageUrl }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/update-event-image') {
    const auth = await checkAuth(true);
    if (!auth.ok) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' })); return; }
    const p = getPool();
    await p.query('UPDATE blood_data SET event_image=$1, last_updated=NOW() WHERE id=1', [json.eventImage || '']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/update-announcements') {
    const auth = await checkAuth(true);
    if (!auth.ok) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' })); return; }
    const anns = json.announcements || [];
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

  if (req.method === 'POST' && pathname === '/api/update-password') {
    const auth = await checkAuth(true);
    if (!auth.ok) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' })); return; }
    if (!json.newPassword || json.newPassword.length < 4) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '新密碼至少4位' })); return; }
    const p = getPool();
    const hash = crypto.createHash('sha256').update(json.newPassword).digest('hex');
    await p.query('UPDATE admin SET password_hash=$1', [hash]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: '密碼已更改' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const pwd = u.searchParams.get('admin_password') || '';
    const p2 = getPool();
    const r2 = await p2.query('SELECT password_hash, role FROM admin ORDER BY CASE WHEN role=$1 THEN 0 ELSE 1 END LIMIT 1', ['super']);
    if (r2.rows.length === 0 || !verifyPassword(pwd, r2.rows[0].password_hash) || r2.rows[0].role !== 'super') {
      res.writeHead(401); res.end(JSON.stringify({ error: '未授權' })); return;
    }
    const p = getPool();
    const r = await p.query('SELECT id, username, role, created_at FROM admin ORDER BY id');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: r.rows }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/users') {
    const auth = await checkAuth(true);
    if (!auth.ok) { res.writeHead(401); res.end(JSON.stringify({ ok: false, message: auth.message || '密碼錯誤' })); return; }
    if (!json.username || json.username.length < 2) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '帳號至少2個字元' })); return; }
    if (!json.password || json.password.length < 4) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '密碼至少4位' })); return; }
    if (!['normal', 'super'].includes(json.role)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '角色錯誤' })); return; }
    const newHash = crypto.createHash('sha256').update(json.password).digest('hex');
    const p = getPool();
    try {
      await p.query('INSERT INTO admin (username, password_hash, role) VALUES ($1, $2, $3)', [json.username, newHash, json.role]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '管理者已新增' }));
    } catch(e) {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, message: '帳號已存在' }));
    }
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/admin/users/')) {
    const pwd = u.searchParams.get('admin_password') || '';
    const p2 = getPool();
    const r2 = await p2.query('SELECT password_hash, role FROM admin ORDER BY CASE WHEN role=$1 THEN 0 ELSE 1 END LIMIT 1', ['super']);
    if (r2.rows.length === 0 || !verifyPassword(pwd, r2.rows[0].password_hash) || r2.rows[0].role !== 'super') {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, message: '密碼錯誤' })); return;
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

  // 上傳的圖片
  if (url.startsWith('/uploads/')) {
    const filePath = path.join(UPLOAD_DIR, url.replace('/uploads/', ''));
    if (!filePath.startsWith(UPLOAD_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'image/jpeg';
    serveFile(res, filePath, mime);
    return;
  }

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
    console.log('🩸 捐血叫號系統已啟動');
    console.log('📋 公開網站：http://0.0.0.0:' + PORT + '/');
    console.log('🔧 管理後台：http://0.0.0.0:' + PORT + '/admin');
  });
})();
