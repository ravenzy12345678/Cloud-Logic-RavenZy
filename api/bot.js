const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const FormData = require('form-data');

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
  NETLIFY_TOKEN: process.env.NETLIFY_TOKEN,
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
const NETLIFY_API = 'https://api.netlify.com/api/v1';
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${ENV.GH_TOKEN}`,
  'X-GitHub-Api-Version': '2022-11-28',
};
const vercelHeaders = {
  Authorization: `Bearer ${ENV.VERCEL_TOKEN}`,
  'Content-Type': 'application/json',
};
const netlifyHeaders = {
  Authorization: `Bearer ${ENV.NETLIFY_TOKEN}`,
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
    [Markup.button.callback('🚀  Deploy Vercel', 'deploy_vercel'), Markup.button.callback('☁️  Deploy Netlify', 'deploy_netlify')],
    [Markup.button.callback('🌐  Get Source', 'get_source'), Markup.button.callback('🛡️  Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🖼️  Foto ke URL', 'photo_url'), Markup.button.callback('🎵  Audio ke URL', 'audio_url')],
    [Markup.button.callback('📸  Screenshot URL', 'screenshot_url'), Markup.button.callback('📦  Get Repo ZIP', 'repo_zip')],
    [Markup.button.callback('🔎  Cari Repo GitHub', 'search_repo'), Markup.button.callback('🤖  Generate Bot', 'generate_bot')],
    [Markup.button.callback('📋  List Web', 'list_web'), Markup.button.callback('🗑️  Delete Web', 'delete_web')],
    [Markup.button.callback('📡  System Check', 'system'), Markup.button.callback('ℹ️  Bantuan', 'help_info')],
    [Markup.button.callback('👤  Add User', 'add_user'), Markup.button.callback('👥  Users', 'users')],
    [Markup.button.callback('📢  Broadcast', 'broadcast')],
  ]);
}

function fileTypeMarkup(platform) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄  Deploy HTML', `${platform}_html`), Markup.button.callback('📦  Deploy ZIP', `${platform}_zip`)],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

// Alur "Tambah .env" cuma untuk Vercel (env var Vercel cuma kepakai kalau
// project punya backend/serverless function di folder api/, tidak berlaku
// untuk website statis biasa — sudah dijelaskan ke user di teks prompt-nya).
async function askForWebsiteName(ctx, session, prefixText = '') {
  session.step = 'name';
  const platformLabel = session.platform === 'netlify' ? 'Netlify' : 'Vercel';
  const title = `${session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML'} — ${platformLabel}`;
  const body = `${prefixText ? `${prefixText}\n\n` : ''}🚀 <b>Langkah Terakhir — Nama Website</b>\n\nKirim nama repository/website (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>toko-online-saya</code>`;
  await sendPrompt(ctx, title, body, session);
}

async function askEnvChoiceOrName(ctx, session, prefixText) {
  if (session.platform !== 'vercel') {
    await askForWebsiteName(ctx, session, prefixText);
    return;
  }
  session.step = 'env_choice';
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await sendPanel(ctx, panel({
    heading: `<b>${escapeHtml(session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML')} — Vercel</b>`,
    body: `${prefixText}\n\n⚙️ <b>Tambahkan Environment Variable (.env)?</b>\n\nKalau project ini punya backend/serverless function (folder <code>api/</code>) yang butuh secret/token, bisa ditambahkan dulu sebelum deploy. Kalau cuma website statis biasa, aman untuk Lewati.`,
  }), Markup.inlineKeyboard([
    [Markup.button.callback('➕  Tambah .env', 'env_add'), Markup.button.callback('⏭️  Lewati', 'env_skip')],
  ]));
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
}

// Beda dari alur .env di Deploy Vercel: Generate Bot LANGSUNG masuk ke
// pengisian .env (tidak ada opsi "Lewati"), karena bot Telegram nyaris
// selalu butuh minimal TOKEN_BOT supaya bisa berfungsi sama sekali.
async function startGenerateBotEnvCollection(ctx, session, prefixText) {
  session.envVars = session.envVars || [];
  session.step = 'gb_env_key';
  const body = `${prefixText ? `${prefixText}\n\n` : ''}🔑 <b>Kirim KEY</b> environment variable pertama.\nContoh: <code>TOKEN_BOT</code> (wajib ada supaya bot bisa login ke Telegram)`;
  await sendPrompt(ctx, 'Generate Bot — .env', body, session);
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

// ─────────────────────────────────────────────
// RIWAYAT DEPLOY — dipakai fitur "List Web". Disimpan di file JSON yang
// sama polanya dengan daftar user (di repo backup GitHub), supaya List Web
// benar-benar berisi data deploy asli, bukan data karangan/simulasi.
// ─────────────────────────────────────────────

async function loadDeployments() {
  try {
    const file = await getBotRepoFile('cloud-logic-deployments.json');
    if (!file?.content) return [];
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function recordDeployment(entry) {
  // Best-effort: kalau gagal simpan catatan, JANGAN gagalkan proses deploy
  // itu sendiri. Ada 1x retry kalau kena konflik versi (409) karena ada
  // proses lain yang menulis file yang sama nyaris bersamaan.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile('cloud-logic-deployments.json');
      let list = [];
      if (file?.content) {
        try {
          list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
        } catch (_) {
          list = [];
        }
        if (!Array.isArray(list)) list = [];
      }
      list.push(entry);
      if (list.length > 200) list = list.slice(list.length - 200);
      await writeBotRepoFile(
        'cloud-logic-deployments.json',
        JSON.stringify(list, null, 2),
        'chore: record Cloud Logic deployment',
        file?.sha
      );
      return;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      return;
    }
  }
}

async function removeDeploymentRecord(name, platform) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile('cloud-logic-deployments.json');
      if (!file?.content) return;
      let list = [];
      try {
        list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      } catch (_) {
        return;
      }
      if (!Array.isArray(list)) return;
      const filtered = list.filter((d) => !(d.name === name && d.platform === platform));
      if (filtered.length === list.length) return;
      await writeBotRepoFile(
        'cloud-logic-deployments.json',
        JSON.stringify(filtered, null, 2),
        'chore: remove Cloud Logic deployment record',
        file.sha
      );
      return;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      return;
    }
  }
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

// ─────────────────────────────────────────────
// VERCEL PROJECT + ENV VAR — dipakai untuk fitur "Tambah .env" (Deploy) dan
// "Generate Bot". Project harus dibuat/ada duluan sebelum env var bisa
// ditempel, dan env var harus sudah ada sebelum deployment dibuat supaya
// langsung terpakai deployment pertamanya.
// ─────────────────────────────────────────────

async function ensureVercelProject(name) {
  const projectName = projectSafeName(name);
  const existing = await tryGetVercelProject(projectName);
  if (existing) return existing;

  const scopes = [null, ...(await getVercelTeamIds())];
  let lastError;
  for (const teamId of scopes) {
    try {
      const response = await axios.post(`${VERCEL_API}/v10/projects`, { name: projectName }, {
        headers: vercelHeaders,
        params: teamId ? { teamId } : undefined,
        timeout: 30000,
      });
      return { ...response.data, teamId: teamId || null };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (![401, 403].includes(status)) break;
    }
  }
  throw new Error(`Gagal membuat project Vercel: ${errorMessage(lastError)}`);
}

