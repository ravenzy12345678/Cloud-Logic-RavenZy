'use strict';

/* CLOUD LOGIC — RAVEN
 * Telegram deploy bot for Vercel + GitHub.
 * Single-file production bot. No .env file is required; all secrets come from Vercel env vars.
 * Features: premium inline UI, HTML/ZIP deploy, source bundle, AES-256-GCM HTML encryption,
 * GitHub single-commit deployment updates, Vercel Deploy Hook/status tracking, deployment deletion,
 * and owner-managed user access.
 *
 * This bot does not bypass authentication, paywalls, server-side rendering, or protected content.
 */

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { URL } = require('url');

const env = (primary, alias, fallback = undefined) => process.env[primary] || process.env[alias] || fallback;

const BOT_TOKEN = env('BOT_TOKEN', 'TOKEN_BOT');
const OWNER_ID = Number(env('OWNER_ID', 'ID_PEMILIK', '0'));
const GITHUB_TOKEN = env('GITHUB_TOKEN', 'TOKEN_GITHUB');
const GITHUB_OWNER = env('GITHUB_OWNER', 'PEMILIK_GITHUB');
const GITHUB_REPO = env('GITHUB_REPO', 'REPO_GITHUB');
const GITHUB_BRANCH = env('GITHUB_BRANCH', 'CABANG_GITHUB', 'main');
const VERCEL_HOOK = env('VERCEL_HOOK');
const VERCEL_TOKEN = env('VERCEL_TOKEN');

const MAX_HTML_MB = 20;
const MAX_ZIP_MB = 100;
const MAX_SOURCE_RESOURCES = 80;
const MAX_SOURCE_TOTAL_MB = 50;
const MAX_SOURCE_FILE_MB = 15;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

if (!BOT_TOKEN || !OWNER_ID || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !VERCEL_HOOK || !VERCEL_TOKEN) {
  console.warn('CLOUD LOGIC: required environment variables are missing. Bot may not start until Vercel env is complete.');
}

const bot = new Telegraf(BOT_TOKEN || 'missing-token');

// Runtime user state. On Vercel this is best-effort and resets on cold start.
const users = new Set([OWNER_ID].filter(Boolean));
const sessions = new Map();
const panelMessage = new Map();
const latestDeployments = new Map(); // userId -> { id, url, name, createdAt }
const AUTH_FILE = '.cloud-logic-users.json';
let authLoaded = false;
let authorizedHashes = new Set();

const api = axios.create({
  timeout: 45_000,
  maxContentLength: MAX_UPLOAD_BYTES,
  maxBodyLength: MAX_UPLOAD_BYTES,
  headers: {
    'User-Agent': 'Cloud-Logic-Raven-Bot/2.0',
    Accept: 'application/vnd.github+json'
  }
});

function uid(ctx) { return ctx.from?.id || 0; }
function isOwner(ctx) { return uid(ctx) === OWNER_ID; }
function userHash(id) {
  return crypto.createHmac('sha256', BOT_TOKEN || 'cloud-logic').update(String(id)).digest('hex');
}

