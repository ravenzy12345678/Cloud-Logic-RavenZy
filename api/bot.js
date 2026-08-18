const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');

const ENV = {
  BOT_TOKEN: process.env.TOKEN_BOT || process.env.BOT_TOKEN,
  OWNER_ID: process.env.ID_PEMILIK || process.env.OWNER_ID,
  GH_TOKEN: process.env.TOKEN_GITHUB || process.env.GITHUB_TOKEN,
  GH_OWNER: process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER,
  GH_REPO: process.env.REPO_GITHUB || process.env.GITHUB_REPO,
  GH_BRANCH: process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || 'main',
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  VERCEL_HOOK: process.env.VERCEL_HOOK,
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || '',
};

function requireConfig() {
  const required = ['BOT_TOKEN', 'OWNER_ID', 'GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'VERCEL_TOKEN'];
  const missing = required.filter((k) => !ENV[k]);
  if (missing.length) console.error(`[CONFIG] Missing: ${missing.join(', ')}`);
}
requireConfig();

const bot = new Telegraf(ENV.BOT_TOKEN);
const OWNER_ID = Number(ENV.OWNER_ID);
const sessions = new Map();
let allowedUsers = new Set([OWNER_ID]);

const GH_API = 'https://api.github.com';
const VERCEL_API = 'https://api.vercel.com';
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${ENV.GH_TOKEN}`,
  'X-GitHub-Api-Version': '2022-11-28',
};
const vercelHeaders = {
  Authorization: `Bearer ${ENV.VERCEL_TOKEN}`,
  'Content-Type': 'application/json',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = (ctx) => Number(ctx.from?.id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function errorMessage(error) {
  return error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    'Unknown error';
}

function repoSafeName(name) {
  let value = String(name || '')
    .replace(/\.[^/.]+$/, '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 90);
  if (!value) value = `website-${Date.now()}`;
  return value;
}

function projectSafeName(name) {
  return repoSafeName(name).toLowerCase().replace(/_/g, '-').slice(0, 90);
}

function isAllowed(ctx) {
  const id = uid(ctx);
  return Number.isInteger(id) && (id === OWNER_ID || allowedUsers.has(id));
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) return;
  return next();
});

async function safeDeleteMessage(ctx, chatId, messageId) {
  if (!messageId) return;
  try { await ctx.telegram.deleteMessage(chatId, messageId); } catch (_) {}
}

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'home')]]);
}

function mainMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Deploy HTML', 'deploy_html'), Markup.button.callback('📦 Deploy ZIP', 'deploy_zip')],
    [Markup.button.callback('🌐 Get Source', 'get_source'), Markup.button.callback('🛡️ Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🗑️ Delete Web', 'delete_web'), Markup.button.callback('📡 System', 'system')],
    [Markup.button.callback('👤 Add User', 'add_user'), Markup.button.callback('👥 Users', 'users')],
  ]);
}

function menuText(text) {
  return `☁️ <b>CLOUD LOGIC</b>\n━━━━━━━━━━━━━━━━━━\n${text}`;
}

async function sendMainMenu(ctx, text = '🟢 <b>ONLINE</b>\n\nPilih menu di bawah.') {
  await safeDeleteMessage(ctx, ctx.chat?.id, ctx.callbackQuery?.message?.message_id);
  await ctx.reply(menuText(text), { parse_mode: 'HTML', ...mainMenuMarkup() });
}

async function sendPlainPrompt(ctx, text, session) {
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await ctx.reply(menuText(text), { parse_mode: 'HTML', ...Markup.forceReply() });
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
  return message;
}

async function updateStatus(ctx, messageId, text, keyboard = null) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, menuText(text), {
      parse_mode: 'HTML',
      ...(keyboard || {}),
    });
  } catch (_) {
    return null;
  }
}

async function getBotRepoFile(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const url = `${GH_API}/repos/${encodeURIComponent(ENV.GH_OWNER)}/${encodeURIComponent(ENV.GH_REPO)}/contents/${encoded}`;
  try {
    const response = await axios.get(url, {
      headers: ghHeaders,
      params: { ref: ENV.GH_BRANCH },
      timeout: 30000,
    });
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
}

async function writeBotRepoFile(path, content, message, sha) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const url = `${GH_API}/repos/${encodeURIComponent(ENV.GH_OWNER)}/${encodeURIComponent(ENV.GH_REPO)}/contents/${encoded}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: ENV.GH_BRANCH,
  };
  if (sha) body.sha = sha;
  return axios.put(url, body, { headers: ghHeaders, timeout: 30000 });
}

