const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  QRIS_URL: process.env.QRIS_URL || process.env.DONATION_QRIS_URL || '',
  TIME_ZONE: process.env.TIME_ZONE || 'Asia/Jakarta',
  DOWNLOAD_API_URL: process.env.DOWNLOAD_API_URL || '',
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
const userProfiles = new Map();

const OWNER_TELEGRAM_URL = 'https://t.me/RavenZyPT';
const OWNER_WHATSAPP_URL = 'https://wa.me/6288271102065';
const OWNER_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb89MImFHWptXTOThg3G';
const BUY_MESSAGE = 'Saya ingin membeli bot DevTools dengan harga 50k, tolong di acc';
const BUY_ACCESS_URL = `${OWNER_TELEGRAM_URL}?text=${encodeURIComponent(BUY_MESSAGE)}`;

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

function buildMultipartFormData(fields) {
  const boundary = `----DevToolsRavenBoundary${crypto.randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const field of fields) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
    if (field.filename) header += `; filename="${field.filename}"`;
    header += '\r\n';
    if (field.contentType) header += `Content-Type: ${field.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function platformDisplayName(platform) {
  if (platform === 'netlify') return 'Netlify';
  if (platform === 'github_pages') return 'GitHub Pages';
  return 'Vercel';
}

function formatCreatedDate(ts) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: ENV.TIME_ZONE, day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)).replace(' pukul ', ', ').replace(/\./g, '');
}

function deploySuccessMessage(name, url, ts) {
  return `WEBSITE BERHASIL DI-DEPLOY! ✅️\n━━━━━━━━━━━━━━━━━━━━━━━━━\n🏷 Proyek : ${escapeHtml(name)}\n🔗 URL    : <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n✨️ Dibuat : ${escapeHtml(formatCreatedDate(ts))}`;
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

function isOwner(ctx) {
  return uid(ctx) === OWNER_ID;
}

function isAllowed(ctx) {
  const id = uid(ctx);
  return Number.isInteger(id) && (id === OWNER_ID || allowedUsers.has(id));
}

function userDisplayName(from) {
  const first = String(from?.first_name || '').trim();
  const last = String(from?.last_name || '').trim();
  const full = `${first} ${last}`.trim();
  return full || (from?.username ? `@${from.username}` : `User ${from?.id || '-'}`);
}

function rememberUser(ctx) {
  const id = uid(ctx);
  if (!Number.isInteger(id) || id <= 0) return;
  userProfiles.set(id, {
    id,
    name: userDisplayName(ctx.from),
    username: ctx.from?.username || null,
    updatedAt: Date.now(),
  });
}

function guestMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.url('💳  Buy Akses', BUY_ACCESS_URL)],
    [Markup.button.url('💬  Hubungi WhatsApp Owner', OWNER_WHATSAPP_URL)],
    [Markup.button.url('📣  Saluran Produk Owner', OWNER_CHANNEL_URL)],
  ]);
}

async function sendGuestMenu(ctx) {
  const text = panel({
    heading: '<b>Akses DevTools Raven</b>',
    body: 'Akun kamu belum terdaftar.\n\nPilih salah satu tombol di bawah.',
  });
  return sendPanel(ctx, text, guestMenuMarkup());
}

bot.use(async (ctx, next) => {
  rememberUser(ctx);
  if (isAllowed(ctx)) return next();
  const startText = ctx.message?.text?.trim() || '';
  const isStart = /^\/start(?:\s|$)/i.test(startText);
  if (isStart) return next();
  return undefined;
});

async function safeDeleteMessage(ctx, chatId, messageId) {
  if (!messageId) return;
  try { await ctx.telegram.deleteMessage(chatId, messageId); } catch (_) {}
}


const BAR = '───── ✦ ───── ✦ ─────';
const BRAND = 'DEVTOOLS RAVEN · V3';

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Menu Utama', 'home')]]);
}

function mainMenuMarkup(ctx) {
  const rows = [
    [Markup.button.callback('🚀  Deployment', 'deployment_menu')],
    [Markup.button.callback('📄  Get Source', 'get_source'), Markup.button.callback('🛡️  Encrypt HTML', 'encrypt_html')],
    [Markup.button.callback('🖼️  Media ke URL', 'media_menu'), Markup.button.callback('📥  Download Media', 'download_menu')],
    [Markup.button.callback('📸  Screenshot URL', 'screenshot_url'), Markup.button.callback('📦  Get Repo ZIP', 'repo_zip')],
    [Markup.button.callback('🔎  Cari Repo', 'search_repo'), Markup.button.callback('🤖  Generate Bot', 'generate_bot')],
    [Markup.button.callback('📱  Web ke APK', 'web_to_apk'), Markup.button.callback('📋  List Web', 'list_web')],
    [Markup.button.callback('🗑️  Delete Web', 'delete_web'), Markup.button.callback('📡  System Check', 'system')],
    [Markup.button.callback('ℹ️  Bantuan', 'help_info'), Markup.button.callback('💝  Donasi', 'donation')],
  ];
  if (ctx && isOwner(ctx)) {
    rows.push([Markup.button.callback('👤  Add User', 'add_user'), Markup.button.callback('👥  Users', 'users')]);
    rows.push([Markup.button.callback('📢  Broadcast', 'broadcast')]);
  }
  return Markup.inlineKeyboard(rows);
}

function deploymentMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▲  Vercel', 'deploy_vercel'), Markup.button.callback('🌐  Netlify', 'deploy_netlify')],
    [Markup.button.callback('🐙  GitHub Pages', 'github_pages_menu')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function mediaMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️  Foto ke URL', 'photo_url'), Markup.button.callback('🎵  Audio ke URL', 'audio_url')],
    [Markup.button.callback('🎬  Video ke URL', 'video_url')],
    [Markup.button.callback('📋  List Media', 'media_list'), Markup.button.callback('🗑️  Delete Media', 'media_delete')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function downloadMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎵  TikTok', 'download_tiktok'), Markup.button.callback('📸  Instagram', 'download_instagram')],
    [Markup.button.callback('▶️  YouTube', 'download_youtube')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function githubPagesMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄  Deploy HTML', 'github_pages_html'), Markup.button.callback('📦  Deploy ZIP', 'github_pages_zip')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function fileTypeMarkup(platform) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄  Deploy HTML', `${platform}_html`), Markup.button.callback('📦  Deploy ZIP', `${platform}_zip`)],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

async function askForWebsiteName(ctx, session, prefixText = '') {
  session.step = 'name';
  const platformLabel = platformDisplayName(session.platform);
  const title = `${session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML'} — ${platformLabel}`;
  const body = `${prefixText ? `${prefixText}\n\n` : ''}Kirim nama website.\nGunakan huruf, angka, dan tanda "-" tanpa spasi.\nContoh: <code>toko-online-saya</code>`;
  await sendPrompt(ctx, title, body, session);
}

async function askEnvChoiceOrName(ctx, session, prefixText) {
  if (session.platform !== 'vercel' || session.type === 'deploy_html') {
    await askForWebsiteName(ctx, session, prefixText);
    return;
  }
  session.step = 'env_choice';
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await sendPanel(ctx, panel({
    heading: '<b>Deploy ZIP — Vercel</b>',
    body: `${prefixText}\n\nProject ini membutuhkan <code>.env</code>?\nPilih <b>Tambah .env</b> untuk memasukkan variable, atau <b>Lewati</b> untuk deploy tanpa variable tambahan.`,
  }), Markup.inlineKeyboard([
    [Markup.button.callback('➕  Tambah .env', 'env_add'), Markup.button.callback('⏭️  Lewati', 'env_skip')],
  ]));
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
}

async function startGenerateBotEnvCollection(ctx, session, prefixText) {
  session.envVars = session.envVars || [];
  session.step = 'gb_env_key';
  const body = `${prefixText ? `${prefixText}\n\n` : ''}Kirim KEY environment variable pertama.\nContoh: <code>TOKEN_BOT</code>`;
  await sendPrompt(ctx, 'Generate Bot — Environment', body, session);
}

function infoBox(rows) {
  const lines = rows.map(([label, value], idx) => {
    const prefix = idx === rows.length - 1 ? '└' : '├';
    return `${prefix} ${label} : ${value}`;
  });
  return `┌─────────────────────────\n${lines.join('\n')}`;
}

function panel({ heading, box, body, footer } = {}) {
  const sections = [];
  if (heading) sections.push(heading);
  if (box) sections.push(box);
  if (body) sections.push(body);
  if (footer) sections.push(footer);
  return sections.filter(Boolean).join('\n\n').trim();
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


let cachedBotPhotoBuffer;
function loadBotPhotoBuffer() {
  if (cachedBotPhotoBuffer !== undefined) return cachedBotPhotoBuffer;
  const candidates = [
    path.join(process.cwd(), 'Bot.png'),
    path.join(process.cwd(), 'api', 'Bot.png'),
    path.join(__dirname, 'Bot.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedBotPhotoBuffer = fs.readFileSync(candidate);
        return cachedBotPhotoBuffer;
      }
    } catch (_) {
    }
  }
  cachedBotPhotoBuffer = null;
  return null;
}

async function sendMainMenu(ctx) {
  const name = escapeHtml(ctx.from?.username || userDisplayName(ctx.from));
  const menuText = [
    `👋 Halo, ${name}! Selamat Datang`,
    BAR,
    `🤖 DEVTOOLS RAVEN  ·  V3`,
    BAR,
    `┃❏ 🛠𝗱𝗲𝘃𝗲𝗹𝗼𝗽𝗲𝗿 : RavenZy`,
    `┃❏ 📡𝘃𝗲𝗿𝘀𝗶𝗼𝗻 : 3.0.0`,
    `┃❏ 🔮𝘀𝘁𝗮𝘁𝘂𝘀: Online✅`,
    `╰━──────────────────────━❏`,
    `( ⬇️ ) 𝗣𝗶𝗹𝗶𝗵 𝗠𝗲𝗻𝘂 𝗗𝗶 𝗕𝗮𝘄𝗮𝗵...ᝄ`,
  ].join('\n');
  const photoBuffer = loadBotPhotoBuffer();
  const keyboard = mainMenuMarkup(ctx);
  if (photoBuffer) {
    try {
      await ctx.replyWithPhoto({ source: photoBuffer }, { caption: menuText, parse_mode: 'HTML', ...keyboard });
      return;
    } catch (_) {}
  }
  await sendPanel(ctx, menuText, keyboard);
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
    const file = await getBotRepoFile('devtools-raven-users.json');
    if (!file?.content) return;
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === 'object' && value !== null) {
          const id = Number(value.id);
          if (Number.isInteger(id) && id > 0) {
            allowedUsers.add(id);
            userProfiles.set(id, { id, name: value.name || `User ${id}`, username: value.username || null, updatedAt: value.updatedAt || Date.now() });
          }
        } else {
          const id = Number(value);
          if (Number.isInteger(id) && id > 0) allowedUsers.add(id);
        }
      }
    }
  } catch (error) {
    console.error('[USERS LOAD]', errorMessage(error));
  }
}