async function loadAuthorizedUsers() {
  if (authLoaded) return;
  authorizedHashes = new Set();
  try {
    const r = await githubGet(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${AUTH_FILE}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const raw = Buffer.from(String(r.data?.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.users)) for (const h of data.users) if (/^[a-f0-9]{64}$/.test(String(h))) authorizedHashes.add(String(h));
  } catch (e) {
    if (e?.response?.status !== 404) console.error('AUTH LOAD:', errorText(e));
  }
  authorizedHashes.add(userHash(OWNER_ID));
  authLoaded = true;
}

async function persistAuthorizedUser(id) {
  await loadAuthorizedUsers();
  const hash = userHash(id);
  authorizedHashes.add(hash);
  const body = Buffer.from(JSON.stringify({ version: 1, users: [...authorizedHashes].filter(h => h !== userHash(OWNER_ID)).sort() }, null, 2) + '\n', 'utf8').toString('base64');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${AUTH_FILE}`;
  let sha;
  try { const current = await githubGet(`${url}?ref=${encodeURIComponent(GITHUB_BRANCH)}`); sha = current.data?.sha; } catch (e) { if (e?.response?.status !== 404) throw e; }
  const payload = { message: `Cloud Logic: authorize user ${id}`, content: body, branch: GITHUB_BRANCH };
  if (sha) payload.sha = sha;
  await githubPut(url, payload);
}

async function authorized(ctx) {
  await loadAuthorizedUsers();
  return authorizedHashes.has(userHash(uid(ctx)));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeFilename(name, fallback = 'file') {
  const cleaned = String(name || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function siteNameValid(name) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  const m = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.mjs': 'application/javascript', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm'
  };
  return m[ext] || 'application/octet-stream';
}

function normalizeRepoPath(p) {
  let x = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  x = path.posix.normalize(x);
  if (x === '.' || x.startsWith('../') || x.includes('/../')) throw new Error(`Invalid path: ${p}`);
  return x;
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10'
  };
}

async function githubGet(url, config = {}) {
  return api.get(url, { ...config, headers: { ...githubHeaders(), ...(config.headers || {}) } });
}

async function githubPost(url, data, config = {}) {
  return api.post(url, data, { ...config, headers: { ...githubHeaders(), ...(config.headers || {}) } });
}

async function githubPatch(url, data, config = {}) {
  return api.patch(url, data, { ...config, headers: { ...githubHeaders(), ...(config.headers || {}) } });
}

async function githubPut(url, data, config = {}) {
  return api.put(url, data, { ...config, headers: { ...githubHeaders(), ...(config.headers || {}) } });
}

async function getBranchHead() {
  const refUrl = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`;
  const ref = await githubGet(refUrl);
  const commitSha = ref.data.object.sha;
  const commitUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${commitSha}`;
  const commit = await githubGet(commitUrl);
  return { ref, commitSha, treeSha: commit.data.tree.sha };
}

async function getRecursiveTree(treeSha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${treeSha}?recursive=1`;
  const r = await githubGet(url);
  return r.data.tree || [];
}

function shouldPreserveRepoPath(p) {
  const n = p.replace(/^\/+/, '');
  return n === 'api/bot.js' || n === 'package.json' || n === 'vercel.json' || n === AUTH_FILE || n.startsWith('.github/');
}

function buildTreeChanges(existingTree, siteFiles) {
  const changes = [];
  for (const item of existingTree) {
    if ((item.type === 'blob' || item.type === 'tree') && !shouldPreserveRepoPath(item.path)) {
      changes.push({ path: item.path, mode: item.mode === '120000' ? '120000' : '100644', type: item.type === 'tree' ? 'tree' : 'blob', sha: null });
    }
  }
  for (const [p, value] of Object.entries(siteFiles)) {
    const normalized = normalizeRepoPath(p);
    if (shouldPreserveRepoPath(normalized)) continue;
    const content = Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(String(value)).toString('base64');
    changes.push({ path: normalized, mode: '100644', type: 'blob', content: contentFromBase64(content) });
  }
  // GitHub's tree endpoint expects UTF-8 content when using `content`; for binary we create blobs separately below.
  return changes;
}

function contentFromBase64(b64) {
  // marker used only by the caller; actual tree builder replaces this with binary blob SHAs.
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function createGithubBlob(buffer) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`;
  const r = await githubPost(url, { content: buffer.toString('base64'), encoding: 'base64' });
  return r.data.sha;
}

async function deployToGithub(siteFiles, commitMessage) {
  const { commitSha, treeSha } = await getBranchHead();
  const existingTree = await getRecursiveTree(treeSha);
  const tree = [];

  for (const item of existingTree) {
    if ((item.type === 'blob' || item.type === 'tree') && !shouldPreserveRepoPath(item.path)) {
      tree.push({ path: item.path, mode: item.mode || '100644', type: item.type, sha: null });
    }
  }

  for (const [p0, value] of Object.entries(siteFiles)) {
    const p = normalizeRepoPath(p0);
    if (shouldPreserveRepoPath(p)) continue;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (buf.length > MAX_SOURCE_FILE_MB * 1024 * 1024) throw new Error(`File too large: ${p}`);
    const sha = await createGithubBlob(buf);
    tree.push({ path: p, mode: '100644', type: 'blob', sha });
  }

  const treeUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`;
  const createdTree = await githubPost(treeUrl, { base_tree: treeSha, tree });

  const commitUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`;
  const commit = await githubPost(commitUrl, {
    message: commitMessage,
    tree: createdTree.data.sha,
    parents: [commitSha]
  });

  const refUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`;
  await githubPatch(refUrl, { sha: commit.data.sha, force: false });

  return { commitSha: commit.data.sha, commitUrl: commit.data.html_url };
}

function parseVercelHook() {
  try {
    const u = new URL(VERCEL_HOOK);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('deploy');
    if (idx < 0 || !parts[idx + 1] || !parts[idx + 2]) return null;
    return { projectId: parts[idx + 1], hookId: parts[idx + 2] };
  } catch { return null; }
}

const hookMeta = parseVercelHook();

function vercelHeaders() {
  return { Authorization: `Bearer ${VERCEL_TOKEN}` };
}

async function triggerVercelHook() {
  if (!VERCEL_HOOK) throw new Error('VERCEL_HOOK belum diatur.');
  const r = await api.post(VERCEL_HOOK, null, { headers: { 'User-Agent': 'Cloud-Logic-Raven-Bot/2.0' } });
  return { job: r.data?.job || null, createdAt: r.data?.job?.createdAt || Date.now() };
}

async function listVercelDeployments(since = undefined) {
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN belum diatur.');
  if (!hookMeta?.projectId) throw new Error('VERCEL_HOOK tidak valid.');
  const params = { projectId: hookMeta.projectId, limit: 20 };
  if (since) params.since = since;
  const r = await api.get('https://api.vercel.com/v6/deployments', { params, headers: vercelHeaders() });
  return r.data?.deployments || [];
}

async function waitForDeployment(since, hookId, onProgress) {
  const started = Date.now();
  let lastState = '';
  for (let i = 0; i < 30; i++) {
    const deployments = await listVercelDeployments(Math.max(0, since - 3_000));
    const candidate = deployments
      .filter(d => !hookId || d?.meta?.deployHookId === hookId || d?.createdAt >= since)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

    if (candidate) {
      const state = candidate.readyState || candidate.state || 'BUILDING';
      if (state !== lastState) {
        lastState = state;
        await onProgress?.(candidate);
      }
      if (['READY', 'ERROR', 'CANCELED'].includes(state)) return candidate;
    }

    if (Date.now() - started > 120_000) break;
    await new Promise(r => setTimeout(r, 4_000));
  }
  return null;
}

async function getDeployment(idOrUrl) {
  const r = await api.get(`https://api.vercel.com/v13/deployments/${encodeURIComponent(idOrUrl)}`, { headers: vercelHeaders() });
  return r.data;
}

async function deleteDeployment(id) {
  const r = await api.delete(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`, { headers: vercelHeaders() });
  return r.data;
}

function errorText(e) {
  const data = e?.response?.data;
  if (data?.error?.message) return data.error.message;
  if (typeof data === 'string') return data.slice(0, 500);
  return e?.message || 'Terjadi kesalahan.';
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Deploy HTML', 'deploy_html'), Markup.button.callback('📦 Deploy ZIP', 'deploy_zip')],
    [Markup.button.callback('🌐 Get Source', 'get_source'), Markup.button.callback('🛡 Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🗑 Delete Web', 'delete_web'), Markup.button.callback('📡 System', 'system')],
    [Markup.button.callback('👤 Add User', 'add_user')]
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'home')]]);
}

function statusKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠 Main Menu', 'home')]]);
}

async function safeDelete(ctx, messageId) {
  if (!messageId) return;
  try { await ctx.telegram.deleteMessage(ctx.chat.id, messageId); } catch (_) {}
}

async function showPanel(ctx, text, keyboard = mainKeyboard(), options = {}) {
  const chatId = ctx.chat?.id;
  const prev = panelMessage.get(uid(ctx));
  if (options.deletePrevious) await safeDelete(ctx, prev);

  let sent;
  try {
    if (ctx.callbackQuery?.message) {
      sent = await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } else if (prev && options.editPrevious !== false) {
      sent = await ctx.telegram.editMessageText(chatId, prev, undefined, text, { parse_mode: 'HTML', ...keyboard });
    }
  } catch (_) {}

  if (!sent) sent = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  panelMessage.set(uid(ctx), sent.message_id || prev);
  return sent;
}

async function prompt(ctx, kind, text, keyboard = backKeyboard()) {
  sessions.set(uid(ctx), { kind });
  const prev = panelMessage.get(uid(ctx));
  await safeDelete(ctx, prev);
  const m = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  panelMessage.set(uid(ctx), m.message_id);
  return m;
}

function resetSession(id) { sessions.delete(id); }

async function handleHome(ctx) {
  resetSession(uid(ctx));
  return showPanel(ctx,
`<b>☁️ CLOUD LOGIC</b>
<blockquote>RAVEN • PROFESSIONAL DEPLOY CENTER</blockquote>

<b>⚡ Control Panel</b>
🚀 Deploy website to GitHub → Vercel
🌐 Mirror public source resources to ZIP
🛡 Protect HTML with password encryption
🗑 Remove a deployment from Vercel

<b>● Status:</b> ONLINE`, mainKeyboard());
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    if (await authorized(ctx)) return next();
    // Do not respond to unauthorized users at all.
    return;
  } catch (e) {
    console.error('AUTH ERROR:', errorText(e));
    return;
  }
});

bot.start(async ctx => handleHome(ctx));
bot.command('menu', async ctx => handleHome(ctx));

bot.action('home', async ctx => { await ctx.answerCbQuery(); return handleHome(ctx); });

bot.action('system', async ctx => {
  await ctx.answerCbQuery();
  const checks = [];
  for (const [name, ok] of [
    ['Telegram', !!BOT_TOKEN], ['GitHub Token', !!GITHUB_TOKEN], ['Vercel Token', !!VERCEL_TOKEN], ['Vercel Hook', !!VERCEL_HOOK]
  ]) checks.push(`${ok ? '🟢' : '🔴'} ${name}`);
  let gh = '⚪ Belum dicek', vc = '⚪ Belum dicek';
  try { await githubGet(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`); gh = '🟢 GitHub API'; } catch (e) { gh = `🔴 GitHub API: ${escapeHtml(errorText(e).slice(0, 80))}`; }
  try { if (hookMeta?.projectId) { await listVercelDeployments(Date.now() - 86_400_000); vc = '🟢 Vercel API'; } } catch (e) { vc = `🔴 Vercel API: ${escapeHtml(errorText(e).slice(0, 80))}`; }
  checks.push(gh, vc);
  return showPanel(ctx, `<b>📡 SYSTEM STATUS</b>\n\n${checks.join('\n')}\n\n<b>Repository</b>\n${escapeHtml(GITHUB_OWNER)}/${escapeHtml(GITHUB_REPO)}\nBranch: <code>${escapeHtml(GITHUB_BRANCH)}</code>`, statusKeyboard());
});

