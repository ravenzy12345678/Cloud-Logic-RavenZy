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
//
// Aturan tampilan bot ini:
// 1. Navigasi HANYA lewat inline button pada pesan bot (tidak ada Reply
//    Keyboard, tidak ada daftar perintah "/" selain /start dan /cancel),
//    supaya tidak ada dua menu berbeda yang membingungkan.
// 2. Semua pesan mematikan link preview (disable_web_page_preview) supaya
//    tidak ada kartu/gambar preview GitHub atau Vercel yang muncul —
//    tampilan tetap murni teks & status.
// 3. Tombol "Menu Utama" TIDAK PERNAH menghapus pesan yang ditempelinya,
//    jadi hasil (link deploy, hasil delete, dsb) tidak pernah hilang saat
//    pengguna menekan tombol itu atau /start ulang.
// ─────────────────────────────────────────────

const BAR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Menu Utama', 'home')]]);
}

function mainMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀  Deploy HTML', 'deploy_html'), Markup.button.callback('📦  Deploy ZIP', 'deploy_zip')],
    [Markup.button.callback('🌐  Get Source', 'get_source'), Markup.button.callback('🛡️  Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🗑️  Delete Web', 'delete_web'), Markup.button.callback('📡  System Check', 'system')],
    [Markup.button.callback('👤  Add User', 'add_user'), Markup.button.callback('👥  Users', 'users')],
  ]);
}

// Kotak info bergaya "dashboard" — dipakai untuk semua tampilan status/hasil
// supaya konsisten & terlihat premium di seluruh menu.
function infoBox(rows) {
  const lines = rows.map(([label, value], idx) => {
    const prefix = idx === rows.length - 1 ? '└' : '├';
    return `${prefix} ${label} : ${value}`;
  });
  return `┌─────────────────────────\n${lines.join('\n')}`;
}

function panel({ heading, box, body, footer } = {}) {
  let out = `⚡ <b>CLOUD LOGIC</b>\n${BAR}\n\n`;
  if (heading) out += `${heading}\n`;
  if (box) out += `${box}\n`;
  if (body) out += `${body}\n`;
  out += `\n${BAR}`;
  if (footer) out += `\n${footer}`;
  return out;
}

function progressBar(percent) {
  const total = 10;
  const filled = Math.min(total, Math.max(0, Math.round((percent / 100) * total)));
  return '█'.repeat(filled) + '░'.repeat(total - filled);
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

const REPLY_OPTS = { parse_mode: 'HTML', disable_web_page_preview: true };

async function sendPanel(ctx, text, keyboard) {
  return ctx.reply(text, { ...REPLY_OPTS, ...(keyboard || {}) });
}

async function editPanel(ctx, messageId, text, keyboard) {
  try {
    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, {
      ...REPLY_OPTS,
      ...(keyboard || {}),
    });
  } catch (_) {
    return null;
  }
}

async function sendMainMenu(ctx, body = '🟢 Status: Online & siap digunakan.\n\nSilakan pilih salah satu menu di bawah ini.') {
  // SENGAJA tidak menghapus pesan apapun di sini — supaya hasil/status
  // sebelumnya (mis. link deploy) tidak pernah hilang saat kembali ke menu.
  await sendPanel(ctx, panel({ heading: '<b>MENU UTAMA</b>', body }), mainMenuMarkup());
}

