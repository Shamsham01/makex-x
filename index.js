import crypto from 'node:crypto';
import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import multer from 'multer';
import dotenv from 'dotenv';
import {
  buildAuthorizationSuccessResponse,
  buildUnauthorizedResponse,
  redactPemFromString,
} from './makexStandard.mjs';
import { handlePost } from './postHandler.mjs';
import {
  handleGetPost,
  handleGetPostStats,
  handleGetReplies,
  handleSearch,
} from './readHandler.mjs';
import { handleUsageFee } from './usageFee.mjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;

if (!SECURE_TOKEN) {
  console.error('SECURE_TOKEN is not set. Set it in Render env vars or .env');
}

app.use(helmet());
app.use(bodyParser.json({ limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
});

app.use((req, _res, next) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
    }),
  );
  next();
});

const checkToken = (req, res, next) => {
  if (req.headers.authorization === `Bearer ${SECURE_TOKEN}`) return next();
  return res.status(401).json(buildUnauthorizedResponse());
};

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'makex-x',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

const OAUTH2_REDIRECT_URI = 'https://www.make.com/oauth/cb/oauth2';

app.post('/authorization', checkToken, (_req, res) => {
  try {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const response = buildAuthorizationSuccessResponse();
    return res.status(200).json({
      ...response,
      data: {
        ...response.data,
        codeVerifier,
        codeChallenge,
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: redactPemFromString(error.message) || 'Internal server error',
      data: { timestamp: new Date().toISOString() },
    });
  }
});

app.post('/post', (req, res, next) => {
  const timeoutMs = 280000;
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);
  next();
}, checkToken, (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return upload.single('media')(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          status: 'error',
          code: 'INVALID_REQUEST',
          message: err.message || 'Invalid multipart upload',
          data: { timestamp: new Date().toISOString() },
        });
      }
      return next();
    });
  }
  return next();
}, handleUsageFee, handlePost);

app.post('/posts/get', checkToken, handleUsageFee, handleGetPost);
app.post('/posts/replies', checkToken, handleUsageFee, handleGetReplies);
app.post('/posts/stats', checkToken, handleUsageFee, handleGetPostStats);
app.post('/search', checkToken, handleUsageFee, handleSearch);

app.post('/oauth/token', checkToken, async (req, res) => {
  try {
    const {
      code,
      codeVerifier,
      clientId,
      clientSecret,
      redirectUri = OAUTH2_REDIRECT_URI,
    } = req.body || {};

    if (!code || !codeVerifier || !clientId || !clientSecret) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_REQUEST',
        message: 'Missing code, codeVerifier, clientId, or clientSecret',
      });
    }

    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const xRes = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: params.toString(),
    });

    const payload = await xRes.json();
    if (!xRes.ok) {
      return res.status(xRes.status).json({
        status: 'error',
        error: payload.error || 'TOKEN_EXCHANGE_FAILED',
        error_description: payload.error_description || payload.error || 'X token exchange failed',
      });
    }

    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: redactPemFromString(error.message) || 'Internal server error',
      data: { timestamp: new Date().toISOString() },
    });
  }
});

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  res.status(500).json({
    status: 'error',
    message: redactPemFromString(err.message) || 'Internal server error',
    data: { timestamp: new Date().toISOString() },
  });
});

app.listen(PORT, () => {
  console.log(`MakeX-X API listening on port ${PORT}`);
});