bot.action('deploy_html', async ctx => {
  await ctx.answerCbQuery();
  return prompt(ctx, 'deploy_html_file', `<b>🚀 DEPLOY HTML</b>\n\nKirim file <code>.html</code> sekarang.\n\n<b>Batas:</b> ${MAX_HTML_MB} MB\n<b>Berikutnya:</b> pilih nama website tanpa spasi.`);
});

bot.action('deploy_zip', async ctx => {
  await ctx.answerCbQuery();
  return prompt(ctx, 'deploy_zip_file', `<b>📦 DEPLOY ZIP</b>\n\nKirim <code>.zip</code> berisi website.\nPastikan terdapat <code>index.html</code> di root atau di dalam satu folder utama.`);
});

bot.action('get_source', async ctx => {
  await ctx.answerCbQuery();
  return prompt(ctx, 'get_source_url', `<b>🌐 GET SOURCE</b>\n\nKirim URL publik, contoh:\n<code>https://example.com</code>\n\nBot akan mencoba membundel HTML, stylesheet, JavaScript, gambar, font, media, dan resource publik yang direferensikan ke dalam ZIP.`);
});

bot.action('encrypt_html', async ctx => {
  await ctx.answerCbQuery();
  return prompt(ctx, 'encrypt_html_file', `<b>🛡 ENCRYPT HTML</b>\n\nKirim file <code>.html</code>. Setelah itu bot akan meminta password dan mengirimkan HTML terenkripsi yang hanya membuka konten setelah password benar.`);
});

