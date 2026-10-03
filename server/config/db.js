const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and configure it.');
  }

  mongoose.connection.on('connected', () => {
    console.log('[mongo] connected to', mongoose.connection.name);
  });

  mongoose.connection.on('error', (err) => {
    console.error('[mongo] connection error:', err.message);
  });

  await mongoose.connect(uri);
  await migratePhasetimeIndex();
}

// Earlier versions indexed phasetimeId as `unique + sparse` while also
// storing null for everyone without a link. Sparse doesn't skip nulls, so
// the second such account failed with E11000 (issue #14). Mongoose won't
// replace an existing index that has the same name but different options,
// so on databases created by those versions we drop the legacy index here
// and make sure the replacement (a partial index — see models/User.js)
// exists before the server starts taking registrations. Existing documents
// that have phasetimeId: null are fine: the partial index ignores them.
async function migratePhasetimeIndex() {
  const User = require('../models/User');

  let indexes = [];
  try {
    indexes = await User.collection.indexes();
  } catch {
    // Collection doesn't exist yet (fresh database) — nothing to migrate.
  }

  if (indexes.some((i) => i.name === 'phasetimeId_1')) {
    await User.collection.dropIndex('phasetimeId_1');
    console.log('[mongo] dropped legacy phasetimeId_1 index');
  }

  try {
    await User.createIndexes();
  } catch (err) {
    console.error('[mongo] could not build user indexes:', err.message);
  }
}

module.exports = connectDB;