async function pushVercelEnvVars(project, envVars) {
  if (!envVars || !envVars.length) return;
  for (const { key, value } of envVars) {
    await axios.post(`${VERCEL_API}/v10/projects/${encodeURIComponent(project.id)}/env`, {
      key,
      value,
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }, {
      headers: vercelHeaders,
      params: project.teamId ? { teamId: project.teamId } : undefined,
      timeout: 20000,
    });
  }
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

// ─────────────────────────────────────────────
// NETLIFY — deploy langsung via upload ZIP, tanpa GitHub sama sekali
// (pola yang sama seperti deploy file langsung ke Vercel)
// ─────────────────────────────────────────────

async function zipFiles(files) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path.replace(/^\/+/, ''), file.buffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createNetlifySite(name) {
  if (!ENV.NETLIFY_TOKEN) throw new Error('NETLIFY_TOKEN belum diatur di environment variable bot.');
  const response = await axios.post(`${NETLIFY_API}/sites`, { name: projectSafeName(name) }, {
    headers: { ...netlifyHeaders, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return response.data;
}

async function deployZipToNetlifyBuilds(siteId, zipBuffer) {
  // PAKAI Build API (multipart/form-data ke /builds), BUKAN kirim ZIP mentah
  // langsung ke /deploys. Metode raw-zip (Content-Type: application/zip)
  // punya bug lama di Netlify: HTML kadang ke-serve sebagai teks mentah
  // (Content-Type salah), bukan di-render sebagai halaman web. Build API
  // ini yang resmi direkomendasikan Netlify untuk deploy otomatis via tools.
  const form = new FormData();
  form.append('title', 'Cloud Logic deployment');
  form.append('zip', zipBuffer, { filename: 'site.zip', contentType: 'application/zip' });

  const response = await axios.post(`${NETLIFY_API}/sites/${encodeURIComponent(siteId)}/builds`, form, {
    headers: { ...netlifyHeaders, ...form.getHeaders() },
    timeout: 120000,
    maxBodyLength: 60 * 1024 * 1024,
    maxContentLength: 60 * 1024 * 1024,
  });

  const deployId = response.data?.deploy_id || response.data?.deploy?.id || response.data?.id;
  if (!deployId) {
    throw new Error('Netlify tidak mengembalikan deploy_id dari proses build.');
  }
  return { ...response.data, deployId };
}

async function getNetlifyDeploy(deployId) {
  const response = await axios.get(`${NETLIFY_API}/deploys/${encodeURIComponent(deployId)}`, {
    headers: netlifyHeaders,
    timeout: 20000,
  });
  return response.data;
}

async function waitForNetlifyDeploy(deployId, timeoutMs = 180000, onStatus) {
  const start = Date.now();
  let lastState = '';
  while (Date.now() - start < timeoutMs) {
    const deploy = await getNetlifyDeploy(deployId);
    const state = deploy.state || '';
    if (state !== lastState) {
      lastState = state;
      if (onStatus) await onStatus(state, deploy);
    }
    if (['ready', 'error'].includes(state)) return deploy;
    await sleep(4000);
  }
  throw new Error('Deploy Netlify belum selesai dalam 3 menit. Periksa lagi beberapa saat lagi.');
}

async function checkNetlify() {
  const r = await axios.get(`${NETLIFY_API}/user`, { headers: netlifyHeaders, timeout: 30000 });
  return r.data;
}

// ─────────────────────────────────────────────
// SCREENSHOT URL — pakai layanan publik thum.io, tidak butuh API key.
// ─────────────────────────────────────────────

async function screenshotUrl(targetUrl) {
  let value = String(targetUrl).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    new URL(value); // validasi format
  } catch (_) {
    throw new Error('URL tidak valid.');
  }
  const shotUrl = `https://image.thum.io/get/width/1200/noanimate/${value}`;
  const response = await axios.get(shotUrl, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 15 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CloudLogicScreenshot/1.0)' },
  });
  const contentType = String(response.headers?.['content-type'] || '');
  if (!contentType.startsWith('image/')) {
    throw new Error('Gagal mengambil screenshot — situs mungkin tidak dapat diakses publik.');
  }
  return Buffer.from(response.data);
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

// Versi lebih longgar buat fitur Generate Bot — TIDAK mewajibkan index.html
// (project bot backend nggak butuh itu), cukup ratakan folder pembungkus
// tunggal kalau ada, sisanya diserahkan apa adanya.
async function extractZipGeneric(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const raw = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const clean = normalizeZipPath(path);
    if (!clean) continue;
    raw.push({ path: clean, buffer: await entry.async('nodebuffer') });
  }
  if (!raw.length) throw new Error('ZIP kosong.');

  const hasPackageJson = raw.some((f) => f.path.toLowerCase() === 'package.json');
  if (hasPackageJson) return raw;

  const topFolders = new Set(raw.map((f) => f.path.split('/')[0]));
  if (topFolders.size === 1) {
    const [prefix] = topFolders;
    const flattened = raw.map((f) => ({ path: f.path.slice(prefix.length + 1), buffer: f.buffer }));
    if (flattened.some((f) => f.path.toLowerCase() === 'package.json')) return flattened;
  }
  return raw;
}

// ─────────────────────────────────────────────
// GENERATE BOT — deteksi otomatis file webhook (bot handler) dari ZIP
// project yang di-upload. Urutan prioritas:
// 1. vercel.json bawaan ZIP (kalau ada, paling akurat, dipakai apa adanya)
// 2. Scan folder api/*.js — 1 file = otomatis, banyak file = tanya user,
//    0 file = webhook tidak didaftarkan otomatis (dijelaskan ke user)
// ─────────────────────────────────────────────

function detectGenerateBotWebhookPath(files) {
  const vercelJsonFile = files.find((f) => f.path.toLowerCase() === 'vercel.json');
  if (vercelJsonFile) {
    try {
      const config = JSON.parse(vercelJsonFile.buffer.toString('utf8'));
      const functionKeys = config?.functions ? Object.keys(config.functions) : [];
      const jsKey = functionKeys.find((k) => /\.js$/i.test(k));
      if (jsKey) return { path: jsKey.replace(/^\/+/, ''), source: 'vercel.json', candidates: null };

      if (Array.isArray(config?.rewrites)) {
        for (const rule of config.rewrites) {
          if (typeof rule?.destination === 'string' && /^\/?api\/.+\.js$/i.test(rule.destination)) {
            return { path: rule.destination.replace(/^\/+/, ''), source: 'vercel.json (rewrites)', candidates: null };
          }
        }
      }
    } catch (_) {
      // vercel.json tidak valid JSON — lanjut ke fallback scan folder api/
    }
  }

  const apiJsFiles = files
    .map((f) => f.path.replace(/^\/+/, ''))
    .filter((p) => /^api\/[^/]+\.js$/i.test(p));

  if (apiJsFiles.length === 1) {
    return { path: apiJsFiles[0], source: 'terdeteksi otomatis (satu-satunya file di folder api/)', candidates: null };
  }
  if (apiJsFiles.length > 1) {
    return { path: null, source: null, candidates: apiJsFiles };
  }
  return { path: null, source: null, candidates: [] };
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

async function tryGetNetlifySite(idOrName) {
  if (!ENV.NETLIFY_TOKEN) return null;
  try {
    const response = await axios.get(`${NETLIFY_API}/sites/${encodeURIComponent(idOrName)}`, {
      headers: netlifyHeaders,
      timeout: 20000,
    });
    return response.data;
  } catch (_) {
    return null;
  }
}

async function findNetlifySiteByHost(host) {
  // Fallback kalau site_id/name langsung tidak cocok (mis. site sudah pakai
  // custom domain tapi kita masih terima link *.netlify.app lama, atau
  // sebaliknya) — telusuri daftar site milik akun dan cocokkan.
  if (!ENV.NETLIFY_TOKEN) return null;
  for (let page = 1; page <= 10; page += 1) {
    try {
      const response = await axios.get(`${NETLIFY_API}/sites`, {
        headers: netlifyHeaders,
        params: { per_page: 100, page },
        timeout: 30000,
      });
      const sites = response.data || [];
      const match = sites.find((s) =>
        (s.name && `${s.name}.netlify.app` === host) ||
        s.custom_domain === host ||
        s.ssl_url === `https://${host}` ||
        s.url === `http://${host}`
      );
      if (match) return match;
      if (sites.length < 100) break;
    } catch (_) {
      break;
    }
  }
  return null;
}

async function resolveNetlifySiteFromUrl(urlInput) {
  if (!ENV.NETLIFY_TOKEN) throw new Error('NETLIFY_TOKEN belum diatur di environment variable bot.');
  let value = String(urlInput).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch (_) {
    throw new Error('Link tidak valid. Kirim URL lengkap, contoh: https://nama-web.netlify.app');
  }
  if (!host.endsWith('.netlify.app')) {
    throw new Error('Link harus berupa domain *.netlify.app hasil deploy Cloud Logic.');
  }

  const baseSlug = host.slice(0, -'.netlify.app'.length);
  let site = await tryGetNetlifySite(baseSlug);
  if (site) return site;

  site = await findNetlifySiteByHost(host);
  if (site) return site;

  throw new Error(`Site Netlify untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy Cloud Logic.`);
}

async function deleteNetlifySite(site) {
  await axios.delete(`${NETLIFY_API}/sites/${encodeURIComponent(site.id)}`, {
    headers: netlifyHeaders,
    timeout: 30000,
  });
}

async function resolveDeployTargetFromUrl(urlInput) {
  let value = String(urlInput).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch (_) {
    throw new Error('Link tidak valid. Kirim URL lengkap, contoh: https://nama-web.vercel.app');
  }

  if (host.endsWith('.vercel.app')) {
    const project = await resolveVercelProjectFromUrl(urlInput);
    return { platform: 'vercel', name: project.name, data: project };
  }
  if (host.endsWith('.netlify.app')) {
    const site = await resolveNetlifySiteFromUrl(urlInput);
    return { platform: 'netlify', name: site.name, data: site };
  }
  throw new Error('Link harus berupa domain *.vercel.app atau *.netlify.app hasil deploy Cloud Logic.');
}

async function deleteDeployTarget(target) {
  if (target.platform === 'netlify') return deleteNetlifySite(target.data);
  return deleteVercelProject(target.data);
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
// GET REPO ZIP — ambil ZIP repo GitHub public lewat endpoint resmi GitHub
// (codeload), lalu diteruskan ke Telegram. Bukan scraping.
// ─────────────────────────────────────────────

function parseGithubRepoUrl(input) {
  let value = String(input).trim();
  value = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  value = value.replace(/^github\.com\//i, '');
  value = value.replace(/\.git$/i, '').replace(/\/+$/g, '');
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('Format link salah. Contoh: https://github.com/owner/nama-repo');
  }
  return { owner: parts[0], repo: parts[1] };
}

async function getPublicRepoInfo(owner, repo) {
  try {
    const response = await axios.get(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: ghHeaders,
      timeout: 20000,
    });
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error('Repository tidak ditemukan (mungkin private, salah nama, atau sudah dihapus).');
    }
    throw error;
  }
}

async function downloadRepoZip(owner, repo, branch) {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: 55 * 1024 * 1024,
    maxRedirects: 5,
  });
  return Buffer.from(response.data);
}

