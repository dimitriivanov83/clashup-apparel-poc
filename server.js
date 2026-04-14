// ══════════════════════════════════════════════════════════════
// ClashUp Connected Apparel — POC Server V2
// Multi-user, auth, unique QR per patch, admin back-office
// Pure Node.js HTTP server — zero dependencies
// ══════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'clashup2024';

// ── MIME types ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ══════════════════════════════════════════════════════════════
// IN-MEMORY DATABASE
// ══════════════════════════════════════════════════════════════

const sessions = {};  // token → userId
const users = {};     // userId → user object
const patches = {};   // patchId → patch object

// Punchline catalog (admin-manageable)
let punchlineCatalog = [
  { id: 'p1', text: "J'AI RÉFLÉCHI. ÇA N'A PAS AIDÉ.", by: '@thotboy', v: 140, cc: 0, active: true },
  { id: 'p2', text: "PAS COMPRIS. VALIDÉ.", by: '@jules', v: 13, cc: 0, active: true },
  { id: 'p3', text: "J'AI PAS LA RÉPONSE.", by: null, v: 0, cc: 0, active: true },
  { id: 'p4', text: "FUCK LA FAST FASHION.", by: null, v: 0, cc: 1, active: true },
  { id: 'p5', text: "JE SUIS VENU, J'AI VU, J'AI RIEN COMPRIS.", by: '@max_la_menace', v: 89, cc: 0, active: true },
  { id: 'p6', text: "MON DOS PARLE MIEUX QUE MOI.", by: null, v: 0, cc: 0, active: true },
  { id: 'p7', text: "T'AS SCANNÉ. T'ES PIÉGÉ.", by: '@clashqueen', v: 42, cc: 2, active: true },
  { id: 'p8', text: "LA HYPE EST MORTE. MOI NON.", by: null, v: 0, cc: 1, active: true },
];

// ── Pre-seed 5 demo users ──
const DEMO_USERS = [
  { username: 'max_la_menace', email: 'max@clashup.fr', pass: 'clash1', owner: '@MAX_LA_MENACE' },
  { username: 'sarah_clash', email: 'sarah@clashup.fr', pass: 'clash2', owner: '@SARAH_CLASH' },
  { username: 'leo_punch', email: 'leo@clashup.fr', pass: 'clash3', owner: '@LEO_PUNCH' },
  { username: 'nina_fire', email: 'nina@clashup.fr', pass: 'clash4', owner: '@NINA_FIRE' },
  { username: 'alex_boom', email: 'alex@clashup.fr', pass: 'clash5', owner: '@ALEX_BOOM' },
];

// ── Helpers ──
function genId(prefix) { return prefix + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function hashPass(pass) { return crypto.createHash('sha256').update(pass + '_clashup_salt').digest('hex'); }
function genPatchId() {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `CU${String(Math.floor(Math.random()*900)+100)}${L[Math.floor(Math.random()*26)]}${L[Math.floor(Math.random()*26)]}`;
}

function createPatch(patchId, number, owner) {
  return {
    id: patchId,
    certificateId: `#${patchId.slice(2)}`,
    series: 'INSIDE_OUT_01',
    number,
    batchRef: 'CU-INV-01',
    clashLv: 'TIER_128',
    origin: 'MADE IN FRANCE // ATELIER_02',
    material: '100% COTON RECYCLÉ (BIO.VEGAN)',
    process: 'TEINTURE NON-TOXIQUE',
    owner,
    edition: 'LTD_EDITION_001',
    punchline: null,
    punchlineHistory: [],
    clashCoins: 475,
    validations: 0,
    clashes: [],
    totalScans: 0,
    createdAt: new Date().toISOString(),
  };
}

// Seed demo users
DEMO_USERS.forEach((d, i) => {
  const userId = `user_${i + 1}`;
  const patchId = genPatchId();
  users[userId] = {
    id: userId, username: d.username, email: d.email,
    passwordHash: hashPass(d.pass), patchId, createdAt: new Date().toISOString(),
  };
  patches[patchId] = createPatch(patchId, `${String(i+1).padStart(3,'0')} / 100`, d.owner);
});

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
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
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  const tc = cookies.find(c => c.startsWith('token='));
  return tc ? tc.split('=')[1] : null;
}

