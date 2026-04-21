# s3-upload-kit

Direct-to-S3 uploads for any Node server. Two functions on the server (`createUploadTicket`, `commitUpload`), one helper in the browser (`uploadToS3`). No framework coupling.

## Design

- **Single bucket, two prefixes.** `uploads/` receives presigned POSTs from browsers. `files/` is where committed files live with stable, hashed keys. Put a lifecycle rule on `uploads/` to auto-delete abandoned files after 24h.
- **Signed tickets.** When a `signingSecret` is configured, the ticket returned from `createUploadTicket` includes an HMAC over the key prefix. On commit, the server verifies the ticket matches the key — so a malicious client can't commit arbitrary S3 keys it didn't upload.
- **Type & size enforcement.** S3 enforces size at upload time via presigned POST conditions. Content type is verified on commit via `HeadObject`.

## Config

```js
const { UploadKit } = require('s3-upload-kit');

const uploads = new UploadKit({
  bucket: process.env.UPLOAD_BUCKET,
  region: process.env.AWS_REGION,

  // Optional — falls back to the default AWS credential chain if omitted
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,

  // Optional — strongly recommended. Prevents clients from committing keys
  // they didn't actually upload.
  signingSecret: process.env.UPLOAD_SIGNING_SECRET,

  // Optional — defaults shown
  uploadPrefix: 'uploads',
  filesPrefix: 'files',
  expiresIn: 600,                    // presigned POST validity (seconds)
  maxBytes: 50 * 1024 * 1024,        // 50MB
  allowedContentTypes: null,         // e.g. ['image/*', 'application/pdf']
});
```

## Server API

### `uploads.createUploadTicket(options?)`

Returns everything the browser needs:

```js
{
  url: 'https://my-bucket.s3.amazonaws.com/',
  fields: { /* policy, signature, etc. */ },
  keyPrefix: 'uploads/ab12c/d3f4g',
  ticket: 'hmac-signature...',      // present when signingSecret is set
  expiresIn: 600,
  maxBytes: 52428800
}
```

Per-call overrides: `{ maxBytes, allowedContentTypes }`.

### `uploads.commitUpload({ uploadKey, ticket, originalName })`

Verifies the upload exists, checks size and type, and moves it to the `files/` prefix with a stable hashed name. Returns:

```js
{
  key: 'files/xy9zA/bC3dE/ab12cd34ef56...jpg',
  bucket: 'my-bucket',
  size: 120483,
  contentType: 'image/jpeg',
  originalName: 'photo.jpg',
  uploadedAt: '2026-04-21T15:32:11.000Z'
}
```

Store `key` in your database. That's the canonical reference to the file.

## Wiring Examples

### Express

```js
const express = require('express');
const { UploadKit } = require('s3-upload-kit');

const app = express();
app.use(express.json());

const uploads = new UploadKit({ /* ...config... */ });

app.get('/api/uploads/ticket', async (req, res) => {
  // Add your own auth check here
  const ticket = await uploads.createUploadTicket();
  res.json(ticket);
});

app.post('/api/uploads/commit', async (req, res) => {
  try {
    const result = await uploads.commitUpload(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

### Fastify

```js
fastify.get('/api/uploads/ticket', async () => uploads.createUploadTicket());
fastify.post('/api/uploads/commit', async (req) => uploads.commitUpload(req.body));
```

### Next.js App Router

```js
// app/api/uploads/ticket/route.js
import { NextResponse } from 'next/server';
import { uploads } from '@/lib/uploads';
export async function GET() {
  return NextResponse.json(await uploads.createUploadTicket());
}

// app/api/uploads/commit/route.js
import { NextResponse } from 'next/server';
import { uploads } from '@/lib/uploads';
export async function POST(req) {
  return NextResponse.json(await uploads.commitUpload(await req.json()));
}
```

### Hono

```js
app.get('/api/uploads/ticket', async (c) => c.json(await uploads.createUploadTicket()));
app.post('/api/uploads/commit', async (c) => c.json(await uploads.commitUpload(await c.req.json())));
```

## Client

```js
import { uploadToS3 } from 's3-upload-kit/client';

async function handleFile(file) {
  const ticket = await fetch('/api/uploads/ticket').then(r => r.json());

  const { uploadKey } = await uploadToS3(file, ticket, {
    onProgress: (pct) => console.log(`${pct}%`),
  });

  const result = await fetch('/api/uploads/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadKey,
      ticket: ticket.ticket,
      originalName: file.name,
    }),
  }).then(r => r.json());

  console.log('Stored at', result.key);
}
```

## Required S3 Setup

**Bucket CORS** (required for browser uploads):

```json
[
  {
    "AllowedOrigins": ["https://yourapp.com"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3000
  }
]
```

**Lifecycle rule** (optional but recommended — cleans up abandoned uploads):

```json
{
  "Rules": [
    {
      "ID": "expire-abandoned-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "uploads/" },
      "Expiration": { "Days": 1 }
    }
  ]
}
```

**IAM policy** for the server's credentials:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:CopyObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    }
  ]
}
```

Block Public Access can (and should) stay on. Presigned URLs don't require public access.

## Serving files back

This kit stores files; it doesn't serve them. Two common patterns:

1. **Presigned GETs** — generate short-lived download URLs on demand using `@aws-sdk/s3-request-presigner`. Use when files are user-scoped.
2. **CloudFront + OAC** — put CloudFront in front of the bucket with Origin Access Control, serve with signed cookies/URLs or make specific prefixes public.

## License

MIT. See [LICENSE](LICENSE).
