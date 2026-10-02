require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Optional password protection (set APP_PASSWORD on Render). Username can be anything.
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const given = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':');
  if (given === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="CashewTrack"').status(401).send('Login required');
});

const DATE = /^\d{4}-\d{2}-\d{2}$/; // dates are stored as plain YYYY-MM-DD strings: no timezone shifts, ever
const Tx = mongoose.model('Tx', new mongoose.Schema({
  type: { type: String, enum: ['purchase', 'sale'], required: true, index: true },
  date: { type: String, required: true, match: DATE, index: true },
  party: { type: String, required: true, trim: true, uppercase: true },
  lines: [{ _id: false, grade: { type: String, required: true }, qty: { type: Number, required: true, min: 0.0001 } }],
  notes: { type: String, default: '' },
}, { timestamps: true }));
const Grade = mongoose.model('Grade', new mongoose.Schema({ name: { type: String, unique: true, required: true } }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }));

const h = f => (q, s) => f(q, s).catch(e => s.status(400).json({ error: e.message }));
const range = q => {
  const m = {};
  if (q.from || q.to) m.date = {};
  if (q.from) m.date.$gte = q.from;
  if (q.to) m.date.$lte = q.to;
  return m;
};
const clean = b => {
  const lines = (b.lines || []).map(l => ({ grade: String(l.grade || '').trim(), qty: Number(l.qty) })).filter(l => l.grade);
  if (!lines.length) throw new Error('Add at least one item');
  if (lines.some(l => !(l.qty > 0))) throw new Error('Every quantity must be above 0');
  if (!DATE.test(b.date || '')) throw new Error('Invalid date');
  if (!(b.party || '').trim()) throw new Error('Name is required');
  return { type: b.type, date: b.date, party: b.party, lines, notes: b.notes || '' };
};

app.get('/api/grades', h(async (q, s) => s.json((await Grade.find().sort('_id')).map(g => g.name))));
app.post('/api/grades', h(async (q, s) => { await Grade.create({ name: String(q.body.name).trim().toUpperCase() }); s.json({ ok: 1 }); }));
app.delete('/api/grades/:name', h(async (q, s) => {
  if (await Tx.exists({ 'lines.grade': q.params.name })) throw new Error('This grade has entries, so it cannot be removed');
  await Grade.deleteOne({ name: q.params.name }); s.json({ ok: 1 });
}));

app.get('/api/settings', h(async (q, s) => { const t = await Setting.findOne({ key: 'low' }); s.json({ low: t ? t.value : 5 }); }));
app.put('/api/settings', h(async (q, s) => { await Setting.updateOne({ key: 'low' }, { value: Number(q.body.low) || 0 }, { upsert: true }); s.json({ ok: 1 }); }));

