import { redactPemFromString } from './makexStandard.mjs';
import { usageFeeFields } from './usageFee.mjs';
import {
  buildTweetUrl,
  getConversationReplies,
  getTweet,
  getUserById,
  getUserByUsername,
  getUserMentions,
  getUserTweets,
  searchRecentTweets,
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

function buildSearchQuery(searchType, query) {
  const value = String(query || '').trim();
  if (!value) {
    const err = new Error('Query is required');
    err.status = 400;
    err.code = 'INVALID_REQUEST';
    throw err;
  }

  switch (String(searchType || 'keyword').toLowerCase()) {
    case 'hashtag':
      return value.startsWith('#') ? value : `#${value}`;
    case 'username':
      return `from:${value.replace(/^@/, '')}`;
    default:
      return value;
  }
}

function mapReply(tweet) {
  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    createdAt: tweet.created_at,
  };
}

function mapSearchPost(tweet, username) {
  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    createdAt: tweet.created_at,
    url: buildTweetUrl(username, tweet.id),
  };
}

export async function handleGetPost(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const tweetId = pickField(body, 'tweetId');
  const xUsername = pickField(body, 'xUsername', 'username');

  try {
    const xRes = await getTweet(accessToken, tweetId, {
      tweetFields: body.tweetFields,
    });
    const tweet = xRes?.data || {};

    return res.status(200).json({
      status: 'success',
      code: 'POST_FETCHED',
      message: 'Post retrieved successfully',
      data: {
        tweet,
        url: buildTweetUrl(xUsername, tweet.id),
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleGetReplies(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const tweetId = pickField(body, 'tweetId');

  try {
    const xRes = await getConversationReplies(accessToken, tweetId, {
      maxResults: pickField(body, 'maxResults') ?? 10,
      paginationToken: pickField(body, 'paginationToken'),
    });

    const replies = (xRes.data || []).map(mapReply);

    return res.status(200).json({
      status: 'success',
      code: 'REPLIES_FETCHED',
      message: 'Replies retrieved successfully',
      data: {
        parentTweetId: String(tweetId),
        replies,
        replyCount: replies.length,
        nextToken: xRes.meta?.next_token || null,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleGetPostStats(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const tweetId = pickField(body, 'tweetId');

  try {
    const xRes = await getTweet(accessToken, tweetId, {
      tweetFields: ['public_metrics'],
    });
    const tweet = xRes?.data || {};
    const metrics = tweet.public_metrics || {};

    return res.status(200).json({
      status: 'success',
      code: 'POST_STATS_FETCHED',
      message: 'Post stats retrieved successfully',
      data: {
        tweetId: tweet.id || String(tweetId),
        public_metrics: metrics,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleSearch(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const searchType = pickField(body, 'searchType') || 'keyword';
  const query = pickField(body, 'query');
  const xUsername = pickField(body, 'xUsername', 'username');

  try {
    const searchQuery = buildSearchQuery(searchType, query);
    const xRes = await searchRecentTweets(accessToken, searchQuery, {
      maxResults: pickField(body, 'maxResults') ?? 10,
      paginationToken: pickField(body, 'paginationToken'),
    });

    const posts = (xRes.data || []).map((tweet) => mapSearchPost(tweet, xUsername));

    return res.status(200).json({
      status: 'success',
      code: 'SEARCH_COMPLETED',
      message: 'Search completed successfully',
      data: {
        searchType,
        query,
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

function mapUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    description: user.description || null,
    createdAt: user.created_at || null,
    verified: user.verified ?? null,
    verifiedType: user.verified_type || null,
    profileImageUrl: user.profile_image_url || null,
    url: user.url || null,
    location: user.location || null,
    protected: user.protected ?? null,
    publicMetrics: user.public_metrics || null,
  };
}

function mapTimelinePost(tweet, username) {
  return {
    id: tweet.id,
    text: tweet.text,
    authorId: tweet.author_id,
    createdAt: tweet.created_at,
    url: buildTweetUrl(username, tweet.id),
  };
}

async function resolveTargetUserId(accessToken, body) {
  const explicitUserId = pickField(body, 'userId', 'targetUserId');
  if (explicitUserId) return String(explicitUserId);

  const username = pickField(body, 'username', 'targetUsername');
  if (username) {
    const xRes = await getUserByUsername(accessToken, username);
    const id = xRes?.data?.id;
    if (!id) {
      const err = new Error('User not found');
      err.status = 404;
      err.code = 'USER_NOT_FOUND';
      throw err;
    }
    return String(id);
  }

  const connectedUserId = pickField(body, 'xUserId');
  if (connectedUserId) return String(connectedUserId);

  const err = new Error('Provide userId, username, or reconnect so connection.userId is available');
  err.status = 400;
  err.code = 'INVALID_REQUEST';
  throw err;
}

export async function handleGetUser(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  const username = pickField(body, 'username');
  const userId = pickField(body, 'userId');

  try {
    if (!username && !userId) {
      const err = new Error('username or userId is required');
      err.status = 400;
      err.code = 'INVALID_REQUEST';
      throw err;
    }

    const xRes = username
      ? await getUserByUsername(accessToken, username, { userFields: body.userFields })
      : await getUserById(accessToken, userId, { userFields: body.userFields });

    const user = mapUser(xRes?.data || {});

    return res.status(200).json({
      status: 'success',
      code: 'USER_FETCHED',
      message: 'User retrieved successfully',
      data: {
        user,
        profileUrl: user.username ? `https://x.com/${user.username}` : null,
        ...usageFeeFields(req),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error);
  }
}

export async function handleGetUserPosts(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  try {
    const userId = await resolveTargetUserId(accessToken, body);
    const xRes = await getUserTweets(accessToken, userId, {
      maxResults: pickField(body, 'maxResults') ?? 10,
      paginationToken: pickField(body, 'paginationToken'),
      tweetFields: body.tweetFields,
    });

    const username = pickField(body, 'username', 'xUsername');
    const posts = (xRes.data || []).map((tweet) => mapTimelinePost(tweet, username));

    return res.status(200).json({
      status: 'success',
      code: 'USER_POSTS_FETCHED',
      message: 'User posts retrieved successfully',
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

export async function handleGetMentions(req, res) {
  const body = req.body || {};
  const accessToken = requireAccessToken(body, res);
  if (!accessToken) return;

  try {
    // Mentions are always for the authenticated user (owned read).
    const userId = pickField(body, 'xUserId', 'userId');
    if (!userId) {
      const err = new Error('Missing userId (reconnect X account so connection.userId is available)');
      err.status = 400;
      err.code = 'INVALID_REQUEST';
      throw err;
    }

    const xRes = await getUserMentions(accessToken, userId, {
      maxResults: pickField(body, 'maxResults') ?? 10,
      paginationToken: pickField(body, 'paginationToken'),
      tweetFields: body.tweetFields,
    });

    const xUsername = pickField(body, 'xUsername', 'username');
    const posts = (xRes.data || []).map((tweet) => mapTimelinePost(tweet, xUsername));

    return res.status(200).json({
      status: 'success',
      code: 'MENTIONS_FETCHED',
      message: 'Mentions retrieved successfully',
      data: {
        userId: String(userId),
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
