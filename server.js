// AGO WhatsApp Team Inbox — bản gộp 1 file để deploy dễ.
// Nhận/gửi WhatsApp Cloud API + tự dịch Anh<->Việt + đăng nhập & phân quyền.
try { require('dotenv').config(); } catch {} // .env chỉ dùng khi chạy local; trên Render lấy từ Environment
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-doi-di';
const VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const TKEY = process.env.GOOGLE_TRANSLATE_API_KEY;

// ---------------- STORE (JSON file) ----------------
const DATA_DIR = path.join(__dirname, 'data');
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
function upsertMessage(waId, name, m) {
  const all = getConvs();
  if (!all[waId]) all[waId] = { id: waId, name: name || waId, assignedTo: null, unread: 0, updatedAt: 0, messages: [] };
  if (name) all[waId].name = name;
  all[waId].messages.push(m);
  all[waId].updatedAt = m.ts;
  if (m.dir === 'in') all[waId].unread = (all[waId].unread || 0) + 1;
  saveConvs(all); return all[waId];
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

// ---------------- WHATSAPP ----------------
async function waSend(to, body) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('Chưa cấu hình WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID');
  const r = await fetch(`https://graph.facebook.com/${VERSION}/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('WhatsApp API: ' + JSON.stringify(d));
  return d;
}
function waParse(payload) {
  const out = [];
  for (const e of payload?.entry || [])
    for (const ch of e.changes || []) {
      const v = ch.value || {}, nameBy = {};
      for (const c of v.contacts || []) nameBy[c.wa_id] = c.profile?.name || c.wa_id;
      for (const m of v.messages || []) {
        if (m.type !== 'text') continue;
        out.push({ from: m.from, name: nameBy[m.from] || m.from, text: m.text?.body || '', ts: Number(m.timestamp) * 1000 || Date.now() });
      }
    }
  return out;
}

// ---------------- AUTO SEED (demo) ----------------
function autoSeed() {
  if (getUsers().length) return;
  saveUsers([
    { username:'admin', name:'Nguyệt (Admin)', role:'admin',  passwordHash:hashPw('demo123'), permissions:[] },
    { username:'linh',  name:'Linh (Sale)',    role:'agent',  passwordHash:hashPw('demo123'), permissions:[] },
    { username:'trang', name:'Trang (Leader)', role:'leader', passwordHash:hashPw('demo123'), permissions:[] }
  ]);
  saveConvs({
    "14155550001":{id:"14155550001",name:"Sarah M.",assignedTo:"linh",unread:1,updatedAt:1785900300000,messages:[
      {dir:"in",orig:"Hi! I saw your ad about fibroids and fertility.",trans:"Chào! Tôi thấy quảng cáo của bạn về u xơ tử cung và khả năng sinh sản.",translated:true,ts:1785900000000,by:null},
      {dir:"in",orig:"Is this safe if I have fibroids? I'm trying to conceive.",trans:"Sản phẩm này có an toàn nếu tôi bị u xơ không? Tôi đang muốn có con.",translated:true,ts:1785900100000,by:null},
      {dir:"out",orig:"Hi Sarah! Thanks for reaching out. AGO MOM is formulated to support reproductive wellness. May I ask a few questions to advise you better?",trans:"Chào Sarah! Cảm ơn bạn đã nhắn. AGO MOM được bào chế để hỗ trợ sức khỏe sinh sản. Cho mình hỏi vài câu để tư vấn kỹ hơn nhé?",translated:true,ts:1785900200000,by:"linh"},
      {dir:"in",orig:"Yes please. What is the price and do you ship to the US?",trans:"Vâng. Giá bao nhiêu và bạn có ship về Mỹ không?",translated:true,ts:1785900300000,by:null}
    ]},
    "14085552222":{id:"14085552222",name:"Jenny L.",assignedTo:null,unread:1,updatedAt:1785899000000,messages:[
      {dir:"in",orig:"How long until I see results?",trans:"Bao lâu thì tôi thấy hiệu quả?",translated:true,ts:1785899000000,by:null}
    ]}
  });
  console.log('✔ Seeded demo: admin/demo123 · linh/demo123 · trang/demo123');
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

// Webhook
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    for (const msg of waParse(req.body)) {
      const tr = await toAgent(msg.text);
      const c = upsertMessage(msg.from, msg.name, { dir:'in', orig:msg.text, trans:tr.text, translated:tr.translated, ts:msg.ts, by:null });
      broadcast({ type:'message', conversation:c });
    }
  } catch (e) { console.error('[webhook]', e.message); }
});

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

// Conversations
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json(Object.values(getConvs()).filter((c) => visibleTo(req.user, c)).sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id:c.id, name:c.name, assignedTo:c.assignedTo, unread:c.unread, updatedAt:c.updatedAt, last:c.messages[c.messages.length-1]||null })));
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
  try { await waSend(c.id, tr.text); } catch (e) { return res.status(502).json({ error: 'Gửi WhatsApp lỗi: ' + e.message }); }
  const conv = upsertMessage(c.id, c.name, { dir:'out', orig:tr.text, trans:vi, translated:tr.translated, ts:Date.now(), by:req.user.username });
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
app.listen(PORT, () => console.log('AGO WhatsApp Inbox: http://localhost:' + PORT));