async function loadUsers() {
  allowedUsers = new Set([OWNER_ID]);
  try {
    const file = await getBotRepoFile('cloud-logic-users.json');
    if (!file?.content) return;
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) allowedUsers.add(id);
      }
    }
  } catch (error) {
    console.error('[USERS LOAD]', errorMessage(error));
  }
}

async function saveUsers() {
  const users = [...allowedUsers].filter((id) => Number.isInteger(id) && id > 0);
  const old = await getBotRepoFile('cloud-logic-users.json');
  await writeBotRepoFile(
    'cloud-logic-users.json',
    JSON.stringify(users, null, 2),
    'chore: update Cloud Logic authorized users',
    old?.sha
  );
}

async function githubApi(method, path, data, config = {}) {
  return axios({
    method,
    url: `${GH_API}${path}`,
    headers: ghHeaders,
    data,
    timeout: config.timeout || 60000,
    params: config.params,
  });
}

async function createGitHubRepo(name) {
  const response = await githubApi('POST', '/user/repos', {
    name,
    description: `Cloud Logic deployment: ${name}`,
    private: false,
    auto_init: true,
  });
  const repo = response.data;
  const actualOwner = repo.owner?.login;
  if (!actualOwner || actualOwner.toLowerCase() !== String(ENV.GH_OWNER).toLowerCase()) {
    throw new Error(`GitHub token membuat repository pada owner "${actualOwner || 'unknown'}", bukan "${ENV.GH_OWNER}".`);
  }
  return repo;
}

async function getRepoRef(owner, repo, branch) {
  const response = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  return response.data.object.sha;
}

async function getGitCommit(owner, repo, sha) {
  const response = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`);
  return response.data;
}

async function createGitBlob(owner, repo, buffer) {
  const response = await githubApi('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
    content: buffer.toString('base64'),
    encoding: 'base64',
  });
  return response.data.sha;
}

async function createGitTree(owner, repo, baseTree, entries) {
  const response = await githubApi('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
    base_tree: baseTree,
    tree: entries,
  });
  return response.data.sha;
}

async function createGitCommit(owner, repo, treeSha, parentSha, message) {
  const response = await githubApi('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`, {
    message,
    tree: treeSha,
    parents: [parentSha],
  });
  return response.data.sha;
}

async function updateGitRef(owner, repo, branch, commitSha) {
  await githubApi('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commitSha,
    force: false,
  });
}

async function uploadFilesToNewRepo(repo, files) {
  const owner = repo.owner.login;
  const branch = repo.default_branch || 'main';
  const parentSha = await getRepoRef(owner, repo.name, branch);
  const parentCommit = await getGitCommit(owner, repo.name, parentSha);
  const entries = [];

  for (const file of files) {
    const path = file.path.replace(/^\/+/, '');
    if (!path || path.includes('..')) continue;
    const blobSha = await createGitBlob(owner, repo.name, file.buffer);
    entries.push({ path, mode: '100644', type: 'blob', sha: blobSha });
  }

  if (!files.some((file) => file.path.toLowerCase() === 'readme.md')) {
    entries.push({ path: 'README.md', mode: '100644', type: 'blob', sha: null });
  }

  const treeSha = await createGitTree(owner, repo.name, parentCommit.tree.sha, entries);
  const commitSha = await createGitCommit(owner, repo.name, treeSha, parentSha, 'deploy: Cloud Logic website');
  await updateGitRef(owner, repo.name, branch, commitSha);
  return { branch, commitSha };
}