bot.action('delete_web', async ctx => {
  await ctx.answerCbQuery();
  const current = latestDeployments.get(uid(ctx));
  let d = current;
  try {
    if (!d) {
      const list = await listVercelDeployments();
      d = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    }
  } catch (e) {
    return showPanel(ctx, `<b>🗑 DELETE WEB</b>\n\n❌ Gagal membaca deployment.\n<code>${escapeHtml(errorText(e))}</code>`, statusKeyboard());
  }
  if (!d?.id) return showPanel(ctx, `<b>🗑 DELETE WEB</b>\n\nTidak ada deployment yang terdeteksi.`, statusKeyboard());
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ CONFIRM DELETE', `confirm_delete:${d.id}`)],
    [Markup.button.callback('❌ CANCEL', 'home')]
  ]);
  return showPanel(ctx, `<b>🗑 DELETE WEB</b>\n\n<b>${escapeHtml(d.name || 'deployment')}</b>\n🌐 ${escapeHtml(d.url || 'unknown')}\n🆔 <code>${escapeHtml(d.id)}</code>\n\nTindakan ini menghapus deployment Vercel tersebut.`, kb);
});

bot.action(/^confirm_delete:(.+)$/, async ctx => {
  await ctx.answerCbQuery('Menghapus deployment…');
  try {
    await deleteDeployment(ctx.match[1]);
    latestDeployments.delete(uid(ctx));
    return showPanel(ctx, `<b>✅ DEPLOYMENT DELETED</b>\n\n🗑 Deployment berhasil dihapus dari Vercel.`, statusKeyboard());
  } catch (e) {
    return showPanel(ctx, `<b>❌ DELETE FAILED</b>\n\n<code>${escapeHtml(errorText(e))}</code>`, statusKeyboard());
  }
});

bot.action('add_user', async ctx => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return showPanel(ctx, '⛔ <b>Owner only.</b>', backKeyboard());
  return prompt(ctx, 'add_user', `<b>👤 ADD USER</b>\n\nKirim Telegram numeric ID user.\nContoh: <code>123456789</code>`);
});

