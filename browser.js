// Tiny browser-side helper for uploading a File to S3 using a ticket from the server.
// No dependencies. Works in any modern browser.
//
// Usage:
//   import { uploadToS3 } from './s3-upload-kit-client.js';
//
//   // 1. Ask your server for a ticket
//   const ticket = await fetch('/api/uploads/ticket').then(r => r.json());
//
//   // 2. Upload directly to S3
//   const { uploadKey } = await uploadToS3(file, ticket, {
//     onProgress: (pct) => console.log(pct + '%'),
//   });
//
//   // 3. Tell your server the upload is done
//   const result = await fetch('/api/uploads/commit', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ uploadKey, ticket: ticket.ticket, originalName: file.name }),
//   }).then(r => r.json());

export async function uploadToS3(file, ticket, options = {}) {
  if (!file) throw new Error('uploadToS3: file required');
  if (!ticket || !ticket.url || !ticket.fields) {
    throw new Error('uploadToS3: invalid ticket');
  }

  // The ticket's Key field contains a literal ${filename} placeholder that S3
  // substitutes with whatever we pass as the "key" form field. We pass the
  // actual filename so the stored key includes it.
  const safeName = sanitizeFilename(file.name);
  const key = ticket.keyPrefix + '/' + safeName;

  const formData = new FormData();
  // All the fields S3 requires (policy, signature, etc.)
  for (const [k, v] of Object.entries(ticket.fields)) {
    // Skip the placeholder key — we'll set our own
    if (k === 'key') continue;
    formData.append(k, v);
  }
  formData.append('key', key);
  // Content-Type must be appended BEFORE the file field, and must match what
  // the server's presigned policy allows. The server always includes a
  // Content-Type condition in the policy for this reason.
  formData.append('Content-Type', file.type || 'application/octet-stream');
  formData.append('file', file); // must be last

  await xhrUpload(ticket.url, formData, options);

  return {
    uploadKey: key,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    originalName: file.name,
  };
}

function sanitizeFilename(name) {
  // Keep it simple: strip path separators and control chars, collapse spaces.
  return (name || 'file')
    .replace(/[\/\\]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 200);
}

function xhrUpload(url, formData, options) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);

    if (options.onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          options.onProgress(Math.round((e.loaded / e.total) * 100), e);
        }
      });
    }

    xhr.onload = () => {
      // S3 returns 204 on successful POST uploads (or 201 if success_action_status set)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ status: xhr.status, response: xhr.responseText });
      } else {
        reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText} — ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error('S3 upload network error'));
    xhr.onabort = () => reject(new Error('S3 upload aborted'));

    if (options.signal) {
      options.signal.addEventListener('abort', () => xhr.abort());
    }

    xhr.send(formData);
  });
}
