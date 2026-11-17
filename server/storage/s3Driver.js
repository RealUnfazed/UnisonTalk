const { assertSafeKey, assertSafePrefix, nameOf } = require('./keys');

const isNotFound = (err) =>
  err && (err.name === 'NoSuchKey' || err.name === 'NotFound' || err.Code === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404));

async function bodyToBuffer(body) {
  if (body && typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Any S3-compatible object store: AWS S3, MinIO, Cloudflare R2, Backblaze B2,
// DigitalOcean Spaces... `client` is an S3Client; `commands` is the SDK
// module (both injected, so tests need no AWS SDK and no network).
class S3Storage {
  constructor({ client, commands, bucket, prefix = '', sse }) {
    this.client = client;
    this.c = commands;
    this.bucket = bucket;
    this.prefix = prefix;
    this.sse = sse; // 'AES256' | 'aws:kms' — optional, on top of our own encryption of attachments
  }

  objectKey(key) {
    return this.prefix + assertSafeKey(key);
  }

  async init() {}

  async ping() {
    await this.client.send(new this.c.HeadBucketCommand({ Bucket: this.bucket }));
  }

  async put(key, buffer, { contentType = 'application/octet-stream' } = {}) {
    await this.client.send(
      new this.c.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: buffer,
        ContentType: contentType,
        ...(this.sse && { ServerSideEncryption: this.sse }),
      })
    );
  }

  async #get(key) {
    try {
      return await this.client.send(new this.c.GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err; // access denied, network errors... must NOT look like "no such file"
    }
  }

  async read(key) {
    const response = await this.#get(key);
    return response ? bodyToBuffer(response.Body) : null;
  }

  async stream(key) {
    const response = await this.#get(key);
    return response ? { stream: response.Body, size: response.ContentLength } : null;
  }

  async exists(key) {
    try {
      await this.client.send(new this.c.HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(key) {
    await this.client.send(new this.c.DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) })); // idempotent in S3
  }

  // Direct children of `prefix` ("folders" via the delimiter), all pages.
  async list(prefix = '') {
    assertSafePrefix(prefix);
    const entries = [];
    let token;
    do {
      const page = await this.client.send(
        new this.c.ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix + prefix, Delimiter: '/', ContinuationToken: token })
      );
      for (const object of page.Contents || []) {
        const key = object.Key.slice(this.prefix.length);
        if (key === prefix) continue; // a "folder" placeholder object, not an upload
        entries.push({ key, name: nameOf(key), lastModified: object.LastModified });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return entries;
  }
}

const normalizePrefix = (p) => (p ? `${String(p).replace(/^\/+/, '').replace(/\/+$/, '')}/` : '');

function createS3FromEnv(env = process.env, deps = {}) {
  if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  const sdk = deps.sdk || require('@aws-sdk/client-s3'); // optional dependency: only loaded when S3 is used
  const client = new sdk.S3Client({
    region: env.S3_REGION || 'us-east-1',
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    ...(env.S3_FORCE_PATH_STYLE === 'true' && { forcePathStyle: true }), // MinIO and friends
    // Without explicit keys the SDK's default chain applies (IAM role, shared config...).
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && {
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    }),
  });
  return new S3Storage({ client, commands: sdk, bucket: env.S3_BUCKET, prefix: normalizePrefix(env.S3_PREFIX), sse: env.S3_SSE || undefined });
}

module.exports = { S3Storage, createS3FromEnv, isNotFound, normalizePrefix };
