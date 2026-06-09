const X_TWEETS_URL = 'https://api.x.com/2/tweets';
const X_MEDIA_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';
const CHUNK_SIZE = 5 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function xApiError(body, status, fallback) {
  const message =
    body?.detail ||
    body?.title ||
    body?.errors?.[0]?.message ||
    body?.error_description ||
    body?.error ||
    fallback;
  const err = new Error(String(message));
  err.status = status;
  err.code = 'X_API_ERROR';
  err.xBody = body;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionFromFilename(filename) {
  if (!filename) return '';
  const dot = String(filename).lastIndexOf('.');
  return dot >= 0 ? String(filename).slice(dot + 1).toLowerCase() : '';
}

function resolveMediaMeta(mediaType = 'image', filename = '') {
  const ext = extensionFromFilename(filename);
  const normalized = String(mediaType || 'image').toLowerCase();

  if (normalized === 'video' || ['mp4', 'mov', 'm4v', 'webm'].includes(ext)) {
    const mime =
      ext === 'mov' || ext === 'qt' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
    return { mime, category: 'tweet_video', chunked: true };
  }

  if (normalized === 'gif' || ext === 'gif') {
    return { mime: 'image/gif', category: 'tweet_gif', chunked: false };
  }

  if (ext === 'png') return { mime: 'image/png', category: 'tweet_image', chunked: false };
  if (ext === 'webp') return { mime: 'image/webp', category: 'tweet_image', chunked: false };
  if (ext === 'jpg' || ext === 'jpeg') return { mime: 'image/jpeg', category: 'tweet_image', chunked: false };

  return { mime: 'image/jpeg', category: 'tweet_image', chunked: false };
}

async function mediaUploadRequest(accessToken, { method = 'POST', query, form, body }) {
  const url = new URL(X_MEDIA_UPLOAD_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  let payload = body;

  if (form) {
    payload = form;
  } else if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetch(url, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw xApiError(json, res.status, 'X media upload failed');
  }
  return json;
}

async function uploadMediaSimple(accessToken, buffer, meta) {
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: meta.mime }), 'media');
  if (meta.category) {
    form.append('media_category', meta.category);
  }

  const body = await mediaUploadRequest(accessToken, { form });
  const mediaId = body.media_id_string || body.media_id;
  if (!mediaId) {
    throw xApiError(body, 502, 'X media upload returned no media id');
  }
  return { mediaId: String(mediaId), uploadDetails: { method: 'simple', bytes: buffer.length } };
}

async function waitForMediaProcessing(accessToken, mediaId) {
  const maxAttempts = 60;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const body = await mediaUploadRequest(accessToken, {
      method: 'GET',
      query: { command: 'STATUS', media_id: mediaId },
    });

    const info = body.processing_info;
    if (!info) {
      return body;
    }

    if (info.state === 'succeeded') {
      return body;
    }

    if (info.state === 'failed') {
      throw xApiError(
        { errors: [{ message: info.error?.message || 'Video processing failed on X' }] },
        502,
        'X video processing failed',
      );
    }

    const waitMs = Math.max(1, Number(info.check_after_secs || 2)) * 1000;
    await sleep(waitMs);
  }

  throw xApiError({}, 504, 'Timed out waiting for X video processing');
}

async function uploadMediaChunked(accessToken, buffer, meta) {
  const initBody = await mediaUploadRequest(accessToken, {
    body: new URLSearchParams({
      command: 'INIT',
      total_bytes: String(buffer.length),
      media_type: meta.mime,
      media_category: meta.category,
    }).toString(),
  });

  const mediaId = initBody.media_id_string || initBody.media_id;
  if (!mediaId) {
    throw xApiError(initBody, 502, 'X media INIT returned no media id');
  }

  let segmentIndex = 0;
  for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
    const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
    const form = new FormData();
    form.append('command', 'APPEND');
    form.append('media_id', String(mediaId));
    form.append('segment_index', String(segmentIndex));
    form.append('media', new Blob([chunk], { type: meta.mime }), `segment-${segmentIndex}`);

    await mediaUploadRequest(accessToken, { form });
    segmentIndex += 1;
  }

  await mediaUploadRequest(accessToken, {
    body: new URLSearchParams({
      command: 'FINALIZE',
      media_id: String(mediaId),
    }).toString(),
  });

  const status = await waitForMediaProcessing(accessToken, mediaId);

  return {
    mediaId: String(mediaId),
    uploadDetails: {
      method: 'chunked',
      bytes: buffer.length,
      segments: segmentIndex,
      processingState: status.processing_info?.state || 'succeeded',
    },
  };
}

export async function uploadMedia(accessToken, buffer, { mediaType = 'image', filename = '' } = {}) {
  if (!buffer?.length) {
    throw xApiError({}, 400, 'Media buffer is empty');
  }

  const meta = resolveMediaMeta(mediaType, filename);
  const useChunked = meta.chunked || buffer.length > SIMPLE_UPLOAD_MAX_BYTES;

  if (useChunked) {
    return uploadMediaChunked(accessToken, buffer, meta);
  }

  try {
    return await uploadMediaSimple(accessToken, buffer, meta);
  } catch (error) {
    if (error.status === 413 || /too large|chunk/i.test(String(error.message))) {
      return uploadMediaChunked(accessToken, buffer, meta);
    }
    throw error;
  }
}

export async function createTweet(accessToken, { text, replyToTweetId, mediaIds = [] } = {}) {
  const payload = {};
  if (text != null && String(text).trim() !== '') {
    payload.text = String(text);
  }
  if (replyToTweetId) {
    payload.reply = { in_reply_to_tweet_id: String(replyToTweetId) };
  }
  if (mediaIds.length > 0) {
    payload.media = { media_ids: mediaIds.map(String) };
  }

  if (!payload.text && !payload.media) {
    const err = new Error('Post text or media is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  const res = await fetch(X_TWEETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw xApiError(body, res.status, 'X tweet creation failed');
  }
  return body;
}

export function buildTweetUrl(username, tweetId) {
  if (!username || !tweetId) return null;
  const handle = String(username).replace(/^@/, '');
  return `https://x.com/${handle}/status/${tweetId}`;
}