async function getVercelProjectFromHook() {
  if (!ENV.VERCEL_HOOK) return null;
  const match = ENV.VERCEL_HOOK.match(/\/deploy\/([^/]+)\//);
  if (!match) return null;
  try {
    const response = await axios.get(`${VERCEL_API}/v9/projects/${encodeURIComponent(match[1])}`, {
      headers: vercelHeaders,
      timeout: 30000,
    });
    return response.data;
  } catch (_) {
    return null;
  }
}

async function getVercelTeamIds() {
  const ids = [];
  if (ENV.VERCEL_TEAM_ID) ids.push(ENV.VERCEL_TEAM_ID);

  const hookProject = await getVercelProjectFromHook();
  if (hookProject?.accountId && String(hookProject.accountId).startsWith('team_')) {
    if (!ids.includes(hookProject.accountId)) ids.push(hookProject.accountId);
  }

  try {
    const response = await axios.get(`${VERCEL_API}/v2/teams`, {
      headers: vercelHeaders,
      params: { limit: 100 },
      timeout: 30000,
    });
    for (const team of response.data?.teams || []) {
      if (team?.id && !ids.includes(team.id)) ids.push(team.id);
    }
  } catch (_) {}
  return ids;
}

async function createVercelDeployment(repo, branch, commitSha) {
  const payload = {
    name: projectSafeName(repo.name),
    target: 'production',
    gitSource: {
      type: 'github',
      repoId: repo.id,
      ref: branch,
      sha: commitSha,
    },
  };

  const triedScopes = [];
  const attempts = [null, ...(await getVercelTeamIds())];
  let lastError;

  for (const teamId of attempts) {
    if (teamId && triedScopes.includes(teamId)) continue;
    if (teamId) triedScopes.push(teamId);
    try {
      const response = await axios.post(`${VERCEL_API}/v13/deployments`, payload, {
        headers: vercelHeaders,
        params: teamId ? { teamId } : undefined,
        timeout: 120000,
      });
      return { ...response.data, teamId: teamId || null };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const message = errorMessage(error).toLowerCase();
      const authFailure = status === 401 || status === 403 || message.includes('not authorized') || message.includes('unauthorized');
      if (!authFailure) break;
    }
  }

  const message = errorMessage(lastError);
  if (/github integration|github repository|link.*github/i.test(message)) {
    throw new Error('Vercel belum mempunyai akses GitHub ke repository baru. Pasang/beri akses GitHub Integration Vercel ke repository tersebut, lalu coba lagi.');
  }
  if (/not authorized|unauthorized/i.test(message)) {
    throw new Error(`Vercel menolak deployment (Not authorized). Token tidak mempunyai scope/team yang bisa membuat deployment untuk repository ${repo.full_name}.`);
  }
  throw new Error(`Vercel deployment gagal: ${message}`);
}

async function getDeployment(deploymentId, teamId) {
  const response = await axios.get(`${VERCEL_API}/v13/deployments/${encodeURIComponent(deploymentId)}`, {
    headers: vercelHeaders,
    params: teamId ? { teamId } : undefined,
    timeout: 30000,
  });
  return response.data;
}

async function waitForDeployment(deploymentId, teamId, timeoutMs = 180000, onStatus) {
  const start = Date.now();
  let lastState = '';
  while (Date.now() - start < timeoutMs) {
    const deployment = await getDeployment(deploymentId, teamId);
    const state = deployment.readyState || deployment.state || deployment.status || '';
    if (state !== lastState) {
      lastState = state;
      if (onStatus) await onStatus(state, deployment);
    }
    if (['READY', 'ERROR', 'CANCELED'].includes(state)) return deployment;
    await sleep(5000);
  }
  throw new Error('Deployment belum selesai dalam 3 menit. Periksa deployment di Vercel untuk build log lengkap.');
}

function normalizeZipPath(path) {
  const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('../') || clean === '..') return null;
  return clean;
}

