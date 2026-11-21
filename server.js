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
const VALID_LOCATIONS = ['GODOWN 1', 'GODOWN 2', 'OFFICE'];

// ─── MODELS ───────────────────────────────────────────────────────────────────
const Tx = mongoose.model('Tx', new mongoose.Schema({
  type:     { type: String, enum: ['purchase', 'sale'], required: true, index: true },
  date:     { type: String, required: true, match: DATE, index: true },
  party:    { type: String, required: true, trim: true, uppercase: true },
  location: { type: String, default: 'GODOWN 1', trim: true, uppercase: true, index: true },
  lines:    [{ _id: false, grade: { type: String, required: true }, qty: { type: Number, required: true, min: 0.0001 }, company: { type: String, default: '', trim: true, uppercase: true } }],
  notes:    { type: String, default: '' },
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
  const sale = b.type === 'sale';
  const lines = (b.lines || [])
    .map(l => {
      const obj = { grade: String(l.grade || '').trim(), qty: Number(l.qty) };
      if (sale && l.company) obj.company = String(l.company).trim().toUpperCase();
      return obj;
    })
    .filter(l => l.grade);
  if (!lines.length)              throw new Error('Add at least one item');
  if (lines.some(l => !(l.qty > 0))) throw new Error('Every quantity must be above 0');
  if (sale && lines.some(l => !l.company)) throw new Error('Select a company for every sale line');
  if (!DATE.test(b.date || ''))  throw new Error('Invalid date');
  if (!(b.party || '').trim())   throw new Error('Buyer / Company name is required');
  let location = String(b.location || 'GODOWN 1').trim().toUpperCase();
  if (!VALID_LOCATIONS.includes(location)) location = 'GODOWN 1';
  return { type: b.type, date: b.date, party: b.party, location, lines, notes: b.notes || '' };
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
  if (q.query.type)     m.type = q.query.type;
  if (q.query.location && q.query.location !== 'ALL') m.location = q.query.location;
  if (q.query.grade)    m['lines.grade'] = q.query.grade;
  if (q.query.q)        m.party = new RegExp(q.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  s.json(await Tx.find(m).sort({ date: -1, createdAt: -1 }));
}));
app.post('/api/tx',      h(async (q, s) => s.json(await Tx.create(clean(q.body)))));
app.put('/api/tx/:id',   h(async (q, s) => s.json(await Tx.findByIdAndUpdate(q.params.id, clean(q.body), { new: true, runValidators: true }))));
app.delete('/api/tx/:id',h(async (q, s) => { await Tx.findByIdAndDelete(q.params.id); s.json({ ok: 1 }); }));
app.get('/api/tx/:id',   h(async (q, s) => s.json(await Tx.findById(q.params.id))));
app.get('/api/parties',  h(async (q, s) => s.json(await Tx.distinct('party', { type: q.query.type }))));

// ─── STOCK SUMMARY (for entry forms & validation) ─────────────────────────────
app.get('/api/stock', h(async (q, s) => {
  const inRangeFilter = range(q.query);
  const allFilter = {};
  if (q.query.location && q.query.location !== 'ALL') {
    inRangeFilter.location = q.query.location;
    allFilter.location     = q.query.location;
  }
  const agg = m => Tx.aggregate([
    { $match: m }, { $unwind: '$lines' },
    { $group: { _id: { g: '$lines.grade', t: '$type' }, n: { $sum: '$lines.qty' } } }
  ]);
  const [inRange, all, grades] = await Promise.all([agg(inRangeFilter), agg(allFilter), Grade.find().sort('_id')]);
  const get = (a, g, t) => (a.find(x => x._id.g === g && x._id.t === t) || { n: 0 }).n;
  const names = [...new Set([...grades.map(g => g.name), ...all.map(x => x._id.g)])];
  s.json(names.map(g => ({
    grade: g,
    added: get(inRange, g, 'purchase'),
    sold:  get(inRange, g, 'sale'),
    balance: get(all, g, 'purchase') - get(all, g, 'sale'),
  })));
}));

// ─── STOCK MATRIX — Company × Category Pivot (Filterable by Godown / Location)
app.get('/api/stock-matrix', h(async (q, s) => {
  const txFilter = {};
  if (q.query.location && q.query.location !== 'ALL') {
    txFilter.location = q.query.location;
  }

  const [allTx, grades, companies] = await Promise.all([
    Tx.find(txFilter).sort({ date: 1, createdAt: 1 }),
    Grade.find().sort('_id'),
    Company.find().sort('_id'),
  ]);

  // Direct attribution — NO proportional math → no fractions
  const stock = {}; // stock[grade][company] = net qty
  for (const tx of allTx) {
    for (const l of tx.lines) {
      const company = tx.type === 'purchase' ? tx.party : (l.company || '');
      if (!company) continue; // skip old sale lines without a company
      if (!stock[l.grade]) stock[l.grade] = {};
      stock[l.grade][company] = (stock[l.grade][company] || 0) + (tx.type === 'purchase' ? l.qty : -l.qty);
    }
  }

  const compNames  = companies.map(c => c.name);
  const catNames   = grades.map(g => g.name);
  const matrix     = {};
  const compTotals = Object.fromEntries(compNames.map(c => [c, 0]));
  let grandTotal   = 0;

  for (const cat of catNames) {
    const catStock = stock[cat] || {};
    matrix[cat] = { _total: 0 };
    for (const comp of compNames) {
      const balance = Math.max(0, Math.round((catStock[comp] || 0) * 100) / 100);
      matrix[cat][comp] = balance;
      compTotals[comp]  = Math.round((compTotals[comp] + balance) * 100) / 100;
      matrix[cat]._total = Math.round((matrix[cat]._total + balance) * 100) / 100;
    }
    grandTotal = Math.round((grandTotal + matrix[cat]._total) * 100) / 100;
  }

  s.json({
    location: q.query.location || 'ALL',
    locations: VALID_LOCATIONS,
    categories: catNames,
    companies: compNames,
    matrix,
    compTotals,
    grandTotal
  });
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
    version:      3,
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
      const loc = VALID_LOCATIONS.includes(String(tx.location || '').toUpperCase()) ? tx.location.toUpperCase() : 'GODOWN 1';
      await Tx.create({ ...tx, location: loc, _id: undefined }).catch(() => {});
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
    await Promise.all([Tx.deleteMany({}), Grade.deleteMany({}), Company.deleteMany({})]);
    await Grade.insertMany(DEFAULT_GRADES.map(name => ({ name })));
    await Company.insertMany(DEFAULT_COMPANIES.map(name => ({ name })));
    await Setting.updateOne({ key: 'schema_version' }, { value: 3 }, { upsert: true });
    console.log('✓ Database initialised — schema v3 with Godown 1, Godown 2 & Office');
  } else if (ver.value < 3) {
    await Tx.updateMany({ location: { $exists: false } }, { $set: { location: 'GODOWN 1' } });
    await Setting.updateOne({ key: 'schema_version' }, { value: 3 }, { upsert: true });
    console.log('✓ Database migrated to schema v3 — locations supported');
  }
  if ((await Grade.countDocuments()) === 0) {
    await Grade.insertMany(DEFAULT_GRADES.map(name => ({ name })));
  }
  if ((await Company.countDocuments()) === 0) {
    await Company.insertMany(DEFAULT_COMPANIES.map(name => ({ name })));
  }
  app.listen(process.env.PORT || 3000, () =>
    console.log('GodownStock running on port', process.env.PORT || 3000)
  );
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
