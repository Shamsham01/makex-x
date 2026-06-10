const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

function pickField(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] != null && body[key] !== '') return body[key];
  }
  return null;
}

function filenameFromUrl(url, fallback = 'upload.mp4') {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name.includes('.') ? name : fallback;
  } catch {
    return fallback;
  }
}

function isMp4Buffer(buffer) {
  return buffer?.length >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

function looksLikeJsonText(buffer) {
  if (!buffer?.length) return false;
  const first = buffer[0];
  return first === 0x7b || first === 0x5b; // { or [
}

function bufferFromUnknownJson(value) {
  if (value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return { url: trimmed };
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 128) {
      return { buffer: Buffer.from(trimmed.replace(/\s+/g, ''), 'base64') };
    }
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'number') {
      return { buffer: Buffer.from(value) };
    }
    if (value.length && typeof value[0] === 'string') {
      return bufferFromUnknownJson(value[0]);
    }
    return null;
  }

  if (typeof value === 'object') {
    const url = value.url || value.mediaUrl || value.media_url || value.fileUrl || value.file_url;
    if (typeof url === 'string' && url.startsWith('http')) {
      return { url, filename: value.fileName || value.filename || value.name };
    }

    const data = value.data || value.file || value.content || value.buffer;
    const nested = bufferFromUnknownJson(data);
    if (nested) {
      return {
        ...nested,
        filename: value.fileName || value.filename || value.name || nested.filename,
      };
    }
  }

  return null;
}

export async function fetchMediaFromUrl(url, filename) {
  const res = await fetch(url, { redirect: 'follow' });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    const err = new Error(`Failed to download media URL (${res.status})`);
    err.status = 400;
    err.code = 'MEDIA_DOWNLOAD_FAILED';
    err.xBody = { url, status: res.status, preview: preview.slice(0, 200) };
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());

  if (contentType.includes('application/json') || (buffer.length && buffer[0] === 0x7b)) {
    const err = new Error('Media URL returned JSON, not a file. Use the direct public storage object URL.');
    err.status = 400;
    err.code = 'MEDIA_DOWNLOAD_FAILED';
    err.xBody = { url, contentType, preview: buffer.subarray(0, 200).toString('utf8') };
    throw err;
  }
  if (!buffer.length) {
    const err = new Error('Media URL download returned an empty file');
    err.status = 400;
    err.code = 'MEDIA_DOWNLOAD_FAILED';
    throw err;
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    const err = new Error(`Media file exceeds ${MAX_MEDIA_BYTES} byte limit`);
    err.status = 413;
    err.code = 'MEDIA_TOO_LARGE';
    throw err;
  }

  return {
    buffer,
    filename: filename || filenameFromUrl(url),
    source: 'url',
    url,
  };
}

export async function resolveMediaForUpload({ buffer, body, mediaType, filename }) {
  const explicitUrl = pickField(body, 'mediaUrl', 'media_url', 'url');
  const fallbackName =
    filename || (String(mediaType).toLowerCase() === 'video' ? 'upload.mp4' : 'upload.jpg');

  if (buffer?.length && isMp4Buffer(buffer)) {
    return { buffer, filename: fallbackName, source: 'multipart' };
  }

  if (buffer?.length && !looksLikeJsonText(buffer)) {
    return { buffer, filename: fallbackName, source: 'multipart' };
  }

  if (buffer?.length && looksLikeJsonText(buffer)) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      const extracted = bufferFromUnknownJson(parsed);
      if (extracted?.url) {
        return fetchMediaFromUrl(extracted.url, extracted.filename || fallbackName);
      }
      if (extracted?.buffer?.length) {
        return {
          buffer: extracted.buffer,
          filename: extracted.filename || fallbackName,
          source: 'json_base64',
        };
      }
    } catch {
      // Fall through to URL/body handling.
    }
  }

  if (explicitUrl) {
    return fetchMediaFromUrl(explicitUrl, fallbackName);
  }

  if (buffer?.length) {
    return { buffer, filename: fallbackName, source: 'multipart' };
  }

  const err = new Error(
    'No media file received. Map HTTP file data to Media Data, or set Media URL to your Supabase public object URL.',
  );
  err.status = 400;
  err.code = 'INVALID_REQUEST';
  throw err;
}