async function searchGithubRepos(query, limit = 5) {
  const response = await axios.get(`${GH_API}/search/repositories`, {
    headers: ghHeaders,
    params: { q: query, sort: 'stars', order: 'desc', per_page: limit },
    timeout: 20000,
  });
  return response.data?.items || [];
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
// Ada 2 "publisher": Vercel & Netlify. Keduanya deploy langsung dari file
// (bukan lewat GitHub), jadi sama-sama tidak bergantung pada integrasi
// GitHub App apapun. Tampilan dashboard-nya sama persis untuk keduanya.
// ─────────────────────────────────────────────

async function getVercelBuildLogTail(deploymentId, teamId, maxLines = 15) {
  try {
    const response = await axios.get(`${VERCEL_API}/v2/deployments/${encodeURIComponent(deploymentId)}/events`, {
      headers: vercelHeaders,
      params: { teamId: teamId || undefined, builds: 1 },
      timeout: 20000,
    });
    const events = Array.isArray(response.data) ? response.data : (response.data?.events || []);
    const lines = events
      .map((e) => e?.payload?.text || e?.text)
      .filter(Boolean)
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (!lines.length) return null;
    return lines.slice(-maxLines).join('\n');
  } catch (_) {
    return null;
  }
}

async function publishToVercel(name, files, render, envVars) {
  if (envVars && envVars.length) {
    await render(15, 'Membuat project & menyimpan .env…');
    const project = await ensureVercelProject(name);
    await pushVercelEnvVars(project, envVars);
  }

  await render(30, 'Mengunggah berkas ke Vercel…');
  const deployment = await createVercelDeployment(name, files);
  await render(45, 'Menunggu antrian build…');

  const final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
    if (state === 'BUILDING') await render(70, 'Membangun & mengoptimasi website…');
    else if (state === 'READY') await render(95, 'Menyelesaikan…');
    else if (state === 'QUEUED' || state === 'INITIALIZING') await render(50, 'Dalam antrian build…');
    else await render(60, `Status: ${state || 'memproses'}…`);
  });

  if ((final.readyState || final.state) !== 'READY') {
    const err = new Error(`Build berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
    const logTail = await getVercelBuildLogTail(deployment.id, deployment.teamId);
    if (logTail) err.detail = logTail;
    throw err;
  }

  await render(98, 'Mengambil link publik…');
  const cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectSafeName(name));
  return `https://${cleanHost}`;
}

async function publishToNetlify(name, files, render) {
  await render(20, 'Membuat site Netlify…');
  const site = await createNetlifySite(name);

  await render(40, 'Mengemas berkas menjadi ZIP…');
  const zipBuffer = await zipFiles(files);

  await render(55, 'Mengunggah ke Netlify (Build API)…');
  const build = await deployZipToNetlifyBuilds(site.id, zipBuffer);

  await render(70, 'Menunggu proses publish…');
  const final = await waitForNetlifyDeploy(build.deployId, 180000, async (state) => {
    if (state === 'processing' || state === 'uploaded') await render(85, 'Memproses build Netlify…');
    else if (state === 'ready') await render(97, 'Menyelesaikan…');
    else await render(75, `Status: ${state || 'memproses'}…`);
  });

  if (final.state !== 'ready') {
    const err = new Error(`Deploy Netlify berakhir dengan status ${final.state || 'error'}.`);
    const detailParts = [];
    if (final.error_message) detailParts.push(String(final.error_message));
    if (Array.isArray(final.summary?.messages)) {
      for (const m of final.summary.messages.slice(0, 6)) {
        if (m?.title) detailParts.push(m.description ? `${m.title}: ${m.description}` : String(m.title));
      }
    }
    if (detailParts.length) err.detail = detailParts.join('\n');
    throw err;
  }

  return final.ssl_url || final.url || site.ssl_url || site.url;
}

// ─────────────────────────────────────────────
// FOTO KE URL — upload 1 gambar, dapat link langsung ke file-nya
// (numpang infrastruktur deploy Vercel yang sudah ada, tanpa backup
// GitHub — supaya prosesnya ringan & cepat)
// ─────────────────────────────────────────────

function sanitizeImageFileName(name, fallbackExt, fallbackBase = 'file') {
  let base = String(name || '').trim();
  base = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = `${fallbackBase}.${fallbackExt || 'png'}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += `.${fallbackExt || 'png'}`;
  return base.toLowerCase();
}

const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const AUDIO_MIME_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

async function runFileToUrl(ctx, files, statusMessage, kind = 'foto') {
  const fileName = files[0].path;
  const startedAt = Date.now();
  const projectName = `${kind === 'audio' ? 'aud' : 'img'}-${crypto.randomBytes(4).toString('hex')}`;
  const modeLabel = kind === 'audio' ? 'Audio ke URL' : 'Foto ke URL';
  const fileIcon = kind === 'audio' ? '🎵' : '🖼️';

  const render = async (percent, activity) => {
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', modeLabel],
        [`${fileIcon} File`, `<code>${escapeHtml(fileName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
        ['📝 Activity', escapeHtml(activity)],
      ]),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
  };

  await render(10, `Mengunggah ${kind === 'audio' ? 'audio' : 'foto'}…`);

  try {
    const deployment = await createVercelDeployment(projectName, files);
    await render(50, 'Memproses…');

    const final = await waitForDeployment(deployment.id, deployment.teamId, 120000, async (state) => {
      if (state === 'READY') await render(90, 'Menyelesaikan…');
      else await render(60, `Status: ${state || 'memproses'}…`);
    });

    if ((final.readyState || final.state) !== 'READY') {
      throw new Error(`Upload berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
    }

    const cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectSafeName(projectName));
    const url = `https://${cleanHost}/${fileName}`;
    const elapsed = formatElapsed(Date.now() - startedAt);
    const usageFooter = kind === 'audio'
      ? '💡 Tinggal pasang di HTML:\n<code>&lt;audio src="LINK_DI_ATAS" controls&gt;&lt;/audio&gt;</code>'
      : '💡 Tinggal pasang di HTML:\n<code>&lt;img src="LINK_DI_ATAS"&gt;</code>';

    await editPanel(ctx, statusMessage.message_id, panel({
      heading: `<b>${kind === 'audio' ? 'AUDIO' : 'FOTO'} SIAP DIPAKAI ✅️</b>`,
      box: infoBox([
        [`${fileIcon} File`, escapeHtml(fileName)],
        ['🔗 URL', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: usageFooter,
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>UPLOAD GAGAL ❌</b>',
      box: infoBox([
        [`${fileIcon} File`, escapeHtml(fileName)],
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: '🔁 Silakan coba lagi dari menu utama',
    }), homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}

async function runPhotoUpload(ctx, files, statusMessage) {
  return runFileToUrl(ctx, files, statusMessage, 'foto');
}

async function runDeployment(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const modeLabel = session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML';
  const platform = session.platform === 'netlify' ? 'netlify' : 'vercel';
  const platformLabel = platform === 'netlify' ? 'Netlify' : 'Vercel';
  const startedAt = Date.now();

  const render = async (percent, activity) => {
    const rows = [
      ['📡 Server', '🔵 <b>PROCESSING</b>'],
      ['🛰️ Platform', escapeHtml(platformLabel)],
      ['🔧 Mode', escapeHtml(modeLabel)],
      ['📦 Nama Web', `<code>${escapeHtml(repoName)}</code>`],
    ];
    if (session.envVars?.length) rows.push(['🔐 .env', `<b>${session.envVars.length}</b> variable`]);
    rows.push(['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`]);
    rows.push(['📝 Activity', escapeHtml(activity)]);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox(rows),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
  };

  await render(5, 'Menyiapkan berkas…');

  try {
    // Backup ke GitHub bersifat opsional (tidak ditampilkan ke pengguna) dan
    // TIDAK BOLEH menggagalkan keseluruhan proses deploy kalau bermasalah,
    // karena deploy ke Vercel/Netlify sekarang sepenuhnya independen dari GitHub.
    try {
      const repo = await createGitHubRepo(repoName);
      await uploadFilesToNewRepo(repo, session.files);
    } catch (_) {
      // backup gagal, tetap lanjut — bukan kegagalan fatal
    }

    const publisher = platform === 'netlify' ? publishToNetlify : publishToVercel;
    const url = platform === 'netlify'
      ? await publisher(repoName, session.files, render)
      : await publisher(repoName, session.files, render, session.envVars);
    const elapsed = formatElapsed(Date.now() - startedAt);

    await recordDeployment({
      name: repoName,
      platform,
      url,
      ownerId: uid(ctx),
      ownerUsername: ctx.from?.username || null,
      ts: Date.now(),
    });

    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY BERHASIL ✅️</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['🛰️ Platform', escapeHtml(platformLabel)],
        ['🔄 Link web', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: '🚀  Selamat menggunakan web',
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const logBody = error.detail
      ? `📄 <b>Log Error:</b>\n<pre>${escapeHtml(String(error.detail).slice(0, 700))}</pre>`
      : undefined;
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY GAGAL ❌</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['🛰️ Platform', escapeHtml(platformLabel)],
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: logBody,
      footer: '🔁 Silakan coba lagi dari menu utama',
    }), homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}

// ─────────────────────────────────────────────
// GENERATE BOT — deploy project bot Node.js (webhook-based) secara otomatis:
// bikin project Vercel, push .env, deploy file, lalu (kalau file webhook-nya
// ketemu & ada TOKEN_BOT/BOT_TOKEN di .env) otomatis daftarkan webhook-nya
// ke Telegram lewat setWebhook. Tidak simulasi — semua panggilan API asli.
// ─────────────────────────────────────────────

async function runGenerateBot(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const startedAt = Date.now();
  const envVars = session.envVars || [];

  const render = async (percent, activity) => {
    const rows = [
      ['📡 Server', '🔵 <b>PROCESSING</b>'],
      ['🔧 Mode', 'Generate Bot'],
      ['📦 Nama Bot', `<code>${escapeHtml(repoName)}</code>`],
      ['🔐 .env', `<b>${envVars.length}</b> variable`],
      ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
      ['📝 Activity', escapeHtml(activity)],
    ];
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox(rows),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
  };

  await render(5, 'Menyiapkan berkas…');

  try {
    await render(15, 'Membuat project & menyimpan .env…');
    const project = await ensureVercelProject(repoName);
    await pushVercelEnvVars(project, envVars);

    // Backup ke GitHub bersifat opsional, tidak boleh menggagalkan proses.
    try {
      const repo = await createGitHubRepo(repoName);
      await uploadFilesToNewRepo(repo, session.files);
    } catch (_) {
      // backup gagal, tetap lanjut
    }

    await render(35, 'Mengunggah berkas bot…');
    const deployment = await createVercelDeployment(repoName, session.files);
    await render(50, 'Menunggu antrian build…');

    const final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
      if (state === 'BUILDING') await render(75, 'Membangun…');
      else if (state === 'READY') await render(92, 'Menyelesaikan…');
      else if (state === 'QUEUED' || state === 'INITIALIZING') await render(55, 'Dalam antrian build…');
      else await render(60, `Status: ${state || 'memproses'}…`);
    });

    if ((final.readyState || final.state) !== 'READY') {
      const err = new Error(`Build berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
      const logTail = await getVercelBuildLogTail(deployment.id, deployment.teamId);
      if (logTail) err.detail = logTail;
      throw err;
    }

    const cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectSafeName(repoName));
    const baseUrl = `https://${cleanHost}`;

    let webhookStatus = '⚠️ Tidak ada file webhook terdeteksi — perlu setWebhook manual.';
    if (session.webhookPath) {
      const tokenEntry = envVars.find((e) => /^(TOKEN_BOT|BOT_TOKEN)$/i.test(e.key));
      if (tokenEntry?.value) {
        await render(96, 'Mendaftarkan webhook Telegram…');
        try {
          const webhookUrl = `${baseUrl}/${session.webhookPath}`;
          const setResponse = await axios.get(`https://api.telegram.org/bot${tokenEntry.value}/setWebhook`, {
            params: { url: webhookUrl },
            timeout: 20000,
          });
          webhookStatus = setResponse.data?.ok
            ? '✅ Terdaftar otomatis'
            : `⚠️ Telegram menolak: ${escapeHtml(String(setResponse.data?.description || 'unknown'))}`;
        } catch (webhookError) {
          webhookStatus = `⚠️ Gagal daftar webhook: ${escapeHtml(errorMessage(webhookError))}`;
        }
      } else {
        webhookStatus = '⚠️ Tidak ada TOKEN_BOT/BOT_TOKEN di .env — webhook tidak didaftarkan otomatis.';
      }
    }

    const elapsed = formatElapsed(Date.now() - startedAt);

    await recordDeployment({
      name: repoName,
      platform: 'vercel',
      url: baseUrl,
      ownerId: uid(ctx),
      ownerUsername: ctx.from?.username || null,
      ts: Date.now(),
    });

    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>BOT BERHASIL DIBUAT ✅️</b>',
      box: infoBox([
        ['📦 Nama', escapeHtml(repoName)],
        ['🔗 URL Project', `<a href="${escapeHtml(baseUrl)}">${escapeHtml(baseUrl)}</a>`],
        ['🧩 File Webhook', session.webhookPath ? `<code>/${escapeHtml(session.webhookPath)}</code>` : '<i>tidak ada</i>'],
        ['📡 Status Webhook', webhookStatus],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      footer: '🚀  Bot baru siap dipakai kalau webhook sudah terdaftar',
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const logBody = error.detail
      ? `📄 <b>Log Error:</b>\n<pre>${escapeHtml(String(error.detail).slice(0, 700))}</pre>`
      : undefined;
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>GENERATE BOT GAGAL ❌</b>',
      box: infoBox([
        ['📦 Nama', escapeHtml(repoName)],
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: logBody,
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

bot.action('deploy_vercel', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY VERCEL</b>',
    body: 'Pilih tipe file yang mau di-deploy:',
  }), fileTypeMarkup('vercel'));
});

bot.action('deploy_netlify', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY NETLIFY</b>',
    body: 'Pilih tipe file yang mau di-deploy:',
  }), fileTypeMarkup('netlify'));
});

bot.action('vercel_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy HTML — Vercel',
    '🚀 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', platform: 'vercel', step: 'file' }
  );
});

bot.action('vercel_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy ZIP — Vercel',
    '📦 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ Wajib ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', platform: 'vercel', step: 'file' }
  );
});

bot.action('netlify_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy HTML — Netlify',
    '🚀 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', platform: 'netlify', step: 'file' }
  );
});

