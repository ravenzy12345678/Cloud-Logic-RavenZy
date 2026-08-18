'use strict';

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const crypto = require('crypto');
const dns = require('dns').promises;

const env = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

const BOT_TOKEN = env('BOT_TOKEN', 'TOKEN_BOT');
const OWNER_ID = Number(env('OWNER_ID', 'ID_PEMILIK'));
const GITHUB_TOKEN = env('GITHUB_TOKEN', 'TOKEN_GITHUB');
const GITHUB_OWNER = env('GITHUB_OWNER', 'PEMILIK_GITHUB');
const GITHUB_REPO = env('GITHUB_REPO', 'REPO_GITHUB');
const GITHUB_BRANCH = env('GITHUB_BRANCH', 'CABANG_GITHUB') || 'main';
const VERCEL_HOOK = env('VERCEL_HOOK');
const VERCEL_TOKEN = env('VERCEL_TOKEN');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN/TOKEN_BOT belum diatur.');
if (!OWNER_ID) throw new Error('OWNER_ID/ID_PEMILIK belum diatur.');
if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) throw new Error('Konfigurasi GitHub belum lengkap.');

const bot = new Telegraf(BOT_TOKEN);
const statePath = '.cloud-logic-state.enc';
const manifestPath = '.cloud-logic-manifest.json';
const STATE_SECRET = env('STATE_SECRET') || crypto.createHash('sha256').update(`${BOT_TOKEN}:${VERCEL_TOKEN}`).digest('hex');

