// AGO WhatsApp Team Inbox — kết nối WhatsApp CÁ NHÂN qua QR (Baileys).
// Nhận/gửi WhatsApp + tự dịch Anh<->Việt + đăng nhập & phân quyền team.
// LƯU Ý: dùng thư viện không chính thức (WhatsApp Web). Cần server chạy 24/7 + ổ đĩa bền.
try { require('dotenv').config(); } catch {}
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const SECRET = process.env.JWT_SECRET || 'dev-secret-doi-di';
const TKEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const CHANNEL = 'wa';                       // 1 số cá nhân => 1 line
const CHANNEL_LABEL = 'WhatsApp cá nhân';

// ---------------- STORE (JSON file) ----------------
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');   // phiên đăng nhập WhatsApp
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 2));
const getUsers = () => readJSON(USERS_FILE, []);
const saveUsers = (u) => writeJSON(USERS_FILE, u);
const findUser = (n) => getUsers().find((u) => u.username.toLowerCase() === String(n).toLowerCase());
const getConvs = () => readJSON(CONV_FILE, {});
const saveConvs = (c) => writeJSON(CONV_FILE, c);
const convKey = (channel, customer) => channel + '|' + customer;

function upsertMessage(channel, channelLabel, customer, name, m) {
  const all = getConvs();
  const key = convKey(channel, customer);
  if (!all[key]) all[key] = { id: key, channel, channelLabel, customer, name: name || customer, assignedTo: null, unread: 0, updatedAt: 0, messages: [] };
  if (name) all[key].name = name;
  if (channelLabel) all[key].channelLabel = channelLabel;
  all[key].messages.push(m);
  all[key].updatedAt = m.ts;
  if (m.dir === 'in') all[key].unread = (all[key].unread || 0) + 1;
  saveConvs(all); return all[key];
}

// ---------------- AUTH / PERMISSIONS ----------------
const PERMISSIONS = {
  view_all: 'Xem tất cả hội thoại', reply: 'Trả lời tin nhắn',
  assign: 'Gán / chuyển chat', manage_users: 'Quản lý tài khoản & phân quyền'
};
const ROLES = { admin: ['view_all','reply','assign','manage_users'], leader: ['view_all','reply','assign'], agent: ['reply'] };
const hashPw = (p) => bcrypt.hashSync(p, 10);
const okPw = (p, h) => bcrypt.compareSync(p, h);
const signToken = (u) => jwt.sign({ u: u.username, r: u.role }, SECRET, { expiresIn: '7d' });
const verifyToken = (t) => { try { return jwt.verify(t, SECRET); } catch { return null; } };
const effPerms = (u) => Array.from(new Set([...(ROLES[u.role] || ROLES.agent), ...(u.permissions || [])]));
const can = (u, p) => effPerms(u).includes(p);
const visibleTo = (u, c) => can(u, 'view_all') || !c.assignedTo || c.assignedTo === u.username;

// ---------------- TRANSLATE ----------------
async function translate(text, target) {
  if (!text || !text.trim()) return { text: '', translated: false };
  if (!TKEY) return { text, translated: false };
  try {
    const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${TKEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target, format: 'text' })
    });
    const d = await r.json();
    const t = d?.data?.translations?.[0]?.translatedText;
    return t ? { text: t, translated: true } : { text, translated: false };
  } catch (e) { console.error('[translate]', e.message); return { text, translated: false }; }
}
const toAgent = (t) => translate(t, process.env.AGENT_LANG || 'vi');
const toCustomer = (t) => translate(t, process.env.CUSTOMER_LANG || 'en');

// ---------------- WHATSAPP (Baileys / QR) ----------------
let waSock = null;
let waStatus = 'disconnected';   // disconnected | qr | connecting | connected
let waQR = null;                 // data-URL của mã QR
let waMe = null;                 // số của mình khi đã kết nối
let waStarting = false;
const waLog = pino({ level: 'silent' });

const tsToMs = (t) => {
  if (!t) return Date.now();
  if (typeof t === 'number') return t * 1000;
  if (typeof t.toNumber === 'function') return t.toNumber() * 1000;
  return Number(t) * 1000 || Date.now();
};

