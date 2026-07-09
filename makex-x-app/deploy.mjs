import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'makex-x-kj31eh';
const APP_VERSION = '1';
const CONNECTION_NAME = 'makex-x-kj31eh';
const CLI = process.env.MAKE_CLI_PATH || join(
  process.env.APPDATA || '',
  'npm',
  'node_modules',
  '@makehq',
  'cli',
  'dist',
  'index.js',
);

const MODULES = [
  { name: 'postTweet', label: 'Post', description: 'Create an X post with optional image, GIF, or video media and text.' },
  { name: 'deletePost', label: 'Delete Post', description: 'Delete an X post owned by the connected account.' },
  { name: 'getPostById', label: 'Get Post by ID', description: 'Retrieve a single X post by its ID.' },
  { name: 'getReplies', label: 'Get Replies', description: 'List replies in a conversation thread for a given post ID.' },
  { name: 'getPostStats', label: 'Get Post Stats', description: 'Fetch engagement metrics for a post.' },
  { name: 'searchPosts', label: 'Search Posts', description: 'Search recent posts by hashtag, username, or keyword.' },
  { name: 'getUser', label: 'Get User', description: 'Look up an X user profile by username or user ID.' },
  { name: 'getUserPosts', label: 'Get User Posts', description: 'List recent posts from a user timeline (defaults to connected account).' },
  { name: 'getMentions', label: 'Get Mentions', description: 'List recent mentions of the connected account.' },
  { name: 'sendDm', label: 'Send DM', description: 'Send a direct message to a user by their numeric user ID.' },
  { name: 'listBookmarks', label: 'List Bookmarks', description: 'List bookmarked posts for the connected account.' },
  { name: 'addBookmark', label: 'Add Bookmark', description: 'Bookmark a post for the connected account.' },
  { name: 'removeBookmark', label: 'Remove Bookmark', description: 'Remove a post from the connected account bookmarks.' },
];

function readJson(relPath, fallbackPath = null) {
  const primary = join(__dirname, relPath);
  const path = existsSync(primary) ? primary : (fallbackPath ? join(__dirname, fallbackPath) : primary);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCli(args, label) {
  console.log(`\n-> ${label}`);
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) throw new Error(`CLI failed (${label}): exit ${result.status}`);
  return result.stdout;
}

function setAppCommon() {
  const common = readJson('common.json', 'common.example.json');
  runCli([
    'sdk-apps', 'set-common',
    `--name=${APP_NAME}`, `--version=${APP_VERSION}`,
    `--common=${JSON.stringify(common)}`,
  ], 'Set app common data');
}

function setAppBase() {
  const base = readJson('base.json');
  runCli([
    'sdk-apps', 'set-section',
    `--name=${APP_NAME}`, `--version=${APP_VERSION}`,
    '--section=base', `--body=${JSON.stringify(base)}`,
  ], 'Set app base');
}

function setConnectionSections() {
  runCli([
    'sdk-connections', 'set-section',
    `--connection-name=${CONNECTION_NAME}`, '--section=parameters',
    `--body=${JSON.stringify(readJson('connection/parameters.json'))}`,
  ], 'Set connection parameters');
  runCli([
    'sdk-connections', 'set-section',
    `--connection-name=${CONNECTION_NAME}`, '--section=scope',
    `--body=${JSON.stringify(readJson('connection/scopes.json'))}`,
  ], 'Set connection scopes');
  runCli([
    'sdk-connections', 'set-section',
    `--connection-name=${CONNECTION_NAME}`, '--section=api',
    `--body=${JSON.stringify(readJson('connection/communication.json'))}`,
  ], 'Set connection communication');
}

function ensureModule(mod) {
  const list = runCli([
    'sdk-modules', 'list',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
  ], `List modules (check ${mod.name})`);
  if (!list.includes(`"name": "${mod.name}"`)) {
    runCli([
      'sdk-modules', 'create',
      `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
      `--name=${mod.name}`, '--type-id=4',
      `--label=${mod.label}`, `--description=${mod.description}`,
      '--module-init-mode=blank',
    ], `Create module ${mod.name}`);
  }
}

function setModuleSections(modName) {
  const mappableParams = readJson(`modules/${modName}/parameters.json`);
  runCli([
    'sdk-modules', 'set-section',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
    `--module-name=${modName}`, '--section=expect',
    `--body=${JSON.stringify(mappableParams)}`,
  ], `Set ${modName} mappable parameters`);
  runCli([
    'sdk-modules', 'set-section',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
    `--module-name=${modName}`, '--section=parameters',
    '--body=[]',
  ], `Clear ${modName} static parameters`);
  runCli([
    'sdk-modules', 'set-section',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
    `--module-name=${modName}`, '--section=api',
    `--body=${JSON.stringify(readJson(`modules/${modName}/communication.json`))}`,
  ], `Set ${modName} communication`);
  runCli([
    'sdk-modules', 'set-section',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
    `--module-name=${modName}`, '--section=interface',
    `--body=${JSON.stringify(readJson(`modules/${modName}/interface.json`))}`,
  ], `Set ${modName} interface`);
  runCli([
    'sdk-modules', 'update',
    `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`,
    `--module-name=${modName}`, `--connection=${CONNECTION_NAME}`,
  ], `Attach connection to ${modName}`);
}

function validate() {
  runCli(['sdk-apps', 'get', `--name=${APP_NAME}`, `--version=${APP_VERSION}`], 'Validate app');
  runCli(['sdk-connections', 'get', `--connection-name=${CONNECTION_NAME}`], 'Validate connection');
  runCli(['sdk-modules', 'list', `--app-name=${APP_NAME}`, `--app-version=${APP_VERSION}`], 'Validate modules');
  console.log('\nValidation complete');
}

const validateOnly = process.argv.includes('--validate-only');

try {
  if (validateOnly) {
    validate();
    process.exit(0);
  }
  setAppCommon();
  setAppBase();
  setConnectionSections();
  for (const mod of MODULES) {
    ensureModule(mod);
    setModuleSections(mod.name);
  }
  validate();
  console.log(`\nDeployed ${APP_NAME} v${APP_VERSION}`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