bot.action('netlify_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Deploy ZIP — Netlify',
    '📦 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ Wajib ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', platform: 'netlify', step: 'file' }
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
  try { await checkNetlify(); rows.push(['☁️ Netlify API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['☁️ Netlify API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
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
  const buttons = ids.length
    ? Markup.inlineKeyboard([[Markup.button.callback('🗑️  Kelola / Hapus User', 'manage_users')], [Markup.button.callback('🏠  Menu Utama', 'home')]])
    : homeButton();
  await sendPanel(ctx, panel({
    heading: '<b>AUTHORIZED USERS</b>',
    box: infoBox([
      ['👑 Owner', `<code>${OWNER_ID}</code>`],
      ['👤 User tambahan', `<b>${ids.length}</b>`],
    ]),
    body: list,
  }), buttons);
});

bot.action('manage_users', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  const ids = [...allowedUsers].filter((x) => x !== OWNER_ID);
  if (!ids.length) {
    await sendPanel(ctx, panel({ heading: '<b>KELOLA USER</b>', body: '<i>Belum ada user tambahan untuk dihapus.</i>' }), homeButton());
    return;
  }
  const buttons = ids.map((x) => [Markup.button.callback(`❌  Hapus ${x}`, `rmuser_${x}`)]);
  buttons.push([Markup.button.callback('🏠  Menu Utama', 'home')]);
  await sendPanel(ctx, panel({
    heading: '<b>KELOLA USER</b>',
    body: 'Tap salah satu user di bawah untuk mencabut aksesnya dari bot ini.',
  }), Markup.inlineKeyboard(buttons));
});

