import express from 'express';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import {
  buildAuthorizationSuccessResponse,
  buildUnauthorizedResponse,
  redactPemFromString,
} from './makexStandard.mjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;

if (!SECURE_TOKEN) {
  console.error('SECURE_TOKEN is not set. Set it in Render env vars or .env');
}

app.use(helmet());
app.use(bodyParser.json({ limit: '50mb' }));

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

app.post('/authorization', checkToken, (_req, res) => {
  try {
    return res.status(200).json(buildAuthorizationSuccessResponse());
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
