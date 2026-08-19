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

// ─────────────────────────────────────────────
// TAMPILAN / UI HELPERS
// Catatan penting: bot ini SENGAJA tidak memakai Reply Keyboard (tombol
// menu di sebelah kotak ketik) maupun daftar perintah "/" di menu chat.
// Semua navigasi hanya lewat inline button yang menempel di pesan bot,
// supaya tidak ada dua menu berbeda yang membingungkan pengguna.
// ─────────────────────────────────────────────

const DIVIDER = '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈';

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Menu Utama', 'home')]]);
}

function backCancelRow() {
  return [Markup.button.callback('✖️  Batalkan', 'home')];
}

function mainMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀  Deploy HTML', 'deploy_html'), Markup.button.callback('📦  Deploy ZIP', 'deploy_zip')],
    [Markup.button.callback('🌐  Get Source', 'get_source'), Markup.button.callback('🛡️  Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🗑️  Delete Web', 'delete_web'), Markup.button.callback('📡  System Check', 'system')],
    [Markup.button.callback('👤  Add User', 'add_user'), Markup.button.callback('👥  Users', 'users')],
  ]);
}

function menuText(title, body) {
  if (body === undefined) {
    // Dipanggil dengan 1 argumen (kompatibilitas lama) → anggap itu body, pakai judul default.
    return `☁️ <b>CLOUD LOGIC</b>\n${DIVIDER}\n${title}`;
  }
  return `☁️ <b>CLOUD LOGIC</b>  ·  <i>${escapeHtml(title)}</i>\n${DIVIDER}\n${body}`;
}

async function sendMainMenu(ctx, body = '🟢 <b>Status:</b> Online & siap digunakan.\n\nSilakan pilih salah satu menu di bawah ini.') {
  await safeDeleteMessage(ctx, ctx.chat?.id, ctx.callbackQuery?.message?.message_id);
  await ctx.reply(menuText('Menu Utama', body), { parse_mode: 'HTML', ...mainMenuMarkup() });
}

async function sendPlainPrompt(ctx, title, body, session) {
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await ctx.reply(menuText(title, body), {
    parse_mode: 'HTML',
    ...Markup.forceReply(),
  });
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
  return message;
}

