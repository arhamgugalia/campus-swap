const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || ''; // e.g. "college.edu" to restrict signups
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(__dirname, 'campus.db'));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, phone TEXT, password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT, price REAL NOT NULL,
    category TEXT NOT NULL, image TEXT, sold INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id))`);
  // migrations for databases created by the first version (errors = column already exists)
  db.run(`ALTER TABLE items ADD COLUMN item_condition TEXT DEFAULT 'Good'`, () => {});
  db.run(`ALTER TABLE items ADD COLUMN views INTEGER DEFAULT 0`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS favorites(
    user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, PRIMARY KEY(user_id,item_id))`);
  db.run(`CREATE TABLE IF NOT EXISTS requests(
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL,
    message TEXT, offer_price REAL, status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype))
});

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const auth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Please log in first.' });
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error.' }); });

// ---- Auth ----
app.post('/api/register', wrap(async (req, res) => {
  let { name, email, phone, password } = req.body;
  name = (name || '').trim(); email = (email || '').trim().toLowerCase();
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Invalid email.' });
  if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) return res.status(400).json({ error: `Use your @${ALLOWED_DOMAIN} email.` });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await get('SELECT id FROM users WHERE email=?', [email])) return res.status(409).json({ error: 'Email already registered.' });
  const hash = await bcrypt.hash(password, 10);
  const r = await run('INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)', [name, email, (phone || '').trim(), hash]);
  req.session.userId = r.lastID;
  res.json({ id: r.lastID, name, email });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const u = await get('SELECT * FROM users WHERE email=?', [email]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(401).json({ error: 'Wrong email or password.' });
  req.session.userId = u.id;
  res.json({ id: u.id, name: u.name, email: u.email });
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', wrap(async (req, res) => {
  if (!req.session.userId) return res.json(null);
  const u = await get('SELECT id,name,email,phone FROM users WHERE id=?', [req.session.userId]);
  const p = await get(`SELECT COUNT(*) c FROM requests r JOIN items i ON i.id=r.item_id
                       WHERE i.user_id=? AND r.status='pending'`, [u.id]);
  res.json({ ...u, pending: p.c });
}));

// ---- Items ----
const SELECT = `SELECT i.*, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
  (SELECT COUNT(*) FROM favorites f WHERE f.item_id=i.id AND f.user_id=?) AS fav
  FROM items i JOIN users u ON u.id=i.user_id`;
const SORTS = { new: 'i.created_at DESC', low: 'i.price ASC', high: 'i.price DESC', popular: 'i.views DESC' };
const hide = (r, uid) => uid ? r : { ...r, seller_email: null, seller_phone: null };

app.get('/api/items', wrap(async (req, res) => {
  const uid = req.session.userId || 0;
  const { q, category, mine, fav, sort, min, max } = req.query;
  const where = [], p = [uid];
  if (q) { where.push('(i.title LIKE ? OR i.description LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (category && category !== 'All') { where.push('i.category=?'); p.push(category); }
  if (min !== undefined && min !== '' && !isNaN(+min)) { where.push('i.price>=?'); p.push(+min); }
  if (max !== undefined && max !== '' && !isNaN(+max)) { where.push('i.price<=?'); p.push(+max); }
  if (mine || fav) {
    if (!uid) return res.status(401).json({ error: 'Log in first.' });
    if (mine) { where.push('i.user_id=?'); p.push(uid); }
    if (fav) { where.push('i.id IN (SELECT item_id FROM favorites WHERE user_id=?)'); p.push(uid); }
  }
  const rows = await all(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.sold ASC, ${SORTS[sort] || SORTS.new}`, p);
  res.json(rows.map(r => hide(r, uid)));
}));

// single item (buyer's detail page)
app.get('/api/items/:id', wrap(async (req, res) => {
  const uid = req.session.userId || 0;
  const it = await get(`${SELECT} WHERE i.id=?`, [uid, req.params.id]);
  if (!it) return res.status(404).json({ error: 'Item not found.' });
  if (it.user_id !== uid) { await run('UPDATE items SET views=views+1 WHERE id=?', [it.id]); it.views++; }
  it.my_request = uid ? await get('SELECT * FROM requests WHERE item_id=? AND buyer_id=? ORDER BY id DESC', [it.id, uid]) || null : null;
  it.request_count = it.user_id === uid ? (await get(`SELECT COUNT(*) c FROM requests WHERE item_id=? AND status='pending'`, [it.id])).c : 0;
  res.json(hide(it, uid));
}));

