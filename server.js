// ══════════════════════════════════════════════════════════════
// ClashUp Connected Apparel — POC Server V4
// PostgreSQL persistence, voting, history, real-time sync
// Robust connection handling for Render free tier
// ══════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'clashup2024';
const DATABASE_URL = process.env.DATABASE_URL;

// ── PostgreSQL Pool — robust config for Render free tier ──
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false,
});

// Handle pool errors gracefully (prevents crash on connection drop)
pool.on('error', (err) => {
  console.error('  ⚠️  Pool error (non-fatal):', err.message);
});

// Helper: query with automatic retry on connection errors
async function dbQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Retry once on connection-related errors
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === '57P01' || err.code === '08006' || err.code === '08003' || err.message?.includes('Connection terminated')) {
      console.log('  🔄 DB reconnecting...');
      return await pool.query(text, params);
    }
    throw err;
  }
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// ══════════════════════════════════════════════════════════════
// DATABASE SCHEMA & INIT
// ══════════════════════════════════════════════════════════════
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT DEFAULT '',
        password_hash TEXT NOT NULL,
        patch_id TEXT NOT NULL,
        clash_coins INTEGER DEFAULT 475,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        certificate_id TEXT,
        series TEXT DEFAULT 'INSIDE_OUT_01',
        number TEXT,
        batch_ref TEXT DEFAULT 'CU-INV-01',
        clash_lv TEXT DEFAULT 'TIER_128',
        origin TEXT DEFAULT 'MADE IN FRANCE // ATELIER_02',
        material TEXT DEFAULT '100% COTON RECYCLÉ (BIO.VEGAN)',
        process_info TEXT DEFAULT 'TEINTURE NON-TOXIQUE',
        owner TEXT,
        edition TEXT DEFAULT 'LTD_EDITION_001',
        punchline TEXT,
        total_scans INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punchline_catalog (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        author TEXT,
        cc INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS punchline_history (
        id SERIAL PRIMARY KEY,
        patch_id TEXT REFERENCES patches(id) ON DELETE CASCADE,
        punchline TEXT NOT NULL,
        activated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clashes (
        id SERIAL PRIMARY KEY,
        patch_id TEXT REFERENCES patches(id) ON DELETE CASCADE,
        punchline TEXT,
        text TEXT NOT NULL,
        author TEXT DEFAULT 'Anon',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS validations (
        id SERIAL PRIMARY KEY,
        patch_id TEXT REFERENCES patches(id) ON DELETE CASCADE,
        punchline TEXT,
        voter_ip TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_validations_unique ON validations(patch_id, punchline, voter_ip);

      CREATE TABLE IF NOT EXISTS punchline_votes (
        id SERIAL PRIMARY KEY,
        catalog_id TEXT REFERENCES punchline_catalog(id) ON DELETE CASCADE,
        voter_ip TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_punchline_votes_unique ON punchline_votes(catalog_id, voter_ip);

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed demo users if empty
    const { rows } = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const demos = [
        { username: 'ju', email: 'ju@clashup.fr', pass: 'ju', owner: '@JU' },
        { username: 'dim', email: 'dim@clashup.fr', pass: 'dim', owner: '@DIM' },
        { username: 'max', email: 'max@clashup.fr', pass: 'max', owner: '@MAX' },
      ];
      for (let i = 0; i < demos.length; i++) {
        const d = demos[i];
        const userId = `user_${i + 1}`;
        const patchId = genPatchId();
        const num = `${String(i + 1).padStart(3, '0')} / 100`;
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, patch_id) VALUES ($1,$2,$3,$4,$5)',
          [userId, d.username, d.email, hashPass(d.pass), patchId]
        );
        await client.query(
          'INSERT INTO patches (id, certificate_id, number, owner) VALUES ($1,$2,$3,$4)',
          [patchId, `#${patchId.slice(2)}`, num, d.owner]
        );
      }
      console.log('  ✅ Demo users seeded');
    }

    // Seed punchline catalog if empty
    const { rows: pRows } = await client.query('SELECT COUNT(*) FROM punchline_catalog');
    if (parseInt(pRows[0].count) === 0) {
      const catalog = [
        { text: "J'AI RÉFLÉCHI. ÇA N'A PAS AIDÉ.", by: '@thotboy', cc: 0 },
        { text: "PAS COMPRIS. VALIDÉ.", by: '@jules', cc: 0 },
        { text: "J'AI PAS LA RÉPONSE.", by: null, cc: 0 },
        { text: "FUCK LA FAST FASHION.", by: null, cc: 1 },
        { text: "JE SUIS VENU, J'AI VU, J'AI RIEN COMPRIS.", by: '@max_la_menace', cc: 0 },
        { text: "MON DOS PARLE MIEUX QUE MOI.", by: null, cc: 0 },
        { text: "T'AS SCANNÉ. T'ES PIÉGÉ.", by: '@clashqueen', cc: 2 },
        { text: "LA HYPE EST MORTE. MOI NON.", by: null, cc: 1 },
        { text: "SÉRIE LIMITÉE COMME MES PRINCIPES.", by: null, cc: 0 },
        { text: "J'AI PAS DE TALENT JUSTE DU WIFI.", by: null, cc: 0 },
      ];
      for (const p of catalog) {
        await client.query(
          'INSERT INTO punchline_catalog (id, text, author, cc) VALUES ($1,$2,$3,$4)',
          [genId('p'), p.text, p.by, p.cc]
        );
      }
      console.log('  ✅ Punchline catalog seeded');
    }

    console.log('  ✅ Database initialized');
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function genId(prefix) { return prefix + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function hashPass(pass) { return crypto.createHash('sha256').update(pass + '_clashup_salt').digest('hex'); }
function genPatchId() {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `CU${String(Math.floor(Math.random() * 900) + 100)}${L[Math.floor(Math.random() * 26)]}${L[Math.floor(Math.random() * 26)]}`;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function getToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function getUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const { rows } = await dbQuery(
    'SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1', [token]
  );
  return rows[0] || null;
}

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  return auth === `Admin ${ADMIN_PASS}`;
}

// ══════════════════════════════════════════════════════════════
// SERVER
// ══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(); return;
  }

  try {

  // ═══ AUTH API ═══

  // POST /api/auth/signup
  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    const { username, email, password } = body;
    if (!username?.trim() || !password?.trim()) return sendJSON(res, { error: 'Username et mot de passe requis' }, 400);

    const { rows: existing } = await dbQuery('SELECT id FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    if (existing.length > 0) return sendJSON(res, { error: 'Ce pseudo est déjà pris' }, 409);

    const userId = genId('user_');
    const patchId = genPatchId();
    const clean = username.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const { rows: countRows } = await dbQuery('SELECT COUNT(*) FROM users');
    const num = `${String(parseInt(countRows[0].count) + 1).padStart(3, '0')} / 100`;

    await dbQuery(
      'INSERT INTO users (id, username, email, password_hash, patch_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, username.trim().toLowerCase(), (email || '').trim().toLowerCase(), hashPass(password), patchId]
    );
    await dbQuery(
      'INSERT INTO patches (id, certificate_id, number, owner) VALUES ($1,$2,$3,$4)',
      [patchId, `#${patchId.slice(2)}`, num, `@${clean}`]
    );

    const token = crypto.randomBytes(24).toString('hex');
    await dbQuery('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, userId]);
    return sendJSON(res, { success: true, token, user: { id: userId, username: username.trim().toLowerCase(), patchId } });
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;
    if (!username?.trim() || !password) return sendJSON(res, { error: 'Username et mot de passe requis' }, 400);

    const { rows } = await dbQuery('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || user.password_hash !== hashPass(password)) return sendJSON(res, { error: 'Identifiants incorrects' }, 401);

    const token = crypto.randomBytes(24).toString('hex');
    await dbQuery('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, user.id]);
    return sendJSON(res, { success: true, token, user: { id: user.id, username: user.username, patchId: user.patch_id } });
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = getToken(req);
    if (token) await dbQuery('DELETE FROM sessions WHERE token = $1', [token]);
    return sendJSON(res, { success: true });
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = await getUser(req);
    if (!user) return sendJSON(res, { error: 'Non connecté' }, 401);

    const { rows: pRows } = await dbQuery('SELECT * FROM patches WHERE id = $1', [user.patch_id]);
    const patch = pRows[0];
    if (!patch) return sendJSON(res, { error: 'Patch introuvable' }, 404);

    // Get validation count and clash count
    const { rows: vRows } = await dbQuery('SELECT COUNT(*) FROM validations WHERE patch_id=$1 AND punchline=$2', [patch.id, patch.punchline]);
    const { rows: cRows } = await dbQuery('SELECT * FROM clashes WHERE patch_id=$1 AND punchline=$2 ORDER BY created_at DESC LIMIT 50', [patch.id, patch.punchline]);

    // Punchline history
    const { rows: hRows } = await dbQuery('SELECT punchline, activated_at FROM punchline_history WHERE patch_id=$1 ORDER BY activated_at DESC LIMIT 20', [patch.id]);

    return sendJSON(res, {
      user: { id: user.id, username: user.username, email: user.email, patchId: user.patch_id },
      patch: {
        id: patch.id, certificateId: patch.certificate_id, series: patch.series, number: patch.number,
        batchRef: patch.batch_ref, clashLv: patch.clash_lv, origin: patch.origin,
        material: patch.material, process: patch.process_info, owner: patch.owner,
        edition: patch.edition, punchline: patch.punchline, clashCoins: user.clash_coins,
        validations: parseInt(vRows[0].count), clashes: cRows.map(c => ({ text: c.text, author: c.author, at: c.created_at })),
        totalScans: patch.total_scans, scanUrl: `${getBaseUrl(req)}/scan/${patch.id}`,
        punchlineHistory: hRows.map(h => ({ text: h.punchline, at: h.activated_at })),
      },
    });
  }

  // ═══ PATCH API ═══

  // GET /api/patch/:id (public — scan)
  const patchGet = pathname.match(/^\/api\/patch\/([^/]+)$/);
  if (patchGet && method === 'GET') {
    const { rows } = await dbQuery('SELECT * FROM patches WHERE id = $1', [patchGet[1]]);
    const patch = rows[0];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);

    await dbQuery('UPDATE patches SET total_scans = total_scans + 1 WHERE id = $1', [patch.id]);

    const { rows: vRows } = await dbQuery('SELECT COUNT(*) FROM validations WHERE patch_id=$1 AND punchline=$2', [patch.id, patch.punchline]);
    const { rows: cRows } = await dbQuery('SELECT * FROM clashes WHERE patch_id=$1 AND punchline=$2 ORDER BY created_at DESC LIMIT 50', [patch.id, patch.punchline]);

    return sendJSON(res, {
      id: patch.id, certificateId: patch.certificate_id, series: patch.series, number: patch.number,
      batchRef: patch.batch_ref, clashLv: patch.clash_lv, origin: patch.origin,
      material: patch.material, process: patch.process_info, owner: patch.owner,
      edition: patch.edition, punchline: patch.punchline,
      validations: parseInt(vRows[0].count),
      clashes: cRows.map(c => ({ text: c.text, author: c.author, at: c.created_at })),
      totalScans: patch.total_scans + 1,
      scanUrl: `${getBaseUrl(req)}/scan/${patch.id}`,
    });
  }

  // POST /api/patch/:id/punchline (owner only)
  const punchPost = pathname.match(/^\/api\/patch\/([^/]+)\/punchline$/);
  if (punchPost && method === 'POST') {
    const { rows } = await dbQuery('SELECT * FROM patches WHERE id = $1', [punchPost[1]]);
    const patch = rows[0];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);

    const user = await getUser(req);
    if (!user || user.patch_id !== patch.id) return sendJSON(res, { error: 'Non autorisé' }, 403);

    const body = await readBody(req);
    if (!body.punchline?.trim()) return sendJSON(res, { error: 'Punchline required' }, 400);

    const newPunchline = body.punchline.trim().toUpperCase();
    const cost = body.cost || 0;

    // Save current punchline to history (only the old one, before replacing)
    if (patch.punchline) {
      await dbQuery('INSERT INTO punchline_history (patch_id, punchline) VALUES ($1,$2)', [patch.id, patch.punchline]);
    }

    // Update patch with new punchline
    await dbQuery('UPDATE patches SET punchline = $1 WHERE id = $2', [newPunchline, patch.id]);

    // Deduct coins
    const newCoins = Math.max(0, user.clash_coins - cost);
    await dbQuery('UPDATE users SET clash_coins = $1 WHERE id = $2', [newCoins, user.id]);

    return sendJSON(res, {
      success: true, punchline: newPunchline, clashCoins: newCoins,
      scanUrl: `${getBaseUrl(req)}/scan/${patch.id}`,
    });
  }

  // POST /api/patch/:id/clash (public)
  const clashPost = pathname.match(/^\/api\/patch\/([^/]+)\/clash$/);
  if (clashPost && method === 'POST') {
    const { rows } = await dbQuery('SELECT * FROM patches WHERE id = $1', [clashPost[1]]);
    const patch = rows[0];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);

    const body = await readBody(req);
    const text = (body.text || '').toUpperCase();
    const author = body.author || 'Anon';

    await dbQuery(
      'INSERT INTO clashes (patch_id, punchline, text, author) VALUES ($1,$2,$3,$4)',
      [patch.id, patch.punchline, text, author]
    );

    const { rows: cRows } = await dbQuery(
      'SELECT * FROM clashes WHERE patch_id=$1 AND punchline=$2 ORDER BY created_at DESC LIMIT 50',
      [patch.id, patch.punchline]
    );

    return sendJSON(res, {
      success: true, totalClashes: cRows.length,
      clashes: cRows.map(c => ({ text: c.text, author: c.author, at: c.created_at })),
    });
  }

  // POST /api/patch/:id/validate (public — 1 vote per IP per punchline)
  const valPost = pathname.match(/^\/api\/patch\/([^/]+)\/validate$/);
  if (valPost && method === 'POST') {
    const { rows } = await dbQuery('SELECT * FROM patches WHERE id = $1', [valPost[1]]);
    const patch = rows[0];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);

    const ip = getClientIP(req);

    try {
      await dbQuery(
        'INSERT INTO validations (patch_id, punchline, voter_ip) VALUES ($1,$2,$3)',
        [patch.id, patch.punchline, ip]
      );
    } catch (e) {
      // Unique constraint violation = already voted
      if (e.code === '23505') return sendJSON(res, { error: 'Déjà voté', alreadyVoted: true }, 409);
      throw e;
    }

    const { rows: vRows } = await dbQuery('SELECT COUNT(*) FROM validations WHERE patch_id=$1 AND punchline=$2', [patch.id, patch.punchline]);
    return sendJSON(res, { success: true, validations: parseInt(vRows[0].count) });
  }

  // ═══ PUNCHLINE CATALOG + VOTING ═══

  // GET /api/punchlines (with vote counts)
  if (pathname === '/api/punchlines' && method === 'GET') {
    const { rows } = await dbQuery(`
      SELECT pc.*, COALESCE(v.votes, 0) as votes
      FROM punchline_catalog pc
      LEFT JOIN (SELECT catalog_id, COUNT(*) as votes FROM punchline_votes GROUP BY catalog_id) v
        ON v.catalog_id = pc.id
      WHERE pc.active = true
      ORDER BY votes DESC, pc.created_at ASC
    `);
    return sendJSON(res, rows.map(r => ({
      id: r.id, text: r.text, by: r.author, v: parseInt(r.votes), cc: r.cc, active: r.active,
    })));
  }

  // POST /api/punchlines/:id/vote (1 per IP)
  const votePost = pathname.match(/^\/api\/punchlines\/([^/]+)\/vote$/);
  if (votePost && method === 'POST') {
    const ip = getClientIP(req);
    try {
      await dbQuery('INSERT INTO punchline_votes (catalog_id, voter_ip) VALUES ($1,$2)', [votePost[1], ip]);
    } catch (e) {
      if (e.code === '23505') return sendJSON(res, { error: 'Déjà voté', alreadyVoted: true }, 409);
      throw e;
    }
    const { rows } = await dbQuery('SELECT COUNT(*) FROM punchline_votes WHERE catalog_id=$1', [votePost[1]]);
    return sendJSON(res, { success: true, votes: parseInt(rows[0].count) });
  }

  // ═══ ADMIN API ═══

  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    if (body.password === ADMIN_PASS) return sendJSON(res, { success: true, token: ADMIN_PASS });
    return sendJSON(res, { error: 'Mot de passe incorrect' }, 401);
  }

  if (pathname.startsWith('/api/admin/') && pathname !== '/api/admin/login') {
    if (!isAdmin(req)) return sendJSON(res, { error: 'Admin requis' }, 403);
  }

  // GET /api/admin/dashboard
  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    const { rows: allUsers } = await dbQuery(`
      SELECT u.id, u.username, u.email, u.patch_id, u.clash_coins, u.created_at,
             p.punchline, p.total_scans
      FROM users u LEFT JOIN patches p ON u.patch_id = p.id ORDER BY u.created_at
    `);

    const { rows: catalog } = await dbQuery(`
      SELECT pc.*, COALESCE(v.votes, 0) as votes
      FROM punchline_catalog pc
      LEFT JOIN (SELECT catalog_id, COUNT(*) as votes FROM punchline_votes GROUP BY catalog_id) v
        ON v.catalog_id = pc.id
      ORDER BY pc.created_at ASC
    `);

    // Global stats
    const { rows: clashCount } = await dbQuery('SELECT COUNT(*) FROM clashes');
    const { rows: valCount } = await dbQuery('SELECT COUNT(*) FROM validations');

    // Recent activity (last 30 clashes and activations)
    const { rows: recentClashes } = await dbQuery('SELECT c.*, p.owner FROM clashes c JOIN patches p ON c.patch_id = p.id ORDER BY c.created_at DESC LIMIT 30');
    const { rows: recentActivations } = await dbQuery('SELECT ph.*, p.owner FROM punchline_history ph JOIN patches p ON ph.patch_id = p.id ORDER BY ph.activated_at DESC LIMIT 30');

    return sendJSON(res, {
      users: allUsers.map(u => ({
        id: u.id, username: u.username, email: u.email, patchId: u.patch_id,
        punchline: u.punchline, clashCoins: u.clash_coins, totalScans: u.total_scans || 0,
      })),
      punchlines: catalog.map(p => ({
        id: p.id, text: p.text, by: p.author, v: parseInt(p.votes), cc: p.cc, active: p.active,
      })),
      stats: {
        totalUsers: allUsers.length,
        activePatches: allUsers.filter(u => u.punchline).length,
        totalScans: allUsers.reduce((s, u) => s + (u.total_scans || 0), 0),
        totalClashes: parseInt(clashCount[0].count),
        totalValidations: parseInt(valCount[0].count),
      },
      recentClashes: recentClashes.map(c => ({ text: c.text, author: c.author, owner: c.owner, punchline: c.punchline, at: c.created_at })),
      recentActivations: recentActivations.map(a => ({ punchline: a.punchline, owner: a.owner, at: a.activated_at })),
    });
  }

  // POST /api/admin/punchlines
  if (pathname === '/api/admin/punchlines' && method === 'POST') {
    const body = await readBody(req);
    if (!body.text?.trim()) return sendJSON(res, { error: 'Texte requis' }, 400);
    const id = genId('p');
    await dbQuery(
      'INSERT INTO punchline_catalog (id, text, author, cc) VALUES ($1,$2,$3,$4)',
      [id, body.text.trim().toUpperCase(), body.by || null, body.cc || 0]
    );
    return sendJSON(res, { success: true, punchline: { id, text: body.text.trim().toUpperCase(), by: body.by, cc: body.cc || 0 } });
  }

  // PUT /api/admin/punchlines/:id
  const punchPut = pathname.match(/^\/api\/admin\/punchlines\/([^/]+)$/);
  if (punchPut && method === 'PUT') {
    const body = await readBody(req);
    const sets = [], vals = [];
    let i = 1;
    if (body.text !== undefined) { sets.push(`text = $${i++}`); vals.push(body.text.trim().toUpperCase()); }
    if (body.by !== undefined) { sets.push(`author = $${i++}`); vals.push(body.by); }
    if (body.cc !== undefined) { sets.push(`cc = $${i++}`); vals.push(Number(body.cc)); }
    if (body.active !== undefined) { sets.push(`active = $${i++}`); vals.push(body.active); }
    if (sets.length === 0) return sendJSON(res, { error: 'Nothing to update' }, 400);
    vals.push(punchPut[1]);
    await dbQuery(`UPDATE punchline_catalog SET ${sets.join(',')} WHERE id = $${i}`, vals);
    return sendJSON(res, { success: true });
  }

  // DELETE /api/admin/punchlines/:id
  const punchDel = pathname.match(/^\/api\/admin\/punchlines\/([^/]+)$/);
  if (punchDel && method === 'DELETE') {
    await dbQuery('DELETE FROM punchline_catalog WHERE id = $1', [punchDel[1]]);
    return sendJSON(res, { success: true });
  }

  // DELETE /api/admin/users/:id
  const userDel = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userDel && method === 'DELETE') {
    const { rows } = await dbQuery('SELECT patch_id FROM users WHERE id = $1', [userDel[1]]);
    if (rows[0]) {
      await dbQuery('DELETE FROM patches WHERE id = $1', [rows[0].patch_id]);
    }
    await dbQuery('DELETE FROM sessions WHERE user_id = $1', [userDel[1]]);
    await dbQuery('DELETE FROM users WHERE id = $1', [userDel[1]]);
    return sendJSON(res, { success: true });
  }

  // ── ADMIN PAGE ──
  if (pathname === '/admin' || pathname === '/admin/') {
    return sendFile(res, path.join(__dirname, 'public', 'admin.html'));
  }

  // ── STATIC FILES ──
  const staticPath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    return sendFile(res, staticPath);
  }

  // ── SPA FALLBACK ──
  sendFile(res, path.join(__dirname, 'public', 'index.html'));

  } catch (err) {
    console.error('Server error:', err);
    sendJSON(res, { error: 'Erreur serveur' }, 500);
  }
});

// ── START ──
async function start() {
  if (!DATABASE_URL) {
    console.error('\n  ❌ DATABASE_URL is required. Set it as an environment variable.');
    console.error('  Example: DATABASE_URL=postgresql://user:pass@host:5432/dbname node server.js\n');
    process.exit(1);
  }

  // Test connection
  try {
    await pool.query('SELECT 1');
    console.log('  ✅ PostgreSQL connected');
  } catch (err) {
    console.error('  ❌ Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }

  await initDB();

  // Keepalive ping every 4 min (Render free tier drops idle connections)
  setInterval(async () => {
    try { await pool.query('SELECT 1'); }
    catch (e) { console.log('  ⚠️  Keepalive failed:', e.message); }
  }, 4 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`\n  ⚡ ClashUp Apparel POC V4 — port ${PORT}`);
    console.log(`  🔗 http://localhost:${PORT}`);
    console.log(`  🔑 Admin: http://localhost:${PORT}/admin (pass: ${ADMIN_PASS})`);
    console.log(`  🗄️  PostgreSQL ready\n`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('  Shutting down...');
  await pool.end();
  process.exit(0);
});

start();