function getUser(req) {
  const token = getToken(req);
  if (!token || !sessions[token]) return null;
  return users[sessions[token]] || null;
}

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  if (auth === `Admin ${ADMIN_PASS}`) return true;
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  const ac = cookies.find(c => c.startsWith('admin='));
  return ac ? ac.split('=')[1] === ADMIN_PASS : false;
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

  // ═══ AUTH API ═══

  // POST /api/auth/signup
  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    const { username, email, password } = body;
    if (!username?.trim() || !password?.trim()) return sendJSON(res, { error: 'Username et mot de passe requis' }, 400);
    const exists = Object.values(users).find(u => u.username === username.trim().toLowerCase());
    if (exists) return sendJSON(res, { error: 'Ce pseudo est déjà pris' }, 409);

    const userId = genId('user_');
    const patchId = genPatchId();
    const clean = username.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const num = String(Object.keys(users).length + 1).padStart(3, '0');

    users[userId] = {
      id: userId, username: username.trim().toLowerCase(), email: (email||'').trim().toLowerCase(),
      passwordHash: hashPass(password), patchId, createdAt: new Date().toISOString(),
    };
    patches[patchId] = createPatch(patchId, `${num} / 100`, `@${clean}`);

    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = userId;
    return sendJSON(res, { success: true, token, user: { id: userId, username: users[userId].username, patchId } });
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;
    if (!username?.trim() || !password) return sendJSON(res, { error: 'Username et mot de passe requis' }, 400);
    const user = Object.values(users).find(u => u.username === username.trim().toLowerCase());
    if (!user || user.passwordHash !== hashPass(password)) return sendJSON(res, { error: 'Identifiants incorrects' }, 401);
    const token = crypto.randomBytes(24).toString('hex');
    sessions[token] = user.id;
    return sendJSON(res, { success: true, token, user: { id: user.id, username: user.username, patchId: user.patchId } });
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token = getToken(req); if (token) delete sessions[token];
    return sendJSON(res, { success: true });
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = getUser(req);
    if (!user) return sendJSON(res, { error: 'Non connecté' }, 401);
    const patch = patches[user.patchId];
    return sendJSON(res, {
      user: { id: user.id, username: user.username, email: user.email, patchId: user.patchId },
      patch: patch ? { ...patch, scanUrl: `${getBaseUrl(req)}/scan/${patch.id}` } : null,
    });
  }

  // ═══ PATCH API ═══

  // GET /api/patch/:id (public)
  const patchGet = pathname.match(/^\/api\/patch\/([^/]+)$/);
  if (patchGet && method === 'GET') {
    const patch = patches[patchGet[1]];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);
    patch.totalScans++;
    return sendJSON(res, { ...patch, scanUrl: `${getBaseUrl(req)}/scan/${patch.id}` });
  }

  // POST /api/patch/:id/punchline (owner only)
  const punchPost = pathname.match(/^\/api\/patch\/([^/]+)\/punchline$/);
  if (punchPost && method === 'POST') {
    const patch = patches[punchPost[1]];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);
    const user = getUser(req);
    if (!user || user.patchId !== patch.id) return sendJSON(res, { error: 'Non autorisé' }, 403);
    const body = await readBody(req);
    if (!body.punchline?.trim()) return sendJSON(res, { error: 'Punchline required' }, 400);
    if (patch.punchline) {
      patch.punchlineHistory.unshift({ text: patch.punchline, at: new Date().toISOString() });
      patch.punchlineHistory = patch.punchlineHistory.slice(0, 10);
    }
    patch.punchline = body.punchline.trim().toUpperCase();
    patch.clashCoins = Math.max(0, patch.clashCoins - (body.cost || 0));
    patch.validations = 0; patch.clashes = [];
    return sendJSON(res, { success: true, punchline: patch.punchline, clashCoins: patch.clashCoins, scanUrl: `${getBaseUrl(req)}/scan/${patch.id}` });
  }

  // POST /api/patch/:id/clash (public)
  const clashPost = pathname.match(/^\/api\/patch\/([^/]+)\/clash$/);
  if (clashPost && method === 'POST') {
    const patch = patches[clashPost[1]];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);
    const body = await readBody(req);
    patch.clashes.unshift({ text: (body.text||'').toUpperCase(), author: body.author||'Anon', at: new Date().toISOString() });
    patch.clashes = patch.clashes.slice(0, 50);
    return sendJSON(res, { success: true, totalClashes: patch.clashes.length });
  }

  // POST /api/patch/:id/validate (public)
  const valPost = pathname.match(/^\/api\/patch\/([^/]+)\/validate$/);
  if (valPost && method === 'POST') {
    const patch = patches[valPost[1]];
    if (!patch) return sendJSON(res, { error: 'Patch not found' }, 404);
    patch.validations++;
    return sendJSON(res, { success: true, validations: patch.validations });
  }

  // GET /api/punchlines (catalog)
  if (pathname === '/api/punchlines' && method === 'GET') {
    return sendJSON(res, punchlineCatalog.filter(p => p.active));
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

  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    const allUsers = Object.values(users).map(u => {
      const p = patches[u.patchId];
      return { id: u.id, username: u.username, email: u.email, patchId: u.patchId, createdAt: u.createdAt,
        punchline: p?.punchline, clashCoins: p?.clashCoins||0, totalScans: p?.totalScans||0,
        validations: p?.validations||0, totalClashes: p?.clashes?.length||0 };
    });
    return sendJSON(res, {
      users: allUsers, punchlines: punchlineCatalog,
      stats: { totalUsers: allUsers.length, activePatches: allUsers.filter(u=>u.punchline).length, totalScans: allUsers.reduce((s,u)=>s+u.totalScans,0) },
    });
  }

  if (pathname === '/api/admin/punchlines' && method === 'POST') {
    const body = await readBody(req);
    if (!body.text?.trim()) return sendJSON(res, { error: 'Texte requis' }, 400);
    const p = { id: genId('p'), text: body.text.trim().toUpperCase(), by: body.by||null, v: body.v||0, cc: body.cc||0, active: true };
    punchlineCatalog.push(p);
    return sendJSON(res, { success: true, punchline: p });
  }

  const punchPut = pathname.match(/^\/api\/admin\/punchlines\/([^/]+)$/);
  if (punchPut && method === 'PUT') {
    const p = punchlineCatalog.find(x => x.id === punchPut[1]);
    if (!p) return sendJSON(res, { error: 'Not found' }, 404);
    const body = await readBody(req);
    if (body.text !== undefined) p.text = body.text.trim().toUpperCase();
    if (body.by !== undefined) p.by = body.by;
    if (body.cc !== undefined) p.cc = Number(body.cc);
    if (body.active !== undefined) p.active = body.active;
    return sendJSON(res, { success: true, punchline: p });
  }

  const punchDel = pathname.match(/^\/api\/admin\/punchlines\/([^/]+)$/);
  if (punchDel && method === 'DELETE') {
    punchlineCatalog = punchlineCatalog.filter(x => x.id !== punchDel[1]);
    return sendJSON(res, { success: true });
  }

  const userDel = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userDel && method === 'DELETE') {
    const u = users[userDel[1]];
    if (u) { delete patches[u.patchId]; delete users[userDel[1]]; Object.keys(sessions).forEach(t => { if(sessions[t]===userDel[1]) delete sessions[t]; }); }
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
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ ClashUp Apparel POC V2 — port ${PORT}`);
  console.log(`  🔗 http://localhost:${PORT}`);
  console.log(`  🔑 Admin: http://localhost:${PORT}/admin (pass: ${ADMIN_PASS})`);
  console.log(`\n  📱 Demo accounts:`);
  DEMO_USERS.forEach(d => {
    const u = Object.values(users).find(x => x.username === d.username);
    console.log(`     ${d.username} / ${d.pass} → patch ${u.patchId}`);
  });
  console.log('');
});
