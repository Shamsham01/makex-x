const X_TWEETS_URL = 'https://api.x.com/2/tweets';
const X_MEDIA_API = 'https://api.x.com/2/media/upload';
const CHUNK_SIZE = 4 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function xApiError(body, status, fallback, uploadStage = null) {
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
  if (uploadStage) err.uploadStage = uploadStage;
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

async function xMediaRequest(accessToken, url, { method = 'POST', query, json, form } = {}, uploadStage) {
  const target = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      target.searchParams.set(key, String(value));
    }
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  let body;

  if (json != null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }

  const res = await fetch(target, { method, headers, body });
  const raw = await res.text();
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
  }

  if (!res.ok || parsed.errors?.length) {
    throw xApiError(
      parsed,
      res.status,
      parsed.errors?.[0]?.message || parsed.raw || `X media upload failed (${uploadStage || method})`,
      uploadStage,
    );
  }

  return parsed;
}

async function waitForMediaProcessing(accessToken, mediaId) {
  const maxAttempts = 90;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const body = await xMediaRequest(
      accessToken,
      X_MEDIA_API,
      { method: 'GET', query: { command: 'STATUS', media_id: mediaId } },
      'STATUS',
    );

    const info = body.data?.processing_info || body.processing_info;
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
        'STATUS',
      );
    }

    const waitMs = Math.max(1, Number(info.check_after_secs || 2)) * 1000;
    await sleep(waitMs);
  }

  throw xApiError({}, 504, 'Timed out waiting for X video processing', 'STATUS');
}

async function uploadMediaChunkedV2(accessToken, buffer, meta) {
  const initBody = await xMediaRequest(
    accessToken,
    `${X_MEDIA_API}/initialize`,
    {
      method: 'POST',
      json: {
        media_type: meta.mime,
        total_bytes: buffer.length,
        media_category: meta.category,
      },
    },
    'INIT',
  );

  const mediaId = initBody.data?.id || initBody.media_id_string || initBody.media_id;
  if (!mediaId) {
    throw xApiError(initBody, 502, 'X media INIT returned no media id', 'INIT');
  }

  let segmentIndex = 0;
  for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
    const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
    const form = new FormData();
    form.append('segment_index', String(segmentIndex));
    form.append('media', new Blob([chunk], { type: 'application/octet-stream' }), `chunk-${segmentIndex}`);

    await xMediaRequest(
      accessToken,
      `${X_MEDIA_API}/${mediaId}/append`,
      { method: 'POST', form },
      `APPEND_${segmentIndex}`,
    );
    segmentIndex += 1;
  }

  const finalizeBody = await xMediaRequest(
    accessToken,
    `${X_MEDIA_API}/${mediaId}/finalize`,
    { method: 'POST' },
    'FINALIZE',
  );

  const processingInfo = finalizeBody.data?.processing_info || finalizeBody.processing_info;
  if (processingInfo && processingInfo.state !== 'succeeded') {
    await waitForMediaProcessing(accessToken, mediaId);
  }

  return {
    mediaId: String(mediaId),
    uploadDetails: {
      method: 'v2_chunked',
      bytes: buffer.length,
      segments: segmentIndex,
      mime: meta.mime,
      category: meta.category,
      processingState: processingInfo?.state || 'succeeded',
    },
  };
}

export async function uploadMedia(accessToken, buffer, { mediaType = 'image', filename = '' } = {}) {
  if (!buffer?.length) {
    throw xApiError({}, 400, 'Media buffer is empty', 'VALIDATE');
  }

  const safeFilename =
    filename ||
    (String(mediaType).toLowerCase() === 'video' ? 'upload.mp4' : 'upload.jpg');
  const meta = resolveMediaMeta(mediaType, safeFilename);
  const useChunked = meta.chunked || buffer.length > SIMPLE_UPLOAD_MAX_BYTES;

  if (useChunked || meta.category === 'tweet_video') {
    return uploadMediaChunkedV2(accessToken, buffer, meta);
  }

  // Small images/GIFs: v2 chunked flow with a single segment is reliable with OAuth 2.0.
  return uploadMediaChunkedV2(accessToken, buffer, meta);
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
    throw xApiError(body, res.status, 'X tweet creation failed', 'TWEET');
  }
  return body;
}

export function buildTweetUrl(username, tweetId) {
  if (!username || !tweetId) return null;
  const handle = String(username).replace(/^@/, '');
  return `https://x.com/${handle}/status/${tweetId}`;
}