async function startWA() {
  if (waStarting) return;
  waStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    waStatus = 'connecting'; broadcast({ type: 'wa-status', status: waStatus });
    waSock = makeWASocket({
      version, auth: state, logger: waLog, printQRInTerminal: false,
      browser: ['AGO Inbox', 'Chrome', '1.0'], syncFullHistory: false
    });
    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        try { waQR = await QRCode.toDataURL(qr); } catch { waQR = null; }
        waStatus = 'qr'; broadcast({ type: 'wa-status', status: waStatus });
      }
      if (connection === 'open') {
        waStatus = 'connected'; waQR = null; waMe = waSock.user?.id || null;
        broadcast({ type: 'wa-status', status: waStatus, me: waMe });
        console.log('✔ WhatsApp connected:', waMe);
      }
      if (connection === 'close') {
        waStatus = 'disconnected'; waStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        broadcast({ type: 'wa-status', status: waStatus });
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
          waQR = null; console.log('WhatsApp đã logout, xoá phiên.');
        } else {
          console.log('WhatsApp rớt, thử kết nối lại…');
          setTimeout(() => startWA().catch(() => {}), 3000);
        }
      }
    });

    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue;
          const jid = m.key.remoteJid || '';
          if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // bỏ nhóm & status
          const text = m.message.conversation || m.message.extendedTextMessage?.text;
          if (!text) continue;
          const phone = jid.split('@')[0];
          const name = m.pushName || phone;
          const tr = await toAgent(text);
          const c = upsertMessage(CHANNEL, CHANNEL_LABEL, phone, name, { dir:'in', orig:text, trans:tr.text, translated:tr.translated, ts:tsToMs(m.messageTimestamp), by:null });
          broadcast({ type:'message', conversation:c });
        } catch (e) { console.error('[incoming]', e.message); }
      }
    });
  } catch (e) {
    console.error('[startWA]', e.message); waStarting = false; waStatus = 'disconnected';
    setTimeout(() => startWA().catch(() => {}), 5000);
  }
}

async function waSend(customer, body) {
  if (!waSock || waStatus !== 'connected') throw new Error('WhatsApp chưa kết nối. Vào "Kết nối WhatsApp" quét QR trước.');
  const jid = String(customer).includes('@') ? customer : customer + '@s.whatsapp.net';
  await waSock.sendMessage(jid, { text: body });
}

// ---------------- AUTO SEED (chỉ tạo tài khoản, không tạo hội thoại giả) ----------------
function autoSeed() {
  if (getUsers().length) return;
  saveUsers([
    { username:'admin', name:'Nguyệt (Admin)', role:'admin',  passwordHash:hashPw('demo123'), permissions:[] },
    { username:'linh',  name:'Linh (Sale)',    role:'agent',  passwordHash:hashPw('demo123'), permissions:[] },
    { username:'trang', name:'Trang (Leader)', role:'leader', passwordHash:hashPw('demo123'), permissions:[] }
  ]);
  console.log('✔ Seeded users: admin/demo123 · linh/demo123 · trang/demo123');
}
autoSeed();

