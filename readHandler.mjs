import { redactPemFromString } from './makexStandard.mjs';
import { usageFeeFields } from './usageFee.mjs';
import {
  buildTweetUrl,
  getConversationReplies,
  getTweet,
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