async function extractZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const raw = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const clean = normalizeZipPath(path);
    if (!clean) continue;
    raw.push({ path: clean, buffer: await entry.async('nodebuffer') });
  }
  if (!raw.length) throw new Error('ZIP kosong.');

  const lowerIndex = raw.find((f) => f.path.toLowerCase() === 'index.html');
  if (lowerIndex) return raw;

  const first = raw[0].path.split('/')[0];
  const nested = raw.every((f) => f.path.startsWith(`${first}/`));
  if (nested) {
    const flattened = raw.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })).filter((f) => f.path);
    if (flattened.some((f) => f.path.toLowerCase() === 'index.html')) return flattened;
  }
  throw new Error('ZIP harus mempunyai index.html sebagai halaman utama.');
}

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await axios.get(link.href || link, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: 200 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}

async function getPublicSource(url) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('URL harus http atau https.');
  const response = await axios.get(base.href, {
    timeout: 30000,
    responseType: 'text',
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'Cloud-Logic-SourceFetcher/1.0' },
  });
  const html = String(response.data);
  const zip = new JSZip();
  zip.file('index.html', html);

  const assets = new Set();
  const add = (candidate) => {
    try {
      const absolute = new URL(candidate, base.href);
      if (['http:', 'https:'].includes(absolute.protocol)) assets.add(absolute.href);
    } catch (_) {}
  };

  for (const match of html.matchAll(/<(?:script|link|img|source|video|audio)[^>]+(?:src|href)=['"]([^'"]+)['"]/gi)) add(match[1]);
  for (const match of html.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)) add(match[1]);

  let index = 0;
  for (const assetUrl of assets) {
    if (index >= 100) break;
    try {
      const asset = await axios.get(assetUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': 'Cloud-Logic-SourceFetcher/1.0' },
      });
      const parsed = new URL(assetUrl);
      const fileName = parsed.pathname.split('/').filter(Boolean).pop() || `asset-${index}`;
      zip.file(`assets/${index}-${fileName}`, Buffer.from(asset.data));
      index += 1;
    } catch (_) {}
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function encryptedHtml(html, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 200000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(html, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (value) => value.toString('base64');

  return `<!doctype html><meta charset="utf-8"><title>Encrypted HTML</title><div id="app">Password required.</div><script>
(async()=>{
const enc=${JSON.stringify(b64(ciphertext))},salt=${JSON.stringify(b64(salt))},iv=${JSON.stringify(b64(iv))},tag=${JSON.stringify(b64(tag))};
const p=prompt('Password:'); if(!p) return;
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(p),'PBKDF2',false,['deriveKey']);
const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes(salt),iterations:200000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
try{
const packed=new Uint8Array([...bytes(enc),...bytes(tag)]);
const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv)},key,packed);
document.open();document.write(new TextDecoder().decode(plain));document.close();
}catch(e){document.body.innerHTML='<h3>Wrong password or corrupted file.</h3>';}
})();
</script>`;
}

async function checkGitHub() {
  const r = await axios.get(`${GH_API}/user`, { headers: ghHeaders, timeout: 30000 });
  return r.data;
}

async function checkVercel() {
  const r = await axios.get(`${VERCEL_API}/v2/user`, { headers: vercelHeaders, timeout: 30000 });
  return r.data;
}

async function deleteDeployment(deploymentId) {
  const scopes = [null, ...(await getVercelTeamIds())];
  let lastError;
  for (const teamId of scopes) {
    try {
      await axios.delete(`${VERCEL_API}/v13/deployments/${encodeURIComponent(deploymentId)}`, {
        headers: vercelHeaders,
        params: teamId ? { teamId } : undefined,
        timeout: 30000,
      });
      return true;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (![401, 403, 404].includes(status)) break;
    }
  }
  throw new Error(errorMessage(lastError));
}

async function runDeployment(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  let repo = null;
  let commit = null;

  await updateStatus(ctx, statusMessage.message_id,
    `🚀 <b>DEPLOYING</b>\n\n📦 Repository: <code>${escapeHtml(repoName)}</code>\n\n⬆️ GitHub: <b>mempersiapkan...</b>\n⚡ Vercel: <b>menunggu...</b>`);

  try {
    repo = await createGitHubRepo(repoName);
    await updateStatus(ctx, statusMessage.message_id,
      `🚀 <b>DEPLOYING</b>\n\n📦 Repository: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">GitHub Repository</a>\n\n⬆️ GitHub: <b>mengunggah ${session.files.length} file...</b>\n⚡ Vercel: <b>menunggu...</b>`);

    commit = await uploadFilesToNewRepo(repo, session.files);
    await updateStatus(ctx, statusMessage.message_id,
      `🚀 <b>DEPLOYING</b>\n\n📦 Repository: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">GitHub Repository</a>\n\n✅ GitHub: <b>upload selesai</b>\n⚡ Vercel: <b>membuat deployment...</b>`);

    const deployment = await createVercelDeployment(repo, commit.branch, commit.commitSha);
    const final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
      await updateStatus(ctx, statusMessage.message_id,
        `🚀 <b>DEPLOYING</b>\n\n📦 Repository: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">GitHub Repository</a>\n\n✅ GitHub: <b>upload selesai</b>\n⚡ Vercel: <b>${escapeHtml(state || 'PROCESSING')}</b>`);
    });

    if ((final.readyState || final.state) !== 'READY') {
      throw new Error(`Build Vercel berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
    }

    const url = final.url ? `https://${final.url}` : `https://${projectSafeName(repo.name)}.vercel.app`;
    await updateStatus(ctx, statusMessage.message_id,
      `✅ <b>DEPLOY BERHASIL</b>\n\n📦 Repository\n<a href="${escapeHtml(repo.html_url)}">${escapeHtml(repo.full_name)}</a>\n\n🌐 Website\n<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n\n🟢 Vercel: <b>READY</b>`, homeButton());
  } catch (error) {
    const detail = errorMessage(error);
    await updateStatus(ctx, statusMessage.message_id,
      `❌ <b>DEPLOY GAGAL</b>\n\n📦 Repository: <code>${escapeHtml(repoName)}</code>\n${repo ? `🔗 <a href="${escapeHtml(repo.html_url)}">Repository berhasil dibuat</a>\n\n` : ''}<b>Alasan:</b>\n<code>${escapeHtml(detail)}</code>`, homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}

bot.start(async (ctx) => {
  await loadUsers();
  return sendMainMenu(ctx);
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();
  sessions.delete(uid(ctx));
  return sendMainMenu(ctx);
});

bot.action('deploy_html', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '🚀 <b>DEPLOY HTML</b>\n\nKirim file <code>.html</code>.', { type: 'deploy_html', step: 'file' });
});

bot.action('deploy_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '📦 <b>DEPLOY ZIP</b>\n\nKirim file <code>.zip</code>.', { type: 'deploy_zip', step: 'file' });
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '🌐 <b>GET SOURCE</b>\n\nKirim URL website publik yang ingin dibundel menjadi ZIP.', { type: 'source', step: 'url' });
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '🛡️ <b>ENCRYPT HTML</b>\n\nKirim file <code>.html</code>.', { type: 'encrypt', step: 'file' });
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Checking...');
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  const status = await ctx.reply(menuText('📡 <b>SYSTEM CHECK</b>\n\n⏳ Memeriksa koneksi Telegram, GitHub, dan Vercel...'), { parse_mode: 'HTML' });
  const result = [];
  try { await checkGitHub(); result.push('🟢 GitHub API'); } catch (e) { result.push(`🔴 GitHub API — ${escapeHtml(errorMessage(e))}`); }
  try { await checkVercel(); result.push('🟢 Vercel API'); } catch (e) { result.push(`🔴 Vercel API — ${escapeHtml(errorMessage(e))}`); }
  result.push(`🟢 Telegram Webhook — handler aktif`);
  await updateStatus(ctx, status.message_id, `📡 <b>SYSTEM STATUS</b>\n\n${result.join('\n')}`, homeButton());
});

