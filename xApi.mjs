const X_API_BASE = 'https://api.x.com/2';
const X_TWEETS_URL = `${X_API_BASE}/tweets`;
const X_MEDIA_API = `${X_API_BASE}/media/upload`;
const DEFAULT_TWEET_FIELDS = 'created_at,author_id,public_metrics,attachments,lang,conversation_id';
const CHUNK_SIZE = 4 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const VIDEO_TROUBLESHOOTING =
  'X video processing requires MP4 (H.264 + AAC). Re-encode with: ffmpeg -i input.mp4 -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart output.mp4';

function xApiError(body, status, fallback, uploadStage = null, extra = {}) {
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
  if (extra.troubleshooting) err.troubleshooting = extra.troubleshooting;
  if (extra.processingError) err.processingError = extra.processingError;
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

function detectMediaFromBuffer(buffer) {
  if (!buffer?.length) return { kind: 'empty' };

  if (buffer.length >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return {
      kind: 'mp4',
      mime: 'video/mp4',
      brand: buffer.subarray(8, 12).toString('ascii'),
    };
  }

  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { kind: 'gif', mime: 'image/gif' };
  }

  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('ascii') === 'PNG') {
    return { kind: 'png', mime: 'image/png' };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { kind: 'jpeg', mime: 'image/jpeg' };
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'webp', mime: 'image/webp' };
  }

  const head = buffer.subarray(0, Math.min(buffer.length, 64)).toString('utf8').trimStart();
  if (head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return { kind: 'html', mime: 'text/html' };
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    return { kind: 'json', mime: 'application/json' };
  }

  return { kind: 'unknown' };
}

function formatProcessingFailure(info) {
  const err = info?.error || {};
  const parts = [
    err.message,
    err.name ? `(${err.name})` : null,
    err.code != null ? `code=${err.code}` : null,
  ].filter(Boolean);
  return parts.join(' ') || 'Video processing failed on X';
}

function resolveMediaMeta(mediaType = 'image', filename = '', buffer = null) {
  const detected = buffer ? detectMediaFromBuffer(buffer) : null;
  const ext = extensionFromFilename(filename);
  const normalized = String(mediaType || 'image').toLowerCase();

  if (detected?.kind === 'html') {
    const err = xApiError(
      { detected: detected.kind },
      400,
      'Downloaded file is HTML, not media. Check the media URL returns raw video bytes.',
      'VALIDATE',
    );
    throw err;
  }

  if (detected?.mime?.startsWith('video/') || normalized === 'video' || ['mp4', 'mov', 'm4v', 'webm'].includes(ext)) {
    if (detected?.kind === 'mp4') {
      return { mime: 'video/mp4', category: 'tweet_video', chunked: true, detected };
    }
    if (detected?.kind === 'unknown' && normalized === 'video') {
      return { mime: 'video/mp4', category: 'tweet_video', chunked: true, detected, assumed: true };
    }
    const mime =
      ext === 'mov' || ext === 'qt' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
    return { mime, category: 'tweet_video', chunked: true, detected };
  }

  if (detected?.mime) {
    if (detected.kind === 'gif') return { mime: detected.mime, category: 'tweet_gif', chunked: false, detected };
    return { mime: detected.mime, category: 'tweet_image', chunked: false, detected };
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
      const processingMessage = formatProcessingFailure(info);
      throw xApiError(
        { processing_info: info, errors: [{ message: processingMessage }] },
        502,
        processingMessage,
        'STATUS',
        {
          troubleshooting: VIDEO_TROUBLESHOOTING,
          processingError: info.error || null,
        },
      );
    }

    const waitMs = Math.max(1, Number(info.check_after_secs || 2)) * 1000;
    await sleep(waitMs);
  }

  throw xApiError({}, 504, 'Timed out waiting for X video processing', 'STATUS', {
    troubleshooting: VIDEO_TROUBLESHOOTING,
  });
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

  await xMediaRequest(accessToken, `${X_MEDIA_API}/${mediaId}/finalize`, { method: 'POST' }, 'FINALIZE');

  if (meta.category === 'tweet_video') {
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
      detected: meta.detected?.kind || null,
      processingState: 'succeeded',
    },
  };
}

