const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const CLI = join(process.env.APPDATA, 'npm', 'node_modules', '@makehq', 'cli', 'dist', 'index.js');
const CONN = 'makex-x-kj31eh';
const APP = 'makex-x-kj31eh';
const BASE_URL = 'https://makex-x.onrender.com';

function run(args, label) {
  console.log('->', label);
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (r.stdout && r.stdout.trim()) console.log(r.stdout.trim());
  if (r.stderr && r.stderr.trim()) console.error(r.stderr.trim());
  if (r.status !== 0) throw new Error('failed: ' + label);
}

const common = JSON.parse(readFileSync('common.json', 'utf8'));

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
    url: BASE_URL + '/authorization',
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
    url: 'https://x.com/i/oauth2/authorize',
    qs: {
      response_type: 'code',
      client_id: '{{ifempty(parameters.clientId, common.clientId)}}',
      redirect_uri: 'https://www.make.com/oauth/cb/oauth2',
      scope: "{{join(distinct(merge(oauth.scope, ifempty(parameters.additionalScopes, emptyarray))), ' ')}}",
      code_challenge: '{{temp.code_challenge}}',
      code_challenge_method: 'S256',
    },
    response: {
      temp: {
        code: '{{query.code}}',
        code_verifier: '{{temp.code_verifier}}',
        code_challenge: '{{temp.code_challenge}}',
      },
    },
  },
  token: {
    url: BASE_URL + '/oauth/token',
    method: 'POST',
    headers: {
      Authorization: '{{common.apiKey}}',
      'Content-Type': 'application/json',
    },
    body: {
      code: '{{temp.code}}',
      codeVerifier: '{{temp.code_verifier}}',
      clientId: '{{ifempty(parameters.clientId, common.clientId)}}',
      clientSecret: '{{ifempty(parameters.clientSecret, common.clientSecret)}}',
      redirectUri: 'https://www.make.com/oauth/cb/oauth2',
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
        message: '[{{ifempty(body.error; statusCode)}}] {{ifempty(body.error_description; body.message)}}',
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
    url: 'https://api.x.com/2/oauth2/token',
    method: 'POST',
    type: 'urlencoded',
    headers: {
      Authorization: 'Basic {{base64(ifempty(parameters.clientId, common.clientId) + \':\' + ifempty(parameters.clientSecret, common.clientSecret))}}',
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
    headers: { Authorization: 'Bearer {{connection.accessToken}}' },
    qs: { 'user.fields': 'id,name,username,profile_image_url' },
    response: {
      error: {
        message: '[{{statusCode}}] {{ifempty(body.detail; body.title; body.error)}}',
      },
      metadata: { type: 'text', value: '@{{body.data.username}} ({{body.data.name}})' },
      uid: '{{body.data.id}}',
      data: {
        userId: '{{body.data.id}}',
        username: '{{body.data.username}}',
        name: '{{body.data.name}}',
        profileImageUrl: '{{body.data.profile_image_url}}',
      },
    },
    log: { sanitize: ['request.headers.authorization'] },
  },
};

writeFileSync('base.json', JSON.stringify(base, null, 2) + '\n', 'utf8');
writeFileSync('connection/communication.json', JSON.stringify(comm, null, 2) + '\n', 'utf8');

const connCommon = {
  apiKey: common.apiKey,
  clientId: common.clientId,
  clientSecret: common.clientSecret,
};
writeFileSync('connection/common.json', JSON.stringify(connCommon, null, 2) + '\n', 'utf8');

const appCommon = {
  apiKey: common.apiKey,
  timeout: common.timeout || 300000,
};

run(['sdk-connections', 'set-common', '--connection-name=' + CONN, '--common=' + JSON.stringify(connCommon)], 'connection common');
run(['sdk-connections', 'set-section', '--connection-name=' + CONN, '--section=api', '--body=' + JSON.stringify(comm)], 'connection api');
run(['sdk-apps', 'set-common', '--name=' + APP, '--version=1', '--common=' + JSON.stringify(appCommon)], 'app common');
run(['sdk-apps', 'set-section', '--name=' + APP, '--version=1', '--section=base', '--body=' + JSON.stringify(base)], 'app base');

const verifyCommon = spawnSync(process.execPath, [CLI, 'sdk-connections', 'get-common', '--connection-name=' + CONN], { encoding: 'utf8' });
console.log('VERIFY connection common keys:', Object.keys(JSON.parse(verifyCommon.stdout || '{}')).join(', '));

const verifyApi = spawnSync(process.execPath, [CLI, 'sdk-connections', 'get-section', '--connection-name=' + CONN, '--section=api'], { encoding: 'utf8' });
const api = JSON.parse(verifyApi.stdout);
console.log('VERIFY preauthorize url:', api.preauthorize && api.preauthorize.url);