bot.action('add_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '👤 <b>ADD USER</b>\n\nKirim Telegram ID user yang ingin diberi akses.', { type: 'add_user', step: 'id' });
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  const ids = [...allowedUsers].filter((id) => id !== OWNER_ID);
  const text = `👥 <b>AUTHORIZED USERS</b>\n\n👑 Owner: <code>${OWNER_ID}</code>\n👤 User tambahan: <b>${ids.length}</b>\n\n${ids.length ? ids.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n') : 'Belum ada user tambahan.'}`;
  await ctx.reply(menuText(text), { parse_mode: 'HTML', ...homeButton() });
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(ctx, '🗑️ <b>DELETE DEPLOYMENT</b>\n\nKirim <b>Deployment ID Vercel</b> yang ingin dihapus.', { type: 'delete', step: 'id' });
});

bot.on('text', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  const text = ctx.message.text.trim();

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  if (session.type === 'add_user' && session.step === 'id') {
    if (id !== OWNER_ID) return;
    const target = Number(text);
    if (!Number.isInteger(target) || target <= 0) {
      await sendPlainPrompt(ctx, '❌ Telegram ID tidak valid. Kirim angka ID Telegram.', session);
      return;
    }
    allowedUsers.add(target);
    try {
      await saveUsers();
      sessions.delete(id);
      await ctx.reply(menuText(`✅ User <code>${target}</code> berhasil ditambahkan.`), { parse_mode: 'HTML', ...homeButton() });
    } catch (error) {
      allowedUsers.delete(target);
      sessions.delete(id);
      await ctx.reply(menuText(`❌ Gagal menyimpan user.\n<code>${escapeHtml(errorMessage(error))}</code>`), { parse_mode: 'HTML', ...homeButton() });
    }
    return;
  }

  if (session.type === 'source' && session.step === 'url') {
    sessions.delete(id);
    const status = await ctx.reply(menuText('🌐 <b>GET SOURCE</b>\n\n⏳ Mengambil HTML, CSS, JavaScript, dan asset publik...'), { parse_mode: 'HTML' });
    try {
      const zip = await getPublicSource(text);
      await ctx.replyWithDocument({ source: zip, filename: 'source-public.zip' }, { caption: '✅ Source publik berhasil dibundel menjadi ZIP.' });
      await updateStatus(ctx, status.message_id, '✅ <b>GET SOURCE SELESAI</b>\n\nZIP sudah dikirim. Resource yang gagal diakses publik tidak dapat dimasukkan.', homeButton());
    } catch (error) {
      await updateStatus(ctx, status.message_id, `❌ <b>GET SOURCE GAGAL</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, homeButton());
    }
    return;
  }

  if (session.type === 'delete' && session.step === 'id') {
    sessions.delete(id);
    const status = await ctx.reply(menuText(`🗑️ <b>DELETE DEPLOYMENT</b>\n\n⏳ Menghapus <code>${escapeHtml(text)}</code>...`), { parse_mode: 'HTML' });
    try {
      await deleteDeployment(text);
      await updateStatus(ctx, status.message_id, `✅ <b>DEPLOYMENT DIHAPUS</b>\n\nID: <code>${escapeHtml(text)}</code>`, homeButton());
    } catch (error) {
      await updateStatus(ctx, status.message_id, `❌ <b>DELETE GAGAL</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, homeButton());
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'password') {
    session.password = text;
    session.step = 'confirm';
    sessions.set(id, session);
    await sendPlainPrompt(ctx, '🔐 <b>KONFIRMASI PASSWORD</b>\n\nKirim password yang sama sekali lagi.', session);
    return;
  }

  if (session.type === 'encrypt' && session.step === 'confirm') {
    if (text !== session.password) {
      await sendPlainPrompt(ctx, '❌ Password berbeda. Kirim ulang password yang benar.', session);
      return;
    }
    sessions.delete(id);
    const encrypted = encryptedHtml(session.fileBuffer.toString('utf8'), session.password);
    await ctx.replyWithDocument({ source: Buffer.from(encrypted, 'utf8'), filename: `${session.fileName.replace(/\.html$/i, '')}-encrypted.html` }, { caption: '✅ HTML berhasil dienkripsi.' });
    await ctx.reply(menuText('🛡️ <b>ENCRYPT SELESAI</b>\n\nFile terenkripsi sudah dikirim.'), { parse_mode: 'HTML', ...homeButton() });
    return;
  }

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'name') {
    session.name = repoSafeName(text);
    session.step = 'deploying';
    sessions.set(id, session);
    const status = await ctx.reply(menuText('🚀 <b>DEPLOYING</b>\n\n⏳ Memulai proses...'), { parse_mode: 'HTML' });
    await runDeployment(ctx, session, status);
    return;
  }

  if (session.type === 'deploy_html' || session.type === 'deploy_zip') {
    await sendPlainPrompt(ctx, '📛 Tahap ini belum meminta nama. Ikuti instruksi terakhir dari bot.', session);
  }
});