async function sendPrompt(ctx, heading, body, session) {
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await ctx.reply(panel({ heading: `<b>${escapeHtml(heading)}</b>`, body }), {
    ...REPLY_OPTS,
    ...Markup.forceReply(),
  });
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
  return message;
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
    throw new Error('Vercel menolak deployment (Not authorized). Periksa VERCEL_TOKEN — pastikan token masih berlaku dan dibuat dari akun/scope yang benar.');
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

async function getCleanProductionUrl(deploymentId, teamId, projectName) {
  // Deployment yang baru dibuat punya URL unik berisi hash acak
  // (mis. nama-b9gt875u5-user.vercel.app). Alias "bersih" produksi
  // (nama.vercel.app) baru muncul di endpoint alias terpisah, kadang
  // butuh beberapa detik setelah status READY. Kita coba ambil,
  // dengan fallback ke pola nama project kalau belum kebentuk.
  try {
    const response = await axios.get(`${VERCEL_API}/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
      headers: vercelHeaders,
      params: teamId ? { teamId } : undefined,
      timeout: 30000,
    });
    const aliases = (response.data?.aliases || []).map((a) => a.alias).filter(Boolean);
    const clean = aliases.find((alias) => alias === `${projectName}.vercel.app`) ||
      aliases.find((alias) => !/-[a-z0-9]{9,}(-[a-z0-9-]+)?\.vercel\.app$/i.test(alias)) ||
      aliases[0];
    if (clean) return clean;
  } catch (_) {}
  return `${projectName}.vercel.app`;
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
  throw new Error('Deployment belum selesai dalam 3 menit. Periksa lagi beberapa saat lagi.');
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

async function tryGetVercelProject(idOrName) {
  const scopes = [null, ...(await getVercelTeamIds())];
  for (const teamId of scopes) {
    try {
      const response = await axios.get(`${VERCEL_API}/v9/projects/${encodeURIComponent(idOrName)}`, {
        headers: vercelHeaders,
        params: teamId ? { teamId } : undefined,
        timeout: 20000,
      });
      return { ...response.data, teamId: teamId || null };
    } catch (_) {
      // coba scope berikutnya
    }
  }
  return null;
}

async function findProjectByDeploymentHost(host) {
  // Cocokkan persis ke deployment.url (bukan menebak pola nama), ini yang
  // paling akurat untuk link lama berformat "nama-hashacak-teamslug.vercel.app"
  // karena teamslug sendiri bisa berisi tanda "-" sehingga tebak-tebakan
  // pemotongan teks jadi tidak bisa diandalkan.
  const scopes = [null, ...(await getVercelTeamIds())];
  for (const teamId of scopes) {
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      try {
        const response = await axios.get(`${VERCEL_API}/v6/deployments`, {
          headers: vercelHeaders,
          params: { teamId: teamId || undefined, limit: 100, until: cursor },
          timeout: 30000,
        });
        const deployments = response.data?.deployments || [];
        const match = deployments.find((d) => d.url === host);
        if (match?.projectId) {
          const project = await tryGetVercelProject(match.projectId);
          if (project) return project;
        }
        cursor = response.data?.pagination?.next;
        if (!cursor) break;
      } catch (_) {
        break;
      }
    }
  }
  return null;
}

async function resolveVercelProjectFromUrl(urlInput) {
  let value = String(urlInput).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch (_) {
    throw new Error('Link tidak valid. Kirim URL lengkap, contoh: https://nama-web.vercel.app');
  }
  if (!host.endsWith('.vercel.app')) {
    throw new Error('Link harus berupa domain *.vercel.app hasil deploy Cloud Logic.');
  }

  const baseSlug = host.slice(0, -'.vercel.app'.length);

  // 1) Coba langsung: cocok untuk link bersih (nama-project.vercel.app)
  let project = await tryGetVercelProject(baseSlug);
  if (project) return project;

  // 2) Coba cocokkan persis ke deployment aslinya (akurat untuk link lama
  //    yang masih ada hash acak di belakangnya)
  project = await findProjectByDeploymentHost(host);
  if (project) return project;

  throw new Error(`Project Vercel untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy Cloud Logic.`);
}

async function deleteVercelProject(project) {
  await axios.delete(`${VERCEL_API}/v9/projects/${encodeURIComponent(project.id)}`, {
    headers: vercelHeaders,
    params: project.teamId ? { teamId: project.teamId } : undefined,
    timeout: 30000,
  });
}

async function findGithubRepoByProjectName(projectName) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubApi('GET', '/user/repos', undefined, {
      params: { per_page: 100, page, affiliation: 'owner' },
    });
    const match = response.data.find((r) => r.name.toLowerCase().replace(/_/g, '-') === projectName);
    if (match) return match;
    if (response.data.length < 100) break;
  }
  return null;
}

async function deleteGithubRepo(owner, repoName) {
  await githubApi('DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
}

// ─────────────────────────────────────────────
// GET SOURCE — pengambilan HTML + CSS + JS + asset publik
//
// Selain membaca HTML utama, fungsi ini SEKARANG juga membuka tiap file
// CSS yang ditemukan untuk mencari referensi asset di dalamnya
// (url(...) dan @import) — jadi background-image / font yang dipanggil
// dari dalam CSS ikut terbawa, bukan cuma asset yang direferensikan
// langsung dari tag HTML.
// ─────────────────────────────────────────────

function looksLikeSpaShell(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;
  const textOnly = bodyContent.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();
  const hasRootMount = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html);
  return hasRootMount && textOnly.length < 40;
}

async function getPublicSource(url) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('URL harus http atau https.');

  const response = await axios.get(base.href, {
    timeout: 30000,
    responseType: 'text',
    maxRedirects: 5,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CloudLogicSourceFetcher/1.0)' },
  });

  const html = String(response.data);
  const zip = new JSZip();
  zip.file('index.html', html);

  const visited = new Set();
  const queue = [];
  const addAsset = (candidate, refBase) => {
    try {
      const absolute = new URL(candidate, refBase);
      if (!['http:', 'https:'].includes(absolute.protocol)) return;
      const clean = absolute.href.split('#')[0];
      if (visited.has(clean)) return;
      visited.add(clean);
      queue.push(clean);
    } catch (_) {}
  };

  const extractFromHtml = (text, refBase) => {
    for (const match of text.matchAll(/<(?:script|link|img|source|video|audio)[^>]+(?:src|href)=['"]([^'"]+)['"]/gi)) addAsset(match[1], refBase);
    for (const match of text.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)) addAsset(match[1], refBase);
  };
  extractFromHtml(html, base.href);

  let downloaded = 0;
  const MAX_ASSETS = 100;
  const MAX_CSS_SCAN = 25;
  let cssScanned = 0;

  while (queue.length && downloaded < MAX_ASSETS) {
    const assetUrl = queue.shift();
    try {
      const asset = await axios.get(assetUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 5,
        maxContentLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CloudLogicSourceFetcher/1.0)' },
      });
      const parsedUrl = new URL(assetUrl);
      const fileName = parsedUrl.pathname.split('/').filter(Boolean).pop() || `asset-${downloaded}`;
      const buffer = Buffer.from(asset.data);
      zip.file(`assets/${downloaded}-${fileName}`, buffer);
      downloaded += 1;

      const contentType = String(asset.headers?.['content-type'] || '');
      const isCss = /\.css($|\?)/i.test(fileName) || contentType.includes('text/css');
      if (isCss && cssScanned < MAX_CSS_SCAN) {
        cssScanned += 1;
        const cssText = buffer.toString('utf8');
        for (const match of cssText.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)) addAsset(match[1], assetUrl);
        for (const match of cssText.matchAll(/@import\s+['"]([^'"]+)['"]/gi)) addAsset(match[1], assetUrl);
      }
    } catch (_) {
      // Asset gagal diambil (mis. diblokir CORS/hotlink protection) — lewati,
      // jangan gagalkan keseluruhan proses.
    }
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: zipBuffer, assetCount: downloaded, isSpaLikely: looksLikeSpaShell(html) };
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

// ─────────────────────────────────────────────
// DEPLOY — dashboard log + hasil premium
// ─────────────────────────────────────────────

async function runDeployment(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const modeLabel = session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML';
  const startedAt = Date.now();

  const render = async (percent, activity) => {
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', escapeHtml(modeLabel)],
        ['📦 Nama Web', `<code>${escapeHtml(repoName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
        ['📝 Activity', escapeHtml(activity)],
      ]),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
  };

  await render(5, 'Menyiapkan berkas…');

  try {
    // Backup ke GitHub bersifat opsional (tidak ditampilkan ke pengguna) dan
    // TIDAK BOLEH menggagalkan keseluruhan proses deploy kalau bermasalah,
    // karena deploy ke Vercel sekarang sepenuhnya independen dari GitHub.
    try {
      const repo = await createGitHubRepo(repoName);
      await uploadFilesToNewRepo(repo, session.files);
    } catch (_) {
      // backup gagal, tetap lanjut — bukan kegagalan fatal
    }

    await render(30, 'Mengunggah berkas ke server…');

    const deployment = await createVercelDeployment(repoName, session.files);
    await render(45, 'Menunggu antrian build…');

    const final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
      if (state === 'BUILDING') await render(70, 'Membangun & mengoptimasi website…');
      else if (state === 'READY') await render(95, 'Menyelesaikan…');
      else if (state === 'QUEUED' || state === 'INITIALIZING') await render(50, 'Dalam antrian build…');
      else await render(60, `Status: ${state || 'memproses'}…`);
    });

    if ((final.readyState || final.state) !== 'READY') {
      throw new Error(`Build berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
    }

    await render(98, 'Mengambil link publik…');
    const cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectSafeName(repoName));
    const url = `https://${cleanHost}`;
    const elapsed = formatElapsed(Date.now() - startedAt);

    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY BERHASIL ✅️</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['🔄 Link web', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: '🚀  Selamat menggunakan web',
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY GAGAL ❌</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: '🔁 Silakan coba lagi dari menu utama',
    }), homeButton());
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
  // TIDAK menghapus pesan apapun — lihat catatan di bagian UI HELPERS.
  return sendMainMenu(ctx);
});

