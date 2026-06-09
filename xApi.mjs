const X_TWEETS_URL = 'https://api.x.com/2/tweets';
const X_MEDIA_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';

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

export async function uploadMediaSimple(accessToken, buffer, { mediaType = 'image' } = {}) {
  const form = new FormData();
  form.append('media', new Blob([buffer]), 'media');
  if (mediaType === 'gif') {
    form.append('media_category', 'tweet_gif');
  } else if (mediaType === 'video') {
    form.append('media_category', 'tweet_video');
  }

  const res = await fetch(X_MEDIA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw xApiError(body, res.status, 'X media upload failed');
  }

  const mediaId = body.media_id_string || body.media_id;
  if (!mediaId) {
    throw xApiError(body, res.status, 'X media upload returned no media id');
  }
  return String(mediaId);
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
