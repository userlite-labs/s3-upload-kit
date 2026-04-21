const crypto = require('crypto');
const { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');

const DEFAULTS = {
  uploadPrefix: 'uploads',
  filesPrefix: 'files',
  expiresIn: 60 * 10, // 10 minutes for the presigned POST
  maxBytes: 50 * 1024 * 1024, // 50MB
  allowedContentTypes: null, // null = any; or array like ['image/*', 'application/pdf']
};

function randomId(len = 8) {
  return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString('base64url').slice(0, len);
}

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function extFromName(name) {
  if (!name || typeof name !== 'string') return '';
  const parts = name.split('.');
  if (parts.length < 2) return '';
  return parts.pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

class UploadKit {
  constructor(config = {}) {
    if (!config.bucket) throw new Error('UploadKit: bucket is required');
    if (!config.region) throw new Error('UploadKit: region is required');

    this.bucket = config.bucket;
    this.region = config.region;
    this.uploadPrefix = (config.uploadPrefix || DEFAULTS.uploadPrefix).replace(/^\/|\/$/g, '');
    this.filesPrefix = (config.filesPrefix || DEFAULTS.filesPrefix).replace(/^\/|\/$/g, '');
    this.expiresIn = config.expiresIn || DEFAULTS.expiresIn;
    this.maxBytes = config.maxBytes || DEFAULTS.maxBytes;
    this.allowedContentTypes = config.allowedContentTypes || DEFAULTS.allowedContentTypes;

    // Optional: a secret used to sign the upload key so clients can't submit
    // arbitrary keys back to your server on commit. Highly recommended.
    this.signingSecret = config.signingSecret || null;

    // Credentials — if omitted, AWS SDK uses the default provider chain
    // (env vars, IAM role, shared config, etc.)
    const clientConfig = { region: this.region };
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }
    this.s3 = new S3Client(clientConfig);
  }

  // Build the presigned POST that the browser uses to upload directly to S3.
  // Returns everything the client needs to do the upload.
  async createUploadTicket(options = {}) {
    const folder = randomId(5);
    const subfolder = randomId(5);
    const keyPrefix = `${this.uploadPrefix}/${folder}/${subfolder}`;

    const conditions = [
      ['starts-with', '$key', `${keyPrefix}/`],
      ['content-length-range', 0, options.maxBytes || this.maxBytes],
    ];

    // Content-Type constraint
    const allowedTypes = options.allowedContentTypes || this.allowedContentTypes;
    if (allowedTypes && allowedTypes.length > 0) {
      // If a single type is supplied, we can lock it exactly.
      // For multiple types, we use starts-with on a common prefix if possible,
      // otherwise we don't constrain (S3 POST doesn't support OR conditions).
      if (allowedTypes.length === 1 && !allowedTypes[0].includes('*')) {
        conditions.push({ 'Content-Type': allowedTypes[0] });
      } else {
        // Find a common starts-with prefix (e.g. ['image/*'] -> 'image/')
        const prefixes = allowedTypes
          .filter(t => t.endsWith('/*'))
          .map(t => t.slice(0, -1));
        if (prefixes.length === 1 && allowedTypes.length === 1) {
          conditions.push(['starts-with', '$Content-Type', prefixes[0]]);
        }
        // Otherwise: accept anything at S3 level, validate on commit.
      }
    }

    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: `${keyPrefix}/\${filename}`,
      Conditions: conditions,
      Expires: this.expiresIn,
    });

    return {
      // What the client POSTs to
      url: presigned.url,
      // Fields the client must include in the multipart POST
      fields: presigned.fields,
      // The key prefix — client appends the filename to form the full key
      keyPrefix,
      // Convenience: signed ticket to return on commit, prevents key tampering
      ticket: this.signingSecret ? this._signTicket(keyPrefix) : null,
      expiresIn: this.expiresIn,
      maxBytes: options.maxBytes || this.maxBytes,
    };
  }

  // Commit a completed upload: validate it exists, optionally enforce type,
  // and move it from uploads/ to files/ with a stable, hashed filename.
  async commitUpload(input) {
    const {
      uploadKey, // full key the client uploaded to, e.g. uploads/abc/def/photo.jpg
      ticket, // the signed ticket returned from createUploadTicket (if signingSecret set)
      originalName, // original filename from the user (for record-keeping)
      allowedContentTypes, // optional per-commit override
      deleteOriginal = true,
    } = input;

    if (!uploadKey || typeof uploadKey !== 'string') {
      throw new Error('commitUpload: uploadKey required');
    }
    if (!uploadKey.startsWith(`${this.uploadPrefix}/`)) {
      throw new Error('commitUpload: uploadKey must be in the upload prefix');
    }

    // Verify the ticket matches the key if signing is enabled
    if (this.signingSecret) {
      if (!ticket) throw new Error('commitUpload: ticket required (signing enabled)');
      const keyPrefix = uploadKey.split('/').slice(0, -1).join('/');
      if (!this._verifyTicket(ticket, keyPrefix)) {
        throw new Error('commitUpload: ticket does not match uploadKey');
      }
    }

    // Verify the object exists and get its metadata
    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: uploadKey,
      }));
    } catch (err) {
      const e = new Error('commitUpload: object not found in S3');
      e.cause = err;
      throw e;
    }

    // Enforce size
    if (head.ContentLength > this.maxBytes) {
      await this._safeDelete(uploadKey);
      throw new Error(`commitUpload: file exceeds max size (${head.ContentLength} > ${this.maxBytes})`);
    }

    // Enforce content type if configured
    const typeRules = allowedContentTypes || this.allowedContentTypes;
    if (typeRules && typeRules.length > 0) {
      const ct = head.ContentType || 'application/octet-stream';
      if (!this._contentTypeAllowed(ct, typeRules)) {
        await this._safeDelete(uploadKey);
        throw new Error(`commitUpload: content type ${ct} not allowed`);
      }
    }

    // Compute the final key: hash the original filename to avoid collisions
    // and to scrub unsafe characters. Keep the extension for usability.
    const useName = originalName || uploadKey.split('/').pop() || 'file';
    const ext = extFromName(useName);
    const hashedName = md5(`${useName}:${randomId(12)}`) + (ext ? `.${ext}` : '');
    const folder = randomId(5);
    const subfolder = randomId(5);
    const finalKey = `${this.filesPrefix}/${folder}/${subfolder}/${hashedName}`;

    // Copy the object
    await this.s3.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${encodeURIComponent(uploadKey).replace(/%2F/g, '/')}`,
      Key: finalKey,
      MetadataDirective: 'COPY',
    }));

    // Delete the original (best-effort; set deleteOriginal=false if you want
    // the lifecycle rule to handle cleanup instead)
    if (deleteOriginal) {
      await this._safeDelete(uploadKey);
    }

    return {
      key: finalKey,
      bucket: this.bucket,
      size: head.ContentLength,
      contentType: head.ContentType || 'application/octet-stream',
      originalName: useName,
      uploadedAt: new Date().toISOString(),
    };
  }

  // --- Internal helpers ---

  _signTicket(keyPrefix) {
    if (!this.signingSecret) return null;
    const h = crypto.createHmac('sha256', this.signingSecret);
    h.update(keyPrefix);
    return h.digest('base64url');
  }

  _verifyTicket(ticket, keyPrefix) {
    if (!this.signingSecret) return true;
    const expected = this._signTicket(keyPrefix);
    if (!expected || !ticket) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(ticket);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  _contentTypeAllowed(ct, rules) {
    for (const rule of rules) {
      if (rule === ct) return true;
      if (rule.endsWith('/*')) {
        const prefix = rule.slice(0, -1);
        if (ct.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  async _safeDelete(key) {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // Non-fatal; lifecycle rule will clean up abandoned uploads
    }
  }
}

module.exports = { UploadKit };
