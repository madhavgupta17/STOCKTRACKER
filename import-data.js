require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cashewtrack';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Tx = mongoose.model('Tx', new mongoose.Schema({
  type: { type: String, enum: ['purchase', 'sale'], required: true, index: true },
  date: { type: String, required: true, match: DATE, index: true },
  party: { type: String, required: true, trim: true, uppercase: true },
  lines: [{ _id: false, grade: { type: String, required: true }, qty: { type: Number, required: true, min: 0.0001 } }],
  notes: { type: String, default: '' },
}, { timestamps: true }));

const Grade = mongoose.model('Grade', new mongoose.Schema({ name: { type: String, unique: true, required: true } }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed }));

async function run() {
  const filePath = path.join(__dirname, 'backup.json');
  if (!fs.existsSync(filePath)) {
    console.error('backup.json not found in', __dirname);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(uri);
  console.log(`Connected to database: ${mongoose.connection.name}`);

  // 1. Import grades
  if (data.grades && Array.isArray(data.grades)) {
    let gradeCount = 0;
    for (const g of data.grades) {
      const name = String(g).trim().toUpperCase();
      if (!name) continue;
      const res = await Grade.updateOne({ name }, { name }, { upsert: true });
      if (res.upsertedCount > 0) gradeCount++;
    }
    console.log(`✓ Processed ${data.grades.length} grades (${gradeCount} new added).`);
  }

  // 2. Import threshold
  if (data.threshold !== undefined) {
    await Setting.updateOne({ key: 'low' }, { value: Number(data.threshold) || 0 }, { upsert: true });
    console.log(`✓ Low stock threshold set to: ${data.threshold}`);
  }

  // 3. Import inventory (purchases)
  if (data.inventory && Array.isArray(data.inventory)) {
    let invCount = 0;
    for (const item of data.inventory) {
      if (!item.grade || !item.seller || !item.qty) continue;
      const exists = await Tx.findOne({
        type: 'purchase',
        date: item.date,
        party: item.seller.trim().toUpperCase(),
        'lines.grade': item.grade.trim(),
        'lines.qty': Number(item.qty),
        notes: item.notes || ''
      });
      if (!exists) {
        await Tx.create({
          type: 'purchase',
          date: item.date,
          party: item.seller.trim().toUpperCase(),
          lines: [{ grade: item.grade.trim(), qty: Number(item.qty) }],
          notes: item.notes || ''
        });
        invCount++;
      }
    }
    console.log(`✓ Inventory: ${invCount} purchases imported.`);
  }

  // 4. Import sales
  if (data.sales && Array.isArray(data.sales)) {
    let salesCount = 0;
    for (const item of data.sales) {
      if (!item.grade || !item.buyer || !item.qty) continue;
      const exists = await Tx.findOne({
        type: 'sale',
        date: item.date,
        party: item.buyer.trim().toUpperCase(),
        'lines.grade': item.grade.trim(),
        'lines.qty': Number(item.qty),
        notes: item.notes || ''
      });
      if (!exists) {
        await Tx.create({
          type: 'sale',
          date: item.date,
          party: item.buyer.trim().toUpperCase(),
          lines: [{ grade: item.grade.trim(), qty: Number(item.qty) }],
          notes: item.notes || ''
        });
        salesCount++;
      }
    }
    console.log(`✓ Sales: ${salesCount} sales imported.`);
  }

  console.log('✅ Migration completed successfully!');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