async function saveUsers() {
  const users = [...allowedUsers]
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => {
      const p = userProfiles.get(id);
      return { id, name: p?.name || (id === OWNER_ID ? 'Owner' : `User ${id}`), username: p?.username || null, updatedAt: p?.updatedAt || Date.now() };
    });
  const old = await getBotRepoFile('devtools-raven-users.json');
  await writeBotRepoFile(
    'devtools-raven-users.json',
    JSON.stringify(users, null, 2),
    'chore: update DevTools Raven authorized users',
    old?.sha
  );
}

async function refreshUserProfileById(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const chat = await bot.telegram.getChat(id);
    const profile = {
      id,
      name: userDisplayName(chat),
      username: chat?.username || null,
      updatedAt: Date.now(),
    };
    userProfiles.set(id, profile);
    return profile;
  } catch (_) {
    return userProfiles.get(id) || null;
  }
}


async function loadDeployments() {
  try {
    const file = await getBotRepoFile('devtools-raven-deployments.json');
    if (!file?.content) return [];
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function recordDeployment(entry) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile('devtools-raven-deployments.json');
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
        'devtools-raven-deployments.json',
        JSON.stringify(list, null, 2),
        'chore: record DevTools Raven deployment',
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
      const file = await getBotRepoFile('devtools-raven-deployments.json');
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
        'devtools-raven-deployments.json',
        JSON.stringify(filtered, null, 2),
        'chore: remove DevTools Raven deployment record',
        file.sha
      );
      return;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      return;
    }
  }
}

async function loadMediaRecords() {
  try {
    const file = await getBotRepoFile('devtools-raven-media.json');
    if (!file?.content) return [];
    const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function recordMedia(entry) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile('devtools-raven-media.json');
      let list = [];
      if (file?.content) { try { list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (_) { list = []; } }
      if (!Array.isArray(list)) list = [];
      list.push(entry);
      if (list.length > 300) list = list.slice(-300);
      await writeBotRepoFile('devtools-raven-media.json', JSON.stringify(list, null, 2), 'chore: record DevTools Raven media', file?.sha);
      return true;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      return false;
    }
  }
  return false;
}

async function removeMediaRecord(projectName, ownerId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile('devtools-raven-media.json');
      if (!file?.content) return false;
      const list = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      if (!Array.isArray(list)) return false;
      const filtered = list.filter((x) => !(x.projectName === projectName && Number(x.ownerId) === Number(ownerId)));
      if (filtered.length === list.length) return false;
      await writeBotRepoFile('devtools-raven-media.json', JSON.stringify(filtered, null, 2), 'chore: remove DevTools Raven media', file.sha);
      return true;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      return false;
    }
  }
  return false;
}

async function githubApi(method, path, data, config = {}) {
  return axios({
    method,
    url: `${GH_API}${path}`,
    headers: { ...ghHeaders, ...(config.headers || {}) },
    data,
    timeout: config.timeout || 60000,
    params: config.params,
    responseType: config.responseType,
    maxContentLength: config.maxContentLength,
    maxBodyLength: config.maxBodyLength,
    validateStatus: config.validateStatus,
  });
}

async function createGitHubRepo(name, options = {}) {
  const response = await githubApi('POST', '/user/repos', {
    name,
    description: options.description || `DevTools Raven deployment: ${name}`,
    private: Boolean(options.private),
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
  const commitSha = await createGitCommit(owner, repo.name, treeSha, parentSha, 'deploy: DevTools Raven website');
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
  const target = `${projectName}.vercel.app`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await axios.get(`${VERCEL_API}/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
        headers: vercelHeaders,
        params: teamId ? { teamId } : undefined,
        timeout: 30000,
      });
      const aliases = (response.data?.aliases || []).map((a) => a.alias).filter(Boolean);
      const exact = aliases.find((alias) => alias === target);
      if (exact) return exact;
      const nonHashed = aliases.find((alias) => !/-[a-z0-9]{9,}(-[a-z0-9-]+)?\.vercel\.app$/i.test(alias));
      if (nonHashed) return nonHashed;
    } catch (_) {
    }
    if (attempt < 7) await sleep(2000);
  }
  return target;
}

async function ensureVercelAlias(projectName, deploymentId, teamId) {
  const target = `${projectSafeName(projectName)}.vercel.app`;
  const scopes = [teamId || null, ...(await getVercelTeamIds())];
  const tried = new Set();
  let lastError;
  for (const scope of scopes) {
    if (scope && tried.has(scope)) continue;
    if (scope) tried.add(scope);
    try {
      await axios.post(`${VERCEL_API}/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`, {
        alias: target,
      }, {
        headers: vercelHeaders,
        params: scope ? { teamId: scope } : undefined,
        timeout: 30000,
      });
      return target;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status === 409) {
        return target;
      }
      if (![401, 403].includes(status)) break;
    }
  }
  if (lastError) console.error('[VERCEL ALIAS]', errorMessage(lastError));
  return null;
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
  const { body, contentType } = buildMultipartFormData([
    { name: 'title', value: 'DevTools Raven deployment' },
    { name: 'zip', value: zipBuffer, filename: 'site.zip', contentType: 'application/zip' },
  ]);

  const response = await axios.post(`${NETLIFY_API}/sites/${encodeURIComponent(siteId)}/builds`, body, {
    headers: { ...netlifyHeaders, 'Content-Type': contentType },
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


async function screenshotUrl(targetUrl) {
  let value = String(targetUrl).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    new URL(value);
  } catch (_) {
    throw new Error('URL tidak valid.');
  }
  const shotUrl = `https://image.thum.io/get/width/1200/noanimate/${value}`;
  const response = await axios.get(shotUrl, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 15 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DevToolsRavenScreenshot/1.0)' },
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

  const topFolders = new Set(raw.map((f) => f.path.split('/')[0]));
  if (topFolders.size === 1) {
    const [prefix] = topFolders;
    const flattened = raw.map((f) => ({ path: f.path.slice(prefix.length + 1), buffer: f.buffer }));
    if (flattened.some((f) => f.path.toLowerCase() === 'index.html')) return flattened;
  }
  throw new Error('ZIP harus mempunyai index.html sebagai halaman utama.');
}

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
    }
  }
  return null;
}

async function findProjectByDeploymentHost(host) {
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
    throw new Error('Link harus berupa domain *.vercel.app hasil deploy DevTools Raven.');
  }

  const baseSlug = host.slice(0, -'.vercel.app'.length);

  let project = await tryGetVercelProject(baseSlug);
  if (project) return project;

  project = await findProjectByDeploymentHost(host);
  if (project) return project;

  throw new Error(`Project Vercel untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy DevTools Raven.`);
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
    throw new Error('Link harus berupa domain *.netlify.app hasil deploy DevTools Raven.');
  }

  const baseSlug = host.slice(0, -'.netlify.app'.length);
  let site = await tryGetNetlifySite(baseSlug);
  if (site) return site;

  site = await findNetlifySiteByHost(host);
  if (site) return site;

  throw new Error(`Site Netlify untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy DevTools Raven.`);
}

async function deleteNetlifySite(site) {
  await axios.delete(`${NETLIFY_API}/sites/${encodeURIComponent(site.id)}`, {
    headers: netlifyHeaders,
    timeout: 30000,
  });
}

async function resolveGithubPagesRepoFromUrl(urlInput) {
  let value = String(urlInput).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const parsed = new URL(value);
  const ownerHost = `${String(ENV.GH_OWNER).toLowerCase()}.github.io`;
  if (parsed.hostname.toLowerCase() !== ownerHost) throw new Error(`Link GitHub Pages harus berada di ${ownerHost}.`);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const repoName = parts[0] || `${ENV.GH_OWNER}.github.io`;
  return (await githubApi('GET', `/repos/${encodeURIComponent(ENV.GH_OWNER)}/${encodeURIComponent(repoName)}`, undefined, { timeout: 30000 })).data;
}

async function resolveDeployTargetFromUrl(urlInput) {
  let value = String(urlInput).trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let host;
  try { host = new URL(value).hostname.toLowerCase(); } catch (_) { throw new Error('Link tidak valid.'); }
  if (host.endsWith('.vercel.app')) { const project = await resolveVercelProjectFromUrl(urlInput); return { platform: 'vercel', name: project.name, data: project }; }
  if (host.endsWith('.netlify.app')) { const site = await resolveNetlifySiteFromUrl(urlInput); return { platform: 'netlify', name: site.name, data: site }; }
  if (host === `${String(ENV.GH_OWNER).toLowerCase()}.github.io`) { const repo = await resolveGithubPagesRepoFromUrl(urlInput); return { platform: 'github_pages', name: repo.name, data: repo }; }
  throw new Error('Link harus berupa domain *.vercel.app, *.netlify.app, atau GitHub Pages milik bot.');
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

async function deleteGithubPagesSite(repo) {
  try { await githubApi('DELETE', `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/pages`, undefined, { timeout: 30000 }); } catch (error) { if (error.response?.status !== 404) throw error; }
  await deleteGithubRepo(repo.owner.login, repo.name);
}

async function deleteDeployTarget(target) {
  if (!target?.platform) throw new Error('Platform deployment tidak dikenali.');
  if (target.platform === 'vercel') return deleteVercelProject(target.data);
  if (target.platform === 'netlify') return deleteNetlifySite(target.data);
  if (target.platform === 'github_pages') return deleteGithubPagesSite(target.data);
  throw new Error(`Platform ${target.platform} tidak didukung.`);
}


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

async function searchGithubRepos(query, limit = 6) {
  const [starsResponse, latestResponse] = await Promise.all([
    axios.get(`${GH_API}/search/repositories`, {
      headers: ghHeaders,
      params: { q: query, sort: 'stars', order: 'desc', per_page: Math.max(3, Math.ceil(limit / 2)) },
      timeout: 20000,
    }),
    axios.get(`${GH_API}/search/repositories`, {
      headers: ghHeaders,
      params: { q: query, sort: 'updated', order: 'desc', per_page: Math.max(3, Math.ceil(limit / 2)) },
      timeout: 20000,
    }),
  ]);
  const merged = [];
  const seen = new Set();
  for (const repo of [...(starsResponse.data?.items || []), ...(latestResponse.data?.items || [])]) {
    if (!repo?.full_name || seen.has(repo.full_name)) continue;
    seen.add(repo.full_name);
    merged.push(repo);
    if (merged.length >= limit) break;
  }
  return merged;
}


function looksLikeSpaShell(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;
  const textOnly = bodyContent.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();
  const hasRootMount = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html);
  return hasRootMount && textOnly.length < 40;
}