bot.action('deploy_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy HTML',
    '🚀 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', step: 'file' }
  );
});

bot.action('deploy_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy ZIP',
    '📦 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ Wajib ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', step: 'file' }
  );
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Get Source',
    '🌐 <b>Kirim URL Website</b>\n\nKirim alamat lengkap website publik (contoh: <code>https://contoh.com</code>) yang ingin diambil HTML, CSS, JavaScript, dan asset-nya menjadi satu file ZIP.\n\n<i>Catatan: website berbasis React/Vue/Next.js (SPA) kontennya dirender oleh JavaScript di browser, jadi HTML mentahnya bisa saja terlihat kosong — bot akan memberi tahu kalau situsnya terdeteksi seperti itu.</i>',
    { type: 'source', step: 'url' }
  );
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Encrypt HTML',
    '🛡️ <b>Langkah 1 dari 3 — Kirim File</b>\n\nUnggah 1 file <code>.html</code> yang ingin dikunci dengan password (AES-256-GCM).',
    { type: 'encrypt', step: 'file' }
  );
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa koneksi…');
  const status = await sendPanel(ctx, panel({ heading: '<b>SYSTEM CHECK</b>', body: '⏳ Memeriksa koneksi Telegram, GitHub, dan Vercel…' }));
  const rows = [];
  try { await checkGitHub(); rows.push(['🐙 GitHub API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['🐙 GitHub API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  try { await checkVercel(); rows.push(['▲ Vercel API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['▲ Vercel API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  rows.push(['✈️ Telegram', '🟢 <b>Aktif</b>']);
  await editPanel(ctx, status.message_id, panel({ heading: '<b>SYSTEM STATUS</b>', box: infoBox(rows) }), homeButton());
});

bot.action('add_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await sendPrompt(
    ctx,
    'Add User',
    '👤 <b>Kirim Telegram ID</b>\n\nKirim angka Telegram ID user yang ingin diberi akses ke bot ini.\n\n<i>Tidak tahu ID Telegram seseorang? Minta mereka forward pesan apapun ke bot @userinfobot.</i>',
    { type: 'add_user', step: 'id' }
  );
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  const ids = [...allowedUsers].filter((x) => x !== OWNER_ID);
  const list = ids.length ? ids.map((x, i) => `${i + 1}. <code>${x}</code>`).join('\n') : '<i>Belum ada user tambahan.</i>';
  await sendPanel(ctx, panel({
    heading: '<b>AUTHORIZED USERS</b>',
    box: infoBox([
      ['👑 Owner', `<code>${OWNER_ID}</code>`],
      ['👤 User tambahan', `<b>${ids.length}</b>`],
    ]),
    body: list,
  }), homeButton());
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Delete Web',
    '🗑️ <b>Kirim Link Website</b>\n\nKirim link website hasil deploy Cloud Logic yang ingin dihapus.\nContoh: <code>https://nama-web.vercel.app</code>\n\nWebsite (Vercel) dan repository (GitHub) yang cocok akan otomatis ikut terhapus — tidak perlu cari ID atau buka dashboard.',
    { type: 'delete', step: 'link' }
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
      await sendPrompt(ctx, 'Add User', '❌ <b>ID tidak valid.</b>\n\nKirim ulang dalam bentuk angka saja, contoh: <code>123456789</code>.', session);
      return;
    }
    allowedUsers.add(target);
    try {
      await saveUsers();
      sessions.delete(id);
      await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: `✅ User <code>${target}</code> berhasil ditambahkan dan sekarang punya akses ke bot ini.` }), homeButton());
    } catch (error) {
      allowedUsers.delete(target);
      sessions.delete(id);
      await sendPanel(ctx, panel({ heading: '<b>ADD USER GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'source' && session.step === 'url') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>GET SOURCE</b>', body: '⏳ Mengambil HTML, CSS, JavaScript, dan asset publik…' }));
    try {
      const result = await getPublicSource(text);
      await ctx.replyWithDocument({ source: result.buffer, filename: 'source-public.zip' }, { caption: '✅ Source publik berhasil dibundel menjadi ZIP.' });
      const note = result.isSpaLikely
        ? '⚠️ Website ini kemungkinan React/Vue/Next.js (SPA) — tampilan aslinya dirender JavaScript di browser, jadi HTML mentah di dalam ZIP bisa terlihat seperti kerangka kosong.'
        : 'Semua asset (CSS, JS, gambar, font) yang bisa diakses publik — termasuk yang dirujuk dari dalam file CSS — sudah dibundel.';
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET SOURCE SELESAI ✅</b>',
        box: infoBox([
          ['🌐 Sumber', `<code>${escapeHtml(text)}</code>`],
          ['📦 Asset', `<b>${result.assetCount}</b> file`],
        ]),
        body: note,
      }), homeButton());
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>GET SOURCE GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'delete' && session.step === 'link') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>DELETE WEB</b>', body: '⏳ Mencari project dari link…' }));
    try {
      const project = await resolveVercelProjectFromUrl(text);

      await editPanel(ctx, status.message_id, panel({
        heading: '<b>DELETE WEB</b>',
        body: `🌐 Project ditemukan: <code>${escapeHtml(project.name)}</code>\n\n⏳ Menghapus website & deployment di Vercel…`,
      }));
      await deleteVercelProject(project);

      let repoStatus = '⚠️ Repository tidak ditemukan otomatis';
      try {
        const repo = await findGithubRepoByProjectName(project.name);
        if (repo) {
          await editPanel(ctx, status.message_id, panel({
            heading: '<b>DELETE WEB</b>',
            body: `🌐 Project: <code>${escapeHtml(project.name)}</code>\n✅ Website Vercel dihapus.\n\n⏳ Menghapus repository…`,
          }));
          await deleteGithubRepo(repo.owner.login, repo.name);
          repoStatus = '✅ Ikut dihapus';
        }
      } catch (repoError) {
        repoStatus = `⚠️ Gagal dihapus: ${errorMessage(repoError)}`;
      }

      await editPanel(ctx, status.message_id, panel({
        heading: '<b>WEB DIHAPUS ✅</b>',
        box: infoBox([
          ['📦 Project', escapeHtml(project.name)],
          ['🌐 Website', '✅ Dihapus'],
          ['📁 Repository', escapeHtml(repoStatus)],
        ]),
      }), homeButton());
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>DELETE GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'password') {
    session.password = text;
    session.step = 'confirm';
    sessions.set(id, session);
    await sendPrompt(ctx, 'Encrypt HTML', '🔐 <b>Langkah 3 dari 3 — Konfirmasi</b>\n\nKetik ulang password yang sama persis untuk konfirmasi.', session);
    return;
  }

  if (session.type === 'encrypt' && session.step === 'confirm') {
    if (text !== session.password) {
      await sendPrompt(ctx, 'Encrypt HTML', '❌ <b>Password tidak sama.</b>\n\nKirim ulang password yang benar (harus sama persis dengan langkah sebelumnya).', session);
      return;
    }
    sessions.delete(id);
    const encrypted = encryptedHtml(session.fileBuffer.toString('utf8'), session.password);
    await ctx.replyWithDocument({ source: Buffer.from(encrypted, 'utf8'), filename: `${session.fileName.replace(/\.html?$/i, '')}-encrypted.html` }, { caption: '✅ HTML berhasil dienkripsi dengan AES-256.' });
    await sendPanel(ctx, panel({
      heading: '<b>ENCRYPT SELESAI ✅</b>',
      body: 'File terenkripsi sudah dikirim di atas. Simpan passwordnya baik-baik — tanpa password, isi file tidak bisa dibuka lagi.',
    }), homeButton());
    return;
  }

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'name') {
    session.name = repoSafeName(text);
    session.step = 'deploying';
    sessions.set(id, session);
    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', escapeHtml(session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML')],
        ['📦 Nama Web', `<code>${escapeHtml(session.name)}</code>`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
    await runDeployment(ctx, session, status);
    return;
  }

  if (session.type === 'deploy_html' || session.type === 'deploy_zip') {
    await sendPrompt(ctx, 'Deploy', 'Tahap ini belum meminta nama website. Ikuti instruksi terakhir dari bot di atas, atau tekan tombol Menu Utama untuk mengulang.', session);
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
      await sendPrompt(ctx, 'Deploy HTML', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = [{ path: 'index.html', buffer }];
      session.step = 'name';
      await sendPrompt(ctx, 'Deploy HTML', `📄 File diterima: <code>${escapeHtml(fileName)}</code>\n\n🚀 <b>Langkah 2 dari 2 — Nama Website</b>\n\nKirim nama repository/website (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>toko-online-saya</code>`, session);
    } catch (error) {
      await sendPrompt(ctx, 'Deploy HTML', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_zip' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, 'Deploy ZIP', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.zip</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = await extractZip(buffer);
      session.step = 'name';
      await sendPrompt(ctx, 'Deploy ZIP', `📦 ZIP diterima: <b>${session.files.length}</b> file ditemukan.\n\n🚀 <b>Langkah 2 dari 2 — Nama Website</b>\n\nKirim nama repository/website (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>toko-online-saya</code>`, session);
    } catch (error) {
      await sendPrompt(ctx, 'Deploy ZIP', `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'file') {
    if (!/\.html?$/i.test(fileName)) {
      await sendPrompt(ctx, 'Encrypt HTML', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      session.fileBuffer = await downloadTelegramFile(ctx, document.file_id);
      session.fileName = fileName;
      session.step = 'password';
      await sendPrompt(ctx, 'Encrypt HTML', `📄 File diterima: <code>${escapeHtml(fileName)}</code>\n\n🔐 <b>Langkah 2 dari 3 — Password</b>\n\nKirim password yang akan dipakai untuk mengunci file ini.`, session);
    } catch (error) {
      await sendPrompt(ctx, 'Encrypt HTML', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
  }
});

bot.command('adduser', async (ctx) => {
  if (uid(ctx) !== OWNER_ID) return;
  const target = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(target) || target <= 0) {
    await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: '❌ Format salah. Gunakan: <code>/adduser 123456789</code>' }));
    return;
  }
  allowedUsers.add(target);
  try {
    await saveUsers();
    await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: `✅ User <code>${target}</code> berhasil ditambahkan.` }), homeButton());
  } catch (error) {
    allowedUsers.delete(target);
    await sendPanel(ctx, panel({ heading: '<b>ADD USER GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
  }
});

bot.command('cancel', async (ctx) => {
  const session = sessions.get(uid(ctx));
  if (session?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  sessions.delete(uid(ctx));
  await sendPanel(ctx, panel({ heading: '<b>DIBATALKAN ↩️</b>', body: 'Proses yang sedang berjalan sudah dibatalkan.' }), homeButton());
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
  return res.status(200).send('⚡ Cloud Logic Bot Online');
};