export async function uploadMedia(accessToken, buffer, { mediaType = 'image', filename = '' } = {}) {
  if (!buffer?.length) {
    throw xApiError({}, 400, 'Media buffer is empty', 'VALIDATE');
  }

  const safeFilename =
    filename || (String(mediaType).toLowerCase() === 'video' ? 'upload.mp4' : 'upload.jpg');
  const meta = resolveMediaMeta(mediaType, safeFilename, buffer);

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
  if (!tweetId) return null;
  if (!username) return `https://x.com/i/status/${tweetId}`;
  const handle = String(username).replace(/^@/, '');
  return `https://x.com/${handle}/status/${tweetId}`;
}

async function xGet(accessToken, path, query = {}, fallback = 'X API request failed') {
  const url = new URL(`${X_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    throw xApiError(
      body,
      res.status,
      body.errors?.[0]?.message || body.detail || body.title || fallback,
    );
  }
  return body;
}

function normalizeTweetFields(tweetFields) {
  if (Array.isArray(tweetFields) && tweetFields.length) {
    return tweetFields.map(String).join(',');
  }
  if (typeof tweetFields === 'string' && tweetFields.trim()) {
    return tweetFields.trim();
  }
  return DEFAULT_TWEET_FIELDS;
}

function clampSearchMaxResults(maxResults, fallback = 10) {
  const parsed = Number(maxResults);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(value, 10), 100);
}

export async function getTweet(accessToken, tweetId, { tweetFields } = {}) {
  if (!tweetId) {
    const err = new Error('tweetId is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  return xGet(
    accessToken,
    `/tweets/${encodeURIComponent(String(tweetId))}`,
    { 'tweet.fields': normalizeTweetFields(tweetFields) },
    'Failed to fetch post',
  );
}

export async function searchRecentTweets(
  accessToken,
  query,
  { maxResults = 10, paginationToken } = {},
) {
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    const err = new Error('Search query is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  const params = {
    query: trimmed,
    max_results: clampSearchMaxResults(maxResults),
    'tweet.fields': DEFAULT_TWEET_FIELDS,
  };
  if (paginationToken) params.next_token = String(paginationToken);

  return xGet(accessToken, '/tweets/search/recent', params, 'Failed to search posts');
}

export async function getConversationReplies(
  accessToken,
  tweetId,
  { maxResults = 10, paginationToken } = {},
) {
  if (!tweetId) {
    const err = new Error('tweetId is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  const result = await searchRecentTweets(accessToken, `conversation_id:${tweetId}`, {
    maxResults,
    paginationToken,
  });

  const parentId = String(tweetId);
  const replies = (result.data || []).filter((tweet) => String(tweet.id) !== parentId);
  return {
    ...result,
    data: replies,
  };
}

const DEFAULT_USER_FIELDS =
  'created_at,description,public_metrics,verified,verified_type,profile_image_url,url,protected,location';

async function xJson(accessToken, path, { method = 'GET', query, json, fallback } = {}) {
  const url = new URL(`${X_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      if (Array.isArray(value)) {
        url.searchParams.set(key, value.join(','));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  let body;
  if (json != null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  const res = await fetch(url, { method, headers, body });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok || parsed.errors?.length) {
    throw xApiError(
      parsed,
      res.status,
      parsed.errors?.[0]?.message || parsed.detail || parsed.title || fallback || 'X API request failed',
    );
  }
  return parsed;
}

function normalizeUserFields(userFields) {
  if (Array.isArray(userFields) && userFields.length) {
    return userFields.map(String).join(',');
  }
  if (typeof userFields === 'string' && userFields.trim()) {
    return userFields.trim();
  }
  return DEFAULT_USER_FIELDS;
}

function clampTimelineMaxResults(maxResults, fallback = 10) {
  const parsed = Number(maxResults);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(value, 5), 100);
}

function requireId(value, label) {
  if (!value) {
    const err = new Error(`${label} is required`);
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }
  return String(value);
}

export async function deleteTweet(accessToken, tweetId) {
  const id = requireId(tweetId, 'tweetId');
  return xJson(accessToken, `/tweets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallback: 'Failed to delete post',
  });
}

export async function getUserByUsername(accessToken, username, { userFields } = {}) {
  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) {
    const err = new Error('username is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  return xJson(accessToken, `/users/by/username/${encodeURIComponent(handle)}`, {
    query: { 'user.fields': normalizeUserFields(userFields) },
    fallback: 'Failed to fetch user by username',
  });
}

export async function getUserById(accessToken, userId, { userFields } = {}) {
  const id = requireId(userId, 'userId');
  return xJson(accessToken, `/users/${encodeURIComponent(id)}`, {
    query: { 'user.fields': normalizeUserFields(userFields) },
    fallback: 'Failed to fetch user',
  });
}

export async function getUserTweets(
  accessToken,
  userId,
  { maxResults = 10, paginationToken, tweetFields } = {},
) {
  const id = requireId(userId, 'userId');
  const params = {
    max_results: clampTimelineMaxResults(maxResults),
    'tweet.fields': normalizeTweetFields(tweetFields),
  };
  if (paginationToken) params.pagination_token = String(paginationToken);

  return xJson(accessToken, `/users/${encodeURIComponent(id)}/tweets`, {
    query: params,
    fallback: 'Failed to fetch user posts',
  });
}

export async function getUserMentions(
  accessToken,
  userId,
  { maxResults = 10, paginationToken, tweetFields } = {},
) {
  const id = requireId(userId, 'userId');
  const params = {
    max_results: clampTimelineMaxResults(maxResults),
    'tweet.fields': normalizeTweetFields(tweetFields),
  };
  if (paginationToken) params.pagination_token = String(paginationToken);

  return xJson(accessToken, `/users/${encodeURIComponent(id)}/mentions`, {
    query: params,
    fallback: 'Failed to fetch mentions',
  });
}

export async function sendDirectMessage(accessToken, participantId, text) {
  const id = requireId(participantId, 'participantId');
  const message = String(text || '').trim();
  if (!message) {
    const err = new Error('DM text is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  return xJson(
    accessToken,
    `/dm_conversations/with/${encodeURIComponent(id)}/messages`,
    {
      method: 'POST',
      json: { text: message },
      fallback: 'Failed to send direct message',
    },
  );
}

export async function listBookmarks(
  accessToken,
  userId,
  { maxResults = 10, paginationToken, tweetFields } = {},
) {
  const id = requireId(userId, 'userId');
  const params = {
    max_results: clampTimelineMaxResults(maxResults),
    'tweet.fields': normalizeTweetFields(tweetFields),
  };
  if (paginationToken) params.pagination_token = String(paginationToken);

  return xJson(accessToken, `/users/${encodeURIComponent(id)}/bookmarks`, {
    query: params,
    fallback: 'Failed to list bookmarks',
  });
}

export async function addBookmark(accessToken, userId, tweetId) {
  const id = requireId(userId, 'userId');
  const postId = requireId(tweetId, 'tweetId');
  return xJson(accessToken, `/users/${encodeURIComponent(id)}/bookmarks`, {
    method: 'POST',
    json: { tweet_id: postId },
    fallback: 'Failed to add bookmark',
  });
}

export async function removeBookmark(accessToken, userId, tweetId) {
  const id = requireId(userId, 'userId');
  const postId = requireId(tweetId, 'tweetId');
  return xJson(
    accessToken,
    `/users/${encodeURIComponent(id)}/bookmarks/${encodeURIComponent(postId)}`,
    {
      method: 'DELETE',
      fallback: 'Failed to remove bookmark',
    },
  );
}
