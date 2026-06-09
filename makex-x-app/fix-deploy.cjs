const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const CLI = join(process.env.APPDATA, 'npm', 'node_modules', '@makehq', 'cli', 'dist', 'index.js');
const CONN = 'makex-x-kj31eh';
const APP = 'makex-x-kj31eh';
const BASE_URL = 'https://makex-x.onrender.com';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_SCOPE = 'tweet.read tweet.write users.read offline.access media.write';
// Must match connection.redirectUri for type=oauth (oauth.makeRedirectUri).
const REDIRECT_URI = '{{oauth.makeRedirectUri}}';
// PKCE S256 fallback without base64url IML (preauthorize backend PKCE is preferred).
const PKCE_CHALLENGE_IML =
  "{{ifempty(temp.code_challenge; replace(replace(replace(base64(sha256(temp.code_verifier, 'base64')); '+'; '-'); '/'; '_'); '='; ''))}}";

function run(args, label) {
  console.log('->', label);
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) console.log(r.stdout.trim());
  if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim());
  if (r.status !== 0) throw new Error(`failed: ${label}`);
}

function readJson(relPath) {
  return JSON.parse(readFileSync(join(__dirname, relPath), 'utf8'));
}

const common = readJson('common.json');

const base = {
  baseUrl: BASE_URL,
  timeout: common.timeout || 300000,
  headers: {
    Authorization: '{{common.apiKey}}',
    'Content-Type': 'application/json',
  },
  response: {
    error: {
      message: '[{{ifempty(body.code; statusCode)}}] {{ifempty(body.message; body.error)}}]',
    },
  },
  log: {
    sanitize: [
      'request.headers.authorization',
      'request.body.walletPem',
      'request.body.accessToken',
      'request.body.refreshToken',
    ],
  },
};

const comm = {
  preauthorize: {
    url: `${BASE_URL}/authorization`,
    method: 'POST',
    headers: {
      Authorization: '{{common.apiKey}}',
      'Content-Type': 'application/json',
    },
    body: {
      walletPem: '{{parameters.pemContent}}',
    },
    response: {
      temp: {
        code_verifier: '{{body.data.codeVerifier}}',
        code_challenge: '{{body.data.codeChallenge}}',
      },
      error: {
        message: '[{{ifempty(body.code; statusCode)}}] {{body.message}}',
      },
    },
    log: {
      sanitize: ['request.headers.authorization', 'request.body.walletPem'],
    },
  },
  authorize: {
    temp: {
      code_verifier: '{{ifempty(temp.code_verifier; randomString(43))}}',
    },
    url: X_AUTHORIZE_URL,
    qs: {
      response_type: 'code',
      client_id: '{{ifempty(parameters.clientId, common.clientId)}}',
      redirect_uri: REDIRECT_URI,
      scope: X_SCOPE,
      code_challenge: PKCE_CHALLENGE_IML,
      code_challenge_method: 'S256',
    },
    response: {
      temp: {
        code: '{{query.code}}',
        code_verifier: '{{temp.code_verifier}}',
      },
    },
  },
  token: {
    url: X_TOKEN_URL,
    method: 'POST',
    type: 'urlencoded',
    headers: {
      Authorization:
        'Basic {{base64(ifempty(parameters.clientId, common.clientId) + \':\' + ifempty(parameters.clientSecret, common.clientSecret))}}',
    },
    body: {
      grant_type: 'authorization_code',
      code: '{{temp.code}}',
      redirect_uri: REDIRECT_URI,
      client_id: '{{ifempty(parameters.clientId, common.clientId)}}',
      code_verifier: '{{temp.code_verifier}}',
    },
    response: {
      data: {
        expires: '{{addSeconds(now, body.expires_in)}}',
        accessToken: '{{body.access_token}}',
        refreshToken: '{{body.refresh_token}}',
        scope: '{{body.scope}}',
        tokenType: '{{body.token_type}}',
      },
      expires: '{{addYears(now, 1)}}',
      error: {
        message: '[{{ifempty(body.error; statusCode)}}] {{ifempty(body.error_description; body.title)}}',
      },
    },
    log: {
      sanitize: [
        'request.body.code',
        'request.headers.authorization',
        'response.body.access_token',
        'response.body.refresh_token',
      ],
    },
  },
  refresh: {
    condition: '{{if(data.expires, data.expires < addMinutes(now, 15), false)}}',
    url: X_TOKEN_URL,
    method: 'POST',
    type: 'urlencoded',
    headers: {
      Authorization:
        'Basic {{base64(ifempty(parameters.clientId, common.clientId) + \':\' + ifempty(parameters.clientSecret, common.clientSecret))}}',
    },
    body: {
      grant_type: 'refresh_token',
      refresh_token: '{{data.refreshToken}}',
      client_id: '{{ifempty(parameters.clientId, common.clientId)}}',
    },
    response: {
      data: {
        expires: '{{addSeconds(now, body.expires_in)}}',
        accessToken: '{{body.access_token}}',
        refreshToken: '{{ifempty(body.refresh_token; data.refreshToken)}}',
      },
    },
    log: {
      sanitize: [
        'request.headers.authorization',
        'request.body.refresh_token',
        'response.body.access_token',
        'response.body.refresh_token',
      ],
    },
  },
  info: {
    url: 'https://api.x.com/2/users/me',
    method: 'GET',
    headers: {
      Authorization: 'Bearer {{connection.accessToken}}',
    },
    qs: {
      'user.fields': 'id,name,username,profile_image_url',
    },
    response: {
      error: {
        message: '[{{statusCode}}] {{ifempty(body.detail; body.title; body.error)}}',
      },
      metadata: {
        type: 'text',
        value: '@{{body.data.username}} ({{body.data.name}})',
      },
      uid: '{{body.data.id}}',
      data: {
        userId: '{{body.data.id}}',
        username: '{{body.data.username}}',
        name: '{{body.data.name}}',
        profileImageUrl: '{{body.data.profile_image_url}}',
      },
    },
    log: {
      sanitize: ['request.headers.authorization'],
    },
  },
};