bot.action(/^rmuser_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  const target = Number(ctx.match[1]);
  if (target === OWNER_ID) {
    await sendPanel(ctx, panel({ heading: '<b>TIDAK BISA ❌</b>', body: 'Owner tidak bisa menghapus dirinya sendiri.' }), homeButton());
    return;
  }
  const existed = allowedUsers.has(target);
  allowedUsers.delete(target);
  try {
    await saveUsers();
    await sendPanel(ctx, panel({ heading: '<b>USER DIHAPUS ✅</b>', body: `User <code>${target}</code> sudah dicabut aksesnya dari bot ini.` }), homeButton());
  } catch (error) {
    if (existed) allowedUsers.add(target);
    await sendPanel(ctx, panel({ heading: '<b>HAPUS USER GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
  }
});

bot.action('list_web', async (ctx) => {
  await ctx.answerCbQuery('Memuat daftar…');
  const all = await loadDeployments();
  const isOwnerView = uid(ctx) === OWNER_ID;
  const relevant = isOwnerView ? all : all.filter((d) => d.ownerId === uid(ctx));
  const recent = relevant.slice(-20).reverse();

  if (!recent.length) {
    await sendPanel(ctx, panel({
      heading: `<b>LIST WEB${isOwnerView ? ' (SEMUA USER)' : ''}</b>`,
      body: isOwnerView ? '<i>Belum ada web yang tercatat.</i>' : '<i>Kamu belum pernah deploy web lewat bot ini.</i>',
    }), homeButton());
    return;
  }

  const lines = recent.map((d, i) => {
    const platformLabel = d.platform === 'netlify' ? 'Netlify' : 'Vercel';
    const who = isOwnerView ? ` — <code>${d.ownerId}</code>` : '';
    return `${i + 1}. <a href="${escapeHtml(d.url)}">${escapeHtml(d.name)}</a> (${escapeHtml(platformLabel)})${who}`;
  });

  await sendPanel(ctx, panel({
    heading: `<b>LIST WEB${isOwnerView ? ' (SEMUA USER)' : ''}</b>`,
    body: lines.join('\n'),
    footer: `Menampilkan ${recent.length} terbaru dari ${relevant.length} total.`,
  }), homeButton());
});

bot.action('broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  if (uid(ctx) !== OWNER_ID) return;
  await sendPrompt(
    ctx,
    'Broadcast',
    '📢 <b>Kirim Pesan Broadcast</b>\n\nKetik pesan yang mau dikirim ke SEMUA user terdaftar di bot ini.',
    { type: 'broadcast', step: 'text' }
  );
});

bot.action('photo_url', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Foto ke URL',
    '🖼️ <b>Kirim Foto/Icon</b>\n\nKirim gambar yang mau dijadikan link (untuk dipakai di <code>&lt;img src&gt;</code> project HTML kamu).\n\nFormat didukung: PNG, JPG, GIF, WEBP, SVG, ICO.\n\n<i>Tips: kirim sebagai File/Dokumen (bukan Foto biasa) kalau mau kualitas asli tanpa dikompres Telegram — cocok buat icon/logo yang butuh tajam.</i>',
    { type: 'photo_url', step: 'file' }
  );
});

