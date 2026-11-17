const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { S3Storage, createS3FromEnv, normalizePrefix, isNotFound } = require('../../server/storage/s3Driver');
const { FakeS3, sdk, notFound } = require('../helpers/fakeS3');

const setup = (options = {}) => {
  const fake = new FakeS3();
  const storage = new S3Storage({ client: fake, commands: sdk, bucket: 'my-bucket', ...options });
  return { fake, storage };
};

describe('S3Storage', () => {
  it('puts objects under the configured prefix, with their content type', async () => {
    const { fake, storage } = setup({ prefix: 'unisontalk/' });
    await storage.put('avatars/1-a.png', Buffer.from('img'), { contentType: 'image/png' });
    const put = fake.sent[0].input;
    assert.equal(put.Bucket, 'my-bucket');
    assert.equal(put.Key, 'unisontalk/avatars/1-a.png');
    assert.equal(put.ContentType, 'image/png');
    assert.ok(!('ServerSideEncryption' in put), 'no SSE unless configured');
    await storage.put('1-b.bin', Buffer.from('x'));
    assert.equal(fake.sent[1].input.ContentType, 'application/octet-stream');
  });

  it('asks for server-side encryption when configured', async () => {
    const { fake, storage } = setup({ sse: 'aws:kms' });
    await storage.put('1-a.bin', Buffer.from('x'));
    assert.equal(fake.sent[0].input.ServerSideEncryption, 'aws:kms');
  });

  it('lists relative to the prefix and strips it from the keys it returns', async () => {
    const { storage } = setup({ prefix: 'unisontalk/' });
    await storage.put('1-a.bin', Buffer.from('x'));
    await storage.put('avatars/2-b.png', Buffer.from('y'));
    assert.deepEqual((await storage.list('')).map((e) => e.key), ['1-a.bin']);
    assert.deepEqual((await storage.list('avatars/')).map((e) => e.key), ['avatars/2-b.png']);
  });

  it('ignores a "folder" placeholder object when listing', async () => {
    const { fake, storage } = setup({ prefix: 'p/' });
    fake.objects.set('my-bucket/p/avatars/', { body: Buffer.alloc(0), lastModified: new Date() });
    await storage.put('avatars/real.png', Buffer.from('x'));
    assert.deepEqual((await storage.list('avatars/')).map((e) => e.name), ['real.png']);
  });

  it('maps "no such object" to null/false — and ONLY that: real failures must surface', async () => {
    const { fake, storage } = setup();
    for (const error of [notFound('NoSuchKey'), notFound('NotFound'), Object.assign(new Error('x'), { Code: 'NoSuchKey' }), Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } })]) {
      fake.failWith = error;
      assert.equal(await storage.read('a.bin'), null);
      assert.equal(await storage.stream('a.bin'), null);
      assert.equal(await storage.exists('a.bin'), false);
    }
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    fake.failWith = denied;
    await assert.rejects(storage.read('a.bin'), /Access Denied/);
    await assert.rejects(storage.stream('a.bin'), /Access Denied/);
    await assert.rejects(storage.exists('a.bin'), /Access Denied/);
    await assert.rejects(storage.put('a.bin', Buffer.from('x')), /Access Denied/);
    await assert.rejects(storage.list(''), /Access Denied/);
    assert.equal(isNotFound(denied), false);
  });

  it('reads bodies that only support async iteration too', async () => {
    const { storage } = setup();
    storage.client = { send: async () => ({ Body: (async function* () { yield Buffer.from('ab'); yield Buffer.from('cd'); })() }) };
    assert.equal((await storage.read('a.bin')).toString(), 'abcd');
  });

  it('ping() checks the bucket', async () => {
    const { fake, storage } = setup();
    await storage.ping();
    assert.equal(fake.sent[0].constructor.name, 'HeadBucketCommand');
    assert.equal(fake.sent[0].input.Bucket, 'my-bucket');
  });
});

describe('createS3FromEnv', () => {
  it('requires a bucket', () => {
    assert.throws(() => createS3FromEnv({}, { sdk }), /S3_BUCKET/);
  });

  it('configures an AWS client from the environment: region default, default credential chain', () => {
    const storage = createS3FromEnv({ S3_BUCKET: 'b' }, { sdk });
    assert.equal(storage.bucket, 'b');
    assert.equal(storage.client.config.region, 'us-east-1');
    assert.ok(!('endpoint' in storage.client.config) && !('credentials' in storage.client.config) && !('forcePathStyle' in storage.client.config));
    assert.equal(storage.prefix, '');
  });

  it('supports S3-compatible stores: endpoint, path-style, explicit credentials, prefix, SSE', () => {
    const storage = createS3FromEnv({
      S3_BUCKET: 'b', S3_REGION: 'eu-west-1', S3_ENDPOINT: 'http://minio:9000', S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 'sek', S3_PREFIX: '/team/uploads', S3_SSE: 'AES256',
    }, { sdk });
    const config = storage.client.config;
    assert.deepEqual([config.region, config.endpoint, config.forcePathStyle], ['eu-west-1', 'http://minio:9000', true]);
    assert.deepEqual(config.credentials, { accessKeyId: 'AKIA', secretAccessKey: 'sek' });
    assert.equal(storage.prefix, 'team/uploads/');
    assert.equal(storage.sse, 'AES256');
  });

  it('uses explicit credentials only when BOTH halves are present', () => {
    assert.ok(!('credentials' in createS3FromEnv({ S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'AKIA' }, { sdk }).client.config));
  });

  it('normalises prefixes', () => {
    assert.deepEqual(['', 'a', '/a', 'a/', '/a/b/', 'a/b'].map(normalizePrefix), ['', 'a/', 'a/', 'a/', 'a/b/', 'a/b/']);
  });
});