async function processDeploy(ctx, kind, buffer, originalName) {
  const userId = uid(ctx);
  const stateMsg = await showPanel(ctx, `<b>⏳ PREPARING DEPLOY</b>\n\n📦 ${escapeHtml(originalName)}\n⚙️ Validating project…\n\n<i>Mohon tunggu.</i>`, statusKeyboard(), { deletePrevious: true });

  let files;
  if (kind === 'html') {
    files = { 'index.html': buffer };
  } else {
    const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: true });
    files = {};
    const entries = Object.values(zip.files).filter(x => !x.dir);
    for (const entry of entries) {
      const p = normalizeRepoPath(entry.name);
      if (p.startsWith('__MACOSX/') || p.includes('/.DS_Store')) continue;
      if (p.split('/').length > 8) throw new Error('ZIP folder nesting terlalu dalam.');
      const data = await entry.async('nodebuffer');
      if (data.length > MAX_SOURCE_FILE_MB * 1024 * 1024) throw new Error(`File dalam ZIP terlalu besar: ${p}`);
      files[p] = data;
    }
    if (!files['index.html']) {
      const indexKey = Object.keys(files).find(k => k.toLowerCase().endsWith('/index.html'));
      if (indexKey) {
        const prefix = indexKey.slice(0, -'index.html'.length);
        const moved = {};
        for (const [k, v] of Object.entries(files)) moved[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
        files = moved;
      }
    }
    if (!files['index.html']) throw new Error('ZIP harus memiliki index.html di root atau satu folder utama.');
  }

  await ctx.telegram.editMessageText(ctx.chat.id, stateMsg.message_id, undefined,
    `<b>⬆️ GITHUB UPDATE</b>\n\n📁 Files: <code>${Object.keys(files).length}</code>\n🔗 ${escapeHtml(GITHUB_OWNER)}/${escapeHtml(GITHUB_REPO)}\n🌿 <code>${escapeHtml(GITHUB_BRANCH)}</code>\n\n<i>Creating one Git commit…</i>`,
    { parse_mode: 'HTML' });

  const commit = await deployToGithub(files, `Cloud Logic deploy: ${originalName}`);

  await ctx.telegram.editMessageText(ctx.chat.id, stateMsg.message_id, undefined,
    `<b>⚡ VERCEL TRIGGER</b>\n\n✅ GitHub commit created\n<code>${commit.commitSha.slice(0, 12)}</code>\n\n🚀 Triggering Vercel…`,
    { parse_mode: 'HTML' });

  const hook = await triggerVercelHook();
  const deployment = await waitForDeployment(hook.createdAt || Date.now(), hookMeta?.hookId, async d => {
    const state = d?.readyState || d?.state || 'BUILDING';
    const line = state === 'READY' ? '🟢 READY' : state === 'ERROR' ? '🔴 ERROR' : state === 'CANCELED' ? '⚪ CANCELED' : '🟡 BUILDING';
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, stateMsg.message_id, undefined,
        `<b>🚀 VERCEL DEPLOY</b>\n\n${line}\n🌐 ${escapeHtml(d?.url || 'waiting…')}\n🆔 <code>${escapeHtml(d?.id || '-')}</code>`,
        { parse_mode: 'HTML' });
    } catch (_) {}
  });

  if (!deployment) {
    return ctx.telegram.editMessageText(ctx.chat.id, stateMsg.message_id, undefined,
      `<b>⚠️ DEPLOY TRIGGERED</b>\n\nGitHub update berhasil dan Vercel menerima trigger, tetapi status deployment belum dapat dibaca dalam batas waktu. Cek Vercel Deployments.`,
      { parse_mode: 'HTML', reply_markup: statusKeyboard().reply_markup });
  }

  latestDeployments.set(userId, {
    id: deployment.id,
    url: deployment.url ? `https://${deployment.url}` : (deployment.alias?.[0] || null),
    name: deployment.name || originalName,
    createdAt: deployment.createdAt
  });

  const finalState = deployment.readyState || deployment.state;
  const ok = finalState === 'READY';
  const resultText = ok
    ? `<b>✅ DEPLOY SUCCESS</b>\n\n🌐 <a href="https://${escapeHtml(deployment.url)}">Open Website</a>\n🔗 <code>https://${escapeHtml(deployment.url)}</code>\n🆔 <code>${escapeHtml(deployment.id)}</code>\n📁 Files: <code>${Object.keys(files).length}</code>\n⚡ Status: <b>READY</b>`
    : `<b>❌ DEPLOY FAILED</b>\n\n🆔 <code>${escapeHtml(deployment.id)}</code>\n⚡ Status: <b>${escapeHtml(finalState || 'ERROR')}</b>`;

  return ctx.telegram.editMessageText(ctx.chat.id, stateMsg.message_id, undefined, resultText, {
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: Markup.inlineKeyboard([
      ...(ok && deployment.url ? [[Markup.button.url('🌐 OPEN WEBSITE', `https://${deployment.url}`)]] : []),
      [Markup.button.callback('🗑 DELETE', 'delete_web'), Markup.button.callback('🏠 MAIN MENU', 'home')]
    ]).reply_markup
  });
}