bot.on('document', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  const document = ctx.message.document;
  const fileName = document.file_name || 'file';

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  if (session.type === 'deploy_html' && session.step === 'file') {
    if (!/\.html?$/i.test(fileName)) {
      await sendPlainPrompt(ctx, '❌ Deploy HTML hanya menerima file <code>.html</code>.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = [{ path: 'index.html', buffer }];
      session.step = 'name';
      await sendPlainPrompt(ctx, '📄 <b>HTML DITERIMA</b>\n\n📛 Sekarang kirim nama repository/website <b>tanpa spasi</b>.', session);
    } catch (error) {
      await sendPlainPrompt(ctx, `❌ Gagal mengambil file Telegram.\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_zip' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPlainPrompt(ctx, '❌ Deploy ZIP hanya menerima file <code>.zip</code>.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = await extractZip(buffer);
      session.step = 'name';
      await sendPlainPrompt(ctx, `📦 <b>ZIP DITERIMA</b>\n\n📁 File: <b>${session.files.length}</b>\n📛 Sekarang kirim nama repository/website <b>tanpa spasi</b>.`, session);
    } catch (error) {
      await sendPlainPrompt(ctx, `❌ ZIP tidak valid.\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'file') {
    if (!/\.html?$/i.test(fileName)) {
      await sendPlainPrompt(ctx, '❌ Encrypt HTML hanya menerima file <code>.html</code>.', session);
      return;
    }
    try {
      session.fileBuffer = await downloadTelegramFile(ctx, document.file_id);
      session.fileName = fileName;
      session.step = 'password';
      await sendPlainPrompt(ctx, '🔐 <b>FILE DITERIMA</b>\n\nKirim password enkripsi.', session);
    } catch (error) {
      await sendPlainPrompt(ctx, `❌ Gagal mengambil file Telegram.\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
  }
});

bot.command('adduser', async (ctx) => {
  if (uid(ctx) !== OWNER_ID) return;
  const target = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(target) || target <= 0) return ctx.reply('Format: /adduser 123456789');
  allowedUsers.add(target);
  try {
    await saveUsers();
    await ctx.reply(menuText(`✅ User <code>${target}</code> berhasil ditambahkan.`), { parse_mode: 'HTML', ...homeButton() });
  } catch (error) {
    allowedUsers.delete(target);
    await ctx.reply(menuText(`❌ Gagal menyimpan user.\n<code>${escapeHtml(errorMessage(error))}</code>`), { parse_mode: 'HTML', ...homeButton() });
  }
});

bot.command('cancel', async (ctx) => {
  const session = sessions.get(uid(ctx));
  if (session?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  sessions.delete(uid(ctx));
  await ctx.reply(menuText('↩️ <b>PROSES DIBATALKAN</b>'), { parse_mode: 'HTML', ...homeButton() });
});

bot.catch((error) => {
  console.error('[BOT ERROR]', error.response?.data || error.message || error);
});

(async () => {
  await loadUsers();
})();

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } catch (error) {
      console.error('[WEBHOOK]', error.response?.data || error.message || error);
      return res.status(500).send('Webhook error');
    }
  }
  return res.status(200).send('☁️ Cloud Logic Bot Online');
};