bot.action('audio_url', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Audio ke URL',
    '🎵 <b>Kirim File Audio</b>\n\nKirim file audio yang mau dijadikan link (untuk dipakai di <code>&lt;audio src&gt;</code> project HTML kamu).\n\nFormat didukung: MP3, WAV, OGG, M4A, AAC, FLAC.\n\n<i>Kirim sebagai File/Dokumen (bukan Voice Note) supaya kualitas asli tidak dikompres Telegram.</i>',
    { type: 'audio_url', step: 'file' }
  );
});

bot.action('screenshot_url', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Screenshot URL',
    '📸 <b>Kirim URL Website</b>\n\nKirim link website manapun (contoh: <code>https://contoh.com</code>), bot akan mengambil screenshot tampilannya dan mengirim gambarnya ke sini.',
    { type: 'screenshot', step: 'url' }
  );
});

bot.action('repo_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Get Repo ZIP',
    '📦 <b>Kirim Link Repository GitHub</b>\n\nContoh: <code>https://github.com/owner/nama-repo</code>\n\nBot akan mengambil ZIP branch default repo tersebut lewat endpoint resmi GitHub, lalu mengirimnya ke sini.\n\n⚠️ Hanya untuk repository <b>public</b>. Batas ukuran kirim Telegram: 50MB.',
    { type: 'repo_zip', step: 'link' }
  );
});

bot.action('search_repo', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Cari Repo GitHub',
    '🔎 <b>Kirim Kata Kunci</b>\n\nContoh: <code>telegram bot starter</code>\n\nBot akan cari repository GitHub publik yang paling relevan (diurutkan dari yang paling banyak star).',
    { type: 'search_repo', step: 'query' }
  );
});

bot.action('generate_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Generate Bot',
    '🤖 <b>Langkah 1 — Kirim ZIP Project Bot</b>\n\nUpload ZIP project bot Node.js (model <b>webhook</b>, bukan polling) yang mau dideploy otomatis.\n\n⚠️ Wajib ada <code>package.json</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).\n\n<i>Struktur folder bebas — jumlah & nama file di dalam <code>api/</code> boleh apa saja, bot akan coba deteksi otomatis mana file handler-nya.</i>',
    { type: 'generate_bot', step: 'file' }
  );
});

bot.action(/^gbpick_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'generate_bot' || session.step !== 'pick_webhook_file') return;
  const idx = Number(ctx.match[1]);
  const chosen = session.webhookCandidates?.[idx];
  if (!chosen) return;
  session.webhookPath = chosen;
  delete session.webhookCandidates;
  await startGenerateBotEnvCollection(ctx, session, `✅ File webhook dipilih: <code>${escapeHtml(chosen)}</code>`);
});

bot.action('gb_env_more_add', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'generate_bot' || session.step !== 'gb_env_more') return;
  session.step = 'gb_env_key';
  await sendPrompt(ctx, 'Generate Bot — .env', '🔑 <b>Kirim KEY</b> berikutnya\nContoh: <code>ID_PEMILIK</code>', session);
});

bot.action('gb_env_more_done', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'generate_bot' || session.step !== 'gb_env_more') return;
  const hasToken = (session.envVars || []).some((e) => /^(TOKEN_BOT|BOT_TOKEN)$/i.test(e.key));
  session.step = 'gb_name';
  const warn = hasToken ? '' : '⚠️ <i>Tidak ada TOKEN_BOT/BOT_TOKEN — webhook tidak akan otomatis terdaftar, kamu perlu set manual nanti.</i>\n\n';
  await sendPrompt(ctx, 'Generate Bot', `${warn}🚀 <b>Langkah Terakhir — Nama Bot</b>\n\nKirim nama repository/project untuk bot ini (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>bot-kedua-saya</code>`, session);
});

bot.action('help_info', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel({
    heading: '<b>ℹ️ TENTANG BOT INI</b>',
    body:
      'Cloud Logic — bot otomasi deploy website, kelola project, dan utilitas developer. Semua fitur pakai API resmi (GitHub, Vercel, Netlify), tidak ada yang simulasi.\n\n' +
      '<b>Ringkasan fitur:</b>\n' +
      '🚀 Deploy Vercel/Netlify — upload HTML/ZIP, langsung online\n' +
      '⚙️ Tambah .env — isi environment variable sebelum deploy (Vercel)\n' +
      '🌐 Get Source — ambil HTML/CSS/JS dari website publik\n' +
      '🛡️ Encrypt HTML — kunci file HTML pakai password (AES-256)\n' +
      '🖼️🎵 Foto/Audio ke URL — upload file, dapat link langsung\n' +
      '📸 Screenshot URL — ambil gambar tampilan website manapun\n' +
      '📦 Get Repo ZIP — ambil ZIP repo GitHub public\n' +
      '🔎 Cari Repo GitHub — cari repo publik berdasar kata kunci\n' +
      '🤖 Generate Bot — deploy project bot lain (Node.js webhook) otomatis\n' +
      '📋 List Web / 🗑️ Delete Web — kelola website yang sudah live\n' +
      '📢 Broadcast / 👥 Users — khusus owner\n\n' +
      '<i>Developer: Raven</i>\n' +
      '<i>Note: baca dulu instruksi di tiap menu sebelum bertanya — supaya lebih paham cara pakainya.</i>',
  }), homeButton());
});

bot.action('env_add', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_choice') return;
  session.envVars = session.envVars || [];
  session.step = 'env_key';
  await sendPrompt(ctx, 'Tambah .env', `🔑 <b>Kirim KEY</b> (nama environment variable)\nContoh: <code>TOKEN_GITHUB</code>`, session);
});