async function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.some(x => isPrivateIp(x.address));
  } catch {
    return true;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a,b,c,d] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:') || x === '::';
}

function extractResourceUrls(html, baseUrl) {
  const out = new Set();
  const add = raw => {
    if (!raw || raw.startsWith('#') || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return;
    try { out.add(new URL(raw, baseUrl).href); } catch (_) {}
  };
  for (const m of html.matchAll(/(?:src|href|poster|data-src|data-href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/url\((?:\s*["']?)([^)"']+)(?:["']?\s*)\)/gi)) add(m[1]);
  return [...out];
}

function localResourceName(url, type, seen) {
  const u = new URL(url);
  let base = decodeURIComponent(path.posix.basename(u.pathname)) || 'resource';
  base = safeFilename(base, 'resource');
  const ext = path.posix.extname(base);
  if (type === 'css' && ext !== '.css') base += '.css';
  if (type === 'js' && !['.js', '.mjs'].includes(ext)) base += '.js';
  const folder = type === 'css' ? 'css' : type === 'js' ? 'js' : 'assets';
  let candidate = `${folder}/${base}`;
  let n = 2;
  while (seen.has(candidate)) {
    const stem = ext ? base.slice(0, -ext.length) : base;
    candidate = `${folder}/${stem}-${n++}${ext || ''}`;
  }
  seen.add(candidate);
  return candidate;
}

async function fetchPublicResource(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP/HTTPS resources are allowed.');
  if (await isPrivateHost(u.hostname)) throw new Error('Private/local hosts are blocked.');
  const r = await api.get(url, { responseType: 'arraybuffer', maxContentLength: MAX_SOURCE_FILE_MB * 1024 * 1024, maxBodyLength: MAX_SOURCE_FILE_MB * 1024 * 1024 });
  return { url, headers: r.headers, data: Buffer.from(r.data) };
}

async function buildSourceZip(targetUrl) {
  const first = await fetchPublicResource(targetUrl);
  const contentType = String(first.headers['content-type'] || '').toLowerCase();
  const html = first.data.toString('utf8');
  if (!contentType.includes('text/html') && !/<html[\s>]/i.test(html)) throw new Error('URL tidak mengembalikan HTML yang dapat diproses.');

  const zip = new JSZip();
  const files = new Map();
  const seenPaths = new Set(['index.html']);
  const urlToPath = new Map([[targetUrl, 'index.html']]);
  const queue = extractResourceUrls(html, targetUrl).slice(0, MAX_SOURCE_RESOURCES);
  let total = first.data.length;

  files.set('index.html', html);

  const maxQueue = Math.min(queue.length, MAX_SOURCE_RESOURCES);
  for (let i = 0; i < maxQueue; i++) {
    const url = queue[i];
    if (urlToPath.has(url)) continue;
    let r;
    try { r = await fetchPublicResource(url); } catch (_) { continue; }
    total += r.data.length;
    if (total > MAX_SOURCE_TOTAL_MB * 1024 * 1024) break;
    const ct = String(r.headers['content-type'] || '').toLowerCase();
    const type = ct.includes('text/css') || /\.css(?:$|\?)/i.test(url) ? 'css' : ct.includes('javascript') || /\.(?:js|mjs)(?:$|\?)/i.test(url) ? 'js' : 'asset';
    const local = localResourceName(url, type, seenPaths);
    urlToPath.set(url, local);
    files.set(local, ct.includes('text/') || type === 'css' || type === 'js' ? r.data.toString('utf8') : r.data);

    if (type === 'css') {
      const cssText = r.data.toString('utf8');
      for (const m of cssText.matchAll(/url\(\s*["']?([^\)"']+)["']?\s*\)/gi)) {
        try {
          const u2 = new URL(m[1], url).href;
          if (!urlToPath.has(u2) && queue.length < MAX_SOURCE_RESOURCES) queue.push(u2);
        } catch (_) {}
      }
    }
  }

  // Rewrite common HTML references to local files.
  let outHtml = html;
  for (const [remote, local] of urlToPath.entries()) {
    if (remote === targetUrl) continue;
    outHtml = outHtml.split(remote).join(local);
  }
  files.set('index.html', outHtml);

  for (const [name, content] of files.entries()) zip.file(name, content);
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return archive;
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 310_000, 32, 'sha256');
}

function encryptHtmlDocument(html, password) {
  if (!html.includes('<html') && !html.includes('<!doctype')) throw new Error('File HTML tidak valid.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(html, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = x => x.toString('base64');

  const safe = JSON.stringify({ salt: b64(salt), iv: b64(iv), tag: b64(tag), data: b64(encrypted) });
  const loader = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected Page</title><style>body{margin:0;background:#08090c;color:#f6f7fb;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(92vw,420px);padding:28px;border:1px solid #2b2e36;border-radius:22px;background:#111318;box-shadow:0 20px 70px #0008}h1{margin:0 0 8px;font-size:22px}p{opacity:.7;line-height:1.5}input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #333845;background:#0b0d11;color:#fff;margin-top:10px}button{cursor:pointer;background:#fff;color:#111;border:0;font-weight:700}#e{color:#ff7b87;margin-top:10px;min-height:1.2em}</style></head><body><div class="card"><h1>🔒 Protected HTML</h1><p>Masukkan password untuk membuka halaman.</p><input id="p" type="password" autocomplete="off" placeholder="Password"><button id="b">BUKA HALAMAN</button><div id="e"></div></div><script>(async()=>{const B=${safe};const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const dec=new TextDecoder();document.getElementById('b').onclick=async()=>{const p=document.getElementById('p').value;const e=document.getElementById('e');e.textContent='';try{const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(p),{name:'PBKDF2'},false,['deriveKey']);const k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(B.salt),iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['decrypt']);const packed=new Uint8Array(b64(B.data).length+b64(B.tag).length);packed.set(b64(B.data),0);packed.set(b64(B.tag),b64(B.data).length);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(B.iv),tagLength:128},k,packed);document.open();document.write(dec.decode(plain));document.close()}catch(_){e.textContent='Password salah atau data rusak.'}}})();</script></body></html>`;
  return loader;
}

async function readTelegramFile(ctx, doc) {
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const r = await api.get(link.href, { responseType: 'arraybuffer', maxContentLength: MAX_UPLOAD_BYTES, maxBodyLength: MAX_UPLOAD_BYTES });
  return Buffer.from(r.data);
}

async function finishSession(ctx, kind, text) {
  const s = sessions.get(uid(ctx));
  if (!s || s.kind !== kind) return false;
  resetSession(uid(ctx));
  await safeDelete(ctx, panelMessage.get(uid(ctx)));
  const m = await ctx.reply(text, { parse_mode: 'HTML', ...mainKeyboard() });
  panelMessage.set(uid(ctx), m.message_id);
  return true;
}

bot.on('document', async ctx => {
  const id = uid(ctx);
  const s = sessions.get(id);
  if (!s) return;
  const doc = ctx.message.document;
  const name = String(doc.file_name || '').toLowerCase();
  try {
    const size = Number(doc.file_size || 0);
    if (size > MAX_UPLOAD_BYTES) throw new Error('Ukuran file melebihi batas 100 MB.');

    if (s.kind === 'deploy_html_file') {
      if (!name.endsWith('.html') && !name.endsWith('.htm')) throw new Error(`File harus .html. Maksimal ${MAX_HTML_MB} MB.`);
      if (size > MAX_HTML_MB * 1024 * 1024) throw new Error(`HTML maksimal ${MAX_HTML_MB} MB.`);
      const buffer = await readTelegramFile(ctx, doc);
      sessions.set(id, { kind: 'deploy_html_name', buffer });
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply(`<b>📌 NAMA WEBSITE</b>\n\nKirim nama website <b>tanpa spasi</b>.\nContoh: <code>cloudx-ai</code>`, { parse_mode: 'HTML', ...backKeyboard() });
      panelMessage.set(id, m.message_id);
      return;
    }

    if (s.kind === 'deploy_zip_file') {
      if (!name.endsWith('.zip')) throw new Error('File harus .zip.');
      if (size > MAX_ZIP_MB * 1024 * 1024) throw new Error(`ZIP maksimal ${MAX_ZIP_MB} MB.`);
      const buffer = await readTelegramFile(ctx, doc);
      resetSession(id);
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply('⏳ <b>ZIP diterima.</b>\nMemulai proses deploy…', { parse_mode: 'HTML' });
      panelMessage.set(id, m.message_id);
      try { await processDeploy(ctx, 'zip', buffer, doc.file_name || 'website.zip'); }
      catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, `<b>❌ DEPLOY GAGAL</b>\n\n<code>${escapeHtml(errorText(e))}</code>`, { parse_mode: 'HTML', reply_markup: mainKeyboard().reply_markup }); }
      return;
    }

    if (s.kind === 'encrypt_html_file') {
      if (!name.endsWith('.html') && !name.endsWith('.htm')) throw new Error('File harus .html.');
      if (size > MAX_HTML_MB * 1024 * 1024) throw new Error(`HTML maksimal ${MAX_HTML_MB} MB.`);
      const buffer = await readTelegramFile(ctx, doc);
      sessions.set(id, { kind: 'encrypt_html_password', buffer, originalName: safeFilename(doc.file_name, 'index.html') });
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply(`<b>🔐 PASSWORD ENCRYPTION</b>\n\nKirim password minimal <b>8 karakter</b>.`, { parse_mode: 'HTML', ...backKeyboard() });
      panelMessage.set(id, m.message_id);
      return;
    }
  } catch (e) {
    resetSession(id);
    await safeDelete(ctx, panelMessage.get(id));
    const m = await ctx.reply(`❌ <b>${escapeHtml(errorText(e))}</b>`, { parse_mode: 'HTML', ...mainKeyboard() });
    panelMessage.set(id, m.message_id);
  }
});

bot.on('text', async ctx => {
  const id = uid(ctx);
  const s = sessions.get(id);
  if (!s) return;
  const text = String(ctx.message.text || '').trim();

  try {
    if (s.kind === 'deploy_html_name') {
      if (!siteNameValid(text)) throw new Error('Nama hanya boleh berisi huruf kecil, angka, dan tanda minus. Contoh: cloudx-ai.');
      resetSession(id);
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply('⏳ <b>Membuat deployment…</b>', { parse_mode: 'HTML' });
      panelMessage.set(id, m.message_id);
      try { await processDeploy(ctx, 'html', s.buffer, `${text}.html`); }
      catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, `<b>❌ DEPLOY GAGAL</b>\n\n<code>${escapeHtml(errorText(e))}</code>`, { parse_mode: 'HTML', reply_markup: mainKeyboard().reply_markup }); }
      return;
    }

    if (s.kind === 'get_source_url') {
      if (!/^https?:\/\//i.test(text)) throw new Error('URL harus dimulai dengan http:// atau https://');
      resetSession(id);
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply('🌐 <b>GET SOURCE</b>\n\n⏳ Mengambil resource publik dan membuat ZIP…', { parse_mode: 'HTML' });
      panelMessage.set(id, m.message_id);
      const zip = await buildSourceZip(text);
      await ctx.telegram.sendDocument(ctx.chat.id, { source: zip, filename: 'source-bundle.zip' }, { caption: '✅ <b>Source bundle selesai.</b>\nHTML + CSS + JavaScript + resource publik yang berhasil diambil.', parse_mode: 'HTML' });
      await safeDelete(ctx, m.message_id);
      return handleHome(ctx);
    }

    if (s.kind === 'encrypt_html_password') {
      if (text.length < 8) throw new Error('Password minimal 8 karakter.');
      resetSession(id);
      const file = s.buffer.toString('utf8');
      const encrypted = encryptHtmlDocument(file, text);
      await safeDelete(ctx, panelMessage.get(id));
      await ctx.replyWithDocument({ source: Buffer.from(encrypted), filename: `encrypted-${safeFilename(s.originalName, 'index.html')}` }, { caption: '✅ <b>HTML encrypted.</b> Password diperlukan saat halaman dibuka.', parse_mode: 'HTML' });
      return handleHome(ctx);
    }

    if (s.kind === 'add_user') {
      if (!isOwner(ctx)) throw new Error('Owner only.');
      const newId = Number(text);
      if (!Number.isInteger(newId) || newId <= 0) throw new Error('ID Telegram tidak valid.');
      users.add(newId);
      await persistAuthorizedUser(newId);
      resetSession(id);
      await safeDelete(ctx, panelMessage.get(id));
      const m = await ctx.reply(`✅ <b>User ditambahkan.</b>\nID: <code>${newId}</code>\n\nCatatan: daftar user runtime dapat reset saat Vercel cold start. Untuk persistensi permanen, gunakan storage eksternal.`, { parse_mode: 'HTML', ...mainKeyboard() });
      panelMessage.set(id, m.message_id);
      return;
    }
  } catch (e) {
    resetSession(id);
    await safeDelete(ctx, panelMessage.get(id));
    const m = await ctx.reply(`❌ <b>${escapeHtml(errorText(e))}</b>`, { parse_mode: 'HTML', ...mainKeyboard() });
    panelMessage.set(id, m.message_id);
  }
});

// Gracefully keep polling/webhook update errors from killing the process.
bot.catch(err => console.error('BOT ERROR:', err));

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('CLOUD LOGIC RAVEN ONLINE');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    await bot.handleUpdate(req.body || {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('WEBHOOK ERROR:', e);
    return res.status(500).json({ ok: false, error: 'Internal webhook error' });
  }
};
