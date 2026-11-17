#!/usr/bin/env node
// Maintenance for uploaded files. Uses the same env as the server (.env), so
// it acts on whatever STORAGE_DRIVER points at.
//
//   node scripts/storage.js encrypt
//       Encrypt chat attachments uploaded before encryption existed
//       (safe to re-run; already-encrypted files are left alone).
//
//   node scripts/storage.js copy --from ./server/uploads
//       Copy an existing local upload folder INTO the configured storage,
//       e.g. when moving to S3. Raw bytes are copied as-is; run `encrypt`
//       afterwards to encrypt any legacy plaintext in the destination.
require('dotenv').config();
const path = require('node:path');
const { createStorage } = require('../server/storage');
const { LocalStorage } = require('../server/storage/localDriver');
const { copyObjects } = require('../server/storage/migrate');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const storage = createStorage();
  await storage.init();

  if (command === 'encrypt') {
    const result = await storage.encryptExisting({ onProgress: (key) => console.log(`encrypted ${key}`) });
    console.log(`Done: ${result.encrypted} encrypted, ${result.alreadyEncrypted} already encrypted.`);
  } else if (command === 'copy') {
    const from = args[args.indexOf('--from') + 1];
    if (!from || from.startsWith('--')) throw new Error('usage: node scripts/storage.js copy --from <local uploads folder>');
    const result = await copyObjects({
      source: new LocalStorage({ root: path.resolve(from) }),
      destination: storage.inner,
      onProgress: (key) => console.log(`copied ${key}`),
    });
    console.log(`Done: ${result.copied} copied, ${result.skipped} already present.`);
  } else {
    throw new Error('usage: node scripts/storage.js <encrypt | copy --from DIR>');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