async function getOriginalGithubSource(input) {
  const { owner, repo } = parseGithubRepoUrl(input);
  const info = await getPublicRepoInfo(owner, repo);
  if (info.private) throw new Error('Repository ini private. Get Source hanya menerima repository GitHub public.');
  const zipBuffer = await downloadRepoZip(owner, repo, info.default_branch);
  return {
    buffer: zipBuffer,
    assetCount: 0,
    failedAssets: [],
    isSpaLikely: false,
    originalRepository: true,
    fullName: info.full_name,
    branch: info.default_branch,
  };
}

async function getPublicSource(url) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('URL harus http atau https.');

  const response = await axios.get(base.href, {
    timeout: 30000,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DevToolsRavenSourceFetcher/1.0)' },
  });

  const htmlBuffer = Buffer.from(response.data);
  const html = htmlBuffer.toString('utf8');

  const zip = new JSZip();
  zip.file('index.html', htmlBuffer);

  const visited = new Set();
  const queue = [];
  const failedAssets = [];
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
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DevToolsRavenSourceFetcher/1.0)' },
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
    } catch (error) {
      failedAssets.push({ url: assetUrl, reason: errorMessage(error) });
    }
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer: zipBuffer,
    assetCount: downloaded,
    failedAssets,
    isSpaLikely: looksLikeSpaShell(html),
  };
}

function androidSafeName(name) {
  const value = String(name || 'DevToolsRaven').replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  return value || 'DevTools Raven';
}

function androidPackageName(name) {
  const base = projectSafeName(name).replace(/-/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 18) || 'ravenapp';
  return `com.devtoolsraven.web.${base}`.slice(0, 90);
}

function buildAndroidWrapperFiles(webFiles, appName) {
  const indexCandidates = webFiles.filter((f) => f.path.toLowerCase().endsWith('/index.html') || f.path.toLowerCase() === 'index.html');
  if (!indexCandidates.length) throw new Error('Project web tidak memiliki index.html. Build Web ke APK membutuhkan halaman utama index.html.');
  const indexPath = indexCandidates.find((f) => f.path.toLowerCase() === 'index.html')?.path || indexCandidates[0].path;
  const displayName = androidSafeName(appName);
  const packageName = androidPackageName(appName);
  const pathToAsset = indexPath.replace(/\\/g, '/');
  const files = [
    { path: 'settings.gradle', buffer: Buffer.from(`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = "DevToolsRavenApk"\ninclude(":app")\n`, 'utf8') },
    { path: 'build.gradle', buffer: Buffer.from(`plugins { id 'com.android.application' version '8.6.1' apply false }\n`, 'utf8') },
    { path: 'gradle.properties', buffer: Buffer.from(`org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\n`, 'utf8') },
    { path: 'app/build.gradle', buffer: Buffer.from(`plugins { id 'com.android.application' }\n\nandroid {\n    namespace '${packageName}'\n    compileSdk 35\n\n    defaultConfig {\n        applicationId '${packageName}'\n        minSdk 23\n        targetSdk 35\n        versionCode 1\n        versionName '1.0'\n    }\n}\n`, 'utf8') },
    { path: 'app/src/main/AndroidManifest.xml', buffer: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:theme="@style/AppTheme" android:label="${displayName.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">\n        <activity android:name=".MainActivity" android:screenOrientation="portrait" android:exported="true">\n            <intent-filter>\n                <action android:name="android.intent.action.MAIN" />\n                <category android:name="android.intent.category.LAUNCHER" />\n            </intent-filter>\n        </activity>\n    </application>\n</manifest>\n`, 'utf8') },
    { path: 'app/src/main/res/values/styles.xml', buffer: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar">\n        <item name="android:fontFamily">sans</item>\n        <item name="android:colorAccent">#FFFFFF</item>\n        <item name="android:navigationBarColor">#0B0B0D</item>\n        <item name="android:statusBarColor">#0B0B0D</item>\n        <item name="android:windowLightStatusBar">false</item>\n    </style>\n</resources>\n`, 'utf8') },
    { path: 'app/src/main/java/' + packageName.replace(/\\./g, '/') + '/MainActivity.java', buffer: Buffer.from(`package ${packageName};\n\nimport android.app.Activity;\nimport android.os.Bundle;\nimport android.webkit.WebChromeClient;\nimport android.webkit.WebSettings;\nimport android.webkit.WebView;\n\npublic class MainActivity extends Activity {\n    private WebView webView;\n    @Override protected void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        webView = new WebView(this);\n        WebSettings settings = webView.getSettings();\n        settings.setJavaScriptEnabled(true);\n        settings.setDomStorageEnabled(true);\n        settings.setAllowFileAccess(true);\n        settings.setAllowContentAccess(true);\n        settings.setMediaPlaybackRequiresUserGesture(false);\n        webView.setWebChromeClient(new WebChromeClient());\n        webView.loadUrl("file:///android_asset/${pathToAsset.replace(/"/g, '\\\\"')}");\n        setContentView(webView);\n    }\n    @Override public void onBackPressed() {\n        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();\n    }\n}\n`, 'utf8') },
  ];
  for (const file of webFiles) {
    const clean = normalizeZipPath(file.path);
    if (!clean) continue;
    files.push({ path: `app/src/main/assets/${clean}`, buffer: Buffer.from(file.buffer) });
  }
  return { files, packageName, indexPath, displayName };
}

function buildAndroidWorkflow() {
  return `name: Build Web to APK\n\non:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n      - name: Setup Java\n        uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: '17'\n      - name: Setup Android SDK\n        uses: android-actions/setup-android@v3\n      - name: Setup Gradle\n        uses: gradle/actions/setup-gradle@v4\n        with:\n          gradle-version: '8.7'\n      - name: Accept licenses\n        run: yes | sdkmanager --licenses >/dev/null 2>&1 || true\n      - name: Install Android SDK packages\n        run: sdkmanager "platforms;android-35" "build-tools;35.0.0"\n      - name: Build debug APK\n        run: gradle :app:assembleDebug --no-daemon\n      - name: Upload APK\n        uses: actions/upload-artifact@v4\n        with:\n          name: DevTools-Raven-APK\n          path: app/build/outputs/apk/debug/app-debug.apk\n          if-no-files-found: error\n`;
}

async function getLatestGithubRun(owner, repo, createdAfterMs, timeoutMs = 360000) {
  const start = Date.now();
  let seen = null;
  while (Date.now() - start < timeoutMs) {
    const response = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, null, { timeout: 30000, params: { event: 'push', branch: 'main', per_page: 20 } });
    const runs = response.data?.workflow_runs || [];
    seen = runs.find((r) => new Date(r.created_at || 0).getTime() >= createdAfterMs) || runs[0] || null;
    if (seen) {
      const current = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${seen.id}`, null, { timeout: 30000 });
      if (current.data?.status === 'completed') return current.data;
    }
    await sleep(5000);
  }
  throw new Error(seen ? 'Build GitHub Actions melewati batas waktu.' : 'GitHub Actions tidak membuat workflow run. Pastikan Actions aktif pada repository.');
}

async function downloadGithubArtifact(owner, repo, artifactId) {
  const apiUrl = `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${encodeURIComponent(artifactId)}/zip`;
  const first = await axios.get(apiUrl, { headers: ghHeaders, timeout: 30000, maxRedirects: 0, validateStatus: (status) => status === 302 });
  const location = first.headers?.location;
  if (!location) throw new Error('GitHub tidak mengembalikan URL unduhan artifact APK.');
  const downloaded = await axios.get(location, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 120 * 1024 * 1024, maxRedirects: 5 });
  return Buffer.from(downloaded.data);
}

async function findAndDownloadApkArtifact(owner, repo, runId) {
  const response = await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/artifacts`, null, { timeout: 30000, params: { per_page: 100 } });
  const artifacts = response.data?.artifacts || [];
  const artifact = artifacts.find((a) => a.name === 'DevTools-Raven-APK' && !a.expired) || artifacts[0];
  if (!artifact?.id) throw new Error('Artifact APK tidak ditemukan pada workflow run yang selesai.');
  const artifactZip = await downloadGithubArtifact(owner, repo, artifact.id);
  const zip = await JSZip.loadAsync(artifactZip);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && /\.apk$/i.test(name)) return { buffer: await entry.async('nodebuffer'), name: name.split('/').pop() };
  }
  throw new Error('Artifact berhasil dibuat tetapi file APK tidak ditemukan di dalam archive.');
}