bot.action('env_skip', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_choice') return;
  await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  await askForWebsiteName(ctx, session);
});

bot.action('env_more_add', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_more') return;
  session.step = 'env_key';
  await sendPrompt(ctx, 'Tambah .env', `🔑 <b>Kirim KEY</b> berikutnya\nContoh: <code>VERCEL_TOKEN</code>`, session);
});

bot.action('env_more_done', async (ctx) => {
  await ctx.answerCbQuery();
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_more') return;
  const count = session.envVars?.length || 0;
  await askForWebsiteName(ctx, session, `✅ <b>${count}</b> environment variable siap ditambahkan saat deploy.`);
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Delete Web',
    '🗑️ <b>Kirim Link Website</b>\n\nKirim link website hasil deploy Cloud Logic yang ingin dihapus.\nContoh: <code>https://nama-web.vercel.app</code> atau <code>https://nama-web.netlify.app</code>\n\nBot otomatis kenali platform-nya dari link. Website (Vercel/Netlify) dan repository (GitHub) yang cocok akan otomatis ikut terhapus — tidak perlu cari ID atau buka dashboard.',
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

  if (session.type === 'broadcast' && session.step === 'text') {
    if (id !== OWNER_ID) return;
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>BROADCAST</b>', body: '⏳ Mengirim pesan ke semua user…' }));

    const targets = [...allowedUsers].filter((x) => x !== id);
    let success = 0;
    let failed = 0;
    for (const targetId of targets) {
      try {
        await bot.telegram.sendMessage(
          targetId,
          panel({ heading: '<b>📢 BROADCAST</b>', body: escapeHtml(text) }),
          REPLY_OPTS
        );
        success += 1;
      } catch (_) {
        failed += 1;
      }
    }

    await editPanel(ctx, status.message_id, panel({
      heading: '<b>BROADCAST SELESAI ✅</b>',
      box: infoBox([
        ['📤 Terkirim', `<b>${success}</b>`],
        ['❌ Gagal', `<b>${failed}</b>`],
        ['👥 Total Target', `<b>${targets.length}</b>`],
      ]),
    }), homeButton());
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

  if (session.type === 'screenshot' && session.step === 'url') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>SCREENSHOT URL</b>', body: '⏳ Mengambil screenshot…' }));
    try {
      const imageBuffer = await screenshotUrl(text);
      await ctx.replyWithPhoto({ source: imageBuffer, filename: 'screenshot.png' }, { caption: `✅ Screenshot dari ${text}` });
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>SCREENSHOT SELESAI ✅</b>',
        box: infoBox([['🌐 URL', `<code>${escapeHtml(text)}</code>`]]),
      }), homeButton());
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>SCREENSHOT GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'repo_zip' && session.step === 'link') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>GET REPO ZIP</b>', body: '⏳ Memeriksa repository…' }));
    try {
      const { owner, repo } = parseGithubRepoUrl(text);
      const info = await getPublicRepoInfo(owner, repo);
      if (info.private) throw new Error('Repository ini private, tidak bisa diambil ZIP-nya lewat fitur ini.');
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET REPO ZIP</b>',
        body: `📦 <code>${escapeHtml(info.full_name)}</code>\n🌿 Branch: <code>${escapeHtml(info.default_branch)}</code>\n\n⏳ Mengunduh ZIP dari GitHub…`,
      }));
      const zipBuffer = await downloadRepoZip(owner, repo, info.default_branch);
      await ctx.replyWithDocument({ source: zipBuffer, filename: `${info.name}-${info.default_branch}.zip` }, { caption: `✅ Source ZIP dari ${info.full_name}` });
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET REPO ZIP SELESAI ✅</b>',
        box: infoBox([
          ['📦 Repository', escapeHtml(info.full_name)],
          ['🌿 Branch', escapeHtml(info.default_branch)],
          ['⭐ Stars', `${info.stargazers_count ?? 0}`],
        ]),
      }), homeButton());
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>GET REPO ZIP GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'search_repo' && session.step === 'query') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>CARI REPO GITHUB</b>', body: '⏳ Mencari…' }));
    try {
      const items = await searchGithubRepos(text, 5);
      if (!items.length) {
        await editPanel(ctx, status.message_id, panel({ heading: '<b>CARI REPO GITHUB</b>', body: '<i>Tidak ada hasil ditemukan.</i>' }), homeButton());
        return;
      }
      const lines = items.map((r, i) =>
        `${i + 1}. <a href="${escapeHtml(r.html_url)}">${escapeHtml(r.full_name)}</a>\n   ⭐ ${r.stargazers_count} · ${escapeHtml(r.language || '-')}${r.description ? `\n   <i>${escapeHtml(r.description.slice(0, 100))}</i>` : ''}`
      );
      await editPanel(ctx, status.message_id, panel({
        heading: `<b>HASIL: "${escapeHtml(text)}"</b>`,
        body: lines.join('\n\n'),
      }), homeButton());
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>PENCARIAN GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'delete' && session.step === 'link') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>DELETE WEB</b>', body: '⏳ Mencari project dari link…' }));
    try {
      const target = await resolveDeployTargetFromUrl(text);
      const platformLabel = target.platform === 'netlify' ? 'Netlify' : 'Vercel';

      await editPanel(ctx, status.message_id, panel({
        heading: '<b>DELETE WEB</b>',
        body: `🛰️ Platform: <b>${escapeHtml(platformLabel)}</b>\n🌐 Project ditemukan: <code>${escapeHtml(target.name)}</code>\n\n⏳ Menghapus website & deployment di ${escapeHtml(platformLabel)}…`,
      }));
      await deleteDeployTarget(target);
      await removeDeploymentRecord(target.name, target.platform);

      let repoStatus = '⚠️ Repository tidak ditemukan otomatis';
      try {
        const repo = await findGithubRepoByProjectName(target.name);
        if (repo) {
          await editPanel(ctx, status.message_id, panel({
            heading: '<b>DELETE WEB</b>',
            body: `🛰️ Platform: <b>${escapeHtml(platformLabel)}</b>\n🌐 Project: <code>${escapeHtml(target.name)}</code>\n✅ Website ${escapeHtml(platformLabel)} dihapus.\n\n⏳ Menghapus repository…`,
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
          ['📦 Project', escapeHtml(target.name)],
          ['🛰️ Platform', escapeHtml(platformLabel)],
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

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'env_key') {
    const key = text.trim().replace(/\s+/g, '_').toUpperCase();
    if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      await sendPrompt(ctx, 'Tambah .env', '❌ <b>KEY tidak valid.</b>\n\nGunakan huruf/angka/underscore saja, contoh: <code>TOKEN_GITHUB</code>. Kirim ulang KEY-nya.', session);
      return;
    }
    session.pendingEnvKey = key;
    session.step = 'env_value';
    sessions.set(id, session);
    await sendPrompt(ctx, 'Tambah .env', `🔒 <b>Kirim VALUE</b> untuk <code>${escapeHtml(key)}</code>`, session);
    return;
  }

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'env_value') {
    session.envVars = session.envVars || [];
    session.envVars.push({ key: session.pendingEnvKey, value: text });
    delete session.pendingEnvKey;
    session.step = 'env_more';
    sessions.set(id, session);
    const old = sessions.get(id);
    if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
    const message = await sendPanel(ctx, panel({
      heading: '<b>Tambah .env</b>',
      box: infoBox(session.envVars.map((e) => [`🔑 ${escapeHtml(e.key)}`, '<i>tersimpan</i>'])),
      body: 'Mau tambah environment variable lagi?',
    }), Markup.inlineKeyboard([
      [Markup.button.callback('➕  Tambah Lagi', 'env_more_add'), Markup.button.callback('✅  Selesai', 'env_more_done')],
    ]));
    session.controlMessageId = message.message_id;
    sessions.set(id, session);
    return;
  }

  if (session.type === 'generate_bot' && session.step === 'gb_env_key') {
    const key = text.trim().replace(/\s+/g, '_').toUpperCase();
    if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      await sendPrompt(ctx, 'Generate Bot — .env', '❌ <b>KEY tidak valid.</b>\n\nGunakan huruf/angka/underscore saja, contoh: <code>TOKEN_BOT</code>. Kirim ulang KEY-nya.', session);
      return;
    }
    session.pendingEnvKey = key;
    session.step = 'gb_env_value';
    sessions.set(id, session);
    await sendPrompt(ctx, 'Generate Bot — .env', `🔒 <b>Kirim VALUE</b> untuk <code>${escapeHtml(key)}</code>`, session);
    return;
  }

  if (session.type === 'generate_bot' && session.step === 'gb_env_value') {
    session.envVars = session.envVars || [];
    session.envVars.push({ key: session.pendingEnvKey, value: text });
    delete session.pendingEnvKey;
    session.step = 'gb_env_more';
    sessions.set(id, session);
    const old = sessions.get(id);
    if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
    const message = await sendPanel(ctx, panel({
      heading: '<b>Generate Bot — .env</b>',
      box: infoBox(session.envVars.map((e) => [`🔑 ${escapeHtml(e.key)}`, '<i>tersimpan</i>'])),
      body: 'Mau tambah environment variable lagi?',
    }), Markup.inlineKeyboard([
      [Markup.button.callback('➕  Tambah Lagi', 'gb_env_more_add'), Markup.button.callback('✅  Selesai', 'gb_env_more_done')],
    ]));
    session.controlMessageId = message.message_id;
    sessions.set(id, session);
    return;
  }

  if (session.type === 'generate_bot' && session.step === 'gb_name') {
    session.name = repoSafeName(text);
    session.step = 'gb_deploying';
    sessions.set(id, session);
    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Generate Bot'],
        ['📦 Nama Bot', `<code>${escapeHtml(session.name)}</code>`],
        ['🔐 .env', `<b>${session.envVars?.length || 0}</b> variable`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
    await runGenerateBot(ctx, session, status);
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
        ['🛰️ Platform', escapeHtml(session.platform === 'netlify' ? 'Netlify' : 'Vercel')],
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

bot.on('photo', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'photo_url' || session.step !== 'file') return;

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  try {
    // Ambil resolusi terbesar yang dikirim Telegram (foto biasa otomatis
    // dikompres Telegram jadi JPEG — untuk kualitas asli, sarankan user
    // kirim sebagai File/Dokumen, sudah dijelaskan di prompt sebelumnya).
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const buffer = await downloadTelegramFile(ctx, largest.file_id);
    const fileName = `foto-${Date.now()}.jpg`;
    sessions.delete(id);

    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>DASHBOARD LOG</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Foto ke URL'],
        ['🖼️ File', `<code>${escapeHtml(fileName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
      footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
    }));
    await runPhotoUpload(ctx, [{ path: fileName, buffer }], status);
  } catch (error) {
    sessions.delete(id);
    await sendPrompt(ctx, 'Foto ke URL', `❌ <b>Gagal mengambil foto dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, { type: 'photo_url', step: 'file' });
  }
});

bot.on('document', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  const document = ctx.message.document;
  const fileName = document.file_name || 'file';

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  if (session.type === 'photo_url' && session.step === 'file') {
    const mimeType = document.mime_type || '';
    const extFromMime = IMAGE_MIME_EXT[mimeType.toLowerCase()];
    const looksLikeImageName = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(fileName);
    if (!mimeType.startsWith('image/') && !looksLikeImageName) {
      await sendPrompt(ctx, 'Foto ke URL', '❌ <b>Format tidak didukung.</b>\n\nKirim gambar dengan format PNG, JPG, GIF, WEBP, SVG, atau ICO.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const safeName = sanitizeImageFileName(fileName, extFromMime);
      sessions.delete(id);

      const status = await sendPanel(ctx, panel({
        heading: '📊 <b>DASHBOARD LOG</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Foto ke URL'],
          ['🖼️ File', `<code>${escapeHtml(safeName)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
      }));
      await runPhotoUpload(ctx, [{ path: safeName, buffer }], status);
    } catch (error) {
      await sendPrompt(ctx, 'Foto ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'audio_url' && session.step === 'file') {
    const mimeType = document.mime_type || '';
    const extFromMime = AUDIO_MIME_EXT[mimeType.toLowerCase()];
    const looksLikeAudioName = /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fileName);
    if (!mimeType.startsWith('audio/') && !looksLikeAudioName) {
      await sendPrompt(ctx, 'Audio ke URL', '❌ <b>Format tidak didukung.</b>\n\nKirim audio dengan format MP3, WAV, OGG, M4A, AAC, atau FLAC.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const safeName = sanitizeImageFileName(fileName, extFromMime || 'mp3', 'audio');
      sessions.delete(id);

      const status = await sendPanel(ctx, panel({
        heading: '📊 <b>DASHBOARD LOG</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Audio ke URL'],
          ['🎵 File', `<code>${escapeHtml(safeName)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        footer: 'Proses membutuhkan waktu, jadi mohon\nuntuk sabar.....',
      }));
      await runFileToUrl(ctx, [{ path: safeName, buffer }], status, 'audio');
    } catch (error) {
      await sendPrompt(ctx, 'Audio ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'generate_bot' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, 'Generate Bot', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.zip</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const files = await extractZipGeneric(buffer);
      const hasPackageJson = files.some((f) => f.path.toLowerCase() === 'package.json');
      if (!hasPackageJson) {
        await sendPrompt(ctx, 'Generate Bot', '❌ <b>Tidak ditemukan <code>package.json</code>.</b>\n\nProject bot wajib punya <code>package.json</code> di root ZIP (atau di dalam satu folder pembungkus tunggal). Kirim ulang ZIP yang sesuai.', session);
        return;
      }
      session.files = files;

      const detected = detectGenerateBotWebhookPath(files);
      if (detected.path) {
        session.webhookPath = detected.path;
        await startGenerateBotEnvCollection(ctx, session, `📄 ZIP OK (${files.length} file).\n🧩 Webhook terdeteksi: <code>${escapeHtml(detected.path)}</code>\n<i>Sumber: ${escapeHtml(detected.source)}</i>`);
      } else if (detected.candidates && detected.candidates.length > 1) {
        session.step = 'pick_webhook_file';
        session.webhookCandidates = detected.candidates;
        sessions.set(id, session);
        const buttons = detected.candidates.map((p, i) => [Markup.button.callback(p, `gbpick_${i}`)]);
        const old = sessions.get(id);
        if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.contro
