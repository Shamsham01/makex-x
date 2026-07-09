import { redactPemFromString } from './makexStandard.mjs';
import { usageFeeFields } from './usageFee.mjs';
import {
  addBookmark,
  deleteTweet,
  listBookmarks,
  removeBookmark,
  sendDirectMessage,
} from './xApi.mjs';

function pickField(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] != null && body[key] !== '') return body[key];
  }
  return null;
}

function sendHandlerError(res, error) {
  const status = error.status && Number.isInteger(error.status) ? error.status : 502;
  return res.status(status >= 400 && status < 600 ? status : 502).json({
    status: 'error',
    code: error.code || 'REQUEST_FAILED',
    message: redactPemFromString(error.message) || 'Request failed',
    data: {
      timestamp: new Date().toISOString(),
      troubleshooting: error.troubleshooting || null,
      ...(error.xBody ? { xError: error.xBody } : {}),
    },
  });
}

function requireAccessToken(body, res) {
  const accessToken = pickField(body, 'accessToken');
  if (!accessToken) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_REQUEST',
      message: 'Missing accessToken',
      data: { timestamp: new Date().toISOString() },
    });
    return null;
  }
  return accessToken;
}

function requireUserId(body, res) {
  const userId = pickField(body, 'xUserId', 'userId');
  if (!userId) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_REQUEST',
      message: 'Missing userId (reconnect X account so connection.userId is available)',
      data: { timestamp: new Date().toISOString() },
    });
    return null;
  }
  return String(userId);
}

function mapBookmarkPost(tweet) {
  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    createdAt: tweet.created_at,
  };
}

export async function handleDeletePost(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const tweetId = pickField(body, 'tweetId');

  try {
    const xRes = await deleteTweet(accessToken, tweetId);
    const deleted = Boolean(xRes?.data?.deleted);

    return res.status(200).json({
      status: 'success',
      code: 'POST_DELETED',
      message: deleted ? 'Post deleted successfully' : 'Delete request completed',
      data: {
        tweetId: String(tweetId),
        deleted,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleSendDm(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const participantId = pickField(body, 'participantId', 'recipientId');
  const text = pickField(body, 'text', 'message');

  try {
    const xRes = await sendDirectMessage(accessToken, participantId, text);
    const dm = xRes?.data || {};

    return res.status(200).json({
      status: 'success',
      code: 'DM_SENT',
      message: 'Direct message sent successfully',
      data: {
        dmEventId: dm.dm_event_id || null,
        dmConversationId: dm.dm_conversation_id || null,
        text: String(text || ''),
        participantId: String(participantId),
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleListBookmarks(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const userId = requireUserId(body, res);
  if (!userId) return;

  try {
    const xRes = await listBookmarks(accessToken, userId, {
      maxResults: pickField(body, 'maxResults') ?? 10,
      paginationToken: pickField(body, 'paginationToken'),
      tweetFields: body.tweetFields,
    });

    const posts = (xRes.data || []).map(mapBookmarkPost);

    return res.status(200).json({
      status: 'success',
      code: 'BOOKMARKS_FETCHED',
      message: 'Bookmarks retrieved successfully',
      data: {
        userId,
        posts,
        resultCount: posts.length,
        nextToken: xRes.meta?.next_token || null,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleAddBookmark(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const userId = requireUserId(body, res);
  if (!userId) return;

  const tweetId = pickField(body, 'tweetId');

  try {
    const xRes = await addBookmark(accessToken, userId, tweetId);
    const bookmarked = Boolean(xRes?.data?.bookmarked);

    return res.status(200).json({
      status: 'success',
      code: 'BOOKMARK_ADDED',
      message: bookmarked ? 'Post bookmarked successfully' : 'Bookmark request completed',
      data: {
        userId,
        tweetId: String(tweetId),
        bookmarked,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleRemoveBookmark(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const userId = requireUserId(body, res);
  if (!userId) return;

  const tweetId = pickField(body, 'tweetId');

  try {
    const xRes = await removeBookmark(accessToken, userId, tweetId);
    const bookmarked = xRes?.data?.bookmarked;
    const removed = bookmarked === false;

    return res.status(200).json({
      status: 'success',
      code: 'BOOKMARK_REMOVED',
      message: removed ? 'Bookmark removed successfully' : 'Remove bookmark request completed',
      data: {
        userId,
        tweetId: String(tweetId),
        bookmarked: Boolean(bookmarked),
        removed,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}