const parameters = [
  {
    name: 'pemContent',
    type: 'pkey',
    label: 'PEM Content',
    required: true,
    help: 'MultiversX wallet PEM for MakeX authorization (WARPS hybrid).',
  },
  {
    name: 'clientId',
    type: 'text',
    label: 'X Client ID',
    required: false,
    editable: true,
    help: 'X OAuth 2.0 Client ID. Leave empty to use connection common clientId.',
  },
  {
    name: 'clientSecret',
    type: 'password',
    label: 'X Client Secret',
    required: false,
    editable: true,
    advanced: true,
    help: 'Optional override. Defaults to connection common clientSecret.',
  },
];

const scopes = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'];

writeFileSync(join(__dirname, 'base.json'), `${JSON.stringify(base, null, 2)}\n`, 'utf8');
writeFileSync(join(__dirname, 'connection/communication.json'), `${JSON.stringify(comm, null, 2)}\n`, 'utf8');
writeFileSync(join(__dirname, 'connection/parameters.json'), `${JSON.stringify(parameters, null, 2)}\n`, 'utf8');
writeFileSync(join(__dirname, 'connection/scopes.json'), `${JSON.stringify(scopes, null, 2)}\n`, 'utf8');

const connCommon = {
  apiKey: common.apiKey,
  clientId: common.clientId,
  clientSecret: common.clientSecret,
};
writeFileSync(join(__dirname, 'connection/common.json'), `${JSON.stringify(connCommon, null, 2)}\n`, 'utf8');

const appCommon = {
  apiKey: common.apiKey,
  timeout: common.timeout || 300000,
};

run(['sdk-connections', 'set-common', `--connection-name=${CONN}`, `--common=${JSON.stringify(connCommon)}`], 'connection common');
run(['sdk-connections', 'set-section', `--connection-name=${CONN}`, '--section=parameters', `--body=${JSON.stringify(parameters)}`], 'connection parameters');
run(['sdk-connections', 'set-section', `--connection-name=${CONN}`, '--section=scope', `--body=${JSON.stringify(scopes)}`], 'connection scopes');
run(['sdk-connections', 'set-section', `--connection-name=${CONN}`, '--section=api', `--body=${JSON.stringify(comm)}`], 'connection api');
run(['sdk-apps', 'set-common', `--name=${APP}`, '--version=1', `--common=${JSON.stringify(appCommon)}`], 'app common');
run(['sdk-apps', 'set-section', `--name=${APP}`, '--version=1', '--section=base', `--body=${JSON.stringify(base)}`], 'app base');

const verifyApi = JSON.parse(
  spawnSync(process.execPath, [CLI, 'sdk-connections', 'get-section', `--connection-name=${CONN}`, '--section=api'], {
    encoding: 'utf8',
  }).stdout,
);

console.log('VERIFY token.url:', verifyApi.token && verifyApi.token.url);
console.log('VERIFY token.type:', verifyApi.token && verifyApi.token.type);
console.log('VERIFY authorize.redirect_uri:', verifyApi.authorize && verifyApi.authorize.qs && verifyApi.authorize.qs.redirect_uri);
console.log('VERIFY token.redirect_uri:', verifyApi.token && verifyApi.token.body && verifyApi.token.body.redirect_uri);

if (!verifyApi.token || verifyApi.token.url !== X_TOKEN_URL) {
  throw new Error(`token.url must be ${X_TOKEN_URL}`);
}
if (verifyApi.token.type !== 'urlencoded') {
  throw new Error('token.type must be urlencoded');
}
if (verifyApi.authorize.qs.redirect_uri !== '{{oauth.makeRedirectUri}}') {
  throw new Error('authorize.redirect_uri must be {{oauth.makeRedirectUri}}');
}

console.log(`\nDeployed OAuth connection for ${APP}`);