async function runWebToApk(ctx, session, statusMessage) {
  const startedAt = Date.now();
  const repoName = `devtools-raven-apk-${crypto.randomBytes(4).toString('hex')}`;
  let tempRepo = null;
  const render = async (percent, activity) => {
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Build Web to APK'],
        ['📦 Project', `<code>${escapeHtml(session.name || repoName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
        ['📝 Activity', escapeHtml(activity)],
      ]),
      footer: 'APK dibangun dari asset web lokal sebagai aplikasi Android WebView.',
    }));
  };
  try {
    await render(10, 'Memeriksa project web…');
    const wrapper = buildAndroidWrapperFiles(session.files, session.name || 'DevTools Raven');
    const workflow = { path: '.github/workflows/build-apk.yml', buffer: Buffer.from(buildAndroidWorkflow(), 'utf8') };
    const allFiles = [...wrapper.files, workflow];
    await render(22, 'Membuat repository build sementara…');
    tempRepo = await createGitHubRepo(repoName, { private: true, description: `DevTools Raven V3 temporary APK build: ${session.name || repoName}` });
    const commitStart = Date.now();
    await uploadFilesToNewRepo(tempRepo, allFiles);
    await render(35, 'Menjalankan GitHub Actions…');
    const run = await getLatestGithubRun(tempRepo.owner.login, tempRepo.name, commitStart - 15000, 420000);
    if (run.conclusion !== 'success') throw new Error(`Workflow berakhir dengan status ${run.conclusion || run.status || 'gagal'}.`);
    await render(80, 'Mengambil artifact APK asli…');
    const apk = await findAndDownloadApkArtifact(tempRepo.owner.login, tempRepo.name, run.id);
    await render(95, 'Mengirim APK…');
    await ctx.replyWithDocument({ source: apk.buffer, filename: apk.name || `${repoSafeName(session.name || 'devtools-raven')}.apk` }, { caption: '✅ <b>APK BERHASIL DIBANGUN</b>\n\nAPK ini dibuild dari asset web yang kamu kirim dan dikemas menjadi aplikasi Android WebView lokal.', parse_mode: 'HTML' });
    const elapsed = formatElapsed(Date.now() - startedAt);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>BUILD APK BERHASIL ✅</b>',
      box: infoBox([
        ['📦 App', escapeHtml(wrapper.displayName)],
        ['📱 Package', `<code>${escapeHtml(wrapper.packageName)}</code>`],
        ['⚙️ Build', 'GitHub Actions'],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: 'APK asli sudah dikirim sebagai file di atas.',
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>BUILD APK GAGAL ❌</b>',
      box: infoBox([
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['🧹 Cleanup', tempRepo ? 'Repository build sementara akan dihapus.' : 'Tidak ada repository yang sempat dibuat'],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
    }), homeButton());
  } finally {
    if (tempRepo?.owner?.login && tempRepo?.name) {
      try { await deleteGithubRepo(tempRepo.owner.login, tempRepo.name); } catch (_) {}
    }
    sessions.delete(uid(ctx));
  }
}


function encryptHtmlReversible(html) {
  const KEY_LEN = 32;
  const key = crypto.randomBytes(KEY_LEN);
  const plain = Buffer.from(html, 'utf8');
  const xored = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) xored[i] = plain[i] ^ key[i % KEY_LEN];
  const payload = Buffer.concat([Buffer.from('RAVEN2'), key, xored]).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><script>
(function(){
var P=${JSON.stringify(payload)};
function b(s){var x=atob(s),u=new Uint8Array(x.length);for(var i=0;i<x.length;i++)u[i]=x.charCodeAt(i);return u;}
var r=b(P),h='';
if(r.length>=38&&r[0]===82&&r[1]===65&&r[2]===86&&r[3]===69&&r[4]===78&&r[5]===50){
 var k=r.slice(6,38),d=r.slice(38),o=new Uint8Array(d.length);
 for(var i=0;i<d.length;i++)o[i]=d[i]^k[i%32];
 h=new TextDecoder('utf-8').decode(o);
}else{
 var KEYLEN=32,key=r.slice(0,KEYLEN),shuffled=r.slice(KEYLEN),makePrng=function(seed){var z=0;for(var j=0;j<seed.length;j++)z=((z*31)+seed[j])>>>0;if(z===0)z=0x9e3779b9;return function(){z^=z<<13;z>>>=0;z^=z>>17;z^=z<<5;z>>>=0;return z>>>0;};};
 var prng=makePrng(key),n=shuffled.length,indices=new Array(n);
 for(var i=0;i<n;i++)indices[i]=i;
 for(var i=n-1;i>0;i--){var j=prng()%(i+1),t=indices[i];indices[i]=indices[j];indices[j]=t;}
 var xored=new Uint8Array(n);
 for(var i=0;i<n;i++)xored[indices[i]]=shuffled[i];
 var data=new Uint8Array(n);
 for(var i=0;i<n;i++)data[i]=xored[i]^key[i%KEYLEN];
 var bin='';for(var i=0;i<data.length;i++)bin+=String.fromCharCode(data[i]);
 h=new TextDecoder('utf-8').decode(Uint8Array.from(atob(bin),function(c){return c.charCodeAt(0);}));
}
if(!/^\\s*<!doctype\\s+html/i.test(h) && !/^\\s*<html[\\s>]/i.test(h))throw new Error('Encrypted HTML decode failed');
document.open();document.write(h);document.close();
})();
</script></head></html>`;
}
async function checkGitHub() {
  const r = await axios.get(`${GH_API}/user`, { headers: ghHeaders, timeout: 30000 });
  return r.data;
}

async function checkVercel() {
  const r = await axios.get(`${VERCEL_API}/v2/user`, { headers: vercelHeaders, timeout: 30000 });
  return r.data;
}


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
  const projectName = projectSafeName(name);

  let cleanHost = await ensureVercelAlias(projectName, deployment.id, deployment.teamId);
  if (!cleanHost) {
    cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectName);
  }
  return `https://${cleanHost}`;
}