const http = axios.create({ timeout: 30000, maxContentLength: 120 * 1024 * 1024, maxBodyLength: 120 * 1024 * 1024, validateStatus: s => s >= 200 && s < 400 });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function esc(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function safeName(name) { return String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48); }
function isOwner(id) { return Number(id) === OWNER_ID; }
function stateKey() { return crypto.createHash('sha256').update(STATE_SECRET).digest(); }
function encryptState(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(), iv);
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decryptState(value) {
  try {
    const buf = Buffer.from(value, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

async function ghRequest(method, path, data) {
  return http.request({
    method,
    url: `https://api.github.com${path}`,
    data,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Cloud-Logic-Raven-Bot'
    }
  });
}

async function githubGetFile(path) {
  try {
    const r = await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/') }?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    if (r.status !== 200 || !r.data || !r.data.content) return null;
    return { sha: r.data.sha, content: Buffer.from(String(r.data.content).replace(/\n/g, ''), 'base64') };
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

async function githubPutFile(path, buffer, message) {
  const current = await githubGetFile(path);
  const body = {
    message,
    content: Buffer.from(buffer).toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (current?.sha) body.sha = current.sha;
  await ghRequest('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, body);
}

async function githubReadJson(path, fallback) {
  const file = await githubGetFile(path);
  if (!file) return fallback;
  try { return JSON.parse(file.content.toString('utf8')); } catch { return fallback; }
}

async function githubWriteJson(path, value, message) {
  await githubPutFile(path, Buffer.from(JSON.stringify(value), 'utf8'), message);
}

async function readState() {
  const file = await githubGetFile(statePath);
  if (!file) return { users: [], pending: {}, deployments: [] };
  return decryptState(file.content.toString('utf8')) || { users: [], pending: {}, deployments: [] };
}

async function writeState(state, message = 'Cloud Logic state update') {
  await githubPutFile(statePath, Buffer.from(encryptState(state), 'utf8'), message);
}

async function isAuthorized(userId) {
  if (isOwner(userId)) return true;
  const state = await readState();
  return state.users.includes(Number(userId));
}

async function getProjectId() {
  const match = VERCEL_HOOK.match(/\/integrations\/deploy\/(prj_[^/]+)\//);
  return match ? match[1] : '';
}

async function vercelRequest(method, path, data) {
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN belum diatur di Vercel.');
  return http.request({ method, url: `https://api.vercel.com${path}`, data, headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
}

async function getLatestDeployment() {
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Project ID Vercel tidak dapat dibaca dari VERCEL_HOOK.');
  const r = await vercelRequest('GET', `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=5`);
  const items = Array.isArray(r.data?.deployments) ? r.data.deployments : [];
  return items[0] || null;
}

async function getDeployment(id) {
  const r = await vercelRequest('GET', `/v13/deployments/${encodeURIComponent(id)}`);
  return r.data;
}

async function deleteDeployment(id) {
  await vercelRequest('DELETE', `/v13/deployments/${encodeURIComponent(id)}`);
}

async function triggerVercel() {
  if (!VERCEL_HOOK) throw new Error('VERCEL_HOOK belum diatur di Vercel.');
  await http.post(VERCEL_HOOK, null, { timeout: 30000, validateStatus: s => s >= 200 && s < 400 });
}

async function safeEdit(ctx, chatId, messageId, text, keyboard) {
  try {
    await ctx.telegram.editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML', ...keyboard });
    return true;
  } catch (error) {
    const description = error.response?.description || error.description || error.message || '';
    if (/message is not modified/i.test(description)) return true;
    return false;
  }
}

function mainKeyboard(owner = false) {
  const rows = [
    [Markup.button.callback('🚀 Deploy HTML', 'deploy_html'), Markup.button.callback('📦 Deploy ZIP', 'deploy_zip')],
    [Markup.button.callback('🌐 Get Source', 'get_source'), Markup.button.callback('🛡️ Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🗑️ Delete Web', 'delete_web'), Markup.button.callback('📡 System', 'system')]
  ];
  if (owner) rows.push([Markup.button.callback('👤 Add User', 'add_user'), Markup.button.callback('👥 Users', 'users')]);
  return Markup.inlineKeyboard(rows);
}

function backKeyboard(owner = false) { return Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'home')]]); }
function deployKeyboard() { return Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')], [Markup.button.callback('🏠 Menu Utama', 'home')]]); }

async function showPanel(ctx, text, keyboard = mainKeyboard(isOwner(ctx.from?.id)), target = null) {
  if (target) {
    const edited = await safeEdit(ctx, target.chatId, target.messageId, text, keyboard);
    if (edited) return { chatId: target.chatId, messageId: target.messageId };
    const msg = await ctx.telegram.sendMessage(target.chatId, text, { parse_mode: 'HTML', ...keyboard });
    return { chatId: msg.chat.id, messageId: msg.message_id };
  }
  if (ctx.callbackQuery?.message) {
    const edited = await safeEdit(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, keyboard);
    if (edited) return { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };
  }
  const msg = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  return { chatId: msg.chat.id, messageId: msg.message_id };
}

async function savePending(ctx, pending) {
  const state = await readState();
  state.pending[String(ctx.from.id)] = pending;
  await writeState(state, 'Cloud Logic pending action');
}

async function clearPending(userId) {
  const state = await readState();
  delete state.pending[String(userId)];
  await writeState(state, 'Cloud Logic clear pending action');
}

async function handleUnauthorized(ctx) {
  return;
}

bot.use(async (ctx, next) => {
  try {
    if (!ctx.from) return;
    if (!(await isAuthorized(ctx.from.id))) return handleUnauthorized(ctx);
    await next();
  } catch (error) {
    console.error('ACCESS_ERROR', error);
    return;
  }
});

bot.start(async (ctx) => {
  const owner = isOwner(ctx.from.id);
  await ctx.reply(
    `<b>☁️ CLOUD LOGIC — RAVEN</b>\n<blockquote>Premium Telegram Deploy Center</blockquote>\n\n🟢 <b>System:</b> Online\n🔐 <b>Access:</b> ${owner ? 'Owner' : 'Authorized User'}\n\nPilih fitur di bawah.`,
    { parse_mode: 'HTML', ...mainKeyboard(owner) }
  );
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();
  await showPanel(ctx, `<b>☁️ CLOUD LOGIC — RAVEN</b>\n<blockquote>Premium Telegram Deploy Center</blockquote>\n\n🟢 <b>System:</b> Online\n🔐 <b>Access:</b> ${isOwner(ctx.from.id) ? 'Owner' : 'Authorized User'}\n\nPilih fitur di bawah.`, mainKeyboard(isOwner(ctx.from.id)));
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery('Dibatalkan');
  await clearPending(ctx.from.id);
  await showPanel(ctx, '<b>❌ Proses dibatalkan.</b>\n\nKembali ke menu utama.', mainKeyboard(isOwner(ctx.from.id)));
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery();
  const target = { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id };
  await showPanel(ctx, '<b>📡 SYSTEM STATUS</b>\n\n⏳ Memeriksa koneksi...', backKeyboard());
  const result = { github: false, vercel: false, deployment: 'unknown' };
  try { await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`); result.github = true; } catch {}
  try {
    if (VERCEL_TOKEN) {
      const latest = await getLatestDeployment();
      result.vercel = true;
      result.deployment = latest?.readyState || 'none';
    }
  } catch {}
  const status = `<b>📡 SYSTEM STATUS</b>\n\n${result.github ? '🟢' : '🔴'} GitHub API\n${result.vercel ? '🟢' : '🔴'} Vercel API\n${result.deployment !== 'unknown' ? `⚡ Deployment: <b>${esc(result.deployment)}</b>` : '⚪ Deployment: unavailable'}\n\n🔐 Webhook: Active`;
  await showPanel(ctx, status, backKeyboard(), target);
});

bot.action('add_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx.from.id)) return;
  await showPanel(ctx, '<b>👤 ADD USER</b>\n\nKirim perintah berikut:\n<code>/adduser 123456789</code>\n\nUser akan disimpan secara terenkripsi di repository state bot.', backKeyboard(true));
});

bot.command('adduser', async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  const id = Number((ctx.message.text.split(/\s+/)[1] || '').trim());
  if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('<b>Format:</b> <code>/adduser 123456789</code>', { parse_mode: 'HTML' });
  const state = await readState();
  if (!state.users.includes(id)) state.users.push(id);
  await writeState(state, `Add authorized Telegram user ${id}`);
  await ctx.reply(`✅ <b>User ditambahkan</b>\n\nID: <code>${id}</code>\nStatus: <b>Authorized</b>`, { parse_mode: 'HTML' });
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx.from.id)) return;
  const state = await readState();
  const list = state.users.length ? state.users.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n') : 'Belum ada user tambahan.';
  await showPanel(ctx, `<b>👥 AUTHORIZED USERS</b>\n\n👑 Owner: <code>${OWNER_ID}</code>\n${esc(list)}`, backKeyboard(true));
});

bot.action('deploy_html', async (ctx) => {
  await ctx.answerCbQuery();
  const panel = await showPanel(ctx, '<b>🚀 DEPLOY HTML</b>\n\n1. Kirim file <code>.html</code>\n2. Setelah diterima, bot akan meminta nama project\n3. GitHub → Vercel akan dijalankan secara nyata.', deployKeyboard());
  await savePending(ctx, { mode: 'deploy_html', stage: 'file', panel, createdAt: Date.now() });
});

bot.action('deploy_zip', async (ctx) => {
  await ctx.answerCbQuery();
  const panel = await showPanel(ctx, '<b>📦 DEPLOY ZIP</b>\n\nKirim file <code>.zip</code> berisi project website.\n\nBot akan extract, validasi <code>index.html</code>, update GitHub, lalu trigger Vercel.', deployKeyboard());
  await savePending(ctx, { mode: 'deploy_zip', stage: 'file', panel, createdAt: Date.now() });
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  const panel = await showPanel(ctx, '<b>🌐 GET SOURCE</b>\n\nKirim URL website publik, contoh:\n<code>https://example.com</code>\n\nBot akan mengambil HTML + CSS + JavaScript + asset publik yang dapat diakses.', deployKeyboard());
  await savePending(ctx, { mode: 'get_source', stage: 'url', panel, createdAt: Date.now() });
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  const panel = await showPanel(ctx, '<b>🛡️ ENCRYPT HTML</b>\n\nKirim file <code>.html</code>. Setelah itu bot akan meminta password untuk membuka hasil.', deployKeyboard());
  await savePending(ctx, { mode: 'encrypt_html', stage: 'file', panel, createdAt: Date.now() });
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  if (!VERCEL_TOKEN) return showPanel(ctx, '<b>🗑️ DELETE WEB</b>\n\n❌ <code>VERCEL_TOKEN</code> belum tersedia.', backKeyboard());
  try {
    const latest = await getLatestDeployment();
    if (!latest) return showPanel(ctx, '<b>🗑️ DELETE WEB</b>\n\nTidak ada deployment yang ditemukan.', backKeyboard());
    const text = `<b>🗑️ DELETE WEB</b>\n\n🌐 <code>${esc(latest.url || latest.name || latest.id)}</code>\n⚡ Status: <b>${esc(latest.readyState || 'UNKNOWN')}</b>\n\nHapus deployment terbaru?`;
    await safeEdit(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Hapus', `confirm_delete:${latest.id}`)], [Markup.button.callback('❌ Batal', 'home')]]) });
  } catch (error) {
    await showPanel(ctx, `<b>🗑️ DELETE WEB</b>\n\n❌ ${esc(error.message)}`, backKeyboard());
  }
});

bot.action(/^confirm_delete:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Menghapus...');
  const id = ctx.match[1];
  try {
    await deleteDeployment(id);
    const state = await readState();
    state.deployments = state.deployments.filter(d => d.id !== id);
    await writeState(state, `Delete Vercel deployment ${id}`);
    await showPanel(ctx, `<b>✅ DEPLOYMENT DIHAPUS</b>\n\nID: <code>${esc(id)}</code>`, backKeyboard());
  } catch (error) {
    await showPanel(ctx, `<b>❌ DELETE GAGAL</b>\n\n${esc(error.response?.data?.error?.message || error.message)}`, backKeyboard());
  }
});

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const r = await http.get(link.href, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(r.data);
}

function normalizeZipPath(p) {
  const normalized = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized === '.' || normalized.includes('\\0')) return '';
  if (/^\.git(?:\/|$)/i.test(normalized) || normalized.startsWith('.vercel/')) return '';
  return normalized.split('/').filter(Boolean).join('/');
}

async function buildDeployFiles(mode, buffer, filename) {
  const files = [];
  if (mode === 'deploy_html') {
    const name = filename.toLowerCase() === 'index.html' ? 'index.html' : 'index.html';
    files.push({ path: name, buffer });
    return files;
  }
  const zip = await JSZip.loadAsync(buffer);
  const candidates = [];
  for (const [rawPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const path = normalizeZipPath(rawPath);
    if (!path) continue;
    const data = await entry.async('nodebuffer');
    files.push({ path, buffer: data });
    candidates.push(path);
  }
  if (!files.length) throw new Error('ZIP kosong atau tidak berisi file yang dapat digunakan.');
  const hasRootIndex = files.some(f => f.path.toLowerCase() === 'index.html');
  if (!hasRootIndex) {
    const index = files.find(f => /^index\.html$/i.test(f.path.split('/').pop() || '') || /\.html$/i.test(f.path));
    if (!index) throw new Error('ZIP harus memiliki index.html atau minimal satu file HTML.');
    const topLevel = files.find(f => f.path === index.path);
    if (topLevel) topLevel.path = 'index.html';
  }
  return files;
}

async function getManifest() { return githubReadJson(manifestPath, { files: [] }); }

async function commitDeployment(files, siteName) {
  const ref = await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`);
  const baseCommit = ref.data.object.sha;
  const commitInfo = await ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${baseCommit}`);
  const baseTree = commitInfo.data.tree.sha;
  const oldManifest = await getManifest();

  const blobs = await Promise.all(files.map(async file => {
    const r = await ghRequest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, {
      content: file.buffer.toString('base64'), encoding: 'base64'
    });
    return { path: file.path, sha: r.data.sha };
  }));

  const tree = [
    ...oldManifest.files.filter(path => !blobs.some(b => b.path === path)).map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
    ...blobs.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    { path: manifestPath, mode: '100644', type: 'blob', content: JSON.stringify({ siteName, files: blobs.map(b => b.path), updatedAt: new Date().toISOString() }) }
  ];

  const treeResp = await ghRequest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, { base_tree: baseTree, tree });
  const commitResp = await ghRequest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
    message: `Cloud Logic Deploy: ${siteName}`,
    tree: treeResp.data.sha,
    parents: [baseCommit]
  });
  await ghRequest('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`, { sha: commitResp.data.sha, force: false });
  return { commitSha: commitResp.data.sha, files: blobs.map(b => b.path) };
}

async function deployAndReturn(ctx, pending, siteName, buffer) {
  const panel = pending.panel;
  await showPanel(ctx, '<b>🚀 DEPLOY PROCESS</b>\n\n⏳ 1/4 Membaca project...', backKeyboard(), panel);
  const files = await buildDeployFiles(pending.mode, buffer, pending.filename);
  await showPanel(ctx, `<b>🚀 DEPLOY PROCESS</b>\n\n✅ 1/4 Project valid\n⏳ 2/4 Upload ke GitHub...`, backKeyboard(), panel);
  const gh = await commitDeployment(files, siteName);
  await showPanel(ctx, `<b>🚀 DEPLOY PROCESS</b>\n\n✅ 1/4 Project valid\n✅ 2/4 GitHub commit <code>${gh.commitSha.slice(0, 7)}</code>\n⏳ 3/4 Trigger Vercel...`, backKeyboard(), panel);
  await triggerVercel();

  let deployment = null;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    try {
      const latest = await getLatestDeployment();
      if (latest) {
        deployment = latest;
        if (['READY', 'ERROR', 'CANCELED'].includes(latest.readyState)) break;
      }
    } catch {}
  }

  const state = await readState();
  state.deployments.unshift({ id: deployment?.id || '', name: siteName, url: deployment?.url ? `https://${deployment.url}` : '', createdAt: Date.now(), status: deployment?.readyState || 'BUILDING' });
  state.deployments = state.deployments.slice(0, 25);
  await writeState(state, `Record deployment ${siteName}`);

  const url = deployment?.url ? `https://${deployment.url}` : '';
  if (deployment?.readyState === 'READY') {
    await showPanel(ctx, `<b>✅ DEPLOY SUCCESS</b>\n\n📦 <b>Project:</b> ${esc(siteName)}\n📂 <b>Files:</b> ${files.length}\n☁️ <b>GitHub:</b> committed\n⚡ <b>Vercel:</b> READY\n\n🌐 <b>Link:</b>\n<code>${esc(url)}</code>`, Markup.inlineKeyboard([[Markup.button.url('🌐 Buka Website', url)], [Markup.button.callback('🏠 Menu Utama', 'home')]]), panel);
  } else {
    await showPanel(ctx, `<b>⚡ DEPLOY TRIGGERED</b>\n\n📦 <b>Project:</b> ${esc(siteName)}\n☁️ GitHub: ✅\n⚡ Vercel: <b>${esc(deployment?.readyState || 'BUILDING')}</b>\n${url ? `\n🌐 <b>Deployment URL:</b>\n<code>${esc(url)}</code>` : ''}\n\nBuild masih dapat berlanjut di Vercel.`, url ? Markup.inlineKeyboard([[Markup.button.url('🌐 Buka Deployment', url)], [Markup.button.callback('🏠 Menu Utama', 'home')]]) : backKeyboard(), panel);
  }
}

async function handleDocument(ctx) {
  const state = await readState();
  const pending = state.pending[String(ctx.from.id)];
  if (!pending) return ctx.reply('Pilih fitur dari menu utama terlebih dahulu.', { ...mainKeyboard(isOwner(ctx.from.id)) });
  if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
    delete state.pending[String(ctx.from.id)];
    await writeState(state, 'Expire pending action');
    return ctx.reply('⏱️ Sesi sudah habis. Pilih menu lagi.', { ...mainKeyboard(isOwner(ctx.from.id)) });
  }

  const doc = ctx.message.document;
  const filename = doc.file_name || 'file';

  if ((pending.mode === 'deploy_html' || pending.mode === 'encrypt_html') && !/\.html?$/i.test(filename)) {
    return showPanel(ctx, '<b>❌ File tidak sesuai</b>\n\nFitur ini membutuhkan file HTML.', deployKeyboard(), pending.panel);
  }
  if (pending.mode === 'deploy_zip' && !/\.zip$/i.test(filename)) {
    return showPanel(ctx, '<b>❌ File tidak sesuai</b>\n\nFitur ini membutuhkan ZIP.', deployKeyboard(), pending.panel);
  }

  pending.fileId = doc.file_id;
  pending.filename = filename;
  pending.stage = pending.mode === 'get_source' ? 'url' : (pending.mode === 'encrypt_html' ? 'password' : 'name');
  state.pending[String(ctx.from.id)] = pending;
  await writeState(state, 'Save Telegram file state');

  if (pending.mode === 'encrypt_html') {
    return showPanel(ctx, '<b>🛡️ PASSWORD ENCRYPTION</b>\n\nFile diterima. Kirim password yang akan digunakan untuk membuka HTML hasil enkripsi.', deployKeyboard(), pending.panel);
  }
  await showPanel(ctx, `<b>📥 FILE DITERIMA</b>\n\n📄 <b>${esc(filename)}</b>\n\nKirim <b>nama website</b> tanpa spasi.\nContoh: <code>cloudxai</code>`, deployKeyboard(), pending.panel);
}

bot.on('document', handleDocument);

function passwordWrap(encryptedBase64, saltB64, ivB64, tagB64) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected HTML</title><style>body{font-family:system-ui;background:#0b0d12;color:#fff;display:grid;place-items:center;min-height:100vh}main{width:min(420px,92vw);background:#151923;padding:24px;border-radius:20px;box-shadow:0 20px 60px #0008}input,button{width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#0f1219;color:#fff;margin-top:10px}button{cursor:pointer}#status{margin-top:12px;color:#aab}</style></head><body><main><h2>🔐 Protected HTML</h2><p>Masukkan password untuk membuka halaman.</p><input id="p" type="password" placeholder="Password"><button id="b">Buka</button><div id="status"></div></main><script>const C={data:'${encryptedBase64}',salt:'${saltB64}',iv:'${ivB64}',tag:'${tagB64}'};const $=id=>document.getElementById(id);async function openFile(){try{$('status').textContent='Mendekripsi...';const pass=$('p').value;if(!pass)throw new Error('Password kosong');const enc=new TextEncoder();const salt=Uint8Array.from(atob(C.salt),c=>c.charCodeAt(0));const iv=Uint8Array.from(atob(C.iv),c=>c.charCodeAt(0));const tag=Uint8Array.from(atob(C.tag),c=>c.charCodeAt(0));const data=Uint8Array.from(atob(C.data),c=>c.charCodeAt(0));const combined=new Uint8Array(data.length+tag.length);combined.set(data);combined.set(tag,data.length);const key0=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']);const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:200000,hash:'SHA-256'},key0,{name:'AES-GCM',length:256},false,['decrypt']);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,combined);document.open();document.write(new TextDecoder().decode(plain));document.close()}catch(e){$('status').textContent='❌ Password salah atau file rusak.'}}$('b').onclick=openFile;$('p').addEventListener('keydown',e=>{if(e.key==='Enter')openFile()});</script></body></html>`;
}

async function encryptHtml(buffer, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, 200000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(passwordWrap(encrypted.toString('base64'), salt.toString('base64'), iv.toString('base64'), tag.toString('base64')), 'utf8');
}

async function handleText(ctx) {
  const state = await readState();
  const pending = state.pending[String(ctx.from.id)];
  if (!pending || !pending.stage) return;
  const text = (ctx.message.text || '').trim();
  if (!text || text.startsWith('/')) return;

  if (pending.mode === 'get_source' && pending.stage === 'url') {
    if (!/^https?:\/\//i.test(text)) return showPanel(ctx, '<b>❌ URL tidak valid.</b>\nGunakan http:// atau https://', deployKeyboard(), pending.panel);
    delete state.pending[String(ctx.from.id)];
    await writeState(state, 'Begin source fetch');
    await runSourceFetch(ctx, pending, text);
    return;
  }

  if (pending.mode === 'encrypt_html' && pending.stage === 'password') {
    if (text.length < 4 || text.length > 128) return showPanel(ctx, '<b>❌ Password harus 4–128 karakter.</b>', deployKeyboard(), pending.panel);
    const buffer = await downloadTelegramFile(ctx, pending.fileId);
    delete state.pending[String(ctx.from.id)];
    await writeState(state, 'Begin HTML encryption');
    const panel = pending.panel;
    await showPanel(ctx, '<b>🛡️ ENCRYPT HTML</b>\n\n⏳ Mengenkripsi dengan AES-256-GCM + PBKDF2...', backKeyboard(), panel);
    try {
      const result = await encryptHtml(buffer, text);
      await ctx.replyWithDocument({ source: result, filename: 'encrypted.html' }, { caption: '✅ HTML terenkripsi berhasil dibuat. Simpan password dengan aman.' });
      await showPanel(ctx, '<b>✅ ENCRYPTION BERHASIL</b>\n\n🔐 AES-256-GCM\n🔑 PBKDF2-SHA256\n📄 Output: <code>encrypted.html</code>', backKeyboard(), panel);
    } catch (error) {
      await showPanel(ctx, `<b>❌ ENCRYPTION GAGAL</b>\n\n${esc(error.message)}`, backKeyboard(), panel);
    }
    return;
  }

  if ((pending.mode === 'deploy_html' || pending.mode === 'deploy_zip') && pending.stage === 'name') {
    const siteName = safeName(text);
    if (!siteName) return showPanel(ctx, '<b>❌ Nama tidak valid.</b>\nGunakan hanya huruf, angka, <code>-</code> atau <code>_</code>, tanpa spasi.', deployKeyboard(), pending.panel);
    const buffer = await downloadTelegramFile(ctx, pending.fileId);
    delete state.pending[String(ctx.from.id)];
    await writeState(state, 'Begin deployment');
    pending.siteName = siteName;
    try {
      await deployAndReturn(ctx, pending, siteName, buffer);
    } catch (error) {
      await showPanel(ctx, `<b>❌ DEPLOY GAGAL</b>\n\n${esc(error.response?.data?.message || error.message)}`, backKeyboard(), pending.panel);
    }
  }
}

bot.on('text', handleText);

async function runSourceFetch(ctx, pending, targetUrl) {
  const panel = pending.panel;
  try {
    await showPanel(ctx, '<b>🌐 GET SOURCE</b>\n\n⏳ Mengambil HTML utama...', backKeyboard(), panel);
    const root = new URL(targetUrl);
    const htmlResp = await http.get(root.href, { responseType: 'text', maxContentLength: 15 * 1024 * 1024 });
    const html = String(htmlResp.data);
    const $ = cheerio.load(html, { decodeEntities: false });
    const zip = new JSZip();
    const resources = new Map();
    const totalLimit = 45 * 1024 * 1024;
    let total = Buffer.byteLength(html);

    const addResource = async (rawUrl, fallbackDir) => {
      if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('#')) return null;
      try {
        const url = new URL(rawUrl, root.href);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        const href = url.href;
        if (resources.has(href)) return resources.get(href);
        const r = await http.get(href, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 12 * 1024 * 1024 });
        const body = Buffer.from(r.data);
        total += body.length;
        if (total > totalLimit) return null;
        const pathname = url.pathname.split('/').filter(Boolean);
        let filename = pathname.pop() || `resource-${resources.size + 1}`;
        filename = filename.split('?')[0].split('#')[0] || `resource-${resources.size + 1}`;
        if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
          const ct = String(r.headers['content-type'] || '').split(';')[0];
          const ext = ct.includes('javascript') ? '.js' : ct.includes('css') ? '.css' : ct.includes('image/') ? '.' + ct.split('/')[1] : '';
          filename += ext;
        }
        const local = `${fallbackDir}/${String(resources.size + 1).padStart(3, '0')}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        resources.set(href, local);
        zip.file(local, body);
        return local;
      } catch { return null; }
    };

    const tasks = [];
    $('link[href],script[src],img[src],source[src],video[poster]').each((_, el) => {
      const attr = $(el).attr('href') ? 'href' : ($(el).attr('src') ? 'src' : 'poster');
      const val = $(el).attr(attr);
      tasks.push({ el, attr, val });
    });

    for (const item of tasks.slice(0, 80)) {
      const local = await addResource(item.val, 'assets');
      if (local) $(item.el).attr(item.attr, local);
    }

    const cssFiles = [...resources.entries()].filter(([, p]) => /\.css$/i.test(p));
    for (const [sourceUrl, local] of cssFiles) {
      try {
        const r = await http.get(sourceUrl, { responseType: 'text', timeout: 15000 });
        let css = String(r.data);
        const urls = [...css.matchAll(/url\((['"]?)([^'"\)]+)\1\)/gi)].map(m => m[2]).slice(0, 100);
        for (const raw of urls) {
          const localAsset = await addResource(new URL(raw, sourceUrl).href, 'assets');
          if (localAsset) css = css.replaceAll(raw, localAsset);
        }
        zip.file(local, css);
      } catch {}
    }

    zip.file('index.html', $.html());
    zip.file('SOURCE_INFO.txt', `Source URL: ${root.href}\nGenerated: ${new Date().toISOString()}\nNote: This bundle contains resources that were publicly retrievable by the bot. Dynamic/server-side/private resources are not included.\n`);
    await showPanel(ctx, `<b>🌐 GET SOURCE</b>\n\n✅ HTML diambil\n✅ ${resources.size} resource publik diproses\n⏳ Membuat ZIP...`, backKeyboard(), panel);
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await ctx.replyWithDocument({ source: out, filename: 'source-bundle.zip' }, { caption: `✅ Source bundle selesai: ${root.hostname}` });
    await showPanel(ctx, `<b>✅ SOURCE BUNDLE SELESAI</b>\n\n📦 File: <code>source-bundle.zip</code>\n📁 Resource: <b>${resources.size}</b>`, backKeyboard(), panel);
  } catch (error) {
    await showPanel(ctx, `<b>❌ GET SOURCE GAGAL</b>\n\n${esc(error.response?.status ? `HTTP ${error.response.status}` : error.message)}`, backKeyboard(), panel);
  }
}

bot.catch((error) => console.error('BOT_ERROR', error));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('CLOUD LOGIC RAVEN ONLINE');
    return;
  }
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('ok');
  } catch (error) {
    console.error('WEBHOOK_ERROR', error);
    res.status(200).send('ok');
  }
};