app.get('/api/tx', h(async (q, s) => {
  const m = { ...range(q.query) };
  if (q.query.type) m.type = q.query.type;
  if (q.query.grade) m['lines.grade'] = q.query.grade;
  if (q.query.q) m.party = new RegExp(q.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  s.json(await Tx.find(m).sort({ date: -1, createdAt: -1 }));
}));
app.post('/api/tx', h(async (q, s) => s.json(await Tx.create(clean(q.body)))));
app.put('/api/tx/:id', h(async (q, s) => s.json(await Tx.findByIdAndUpdate(q.params.id, clean(q.body), { new: true, runValidators: true }))));
app.delete('/api/tx/:id', h(async (q, s) => { await Tx.findByIdAndDelete(q.params.id); s.json({ ok: 1 }); }));
app.get('/api/tx/:id', h(async (q, s) => s.json(await Tx.findById(q.params.id))));

// Flat grade search: one row per (entry, grade) with the running balance of that grade after the entry.
app.get('/api/search', h(async (q, s) => {
  const { grades = '', type, from, to, min, max, q: name, sort = 'date_desc' } = q.query;
  const gs = grades.split(',').filter(Boolean);
  const all = await Tx.find().sort({ date: 1, createdAt: 1 });
  const bal = {}, out = [];
  for (const t of all) for (const l of t.lines) {
    bal[l.grade] = (bal[l.grade] || 0) + (t.type === 'purchase' ? l.qty : -l.qty);
    out.push({ id: t._id, date: t.date, type: t.type, party: t.party, grade: l.grade, qty: l.qty, notes: t.notes, bal: bal[l.grade] });
  }
  const nm = (name || '').toUpperCase();
  const rows = out.filter(r => (!gs.length || gs.includes(r.grade)) && (!type || r.type === type) && (!from || r.date >= from) && (!to || r.date <= to)
    && (min === '' || min == null || r.qty >= +min) && (max === '' || max == null || r.qty <= +max) && (!nm || r.party.includes(nm)));
  const [k, dir] = sort.split('_');
  rows.sort((a, b) => (k === 'qty' ? a.qty - b.qty : a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  s.json(rows);
}));

app.get('/api/parties', h(async (q, s) => s.json(await Tx.distinct('party', { type: q.query.type }))));

// Per-grade added/sold within an optional date range, plus the current overall balance.
app.get('/api/stock', h(async (q, s) => {
  const agg = m => Tx.aggregate([{ $match: m }, { $unwind: '$lines' }, { $group: { _id: { g: '$lines.grade', t: '$type' }, n: { $sum: '$lines.qty' } } }]);
  const [inRange, all, grades] = await Promise.all([agg(range(q.query)), agg({}), Grade.find().sort('_id')]);
  const get = (a, g, t) => (a.find(x => x._id.g === g && x._id.t === t) || { n: 0 }).n;
  const names = [...new Set([...grades.map(g => g.name), ...all.map(x => x._id.g)])];
  s.json(names.map(g => ({
    grade: g, added: get(inRange, g, 'purchase'), sold: get(inRange, g, 'sale'),
    balance: get(all, g, 'purchase') - get(all, g, 'sale'),
  })));
}));

app.get('/api/export', h(async (q, s) => {
  const [grades, txs, lowSetting] = await Promise.all([
    Grade.find().sort('_id'),
    Tx.find().sort({ date: 1, createdAt: 1 }),
    Setting.findOne({ key: 'low' })
  ]);
  const inventory = [], sales = [];
  for (const t of txs) {
    for (const l of t.lines) {
      if (t.type === 'purchase') {
        inventory.push({ id: t._id, date: t.date, seller: t.party, grade: l.grade, qty: l.qty, notes: t.notes || '' });
      } else {
        sales.push({ id: t._id, date: t.date, buyer: t.party, grade: l.grade, qty: l.qty, notes: t.notes || '' });
      }
    }
  }
  s.json({ inventory, sales, grades: grades.map(g => g.name), threshold: lowSetting ? lowSetting.value : 0 });
}));

app.post('/api/import', h(async (q, s) => {
  const { inventory = [], sales = [], grades = [], threshold } = q.body || {};
  for (const g of grades) {
    const name = String(g).trim().toUpperCase();
    if (name) await Grade.updateOne({ name }, { name }, { upsert: true });
  }
  if (threshold !== undefined) {
    await Setting.updateOne({ key: 'low' }, { value: Number(threshold) || 0 }, { upsert: true });
  }
  for (const item of inventory) {
    if (!item.grade || !item.seller || !item.qty) continue;
    const date = item.date;
    const party = item.seller.trim().toUpperCase();
    const grade = item.grade.trim();
    const qty = Number(item.qty);
    const notes = item.notes || '';
    const exists = await Tx.findOne({ type: 'purchase', date, party, 'lines.grade': grade, 'lines.qty': qty, notes });
    if (!exists) {
      await Tx.create({ type: 'purchase', date, party, lines: [{ grade, qty }], notes });
    }
  }
  for (const item of sales) {
    if (!item.grade || !item.buyer || !item.qty) continue;
    const date = item.date;
    const party = item.buyer.trim().toUpperCase();
    const grade = item.grade.trim();
    const qty = Number(item.qty);
    const notes = item.notes || '';
    const exists = await Tx.findOne({ type: 'sale', date, party, 'lines.grade': grade, 'lines.qty': qty, notes });
    if (!exists) {
      await Tx.create({ type: 'sale', date, party, lines: [{ grade, qty }], notes });
    }
  }
  s.json({ ok: 1, inventoryCount: inventory.length, salesCount: sales.length });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cashewtrack').then(async () => {
  if (!(await Grade.countDocuments()))
    await Grade.insertMany('SW320 JH1 JH LWP SW240 W210 W320 W400 W180 W240 K2 K'.split(' ').map(name => ({ name })));
  app.listen(process.env.PORT || 3000, () => console.log('CashewTrack running'));
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