// ---------------- APP ----------------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const broadcast = (ev) => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const r of clients) { try { r.write(s); } catch {} } };
const curUser = (req) => { const p = verifyToken(req.cookies?.token || ''); return p ? findUser(p.u) : null; };
const requireAuth = (req, res, next) => { const u = curUser(req); if (!u) return res.status(401).json({ error: 'Chưa đăng nhập' }); req.user = u; next(); };
const requirePerm = (p) => (req, res, next) => can(req.user, p) ? next() : res.status(403).json({ error: 'Không có quyền: ' + p });

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = findUser(username);
  if (!u || !okPw(password || '', u.passwordHash)) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  res.cookie('token', signToken(u), { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
app.get('/api/me', requireAuth, (req, res) => res.json({ username: req.user.username, name: req.user.name || req.user.username, role: req.user.role, permissions: effPerms(req.user) }));

// --- WhatsApp kết nối ---
app.get('/api/wa/status', requireAuth, (req, res) => res.json({ status: waStatus, qr: waQR, me: waMe }));
app.post('/api/wa/connect', requireAuth, requirePerm('manage_users'), (req, res) => {
  if (waStatus === 'connected') return res.json({ ok: true, status: waStatus });
  startWA().catch(() => {});
  res.json({ ok: true, status: waStatus });
});
app.Aost('/api/wa/logout', requireAuth, requirePerm('manage_users'), async (req, res) => {
  try { if (waSock) await waSock.logout(); } catch {}
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  waSock = null; waStatus = 'disconnected'; waQR = null; waMe = null; waStarting = false;
  broadcast({ type: 'wa-status', status: waStatus });
  res.json({ ok: true });
});

// Danh sách các line (số)
app.get('/api/numbers', requireAuth, (req, res) => {
  const seen = new Set(); const cfg = [];
  for (const c of Object.values(getConvs())) if (c.channel && !seen.has(c.channel)) { seen.add(c.channel); cfg.push({ id: c.channel, label: c.channelLabel || c.channel }); }
  if (!cfg.length) cfg.push({ id: CHANNEL, label: CHANNEL_LABEL });
  res.json(cfg);
});

// Conversations
app.get('/api/conversations', requireAuth, (req, res) => {
  const channel = req.query.channel;
  res.json(Object.values(getConvs())
    .filter((c) => visibleTo(req.user, c))
    .filter((c) => !channel || c.channel === channel)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id:c.id, name:c.name, customer:c.customer, channel:c.channel, channelLabel:c.channelLabel, assignedTo:c.assignedTo, unread:c.unread, updatedAt:c.updatedAt, last:c.messages[c.messages.length-1]||null })));
});
app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const c = getConvs()[req.params.id];
  if (!c) return res.status(404).json({ error: 'Không tìm thấy' });
  if (!visibleTo(req.user, c)) return res.status(403).json({ error: 'Không có quyền' });
  const all = getConvs(); if (all[c.id]) { all[c.id].unread = 0; saveConvs(all); }
  res.json(c);
});
app.post('/api/conversations/:id/send', requireAuth, requirePerm('reply'), async (req, res) => {
  const c = getConvs()[req.params.id];
  if (!c) return res.status(404).json({ error: 'Không tìm thấy' });
  if (!visibleTo(req.user, c)) return res.status(403).json({ error: 'Không có quyền' });
  const vi = (req.body?.text || '').trim(); if (!vi) return res.status(400).json({ error: 'Trống' });
  const tr = await toCustomer(vi);
  try { await waSend(c.customer, tr.text); } catch (e) { return res.status(502).json({ error: 'Gửi WhatsApp lỗi: ' + e.message }); }
  const conv = upsertMessage(c.channel, c.channelLabel, c.customer, c.name, { dir:'out', orig:tr.text, trans:vi, translated:tr.translated, ts:Date.now(), by:req.user.username });
  broadcast({ type:'message', conversation:conv });
  res.json({ ok: true });
});
app.post('/api/conversations/:id/assign', requireAuth, requirePerm('assign'), (req, res) => {
  const all = getConvs(); if (!all[req.params.id]) return res.status(404).json({ error: 'Không tìm thấy' });
  all[req.params.id].assignedTo = req.body?.agent || null; saveConvs(all);
  broadcast({ type:'assigned', conversation: all[req.params.id] });
  res.json({ ok: true });
});
app.post('/api/translate', requireAuth, async (req, res) => {
  const { text, dir } = req.body || {};
  res.json(dir === 'in' ? await toAgent(text) : await toCustomer(text));
});

// Users / phân quyền
app.get('/api/agents', requireAuth, (req, res) => res.json(getUsers().map((u) => ({ username:u.username, name:u.name||u.username, role:u.role }))));
app.get('/api/permissions', requireAuth, (req, res) => res.json(PERMISSIONS));
app.get('/api/users', requireAuth, requirePerm('manage_users'), (req, res) =>
  res.json(getUsers().map((u) => ({ username:u.username, name:u.name||u.username, role:u.role, permissions:u.permissions||[], effective:effPerms(u) }))));
app.post('/api/users', requireAuth, requirePerm('manage_users'), (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu username/mật khẩu' });
  if (findUser(username)) return res.status(409).json({ error: 'Đã tồn tại' });
  const u = getUsers(); u.push({ username, name: name||username, role: role||'agent', passwordHash: hashPw(password), permissions: [] }); saveUsers(u);
  res.json({ ok: true });
});
app.put('/api/users/:username/permissions', requireAuth, requirePerm('manage_users'), (req, res) => {
  const u = getUsers(), x = u.find((y) => y.username === req.params.username);
  if (!x) return res.status(404).json({ error: 'Không tìm thấy' });
  if (Array.isArray(req.body?.permissions)) x.permissions = req.body.permissions;
  if (req.body?.role) x.role = req.body.role;
  saveUsers(u); res.json({ ok: true });
});
app.delete('/api/users/:username', requireAuth, requirePerm('manage_users'), (req, res) => {
  saveUsers(getUsers().filter((u) => u.username !== req.params.username)); res.json({ ok: true });
});

// SSE
app.get('/api/stream', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders(); res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('AGO WhatsApp Inbox (QR/Baileys): http://localhost:' + PORT);
  startWA().catch((e) => console.error('startWA:', e.message));   // tự kết nối lại nếu đã có phiên
});
