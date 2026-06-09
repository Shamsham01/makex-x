import { redactPemFromString } from './makexStandard.mjs';
import { buildTweetUrl, createTweet, uploadMedia } from './xApi.mjs';

function pickField(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] != null && body[key] !== '') return body[key];
  }
  return null;
}

export async function handlePost(req, res) {
  const body = req.body || {};
  const accessToken = pickField(body, 'accessToken');
  const text = pickField(body, 'text');
  const replyToTweetId = pickField(body, 'replyToTweetId');
  const mediaType = pickField(body, 'mediaType') || 'image';
  const xUsername = pickField(body, 'xUsername', 'username');

  if (!accessToken) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_REQUEST',
      message: 'Missing accessToken',
      data: { timestamp: new Date().toISOString() },
    });
  }

  const mediaBuffer = req.file?.buffer;
  const mediaFilename = req.file?.originalname || pickField(body, 'mediaFileName', 'media_file_name');
  const mediaIds = [];
  let uploadDetails;

  try {
    if (mediaBuffer?.length) {
      const uploaded = await uploadMedia(accessToken, mediaBuffer, { mediaType, filename: mediaFilename });
      mediaIds.push(uploaded.mediaId);
      uploadDetails = uploaded.uploadDetails;
    }

    const xRes = await createTweet(accessToken, { text, replyToTweetId, mediaIds });
    const tweet = xRes?.data || {};
    const tweetId = tweet.id;
    const tweetText = tweet.text ?? text ?? '';

    return res.status(200).json({
      status: 'success',
      code: 'TWEET_CREATED',
      message: 'Post created successfully',
      data: {
        tweetId,
        text: tweetText,
        mediaIds: mediaIds.length ? mediaIds : undefined,
        url: buildTweetUrl(xUsername, tweetId),
        createdAt: new Date().toISOString(),
        uploadDetails,
      },
    });
  } catch (error) {
    const status = error.status && Number.isInteger(error.status) ? error.status : 502;
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      status: 'error',
      code: error.code || 'POST_FAILED',
      message: redactPemFromString(error.message) || 'Failed to create post',
      data: {
        timestamp: new Date().toISOString(),
        ...(error.xBody ? { xError: error.xBody } : {}),
      },
    });
  }
}
