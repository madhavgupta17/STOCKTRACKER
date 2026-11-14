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

app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const given = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':');
  if (given === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="GodownStock"').status(401).send('Login required');
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ─── MODELS ───────────────────────────────────────────────────────────────────
const Tx = mongoose.model('Tx', new mongoose.Schema({
  type:  { type: String, enum: ['purchase', 'sale'], required: true, index: true },
  date:  { type: String, required: true, match: DATE, index: true },
  party: { type: String, required: true, trim: true, uppercase: true },
  lines: [{ _id: false, grade: { type: String, required: true }, qty: { type: Number, required: true, min: 0.0001 } }],
  notes: { type: String, default: '' },
}, { timestamps: true }));

const Grade   = mongoose.model('Grade',   new mongoose.Schema({ name: { type: String, unique: true, required: true } }));
const Company = mongoose.model('Company', new mongoose.Schema({ name: { type: String, unique: true, required: true } }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const h     = f => (q, s) => f(q, s).catch(e => s.status(400).json({ error: e.message }));
const range = q => {
  const m = {};
  if (q.from || q.to) m.date = {};
  if (q.from) m.date.$gte = q.from;
  if (q.to)   m.date.$lte = q.to;
  return m;
};
const clean = b => {
  const lines = (b.lines || [])
    .map(l => ({ grade: String(l.grade || '').trim(), qty: Number(l.qty) }))
    .filter(l => l.grade);
  if (!lines.length)              throw new Error('Add at least one item');
  if (lines.some(l => !(l.qty > 0))) throw new Error('Every quantity must be above 0');
  if (!DATE.test(b.date || ''))  throw new Error('Invalid date');
  if (!(b.party || '').trim())   throw new Error('Company / Name is required');
  return { type: b.type, date: b.date, party: b.party, lines, notes: b.notes || '' };
};

// ─── GRADE / CATEGORY ENDPOINTS ───────────────────────────────────────────────
app.get('/api/grades', h(async (q, s) => s.json((await Grade.find().sort('_id')).map(g => g.name))));

app.post('/api/grades', h(async (q, s) => {
  await Grade.create({ name: String(q.body.name).trim() });
  s.json({ ok: 1 });
}));

app.delete('/api/grades/:name', h(async (q, s) => {
  if (await Tx.exists({ 'lines.grade': q.params.name }))
    throw new Error('This category has entries — cannot remove');
  await Grade.deleteOne({ name: q.params.name });
  s.json({ ok: 1 });
}));

app.patch('/api/grades/:name', h(async (q, s) => {
  const oldName = q.params.name;
  const newName = String(q.body.name || '').trim();
  if (!newName) throw new Error('New category name is required');
  if (newName === oldName) return s.json({ ok: 1 });
  if (await Grade.exists({ name: newName })) throw new Error('"' + newName + '" already exists');
  await Grade.updateOne({ name: oldName }, { name: newName });
  await Tx.updateMany(
    { 'lines.grade': oldName },
    { $set: { 'lines.$[el].grade': newName } },
    { arrayFilters: [{ 'el.grade': oldName }] }
  );
  s.json({ ok: 1 });
}));

// ─── COMPANY ENDPOINTS ────────────────────────────────────────────────────────
app.get('/api/companies', h(async (q, s) => s.json((await Company.find().sort('_id')).map(c => c.name))));

app.post('/api/companies', h(async (q, s) => {
  await Company.create({ name: String(q.body.name).trim().toUpperCase() });
  s.json({ ok: 1 });
}));

app.delete('/api/companies/:name', h(async (q, s) => {
  if (await Tx.exists({ type: 'purchase', party: q.params.name }))
    throw new Error('This company has purchase records — cannot remove');
  await Company.deleteOne({ name: q.params.name });
  s.json({ ok: 1 });
}));

app.patch('/api/companies/:name', h(async (q, s) => {
  const oldName = q.params.name;
  const newName = String(q.body.name || '').trim().toUpperCase();
  if (!newName) throw new Error('New company name is required');
  if (newName === oldName) return s.json({ ok: 1 });
  if (await Company.exists({ name: newName })) throw new Error('"' + newName + '" already exists');
  await Company.updateOne({ name: oldName }, { name: newName });
  await Tx.updateMany({ type: 'purchase', party: oldName }, { party: newName });
  s.json({ ok: 1 });
}));

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
app.get('/api/settings', h(async (q, s) => { const t = await Setting.findOne({ key: 'low' }); s.json({ low: t ? t.value : 5 }); }));
app.put('/api/settings', h(async (q, s) => { await Setting.updateOne({ key: 'low' }, { value: Number(q.body.low) || 0 }, { upsert: true }); s.json({ ok: 1 }); }));

// ─── TRANSACTION ENDPOINTS ────────────────────────────────────────────────────
app.get('/api/tx', h(async (q, s) => {
  const m = { ...range(q.query) };
  if (q.query.type)  m.type = q.query.type;
  if (q.query.grade) m['lines.grade'] = q.query.grade;
  if (q.query.q)     m.party = new RegExp(q.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  s.json(await Tx.find(m).sort({ date: -1, createdAt: -1 }));
}));
app.post('/api/tx',      h(async (q, s) => s.json(await Tx.create(clean(q.body)))));
app.put('/api/tx/:id',   h(async (q, s) => s.json(await Tx.findByIdAndUpdate(q.params.id, clean(q.body), { new: true, runValidators: true }))));
app.delete('/api/tx/:id',h(async (q, s) => { await Tx.findByIdAndDelete(q.params.id); s.json({ ok: 1 }); }));
app.get('/api/tx/:id',   h(async (q, s) => s.json(await Tx.findById(q.params.id))));
app.get('/api/parties',  h(async (q, s) => s.json(await Tx.distinct('party', { type: q.query.type }))));

// ─── STOCK SUMMARY (for entry forms) ─────────────────────────────────────────
app.get('/api/stock', h(async (q, s) => {
  const agg = m => Tx.aggregate([
    { $match: m }, { $unwind: '$lines' },
    { $group: { _id: { g: '$lines.grade', t: '$type' }, n: { $sum: '$lines.qty' } } }
  ]);
  const [inRange, all, grades] = await Promise.all([agg(range(q.query)), agg({}), Grade.find().sort('_id')]);
  const get = (a, g, t) => (a.find(x => x._id.g === g && x._id.t === t) || { n: 0 }).n;
  const names = [...new Set([...grades.map(g => g.name), ...all.map(x => x._id.g)])];
  s.json(names.map(g => ({
    grade: g,
    added: get(inRange, g, 'purchase'),
    sold:  get(inRange, g, 'sale'),
    balance: get(all, g, 'purchase') - get(all, g, 'sale'),
  })));
}));

// ─── STOCK MATRIX — Company × Category Pivot ─────────────────────────────────
app.get('/api/stock-matrix', h(async (q, s) => {
  const [allTx, grades, companies] = await Promise.all([
    Tx.find().sort({ date: 1, createdAt: 1 }),
    Grade.find().sort('_id'),
    Company.find().sort('_id'),
  ]);

  // Aggregate purchases by (grade, company) and sales by grade
  const purchByCompGrade = {};   // grade → { company: qty }
  const soldByGrade      = {};   // grade → qty

  for (const tx of allTx) {
    for (const l of tx.lines) {
      if (tx.type === 'purchase') {
        if (!purchByCompGrade[l.grade]) purchByCompGrade[l.grade] = {};
        purchByCompGrade[l.grade][tx.party] = (purchByCompGrade[l.grade][tx.party] || 0) + l.qty;
      } else {
        soldByGrade[l.grade] = (soldByGrade[l.grade] || 0) + l.qty;
      }
    }
  }

  const compNames = companies.map(c => c.name);
  const catNames  = grades.map(g => g.name);
  const matrix    = {};
  const compTotals = Object.fromEntries(compNames.map(c => [c, 0]));
  let grandTotal  = 0;

  for (const cat of catNames) {
    const purch  = purchByCompGrade[cat] || {};
    const totalP = Object.values(purch).reduce((a, b) => a + b, 0);
    const totalS = soldByGrade[cat] || 0;
    const balance = Math.max(0, totalP - totalS);

    matrix[cat] = { _total: balance };
    for (const comp of compNames) {
      const compP   = purch[comp] || 0;
      // Proportional attribution of remaining balance per company
      const compBal = totalP > 0
        ? Math.round((compP / totalP) * balance * 100) / 100
        : 0;
      matrix[cat][comp]      = compBal;
      compTotals[comp]       = Math.round((compTotals[comp] + compBal) * 100) / 100;
    }
    grandTotal = Math.round((grandTotal + balance) * 100) / 100;
  }

  s.json({ categories: catNames, companies: compNames, matrix, compTotals, grandTotal });
}));

// ─── EXPORT / IMPORT ─────────────────────────────────────────────────────────
app.get('/api/export', h(async (q, s) => {
  const [grades, companies, txs, lowSetting] = await Promise.all([
    Grade.find().sort('_id'),
    Company.find().sort('_id'),
    Tx.find().sort({ date: 1, createdAt: 1 }),
    Setting.findOne({ key: 'low' }),
  ]);
  s.json({
    version:      2,
    grades:       grades.map(g => g.name),
    companies:    companies.map(c => c.name),
    transactions: txs,
    threshold:    lowSetting ? lowSetting.value : 0,
  });
}));

app.post('/api/import', h(async (q, s) => {
  const { grades = [], companies = [], transactions = [], threshold } = q.body || {};
  for (const g of grades) {
    const name = String(g).trim();
    if (name) await Grade.updateOne({ name }, { name }, { upsert: true });
  }
  for (const c of companies) {
    const name = String(c).trim().toUpperCase();
    if (name) await Company.updateOne({ name }, { name }, { upsert: true });
  }
  if (threshold !== undefined) {
    await Setting.updateOne({ key: 'low' }, { value: Number(threshold) || 0 }, { upsert: true });
  }
  for (const tx of transactions) {
    if (tx.type && tx.date && tx.party && Array.isArray(tx.lines) && tx.lines.length) {
      const exists = tx._id ? await Tx.findById(tx._id).catch(() => null) : null;
      if (!exists) await Tx.create({ ...tx, _id: undefined }).catch(() => {});
    }
  }
  s.json({ ok: 1, grades: grades.length, companies: companies.length, transactions: transactions.length });
}));

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── DEFAULT DATA ─────────────────────────────────────────────────────────────
const DEFAULT_COMPANIES = ['MANIKANTHA', 'NUTBERRY', 'CAPITAL', 'ALKA'];
const DEFAULT_GRADES    = [
  'JH', 'S240', 'Mix', 'W240', 'W320', 'Y320', 'Sk', 'Kk',
  'Sjh', 'Mix 400', 'S210', 'Bpcs', 'K2', 'Lwp', 'W160',
  'JK 1', 'Swp', 'JH 1', 'W400', 'A210', 'A320',
];

// ─── CONNECT & START ──────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/godownstock').then(async () => {
  const ver = await Setting.findOne({ key: 'schema_version' });
  if (!ver || ver.value < 2) {
    // Clear ALL old data and reinitialise with new structure
    await Promise.all([Tx.deleteMany({}), Grade.deleteMany({}), Company.deleteMany({})]);
    await Grade.insertMany(DEFAULT_GRADES.map(name => ({ name })));
    await Company.insertMany(DEFAULT_COMPANIES.map(name => ({ name })));
    await Setting.updateOne({ key: 'schema_version' }, { value: 2 }, { upsert: true });
    console.log('✓ Database restructured — company + category matrix schema v2');
  }
  app.listen(process.env.PORT || 3000, () =>
    console.log('GodownStock running on port', process.env.PORT || 3000)
  );
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