async function createGithubPagesSite(owner, repo, branch) {
  const body = { source: { branch, path: '/' }, build_type: 'legacy', https_enforced: true };
  try { return (await githubApi('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, body, { timeout: 30000 })).data; }
  catch (error) {
    if (![409, 422].includes(error.response?.status)) throw error;
    try { return (await githubApi('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, body, { timeout: 30000 })).data || null; }
    catch (updateError) { if (updateError.response?.status === 409) return null; throw updateError; }
  }
}

async function waitForGithubPages(owner, repo, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const page = (await githubApi('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`, undefined, { timeout: 30000 })).data;
      const status = String(page?.status || '').toLowerCase();
      if (page?.html_url && ['built', 'ready'].includes(status)) return page;
      if (page?.html_url && status && !['building', 'queued', 'deploying'].includes(status)) return page;
    } catch (error) { if (error.response?.status !== 404) throw error; }
    await sleep(4000);
  }
  throw new Error('GitHub Pages belum selesai dipublikasikan dalam 2 menit.');
}

async function publishToGithubPages(name, files, render) {
  if (!ENV.GH_TOKEN || !ENV.GH_OWNER) throw new Error('TOKEN_GITHUB dan PEMILIK_GITHUB wajib diatur untuk GitHub Pages.');
  await render(15, 'Membuat repository GitHub…');
  const repo = await createGitHubRepo(projectSafeName(name), { private: false });
  const pageFiles = files.some((f) => f.path.replace(/^\/+/, '').toLowerCase() === '.nojekyll') ? files : [...files, { path: '.nojekyll', buffer: Buffer.from('', 'utf8') }];
  await render(35, 'Mengunggah berkas website…');
  const uploaded = await uploadFilesToNewRepo(repo, pageFiles);
  await render(65, 'Mengaktifkan GitHub Pages…');
  await createGithubPagesSite(repo.owner.login, repo.name, uploaded.branch);
  await render(80, 'Menunggu website dipublikasikan…');
  const page = await waitForGithubPages(repo.owner.login, repo.name);
  const url = page.html_url || `https://${String(repo.owner.login).toLowerCase()}.github.io/${repo.name}`;
  await render(95, 'Memverifikasi URL publik…');
  const verification = await verifyPublicUrl(url, 8, 4000);
  if (!verification.ok) throw new Error(`GitHub Pages aktif tetapi URL publik belum merespons (${verification.error || `HTTP ${verification.status ?? '-'}`}).`);
  return url;
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

const VIDEO_MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
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
  const prefix = kind === 'audio' ? 'aud' : kind === 'video' ? 'vid' : 'img';
  const projectName = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  const modeLabel = kind === 'audio' ? 'Audio ke URL' : kind === 'video' ? 'Video ke URL' : 'Foto ke URL';
  const fileIcon = kind === 'audio' ? '🎵' : kind === 'video' ? '🎬' : '🖼️';

  const render = async (percent, activity) => {
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', modeLabel],
        [`${fileIcon} File`, `<code>${escapeHtml(fileName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
        ['📝 Activity', escapeHtml(activity)],
      ]),
    }));
  };

  await render(10, `Mengunggah ${kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'foto'}…`);

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
    await recordMedia({ projectName, url, fileName, kind, ownerId: uid(ctx), ownerUsername: ctx.from?.username || null, ts: Date.now() });
    const elapsed = formatElapsed(Date.now() - startedAt);
    const usageFooter = kind === 'audio'
      ? '💡 Tinggal pasang di HTML:\n<code>&lt;audio src="LINK_DI_ATAS" controls&gt;&lt;/audio&gt;</code>'
      : kind === 'video'
        ? '💡 Tinggal pasang di HTML:\n<code>&lt;video src="LINK_DI_ATAS" controls&gt;&lt;/video&gt;</code>'
        : '💡 Tinggal pasang di HTML:\n<code>&lt;img src="LINK_DI_ATAS"&gt;</code>';

    await editPanel(ctx, statusMessage.message_id, panel({
      heading: `<b>${kind === 'audio' ? 'AUDIO' : kind === 'video' ? 'VIDEO' : 'FOTO'} SIAP DIPAKAI ✅️</b>`,
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


function normalizeDownloadUrl(text) { let value = String(text || '').trim(); if (!/^https?:\/\//i.test(value)) value = `https://${value}`; return new URL(value).toString(); }
function detectDownloadPlatform(url) { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok'; if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram'; if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube'; return null; }
async function resolveDownloadMedia(url, platform) {
  if (ENV.DOWNLOAD_API_URL.trim()) {
    const base = ENV.DOWNLOAD_API_URL.trim();
    const endpoint = base.includes('{url}') ? base.replaceAll('{url}', encodeURIComponent(url)) : `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
    const response = await axios.get(endpoint, { timeout: 60000, maxContentLength: 8 * 1024 * 1024, validateStatus: () => true });
    if (response.status >= 400) throw new Error(`Download API HTTP ${response.status}.`);
    const direct = response.data?.download_url || response.data?.url || response.data?.result?.download_url || response.data?.result?.url || response.data?.video_url;
    if (!direct) throw new Error('DOWNLOAD_API_URL tidak mengembalikan link media.');
    return { url: direct, title: response.data?.title || response.data?.result?.title || 'Media' };
  }
  if (platform === 'tiktok') {
    const response = await axios.get(`https://tdownv4.sl-bjs.workers.dev/?down=${encodeURIComponent(url)}`, { timeout: 60000, maxContentLength: 8 * 1024 * 1024, validateStatus: () => true });
    if (response.status >= 400) throw new Error(`TikTok downloader HTTP ${response.status}.`);
    const direct = response.data?.download_url || response.data?.video_url || response.data?.data?.download_url;
    if (!direct) throw new Error('TikTok downloader tidak mengembalikan link video.');
    return { url: direct, title: response.data?.title || 'TikTok' };
  }
  const candidates = [
    `https://api.vevioz.com/api/single/mp4?url=${encodeURIComponent(url)}`,
    `https://api.vevioz.com/api/v1/info?url=${encodeURIComponent(url)}`
  ];
  let lastError = null;
  for (const endpoint of candidates) {
    try {
      const response = await axios.get(endpoint, { timeout: 60000, maxContentLength: 8 * 1024 * 1024, validateStatus: () => true });
      if (response.status >= 400) { lastError = new Error(`Downloader HTTP ${response.status}.`); continue; }
      const direct = response.data?.download_url || response.data?.url || response.data?.result?.download_url || response.data?.result?.url || response.data?.video_url || response.data?.data?.download_url;
      if (direct) return { url: direct, title: response.data?.title || response.data?.result?.title || response.data?.data?.title || (platform === 'youtube' ? 'YouTube' : 'Instagram') };
      const returned = typeof response.data === 'string' && /^https?:\/\//i.test(response.data.trim()) ? response.data.trim() : null;
      if (returned) return { url: returned, title: platform === 'youtube' ? 'YouTube' : 'Instagram' };
      if (endpoint.includes('/api/single/')) return { url: endpoint, title: platform === 'youtube' ? 'YouTube' : 'Instagram' };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Downloader publik tidak mengembalikan media.');
}
async function downloadRemoteMediaBuffer(mediaUrl) {
  const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 7, maxContentLength: 55 * 1024 * 1024, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const type = String(response.headers?.['content-type'] || '').toLowerCase();
  if (response.status >= 400) throw new Error(`Media server HTTP ${response.status}.`);
  if (!response.data || !Buffer.from(response.data).length) throw new Error('Media kosong.');
  if (type.includes('text/html') || type.includes('application/json')) throw new Error('Downloader mengembalikan halaman/API, bukan file media langsung.');
  return { buffer: Buffer.from(response.data), contentType: type };
}
async function runExternalDownload(ctx, statusMessage, sourceUrl, requestedPlatform) {
  try {
    const resolvedPlatform = detectDownloadPlatform(sourceUrl);
    if (!resolvedPlatform) throw new Error('URL harus dari TikTok, Instagram, atau YouTube.');
    if (resolvedPlatform !== requestedPlatform) throw new Error(`Link ini terdeteksi sebagai ${resolvedPlatform}, bukan ${requestedPlatform}.`);
    await editPanel(ctx, statusMessage.message_id, panel({ heading: '📥 <b>DOWNLOAD MEDIA</b>', body: '⏳ Mencari file media…' }));
    const media = await resolveDownloadMedia(sourceUrl, resolvedPlatform);
    const caption = `✅ <b>${escapeHtml(media.title || 'Media')} siap diunduh</b>`;
    try {
      await ctx.replyWithDocument({ url: media.url }, { caption, parse_mode: 'HTML' });
    } catch (_) {
      const remote = await downloadRemoteMediaBuffer(media.url);
      const ext = remote.contentType.includes('audio') ? 'mp3' : 'mp4';
      await ctx.replyWithDocument({ source: remote.buffer, filename: `${resolvedPlatform}-${Date.now()}.${ext}` }, { caption, parse_mode: 'HTML' });
    }
    await editPanel(ctx, statusMessage.message_id, panel({ heading: '<b>DOWNLOAD SELESAI ✅</b>', body: `Platform: <b>${escapeHtml(resolvedPlatform)}</b>\n🔗 Sumber: <code>${escapeHtml(sourceUrl)}</code>` }), homeButton());
  } catch (error) {
    await editPanel(ctx, statusMessage.message_id, panel({ heading: '<b>DOWNLOAD GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
  } finally { sessions.delete(uid(ctx)); }
}

async function verifyPublicUrl(url, maxAttempts = 6, delayMs = 3000) {
  let lastStatus = null;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 400) {
        return { ok: true, status: response.status };
      }
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return { ok: false, status: lastStatus, error: lastError };
}


async function runDeployment(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const modeLabel = session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML';
  const platform = session.platform || 'vercel';
  const platformLabel = platformDisplayName(platform);
  const startedAt = Date.now();
  const isVercelHtml = platform === 'vercel' && session.type === 'deploy_html';
  const isVercelZip = platform === 'vercel' && session.type === 'deploy_zip';

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
      heading: '📊 <b>PROSES</b>',
      box: infoBox(rows),
    }));
  };

  await render(5, 'Menyiapkan berkas…');

  try {
    if (isVercelZip) {
      await render(10, 'Menyimpan berkas ke GitHub…');
      const repo = await createGitHubRepo(repoName);
      await uploadFilesToNewRepo(repo, session.files);
    } else if (!isVercelHtml) {
      try {
        const repo = await createGitHubRepo(repoName);
        await uploadFilesToNewRepo(repo, session.files);
      } catch (_) {
      }
    }

    let url;
    if (platform === 'netlify') {
      url = await publishToNetlify(repoName, session.files, render);
    } else if (platform === 'github_pages') {
      url = await publishToGithubPages(repoName, session.files, render);
    } else {
      url = await publishToVercel(repoName, session.files, render, session.envVars);
    }

    await render(97, 'Memverifikasi URL publik…');
    const verification = await verifyPublicUrl(url);
    if (!verification.ok) {
      const reason = verification.error || `HTTP ${verification.status ?? 'tidak merespons'}`;
      throw new Error(`Deployment dianggap GAGAL: URL publik tidak bisa diakses (${reason}), walau ${platformLabel} melaporkan proses selesai.`);
    }

    const elapsed = formatElapsed(Date.now() - startedAt);
    await recordDeployment({
      name: repoName,
      platform,
      url,
      ownerId: uid(ctx),
      ownerUsername: ctx.from?.username || null,
      ts: Date.now(),
    });

    await editPanel(ctx, statusMessage.message_id, panel({ body: deploySuccessMessage(repoName, url, Date.now()) }), homeButton());
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
    }), homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}


async function runGenerateBot(ctx, session, statusMessage) {
  return runGenerateBotVercel(ctx, session, statusMessage);
}

function validateGenerateBotEnv(envVars) {
  const token = (envVars || []).find((e) => /^(TOKEN_BOT|BOT_TOKEN)$/i.test(e.key));
  if (!token?.value?.trim()) throw new Error('TOKEN_BOT atau BOT_TOKEN wajib diisi agar bot hasil generate benar-benar bisa diaktifkan.');
  return token.value.trim();
}

function safeGenerateBotAutofix(files, webhookPath) {
  const cloned = files.map((f) => ({ path: f.path, buffer: Buffer.from(f.buffer) }));
  let packageFile = cloned.find((f) => f.path.toLowerCase() === 'package.json');
  if (!packageFile) throw new Error('Auto-fix dibatalkan: package.json tidak ditemukan.');
  let pkg;
  try { pkg = JSON.parse(packageFile.buffer.toString('utf8')); } catch (_) { throw new Error('Auto-fix dibatalkan: package.json tidak valid JSON.'); }
  let changed = false;
  return { files: cloned, changed };
}

async function runGenerateBotVercel(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const startedAt = Date.now();
  const envVars = session.envVars || [];
  let createdProject = null;
  let createdRepo = null;
  const render = async (percent, activity) => {
    const rows = [
      ['📡 Server', '🔵 <b>PROCESSING</b>'],
      ['🛰️ Platform', 'Vercel'],
      ['🔧 Mode', 'Generate Bot'],
      ['📦 Nama Bot', `<code>${escapeHtml(repoName)}</code>`],
      ['🔐 .env', `<b>${envVars.length}</b> variable`],
      ['🔄 Progress', `<code>${progressBar(percent)}</code> ${percent}%`],
      ['📝 Activity', escapeHtml(activity)],
    ];
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox(rows),
    }));
  };

  await render(5, 'Menyiapkan berkas…');

  try {
    await render(15, 'Membuat project & menyimpan .env…');
    validateGenerateBotEnv(envVars);
    const existingProject = await tryGetVercelProject(repoName);
    const project = existingProject || await ensureVercelProject(repoName);
    createdProject = existingProject ? null : project;
    await pushVercelEnvVars(project, envVars);


    try {
      const repo = await createGitHubRepo(repoName);
      createdRepo = repo;
      await uploadFilesToNewRepo(repo, session.files);
    } catch (_) {
    }

    let deployFiles = session.files;
    let final;
    let deployment;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await render(attempt === 1 ? 35 : 55, attempt === 1 ? 'Mengunggah berkas bot…' : 'Mencoba auto-fix deployment…');
      deployment = await createVercelDeployment(repoName, deployFiles);
      await render(attempt === 1 ? 50 : 65, 'Menunggu antrian build…');
      final = await waitForDeployment(deployment.id, deployment.teamId, 180000, async (state) => {
        if (state === 'BUILDING') await render(attempt === 1 ? 75 : 82, 'Membangun…');
        else if (state === 'READY') await render(92, 'Menyelesaikan…');
        else if (state === 'QUEUED' || state === 'INITIALIZING') await render(attempt === 1 ? 55 : 70, 'Dalam antrian build…');
        else await render(attempt === 1 ? 60 : 75, `Status: ${state || 'memproses'}…`);
      });
      if ((final.readyState || final.state) === 'READY') break;
      const err = new Error(`Build berakhir dengan status ${final.readyState || final.state || 'ERROR'}.`);
      const logTail = await getVercelBuildLogTail(deployment.id, deployment.teamId);
      if (logTail) err.detail = logTail;
      if (attempt === 1) {
        const fixed = safeGenerateBotAutofix(deployFiles, session.webhookPath);
        if (!fixed.changed) throw err;
        deployFiles = fixed.files;
        continue;
      }
      throw err;
    }


    const projectName = projectSafeName(repoName);
    let cleanHost = await ensureVercelAlias(projectName, deployment.id, deployment.teamId);
    if (!cleanHost) {
      cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectName);
    }
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
          if (!setResponse.data?.ok) {
            throw new Error(`Telegram menolak setWebhook: ${String(setResponse.data?.description || 'unknown')}`);
          }
          webhookStatus = '✅ Terdaftar otomatis';
        } catch (webhookError) {
          throw webhookError;
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
        ['🛰️ Platform', 'Vercel'],
        ['🔗 URL Project', `<a href="${escapeHtml(baseUrl)}">${escapeHtml(baseUrl)}</a>`],
        ['🧩 File Webhook', session.webhookPath ? `<code>/${escapeHtml(session.webhookPath)}</code>` : '<i>tidak ada</i>'],
        ['📡 Status Webhook', webhookStatus],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    let cleanup = [];
    try {
      if (createdProject?.id) {
        await axios.delete(`${VERCEL_API}/v9/projects/${encodeURIComponent(createdProject.id)}`, { headers: vercelHeaders, params: createdProject.teamId ? { teamId: createdProject.teamId } : undefined, timeout: 30000 });
        cleanup.push('Project Vercel dibersihkan');
      }
    } catch (cleanupError) { cleanup.push(`Project Vercel gagal dibersihkan: ${errorMessage(cleanupError)}`); }
    try {
      if (createdRepo?.owner?.login && createdRepo?.name) {
        await deleteGithubRepo(createdRepo.owner.login, createdRepo.name);
        cleanup.push('Repository GitHub dibersihkan');
      }
    } catch (cleanupError) { cleanup.push(`Repository GitHub gagal dibersihkan: ${errorMessage(cleanupError)}`); }
    const logBody = error.detail
      ? `📄 <b>Log Error:</b>\n<pre>${escapeHtml(String(error.detail).slice(0, 700))}</pre>`
      : undefined;
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>GENERATE BOT GAGAL ❌</b>',
      box: infoBox([
        ['📦 Nama', escapeHtml(repoName)],
        ['⚠️ Penyebab', escapeHtml(errorMessage(error))],
        ['🧹 Cleanup', cleanup.length ? cleanup.join('\n') : 'Tidak ada resource yang sempat dibuat'],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: logBody,
    }), homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}


bot.start(async (ctx) => {
  rememberUser(ctx);
  await loadUsers();
  rememberUser(ctx);
  if (!isAllowed(ctx)) return sendGuestMenu(ctx);
  return sendMainMenu(ctx);
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();
  sessions.delete(uid(ctx));
  return sendMainMenu(ctx);
});

bot.action('deployment_menu', async (ctx) => {
  await ctx.answerCbQuery();
  return sendPanel(ctx, panel({
    heading: '<b>DEPLOYMENT</b>',
    body: 'Pilih platform terlebih dahulu. Setelah itu bot akan menampilkan alur file yang sesuai untuk platform tersebut.',
  }), deploymentMenuMarkup());
});

bot.action('github_pages_menu', async (ctx) => { await ctx.answerCbQuery(); return sendPanel(ctx, panel({ heading: '<b>GITHUB PAGES</b>', body: 'Pilih tipe file yang mau dipublikasikan.' }), githubPagesMenuMarkup()); });

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


bot.action('github_pages_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(ctx, 'Deploy HTML — GitHub Pages', '🚀 <b>Kirim file HTML</b>\n\nURL hasil: <code>https://OWNER.github.io/PROJECT</code>.', { type: 'deploy_html', platform: 'github_pages', step: 'file' });
});

bot.action('github_pages_zip', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(ctx, 'Deploy ZIP — GitHub Pages', '📦 <b>Kirim file ZIP</b>\n\nZIP wajib memiliki <code>index.html</code>. URL hasil: <code>https://OWNER.github.io/PROJECT</code>.', { type: 'deploy_zip', platform: 'github_pages', step: 'file' });
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Get Source',
    '🌐 <b>Kirim URL</b>\n\nKirim URL website publik atau link repository GitHub.\n\n• GitHub: bot mengambil ZIP repository asli dari branch default.\n• Website publik: bot mengambil HTML/CSS/JS/asset byte yang benar-benar dapat diakses, tanpa membuat file atau struktur palsu.\n\n<i>Catatan: website SPA bisa tetap berisi shell HTML karena source repository asli tidak tersedia dari URL produksi saja.</i>',
    { type: 'source', step: 'url' }
  );
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Encrypt HTML',
    '🛡️ <b>Kirim File HTML</b>\n\nUnggah 1 file <code>.html</code> yang ingin dienkripsi.\n\n🔐 Enkripsi memakai <b>Base64 + XOR + Shuffle</b> yang sepenuhnya reversible — file hasilnya masih bisa direkonstruksi kembali menjadi HTML yang sama persis saat dibuka di browser, tanpa perlu memasukkan password.',
    { type: 'encrypt', step: 'file' }
  );
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa koneksi…');
  const status = await sendPanel(ctx, panel({ heading: '<b>SYSTEM CHECK</b>', body: '⏳ Memeriksa koneksi Telegram, GitHub, Vercel, dan Netlify…' }));
  const rows = [];
  try { await checkGitHub(); rows.push(['🐙 GitHub API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['🐙 GitHub API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  try { await checkVercel(); rows.push(['▲ Vercel API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['▲ Vercel API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  try { await checkNetlify(); rows.push(['☁️ Netlify API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['☁️ Netlify API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  rows.push(['✈️ Telegram', '🟢 <b>Aktif</b>']);
  await editPanel(ctx, status.message_id, panel({ heading: '<b>SYSTEM STATUS</b>', box: infoBox(rows) }), homeButton());
});

bot.action('add_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await sendPrompt(
    ctx,
    'Add User',
    '👤 <b>Kirim Telegram ID</b>\n\nKirim angka Telegram ID user yang ingin diberi akses ke bot ini.\n\n<i>Tidak tahu ID Telegram seseorang? Minta mereka forward pesan apapun ke bot @userinfobot.</i>',
    { type: 'add_user', step: 'id' }
  );
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const ids = [...allowedUsers].filter((x) => x !== OWNER_ID);
  for (const x of ids) await refreshUserProfileById(x);
  const ownerProfile = userProfiles.get(OWNER_ID) || { name: 'Owner' };
  const list = ids.length ? ids.map((x, i) => {
    const p = userProfiles.get(x);
    const username = p?.username ? ` · @${escapeHtml(p.username)}` : '';
    return `${i + 1}. <b>${escapeHtml(p?.name || `User ${x}`)}</b>${username}\n   🆔 <code>${x}</code>`;
  }).join('\n\n') : '<i>Belum ada user tambahan.</i>';
  const buttons = ids.length
    ? Markup.inlineKeyboard([[Markup.button.callback('🗑️  Kelola / Hapus User', 'manage_users')], [Markup.button.callback('🏠  Menu Utama', 'home')]])
    : homeButton();
  await sendPanel(ctx, panel({
    heading: '<b>AUTHORIZED USERS</b>',
    box: infoBox([
      ['👑 Owner', `<b>${escapeHtml(ownerProfile.name)}</b> · <code>${OWNER_ID}</code>`],
      ['👤 User tambahan', `<b>${ids.length}</b>`],
    ]),
    body: list,
  }), buttons);
});

bot.action('manage_users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const ids = [...allowedUsers].filter((x) => x !== OWNER_ID);
  if (!ids.length) {
    await sendPanel(ctx, panel({ heading: '<b>KELOLA USER</b>', body: '<i>Belum ada user tambahan untuk dihapus.</i>' }), homeButton());
    return;
  }
  for (const x of ids) await refreshUserProfileById(x);
  const buttons = ids.map((x) => {
    const p = userProfiles.get(x);
    return [Markup.button.callback(`❌  Hapus ${String(p?.name || `User ${x}`).slice(0, 28)}`, `rmuser_${x}`)];
  });
  buttons.push([Markup.button.callback('🏠  Menu Utama', 'home')]);
  await sendPanel(ctx, panel({
    heading: '<b>KELOLA USER</b>',
    body: 'Tap salah satu user di bawah untuk mencabut aksesnya dari bot ini.',
  }), Markup.inlineKeyboard(buttons));
});

bot.action(/^rmuser_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
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
  const ownerView = isOwner(ctx);
  const supportedDeployments = all.filter((d) => ['vercel', 'netlify', 'github_pages'].includes(d.platform));
  const relevant = ownerView ? supportedDeployments : supportedDeployments.filter((d) => d.ownerId === uid(ctx));
  const recent = relevant.slice(-20).reverse();

  if (!recent.length) {
    await sendPanel(ctx, panel({
      heading: `<b>LIST WEB${ownerView ? ' (SEMUA USER)' : ''}</b>`,
      body: ownerView ? '<i>Belum ada web yang tercatat.</i>' : '<i>Kamu belum pernah deploy web lewat bot ini.</i>',
    }), homeButton());
    return;
  }

  const status = await sendPanel(ctx, panel({
    heading: `<b>LIST WEB${ownerView ? ' (SEMUA USER)' : ''}</b>`,
    body: '⏳ Memeriksa status tiap web (hanya yang masih aktif yang akan ditampilkan)…',
  }));

  const active = [];
  for (const d of recent) {
    try {
      const verification = await verifyPublicUrl(d.url, 1, 0);
      if (verification.ok) active.push(d);
    } catch (_) {
    }
  }

  if (!active.length) {
    await editPanel(ctx, status.message_id, panel({
      heading: `<b>LIST WEB${ownerView ? ' (SEMUA USER)' : ''}</b>`,
      body: '<i>Tidak ada web aktif yang bisa ditampilkan saat ini — kemungkinan sudah dihapus atau sedang tidak respons.</i>',
    }), homeButton());
    return;
  }

  const lines = active.map((d, i) => {
    const platformLabel = platformDisplayName(d.platform);
    const who = ownerView ? ` — <code>${d.ownerId}</code>` : '';
    return `${i + 1}. <a href="${escapeHtml(d.url)}">${escapeHtml(d.name)}</a> (${escapeHtml(platformLabel)})${who}`;
  });

  await editPanel(ctx, status.message_id, panel({
    heading: `<b>LIST WEB${ownerView ? ' (SEMUA USER)' : ''}</b>`,
    body: lines.join('\n'),
    footer: `Menampilkan ${active.length} web aktif dari ${relevant.length} total tercatat.`,
  }), homeButton());
});

bot.action('broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await sendPrompt(
    ctx,
    'Broadcast',
    '📢 <b>Kirim Pesan Broadcast</b>\n\nKetik pesan yang mau dikirim ke SEMUA user terdaftar di bot ini.',
    { type: 'broadcast', step: 'text' }
  );
});

bot.action('media_menu', async (ctx) => {
  await ctx.answerCbQuery();
  return sendPanel(ctx, panel({
    heading: '<b>MEDIA KE URL</b>',
    body: 'Pilih jenis media. File akan diproses sebagai file asli yang dikirim ke bot, lalu dipublikasikan sebagai URL langsung.',
  }), mediaMenuMarkup());
});

bot.action('download_menu', async (ctx) => { await ctx.answerCbQuery(); return sendPanel(ctx, panel({ heading: '<b>DOWNLOAD MEDIA</b>', body: 'Pilih platform lalu kirim URL publik.' }), downloadMenuMarkup()); });
for (const [action, platform, label] of [['download_tiktok', 'tiktok', 'TikTok'], ['download_instagram', 'instagram', 'Instagram'], ['download_youtube', 'youtube', 'YouTube']]) {
  bot.action(action, async (ctx) => { await ctx.answerCbQuery(); await sendPrompt(ctx, `Download ${label}`, `📥 <b>Kirim Link ${label}</b>\n\nKirim URL publik ${label}.`, { type: 'download', platform, step: 'url' }); });
}

bot.action('donation', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    let buffer;
    if (ENV.QRIS_URL) {
      const response = await axios.get(ENV.QRIS_URL, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 10 * 1024 * 1024, validateStatus: () => true });
      const ct = String(response.headers?.['content-type'] || '').toLowerCase();
      if (response.status >= 400 || !ct.startsWith('image/')) throw new Error(`QRIS_URL tidak dapat diambil (HTTP ${response.status}).`);
      buffer = Buffer.from(response.data);
    } else {
      const local = [path.join(process.cwd(), 'qris.png'), path.join(process.cwd(), 'api', 'qris.png'), path.join(__dirname, 'qris.png')].find((x) => fs.existsSync(x));
      if (!local) throw new Error('QRIS belum dikonfigurasi. Isi QRIS_URL atau tambahkan qris.png ke project.');
      buffer = fs.readFileSync(local);
    }
    await ctx.replyWithPhoto({ source: buffer }, { caption: '💝 <b>Donasi DevTools Raven</b>\n\nScan QRIS pada gambar di atas.', parse_mode: 'HTML' });
  } catch (error) {
    await sendPanel(ctx, panel({ heading: '<b>QRIS BELUM SIAP ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
  }
});

bot.action('media_list', async (ctx) => {
  await ctx.answerCbQuery('Memuat media…');
  const all = await loadMediaRecords();
  const relevant = isOwner(ctx) ? all : all.filter((x) => Number(x.ownerId) === uid(ctx));
  const recent = relevant.slice(-30).reverse();
  if (!recent.length) return sendPanel(ctx, panel({ heading: '<b>LIST MEDIA</b>', body: '<i>Belum ada media yang tersimpan.</i>' }), homeButton());
  const lines = recent.map((x, i) => `${i + 1}. <a href="${escapeHtml(x.url)}">${escapeHtml(x.fileName || x.projectName)}</a> · ${escapeHtml(String(x.kind || 'media').toUpperCase())}${isOwner(ctx) ? ` · <code>${escapeHtml(String(x.ownerId))}</code>` : ''}`);
  return sendPanel(ctx, panel({ heading: '<b>LIST MEDIA</b>', body: lines.join('\n\n'), footer: `Menampilkan ${recent.length} media terakhir.` }), homeButton());
});

bot.action('media_delete', async (ctx) => { await ctx.answerCbQuery(); await sendPrompt(ctx, 'Delete Media', '🗑️ <b>Kirim URL media</b> yang sebelumnya dibuat lewat Media ke URL.', { type: 'media_delete', step: 'url' }); });

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

bot.action('video_url', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Video ke URL',
    '🎬 <b>Kirim File Video</b>\n\nKirim video yang mau dijadikan URL publik langsung.\n\nFormat didukung: MP4, WEBM, MOV, MKV, OGV.\n\n<i>Kirim sebagai File/Dokumen untuk mempertahankan file asli.</i>',
    { type: 'video_url', step: 'file' }
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

bot.action('web_to_apk', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Build Web ke APK',
    '📱 <b>Kirim Project Web</b>\n\nKirim <code>.zip</code> berisi project web dengan <code>index.html</code>, atau kirim 1 file <code>.html</code>.\n\nBot akan membungkus asset web menjadi aplikasi Android WebView lokal dan membuild APK asli lewat GitHub Actions. Tidak ada browser address bar dan asset lokal tidak perlu refresh dari server web.',
    { type: 'web_to_apk', step: 'file' }
  );
});

bot.action('generate_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPrompt(
    ctx,
    'Generate Bot',
    '🤖 <b>Langkah 1 — Kirim ZIP Project Bot</b>\n\nUpload ZIP project bot Node.js (model <b>webhook</b>, bukan polling — deploy-nya ke Vercel yang serverless) yang mau dideploy otomatis.\n\n⚠️ Wajib ada <code>package.json</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).\n\n<i>Struktur folder bebas — jumlah & nama file di dalam <code>api/</code> boleh apa saja, bot akan coba deteksi otomatis mana file handler-nya.</i>',
    { type: 'generate_bot', platform: 'vercel', step: 'file' }
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
  const hasToken = (session.envVars || []).some((e) => /^(TOKEN_BOT|BOT_TOKEN)$/i.test(e.key) && String(e.value || '').trim());
  if (!hasToken) {
    session.step = 'gb_env_key';
    sessions.set(id, session);
    await sendPrompt(ctx, 'Generate Bot — .env', '⚠️ <b>TOKEN_BOT atau BOT_TOKEN wajib diisi.</b>\n\nTanpa token bot Telegram, bot hasil generate tidak bisa diaktifkan atau didaftarkan webhook secara nyata. Kirim KEY: <code>TOKEN_BOT</code> atau <code>BOT_TOKEN</code>.', session);
    return;
  }
  session.step = 'gb_name';
  await sendPrompt(ctx, 'Generate Bot', '🚀 <b>Langkah Terakhir — Nama Bot</b>\n\nKirim nama repository/project untuk bot ini (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>bot-kedua-saya</code>', session);
});

bot.action('help_info', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel({
    heading: '<b>ℹ️ TENTANG BOT INI</b>',
    body:
      '<b>DevTools Raven V3</b> menyediakan utilitas deployment, pengelolaan project, media, source, dan otomasi bot dengan API resmi.\n\n<b>Ringkasan fitur:</b>\n' +
      '🚀 Deploy Vercel/Netlify/GitHub Pages — upload HTML/ZIP, langsung online\n' +
      '⚙️ Tambah .env — isi environment variable sebelum deploy (Vercel ZIP)\n' +
      '📱 Web ke APK — build APK Android dari HTML/ZIP menggunakan GitHub Actions\n' +
      '🌐 Get Source — repository GitHub diambil sebagai ZIP asli; website publik hanya mengambil byte source/assets yang benar-benar tersedia\n' +
      '🛡️ Encrypt HTML — enkripsi reversible tanpa placeholder Decrypting dan tanpa flash UI awal\n' +
      '🖼️🎵🎬 Foto/Audio/Video ke URL — upload file asli, dapat link langsung\n' +
      '📸 Screenshot URL — ambil gambar tampilan website manapun\n' +
      '📥 Download Media — TikTok, Instagram, dan YouTube\n' +
      '📋 List Media / 🗑️ Delete Media — kelola media yang sudah dipublikasikan\n' +
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
    '🗑️ <b>Kirim Link Website</b>\n\nKirim link website hasil deploy DevTools Raven yang ingin dihapus.\nContoh: <code>https://nama-web.vercel.app</code>, <code>https://nama-web.netlify.app</code>, atau <code>https://${String(ENV.GH_OWNER).toLowerCase()}.github.io/nama-web</code>\n\nBot otomatis mengenali platform dari link dan menghapus website beserta repository GitHub yang cocok bila ditemukan.',
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
    if (!isOwner(ctx)) return;
    const target = Number(text);
    if (!Number.isInteger(target) || target <= 0) {
      await sendPrompt(ctx, 'Add User', '❌ <b>ID tidak valid.</b>\n\nKirim ulang dalam bentuk angka saja, contoh: <code>123456789</code>.', session);
      return;
    }
    allowedUsers.add(target);
    await refreshUserProfileById(target);
    try {
      await saveUsers();
      sessions.delete(id);
      const profile = userProfiles.get(target);
      await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: `✅ User <b>${escapeHtml(profile?.name || `User ${target}`)}</b> (<code>${target}</code>) berhasil ditambahkan dan sekarang punya akses ke bot ini.` }), homeButton());
    } catch (error) {
      allowedUsers.delete(target);
      sessions.delete(id);
      await sendPanel(ctx, panel({ heading: '<b>ADD USER GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'broadcast' && session.step === 'text') {
    if (!isOwner(ctx)) return;
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
      const result = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(text.trim())
        ? await getOriginalGithubSource(text.trim())
        : await getPublicSource(text.trim());
      await ctx.replyWithDocument({ source: result.buffer, filename: result.originalRepository ? `${repoSafeName(result.fullName)}-source.zip` : 'source-public.zip' }, { caption: result.originalRepository ? '✅ Repository asli GitHub berhasil diambil sebagai ZIP.' : '✅ Source publik asli yang tersedia berhasil dibundel menjadi ZIP.' });
      const noteLines = [];
      if (result.originalRepository) {
        noteLines.push(`✅ Repository asli diambil lewat endpoint resmi GitHub.
🌿 Branch: <code>${escapeHtml(result.branch)}</code>`);
      } else if (result.isSpaLikely) {
        noteLines.push('⚠️ Website ini kemungkinan React/Vue/Next.js (SPA) — ZIP berisi byte source/assets publik yang benar-benar dapat diambil, bukan source repository yang direka-reka.');
      } else {
        noteLines.push('✅ HTML/CSS/JS/gambar/font yang benar-benar tersedia secara publik sudah dibundel sebagai file asli yang diterima bot.');
      }
      if (result.failedAssets?.length) {
        noteLines.push(`⚠️ <b>${result.failedAssets.length}</b> asset gagal diambil (kemungkinan diblokir CORS/hotlink protection) dan TIDAK dimasukkan ke ZIP.`);
      }
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET SOURCE SELESAI ✅</b>',
        box: infoBox([
          ['🌐 Sumber', `<code>${escapeHtml(text)}</code>`],
          ['📦 Asset', `<b>${result.assetCount}</b> file`],
        ]),
        body: noteLines.join('\n\n'),
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
        `${i + 1}. <a href="${escapeHtml(r.html_url)}">${escapeHtml(r.full_name)}</a>\n   ⭐ ${r.stargazers_count ?? 0} · 🕒 ${escapeHtml(String(r.updated_at || '').slice(0, 10) || '-')} · ${escapeHtml(r.language || '-')}\n   ${r.description ? `<i>${escapeHtml(r.description.slice(0, 100))}</i>` : '<i>Tidak ada deskripsi.</i>'}`
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

  if (session.type === 'download' && session.step === 'url') {
    const platform = session.platform; sessions.delete(id); const status = await sendPanel(ctx, panel({ heading: '📥 <b>DOWNLOAD MEDIA</b>', body: '⏳ Memproses link…' }));
    try { await runExternalDownload(ctx, status, normalizeDownloadUrl(text), platform); } catch (error) { await editPanel(ctx, status.message_id, panel({ heading: '<b>DOWNLOAD GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton()); }
    return;
  }

  if (session.type === 'media_delete' && session.step === 'url') {
    sessions.delete(id); const status = await sendPanel(ctx, panel({ heading: '<b>DELETE MEDIA</b>', body: '⏳ Mencari media…' }));
    try {
      const url = normalizeDownloadUrl(text); const records = await loadMediaRecords(); const record = records.find((x) => x.url === url && (isOwner(ctx) || Number(x.ownerId) === id));
      if (!record) throw new Error('Media tidak ditemukan atau bukan milik akun ini.');
      if (record.url.includes('.vercel.app')) await deleteVercelProject(await resolveVercelProjectFromUrl(record.url));
      await removeMediaRecord(record.projectName, record.ownerId);
      await editPanel(ctx, status.message_id, panel({ heading: '<b>MEDIA DIHAPUS ✅</b>', body: `📁 File: <code>${escapeHtml(record.fileName)}</code>\n🔗 URL: <code>${escapeHtml(record.url)}</code>` }), homeButton());
    } catch (error) { await editPanel(ctx, status.message_id, panel({ heading: '<b>DELETE MEDIA GAGAL ❌</b>', body: `<code>${escapeHtml(errorMessage(error))}</code>` }), homeButton()); }
    return;
  }

  if (session.type === 'delete' && session.step === 'link') {
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>DELETE WEB</b>', body: '⏳ Mencari project dari link…' }));
    try {
      const target = await resolveDeployTargetFromUrl(text);
      const platformLabel = platformDisplayName(target.platform);

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
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Generate Bot'],
        ['📦 Nama Bot', `<code>${escapeHtml(session.name)}</code>`],
        ['🔐 .env', `<b>${session.envVars?.length || 0}</b> variable`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
    }));
    await runGenerateBot(ctx, session, status);
    return;
  }

  if ((session.type === 'deploy_html' || session.type === 'deploy_zip') && session.step === 'name') {
    session.name = repoSafeName(text);
    session.step = 'deploying';
    sessions.set(id, session);
    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🛰️ Platform', escapeHtml(platformDisplayName(session.platform))],
        ['🔧 Mode', escapeHtml(session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML')],
        ['📦 Nama Web', `<code>${escapeHtml(session.name)}</code>`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
    }));
    await runDeployment(ctx, session, status);
    return;
  }

  if (session.type === 'deploy_html' || session.type === 'deploy_zip') {
    await sendPrompt(ctx, 'Deploy', 'Tahap ini belum meminta nama website. Ikuti instruksi terakhir dari bot di atas, atau tekan tombol Menu Utama untuk mengulang.', session);
  }
});

bot.on('audio', async (ctx) => {
  const id = uid(ctx); const session = sessions.get(id);
  if (!session || session.type !== 'audio_url' || session.step !== 'file') return;
  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  const audio = ctx.message.audio; const mimeType = String(audio.mime_type || '').toLowerCase(); const rawName = String(audio.file_name || '').trim();
  const ext = rawName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || AUDIO_MIME_EXT[mimeType] || 'mp3';
  if (!mimeType.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(rawName)) { await sendPrompt(ctx, 'Audio ke URL', '❌ <b>Format tidak didukung.</b>', { type: 'audio_url', step: 'file' }); return; }
  try {
    const buffer = await downloadTelegramFile(ctx, audio.file_id); const safeName = sanitizeImageFileName(rawName || `audio-${Date.now()}.${ext}`, ext, 'audio'); sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '📊 <b>PROSES</b>', box: infoBox([['📡 Server', '🔵 <b>PROCESSING</b>'], ['🔧 Mode', 'Audio ke URL'], ['🎵 File', `<code>${escapeHtml(safeName)}</code>`], ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`], ['📝 Activity', 'Memulai proses…']]) }));
    await runFileToUrl(ctx, [{ path: safeName, buffer }], status, 'audio');
  } catch (error) { sessions.delete(id); await sendPrompt(ctx, 'Audio ke URL', `<b>Gagal mengambil audio.</b>\n<code>${escapeHtml(errorMessage(error))}</code>`, { type: 'audio_url', step: 'file' }); }
});

bot.on('video', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'video_url' || session.step !== 'file') return;
  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  try {
    const video = ctx.message.video;
    const buffer = await downloadTelegramFile(ctx, video.file_id);
    const rawName = String(video.file_name || '').trim();
    const ext = rawName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'mp4';
    const fileName = sanitizeImageFileName(rawName || `video-${Date.now()}.${ext}`, ext, 'video');
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Video ke URL'],
        ['🎬 File', `<code>${escapeHtml(fileName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
    }));
    await runFileToUrl(ctx, [{ path: fileName, buffer }], status, 'video');
  } catch (error) {
    sessions.delete(id);
    await sendPrompt(ctx, 'Video ke URL', `❌ <b>Gagal mengambil video dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, { type: 'video_url', step: 'file' });
  }
});

bot.on('photo', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'photo_url' || session.step !== 'file') return;

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  try {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    const buffer = await downloadTelegramFile(ctx, largest.file_id);
    const fileName = `foto-${Date.now()}.jpg`;
    sessions.delete(id);

    const status = await sendPanel(ctx, panel({
      heading: '📊 <b>PROSES</b>',
      box: infoBox([
        ['📡 Server', '🔵 <b>PROCESSING</b>'],
        ['🔧 Mode', 'Foto ke URL'],
        ['🖼️ File', `<code>${escapeHtml(fileName)}</code>`],
        ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
        ['📝 Activity', 'Memulai proses…'],
      ]),
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
        heading: '📊 <b>PROSES</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Foto ke URL'],
          ['🖼️ File', `<code>${escapeHtml(safeName)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
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
        heading: '📊 <b>PROSES</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Audio ke URL'],
          ['🎵 File', `<code>${escapeHtml(safeName)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        }));
      await runFileToUrl(ctx, [{ path: safeName, buffer }], status, 'audio');
    } catch (error) {
      await sendPrompt(ctx, 'Audio ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'video_url' && session.step === 'file') {
    const mimeType = document.mime_type || '';
    const extFromMime = VIDEO_MIME_EXT[mimeType.toLowerCase()];
    const looksLikeVideoName = /\.(mp4|webm|mov|mkv|ogv)$/i.test(fileName);
    if (!mimeType.startsWith('video/') && !looksLikeVideoName) {
      await sendPrompt(ctx, 'Video ke URL', '❌ <b>Format tidak didukung.</b>\n\nKirim video dengan format MP4, WEBM, MOV, MKV, atau OGV.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const safeName = sanitizeImageFileName(fileName, extFromMime || 'mp4', 'video');
      sessions.delete(id);
      const status = await sendPanel(ctx, panel({
        heading: '📊 <b>PROSES</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Video ke URL'],
          ['🎬 File', `<code>${escapeHtml(safeName)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        }));
      await runFileToUrl(ctx, [{ path: safeName, buffer }], status, 'video');
    } catch (error) {
      await sendPrompt(ctx, 'Video ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'web_to_apk' && session.step === 'file') {
    if (!/\.(zip|html?)$/i.test(fileName)) {
      await sendPrompt(ctx, 'Build Web ke APK', '❌ <b>Format salah.</b>\n\nKirim file <code>.zip</code> atau <code>.html</code>.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = /\.zip$/i.test(fileName) ? await extractZipGeneric(buffer) : [{ path: 'index.html', buffer }];
      if (!session.files.some((f) => /(^|\/)index\.html$/i.test(f.path))) {
        await sendPrompt(ctx, 'Build Web ke APK', '❌ <b>index.html tidak ditemukan.</b>\n\nPastikan ZIP memiliki halaman utama <code>index.html</code>.', session);
        return;
      }
      session.name = repoSafeName(fileName.replace(/\.(zip|html?)$/i, '')) || 'devtools-raven-app';
      session.step = 'deploying';
      sessions.set(id, session);
      const status = await sendPanel(ctx, panel({
        heading: '📊 <b>PROSES</b>',
        box: infoBox([
          ['📡 Server', '🔵 <b>PROCESSING</b>'],
          ['🔧 Mode', 'Build Web to APK'],
          ['📦 Project', `<code>${escapeHtml(session.name)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        footer: 'Build APK asli sedang diproses.',
      }));
      await runWebToApk(ctx, session, status);
    } catch (error) {
      await sendPrompt(ctx, 'Build Web ke APK', `❌ <b>Project tidak bisa diproses.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
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
        if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
        const message = await sendPanel(ctx, panel({
          heading: '<b>Generate Bot</b>',
          body: `📄 ZIP OK (${files.length} file).\n\n🧩 Ditemukan <b>${detected.candidates.length}</b> file di folder <code>api/</code>. Pilih mana yang jadi handler bot-nya:`,
        }), Markup.inlineKeyboard(buttons));
        session.controlMessageId = message.message_id;
        sessions.set(id, session);
      } else {
        session.webhookPath = null;
        await startGenerateBotEnvCollection(ctx, session, `📄 ZIP OK (${files.length} file).\n⚠️ Tidak ditemukan file <code>.js</code> di folder <code>api/</code> atau <code>vercel.json</code> yang valid — webhook tidak akan didaftarkan otomatis, kamu perlu <code>setWebhook</code> manual nanti.`);
      }
    } catch (error) {
      await sendPrompt(ctx, 'Generate Bot', `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_html' && session.step === 'file') {
    const platformLabel = platformDisplayName(session.platform);
    if (!/\.html?$/i.test(fileName)) {
      await sendPrompt(ctx, `Deploy HTML — ${platformLabel}`, '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = [{ path: 'index.html', buffer }];
      await askEnvChoiceOrName(ctx, session, `📄 File diterima: <code>${escapeHtml(fileName)}</code>`);
    } catch (error) {
      await sendPrompt(ctx, `Deploy HTML — ${platformLabel}`, `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_zip' && session.step === 'file') {
    const platformLabel = platformDisplayName(session.platform);
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, `Deploy ZIP — ${platformLabel}`, '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.zip</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = await extractZip(buffer);
      await askEnvChoiceOrName(ctx, session, `📦 ZIP diterima: <b>${session.files.length}</b> file ditemukan.`);
    } catch (error) {
      await sendPrompt(ctx, `Deploy ZIP — ${platformLabel}`, `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'file') {
    if (!/\.html?$/i.test(fileName)) {
      await sendPrompt(ctx, 'Encrypt HTML', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      sessions.delete(id);
      const encrypted = encryptHtmlReversible(buffer.toString('utf8'));
      await ctx.replyWithDocument({ source: Buffer.from(encrypted, 'utf8'), filename: `${fileName.replace(/\.html?$/i, '')}-encrypted.html` }, { caption: '✅ HTML berhasil dienkripsi (Base64 + XOR + Shuffle, reversible).' });
      await sendPanel(ctx, panel({
        heading: '<b>ENCRYPT SELESAI ✅</b>',
        body: 'File terenkripsi sudah dikirim di atas.\n\n🔐 Hasil enkripsi ini <b>reversible</b> — saat dibuka di browser, HTML asli akan direkonstruksi otomatis oleh decoder yang sudah tertanam di dalam file. Tidak perlu password.',
      }), homeButton());
    } catch (error) {
      await sendPrompt(ctx, 'Encrypt HTML', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(errorMessage(error))}</code>`, session);
    }
  }
});

bot.command('adduser', async (ctx) => {
  if (!isOwner(ctx)) return;
  const target = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(target) || target <= 0) {
    await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: '❌ Format salah. Gunakan: <code>/adduser 123456789</code>' }));
    return;
  }
  allowedUsers.add(target);
  await refreshUserProfileById(target);
  try {
    await saveUsers();
    const profile = userProfiles.get(target);
    await sendPanel(ctx, panel({ heading: '<b>ADD USER</b>', body: `✅ User <b>${escapeHtml(profile?.name || `User ${target}`)}</b> (<code>${target}</code>) berhasil ditambahkan.` }), homeButton());
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
  return res.status(200).send('DevTools Raven Bot Online');
};