async function updateStatus(ctx, messageId, title, body, keyboard = null) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, menuText(title, body), {
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

async function createVercelDeployment(name, files) {
  // Deploy langsung dari isi file (bukan gitSource) supaya TIDAK bergantung
  // sama sekali pada GitHub App Integration Vercel <-> GitHub. Hanya butuh
  // VERCEL_TOKEN yang valid untuk akun/scope yang dipakai.
  const payload = {
    name: projectSafeName(name),
    target: 'production',
    files: files.map((file) => ({
      file: file.path.replace(/^\/+/, ''),
      data: file.buffer.toString('base64'),
      encoding: 'base64',
    })),
    projectSettings: {
      framework: null,
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
        params: { teamId: teamId || undefined, skipAutoDetectionConfirmation: 1 },
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
  if (/not authorized|unauthorized/i.test(message)) {
    throw new Error(`Vercel menolak deployment (Not authorized). Periksa VERCEL_TOKEN — pastikan token masih berlaku dan dibuat dari akun/scope yang benar (name: ${name}).`);
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

  // Coba ratakan folder pembungkus tunggal (mis. "my-site/index.html" → "index.html")
  const topFolders = new Set(raw.map((f) => f.path.split('/')[0]));
  if (topFolders.size === 1) {
    const [prefix] = topFolders;
    const flattened = raw.map((f) => ({ path: f.path.slice(prefix.length + 1), buffer: f.buffer }));
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

  const progress = (ghLine, vercelLine) =>
    `📦 Repository&#8202;: <code>${escapeHtml(repoName)}</code>\n\n${ghLine}\n${vercelLine}`;

  await updateStatus(ctx, statusMessage.message_id, 'Deploying',
    progress('⬆️ GitHub&#8202;: <b>mempersiapkan…</b>', '⚡ Vercel&#8202;: <b>menunggu…</b>'));

  try {
    repo = await createGitHubRepo(repoName);
    await updateStatus(ctx, statusMessage.message_id, 'Deploying',
      `📦 Repository&#8202;: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">Buka di GitHub</a>\n\n⬆️ GitHub&#8202;: <b>mengunggah ${session.files.length} berkas…</b>\n⚡ Vercel&#8202;: <b>menunggu…</b>`);

    commit = await uploadFilesToNewRepo(repo, session.files);
    await updateStatus(ctx, statusMessage.message_id, 'Deploying',
      `📦 Repository&#8202;: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">Buka di GitHub</a>\n\n✅ GitHub&#8202;: <b>unggah selesai</b>\n⚡ Vercel&#8202;: <b>membuat deployment…</b>`);

    // Deploy langsung dari file yang sudah diunggah user (bukan menarik dari
    // GitHub), jadi tidak butuh GitHub App Integration Vercel sama sekali.
    const deployment = await createVercelDeployment(repo.name, session.files);
    const final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
      await updateStatus(ctx, statusMessage.message_id, 'Deploying',
        `📦 Repository&#8202;: <code>${escapeHtml(repo.name)}</code>\n🔗 <a href="${escapeHtml(repo.html_url)}">Buka di GitHub</a>\n\n✅ GitHub&#8202;: <b>unggah selesai</b>\n⚡ Vercel&#8202;: <b>${escapeHtml(state || 'PROCESSING')}</b>`);
    });

    if ((final.readyState || final.state) !== 'READY') {
      throw new Error(`Build Vercel berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
    }

    const url = final.url ? `https://${final.url}` : `https://${projectSafeName(repo.name)}.vercel.app`;
    await updateStatus(ctx, statusMessage.message_id, 'Deploy Berhasil ✅',
      `📦 <b>Repository</b>\n<a href="${escapeHtml(repo.html_url)}">${escapeHtml(repo.full_name)}</a>\n\n🌐 <b>Website</b>\n<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n\n🟢 Status Vercel&#8202;: <b>READY</b>`,
      homeButton());
  } catch (error) {
    const detail = errorMessage(error);
    await updateStatus(ctx, statusMessage.message_id, 'Deploy Gagal ❌',
      `📦 Repository&#8202;: <code>${escapeHtml(repoName)}</code>\n${repo ? `🔗 <a href="${escapeHtml(repo.html_url)}">Repository sudah terlanjur dibuat</a>\n\n` : ''}<b>Penyebab&#8202;:</b>\n<code>${escapeHtml(detail)}</code>`,
      homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}

// ─────────────────────────────────────────────
// COMMANDS & ACTIONS
// ─────────────────────────────────────────────

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
  await sendPlainPrompt(
    ctx,
    'Deploy HTML',
    '🚀 <b>Langkah 1 dari 2&#8202;: Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', step: 'file' }
  );
});

bot.action('deploy_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(
    ctx,
    'Deploy ZIP',
    '📦 <b>Langkah 1 dari 2&#8202;: Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ <b>Wajib</b> ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', step: 'file' }
  );
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(
    ctx,
    'Get Source',
    '🌐 <b>Kirim URL Website</b>\n\nKirim alamat lengkap website publik (contoh&#8202;: <code>https://contoh.com</code>) yang ingin diambil HTML, CSS, JavaScript, dan asset-nya menjadi satu file ZIP.',
    { type: 'source', step: 'url' }
  );
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(
    ctx,
    'Encrypt HTML',
    '🛡️ <b>Langkah 1 dari 3&#8202;: Kirim File</b>\n\nUnggah 1 file <code>.html</code> yang ingin dikunci dengan password (AES-256).',
    { type: 'encrypt', step: 'file' }
  );
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa koneksi…');
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  const status = await ctx.reply(menuText('System Check', '⏳ Memeriksa koneksi Telegram, GitHub, dan Vercel…'), { parse_mode: 'HTML' });
  const result = [];
  try { await checkGitHub(); result.push('🟢 GitHub API&#8202;: <b>terhubung</b>'); } catch (e) { result.push(`🔴 GitHub API&#8202;: <code>${escapeHtml(errorMessage(e))}</code>`); }
  try { await checkVercel(); result.push('🟢 Vercel API&#8202;: <b>terhubung</b>'); } catch (e) { result.push(`🔴 Vercel API&#8202;: <code>${escapeHtml(errorMessage(e))}</code>`); }
  result.push('🟢 Telegram Webhook&#8202;: <b>aktif</b>');
  await updateStatus(ctx, status.message_id, 'System Status', result.join('\n'), homeButton());
});

bot.action('add_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(
    ctx,
    'Add User',
    '👤 <b>Kirim Telegram ID</b>\n\nKirim angka Telegram ID user yang ingin diberi akses ke bot ini.\n\n<i>Tidak tahu ID Telegram seseorang? Minta mereka forward pesan apapun ke bot @userinfobot.</i>',
    { type: 'add_user', step: 'id' }
  );
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  const ids = [...allowedUsers].filter((id) => id !== OWNER_ID);
  const body = `👑 Owner&#8202;: <code>${OWNER_ID}</code>\n👤 User tambahan&#8202;: <b>${ids.length}</b>\n\n${ids.length ? ids.map((id, i) => `${i + 1}. <code>${id}</code>`).join('\n') : '<i>Belum ada user tambahan.</i>'}`;
  await ctx.reply(menuText('Authorized Users', body), { parse_mode: 'HTML', ...homeButton() });
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  await safeDeleteMessage(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id);
  await sendPlainPrompt(
    ctx,
    'Delete Deployment',
    '🗑️ <b>Kirim Deployment ID</b>\n\nKirim Deployment ID dari Vercel yang ingin dihapus (bisa dilihat di dashboard Vercel, contoh&#8202;: <code>dpl_xxx…</code>).',
    { type: 'delete', step: 'id' }
  );
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
      await sendPlainPrompt(ctx, 'Add User', '❌ <b>ID tidak valid.</b>\n\nKirim ulang dalam bentuk angka saja, contoh&#8202;: <code>123456789</code>.', session);
      return;
    }
    allowedUsers.add(target);
    try {
      await saveUsers();
      sessions.delete(id);
      await ctx.reply(menuText('Add User', `✅ User <code>${target}</code> berhasil ditambahkan dan sekarang punya akses ke bot ini.`), { parse_mode: 'HTML', ...homeButton() });
    } catch (error) {
      allowedUsers.delete(target);
      sessions.delete(id);
      await ctx.reply(menuText('Add User', `❌ <b>Gagal menyimpan user.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`), { parse_mode: 'HTML', ...homeButton() });
    }
    return;
  }

  if (session.type === 'source' && session.step === 'url') {
    sessions.delete(id);
    const status = await ctx.reply(menuText('Get Source', '⏳ Mengambil HTML, CSS, JavaScript, dan asset publik…'), { parse_mode: 'HTML' });
    try {
      const zip = await getPublicSource(text);
      await ctx.replyWithDocument({ source: zip, filename: 'source-public.zip' }, { caption: '✅ Source publik berhasil dibundel menjadi ZIP.' });
      await updateStatus(ctx, status.message_id, 'Get Source Selesai ✅', 'ZIP sudah dikirim di atas.\n\n<i>Catatan&#8202;: resource yang tidak bisa diakses publik tidak dapat dimasukkan.</i>', homeButton());
    } catch (error) {
      await updateStatus(ctx, status.message_id, 'Get Source Gagal ❌', `<code>${escapeHtml(errorMessage(error))}</code>`, homeButton());
    }
    return;
  }

  if (session.type === 'delete' && session.step === 'id') {
    sessions.delete(id);
    const status = await ctx.reply(menuText('Delete Deployment', `⏳ Menghapus <code>${escapeHtml(text)}</code>…`), { parse_mode: 'HTML' });
    try {
      await deleteDeployment(text);
      await updateStatus(ctx, status.message_id, 'Deployment Dihapus ✅', `ID&#8202;: <code>${escapeHtml(text)}</code>`, homeButton());
    } catch (error) {
      await updateStatus(ctx, status.message_id, 'Delete Gagal ❌', `<code>${escapeHtml(errorMessage(error))}</code>`, homeButton());
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'password') {
    session.password = text;
    session.step = 'confirm';
    sessions.set(id, session);
    await sendPlainPrompt(ctx, 'Encrypt HTML', '🔐 <b>Langkah 3 dari 3&#8202;: Konfirmasi</b>\n\nKetik ulang password yang sama persis untuk konfirmasi.', session);
    return;
  }

  if (session.type === 'encrypt' && session.step === 'confirm') {
    if (text !== session.password) {
      await sendPlainPrompt(ctx, 'Encrypt HTML', '❌ <b>Password tidak sama.</b>\n\nKirim ulang password yang benar (harus sama persis dengan langkah sebelumnya).', session);
      return;
    }
    sessions.delete(id);
    const encrypted = encryptedHtml(session.fileBuffer.toString('utf8'), session.password);
    await ctx.replyWithDocument({ source: Buffer.from(encrypted, 'utf8'), filename: `${session.fileName.replace(/\.html$/i, '')}-encrypted.html` }, { caption: '✅ HTML berhasil dienkripsi dengan AES-256.' });
    await ctx.reply(menuText('Encrypt Selesai ✅', 'File terenkripsi sudah dikirim di atas. Simpan passwordnya baik-baik — tanpa password, isi file tidak bisa dibuka lagi.'), { parse_mode: 'HTML', ...homeButton() });
    return;
  }

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'name') {
    session.name = repoSafeName(text);
    session.step = 'deploying';
    sessions.set(id, session);
    const status = await ctx.reply(menuText('Deploying', '⏳ Memulai proses deploy…'), { parse_mode: 'HTML' });
    await runDeployment(ctx, session, status);
    return;
  }

  if (session.type === 'deploy_html' || session.type === 'deploy_zip') {
    await sendPlainPrompt(ctx, 'Deploy', '📛 Tahap ini belum meminta nama repository. Ikuti instruksi terakhir dari bot di atas, atau tekan tombol Batalkan.', session);
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
      await sendPlainPrompt(ctx, 'Deploy HTML', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = [{ path: 'index.html', buffer }];
      session.step = 'name';
      await sendPlainPrompt(ctx, 'Deploy HTML', `📄 <b>File diterima&#8202;:</b> <code>${escapeHtml(fileName)}</code>\n\n🚀 <b>Langkah 2 dari 2&#8202;: Nama Website</b>\n\nKirim nama repository/website (huruf, angka, dan tanda "-" saja, <b>tanpa spasi</b>).\nContoh&#8202;: <code>toko-online-saya</code>`, session);
    } catch (error) {
      await sendPlainPrompt(ctx, 'Deploy HTML', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_zip' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPlainPrompt(ctx, 'Deploy ZIP', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.zip</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = await extractZip(buffer);
      session.step = 'name';
      await sendPlainPrompt(ctx, 'Deploy ZIP', `📦 <b>ZIP diterima&#8202;:</b> <b>${session.files.length}</b> file ditemukan.\n\n🚀 <b>Langkah 2 dari 2&#8202;: Nama Website</b>\n\nKirim nama repository/website (huruf, angka, dan tanda "-" saja, <b>tanpa spasi</b>).\nContoh&#8202;: <code>toko-online-saya</code>`, session);
    } catch (error) {
      await sendPlainPrompt(ctx, 'Deploy ZIP', `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'file') {
    if (!/\.html?$/i.test(fileName)) {
      await sendPlainPrompt(ctx, 'Encrypt HTML', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      session.fileBuffer = await downloadTelegramFile(ctx, document.file_id);
      session.fileName = fileName;
      session.step = 'password';
      await sendPlainPrompt(ctx, 'Encrypt HTML', `📄 <b>File diterima&#8202;:</b> <code>${escapeHtml(fileName)}</code>\n\n🔐 <b>Langkah 2 dari 3&#8202;: Password</b>\n\nKirim password yang akan dipakai untuk mengunci file ini.`, session);
    } catch (error) {
      await sendPlainPrompt(ctx, 'Encrypt HTML', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
  }
});

bot.command('adduser', async (ctx) => {
  if (uid(ctx) !== OWNER_ID) return;
  const target = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(target) || target <= 0) return ctx.reply(menuText('Add User', '❌ Format salah. Gunakan&#8202;: <code>/adduser 123456789</code>'), { parse_mode: 'HTML' });
  allowedUsers.add(target);
  try {
    await saveUsers();
    await ctx.reply(menuText('Add User', `✅ User <code>${target}</code> berhasil ditambahkan.`), { parse_mode: 'HTML', ...homeButton() });
  } catch (error) {
    allowedUsers.delete(target);
    await ctx.reply(menuText('Add User', `❌ <b>Gagal menyimpan user.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`), { parse_mode: 'HTML', ...homeButton() });
  }
});

bot.command('cancel', async (ctx) => {
  const session = sessions.get(uid(ctx));
  if (session?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  sessions.delete(uid(ctx));
  await ctx.reply(menuText('Dibatalkan ↩️', 'Proses yang sedang berjalan sudah dibatalkan.'), { parse_mode: 'HTML', ...homeButton() });
});

bot.catch((error) => {
  console.error('[BOT ERROR]', error.response?.data || error.message || error);
});

(async () => {
  await loadUsers();
  // Sengaja HANYA mendaftarkan /start dan /cancel di daftar perintah "/".
  // Navigasi utama tetap lewat inline button pada pesan bot, bukan lewat
  // Reply Keyboard, supaya tidak ada dua menu yang tampil berbarengan.
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Buka menu utama' },
      { command: 'cancel', description: 'Batalkan proses yang sedang berjalan' },
    ]);
  } catch (error) {
    console.error('[SET COMMANDS]', errorMessage(error));
  }
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