app.post('/api/items', auth, upload.single('image'), wrap(async (req, res) => {
  const { title, description, price, category, item_condition } = req.body;
  if (!title || !title.trim() || price === undefined || isNaN(+price) || +price < 0 || !category)
    return res.status(400).json({ error: 'Title, valid price and category are required.' });
  const r = await run('INSERT INTO items(user_id,title,description,price,category,item_condition,image) VALUES(?,?,?,?,?,?,?)',
    [req.session.userId, title.trim(), (description || '').trim(), +price, category, item_condition || 'Good', req.file ? req.file.filename : null]);
  res.json({ id: r.lastID });
}));

app.patch('/api/items/:id/sold', auth, wrap(async (req, res) => {
  const r = await run('UPDATE items SET sold = 1 - sold WHERE id=? AND user_id=?', [req.params.id, req.session.userId]);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found.' });
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  const it = await get('SELECT * FROM items WHERE id=? AND user_id=?', [req.params.id, req.session.userId]);
  if (!it) return res.status(404).json({ error: 'Not found.' });
  await run('DELETE FROM items WHERE id=?', [it.id]);
  await run('DELETE FROM requests WHERE item_id=?', [it.id]);
  await run('DELETE FROM favorites WHERE item_id=?', [it.id]);
  if (it.image) fs.unlink(path.join(UPLOAD_DIR, it.image), () => {});
  res.json({ ok: true });
}));

// ---- Wishlist ----
app.post('/api/items/:id/fav', auth, wrap(async (req, res) => {
  const uid = req.session.userId, id = req.params.id;
  const ex = await get('SELECT 1 x FROM favorites WHERE user_id=? AND item_id=?', [uid, id]);
  if (ex) await run('DELETE FROM favorites WHERE user_id=? AND item_id=?', [uid, id]);
  else await run('INSERT INTO favorites(user_id,item_id) VALUES(?,?)', [uid, id]);
  res.json({ fav: !ex });
}));

// ---- Buy requests ----
app.post('/api/items/:id/requests', auth, wrap(async (req, res) => {
  const uid = req.session.userId;
  const it = await get('SELECT * FROM items WHERE id=?', [req.params.id]);
  if (!it) return res.status(404).json({ error: 'Item not found.' });
  if (it.user_id === uid) return res.status(400).json({ error: "You can't buy your own item." });
  if (it.sold) return res.status(400).json({ error: 'This item is already sold.' });
  if (await get(`SELECT id FROM requests WHERE item_id=? AND buyer_id=? AND status='pending'`, [it.id, uid]))
    return res.status(409).json({ error: 'You already have a pending request for this item.' });
  const offer = req.body.offer_price === '' || req.body.offer_price == null ? it.price : +req.body.offer_price;
  if (isNaN(offer) || offer < 0) return res.status(400).json({ error: 'Invalid offer price.' });
  await run('INSERT INTO requests(item_id,buyer_id,message,offer_price) VALUES(?,?,?,?)',
    [it.id, uid, (req.body.message || '').trim().slice(0, 500), offer]);
  res.json({ ok: true });
}));

app.get('/api/requests/received', auth, wrap(async (req, res) => {
  res.json(await all(`SELECT r.*, i.title, i.image, i.price, u.name AS other_name, u.email AS other_email, u.phone AS other_phone
    FROM requests r JOIN items i ON i.id=r.item_id JOIN users u ON u.id=r.buyer_id
    WHERE i.user_id=? ORDER BY r.created_at DESC`, [req.session.userId]));
}));

app.get('/api/requests/sent', auth, wrap(async (req, res) => {
  res.json(await all(`SELECT r.*, i.title, i.image, i.price, u.name AS other_name, u.email AS other_email, u.phone AS other_phone
    FROM requests r JOIN items i ON i.id=r.item_id JOIN users u ON u.id=i.user_id
    WHERE r.buyer_id=? ORDER BY r.created_at DESC`, [req.session.userId]));
}));

// seller accepts / declines
app.patch('/api/requests/:id', auth, wrap(async (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const r = await get(`SELECT r.* FROM requests r JOIN items i ON i.id=r.item_id
    WHERE r.id=? AND i.user_id=? AND r.status='pending'`, [req.params.id, req.session.userId]);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  await run('UPDATE requests SET status=? WHERE id=?', [status, r.id]);
  if (status === 'accepted') {
    await run('UPDATE items SET sold=1 WHERE id=?', [r.item_id]);
    await run(`UPDATE requests SET status='declined' WHERE item_id=? AND id<>? AND status='pending'`, [r.item_id, r.id]);
  }
  res.json({ ok: true });
}));

// buyer cancels own pending request
app.delete('/api/requests/:id', auth, wrap(async (req, res) => {
  const r = await run(`DELETE FROM requests WHERE id=? AND buyer_id=? AND status='pending'`, [req.params.id, req.session.userId]);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Request not found.' });
}));

app.listen(PORT, () => console.log(`Campus Swap running at http://localhost:${PORT}`));
