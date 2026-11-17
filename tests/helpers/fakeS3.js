// A stand-in for the AWS SDK's S3 client, faithful to the behaviours the
// driver depends on (404 errors, ListObjectsV2 paging and delimiters, a Body
// that is both a stream and has transformToByteArray) — so the S3 driver is
// tested without the SDK, a network, or an S3 account.
const { Readable } = require('node:stream');

class Command { constructor(input) { this.input = input; } }
class PutObjectCommand extends Command {}
class GetObjectCommand extends Command {}
class HeadObjectCommand extends Command {}
class DeleteObjectCommand extends Command {}
class ListObjectsV2Command extends Command {}
class HeadBucketCommand extends Command {}
class S3Client { constructor(config) { this.config = config; } async send() {} }

const notFound = (name = 'NoSuchKey') => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

class FakeS3 {
  constructor({ pageSize = 1000 } = {}) {
    this.objects = new Map(); // "bucket/key" -> { body, contentType, lastModified, sse }
    this.pageSize = pageSize;
    this.sent = [];
    this.failWith = null;
  }

  touch(bucket, key, date) {
    this.objects.get(`${bucket}/${key}`).lastModified = date;
  }

  async send(command) {
    this.sent.push(command);
    if (this.failWith) throw this.failWith;
    const { Bucket, Key } = command.input;
    const id = `${Bucket}/${Key}`;

    if (command instanceof PutObjectCommand) {
      this.objects.set(id, { body: Buffer.from(command.input.Body), contentType: command.input.ContentType, lastModified: new Date(), sse: command.input.ServerSideEncryption });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(id);
      if (!object) throw notFound('NoSuchKey');
      return { Body: Object.assign(Readable.from([object.body]), { transformToByteArray: async () => new Uint8Array(object.body) }), ContentLength: object.body.length };
    }
    if (command instanceof HeadObjectCommand) {
      if (!this.objects.has(id)) throw notFound('NotFound');
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(id);
      return {};
    }
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix || '';
      const all = [...this.objects.entries()]
        .filter(([key]) => key.startsWith(`${Bucket}/`))
        .map(([key, object]) => ({ Key: key.slice(Bucket.length + 1), LastModified: object.lastModified }))
        .filter((o) => o.Key.startsWith(prefix) && !o.Key.slice(prefix.length).includes('/')) // the delimiter hides deeper keys
        .sort((a, b) => a.Key.localeCompare(b.Key));
      const start = Number(command.input.ContinuationToken || 0);
      const next = start + this.pageSize;
      return { Contents: all.slice(start, next), IsTruncated: next < all.length, NextContinuationToken: next < all.length ? String(next) : undefined };
    }
    throw new Error(`FakeS3 does not implement ${command.constructor.name}`);
  }
}

const sdk = { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand };
module.exports = { FakeS3, sdk, notFound };
