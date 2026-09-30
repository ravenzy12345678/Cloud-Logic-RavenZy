const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildId, workflowYml, androidWorkflowYml, createRepo: createBuildRepo, uploadFiles: uploadBuildFiles, dispatchWorkflow, createRelease, uploadReleaseAsset, downloadReleaseAsset, getArtifact, cancelRun, deleteRepo: deleteBuildRepo } = require('./build-engine');
const { extractZip: extractRenameZip, scanRenameFiles, transformZip: transformRenameZip } = require('./rename');
const legacyTools = require('./legacy-tools');

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
const userProfiles = new Map();
const bannedUsers = new Set();
const repoQuota = new Map();
const joinCache = new Map();
const joinGateSeen = new Map();
let maintenanceEnabled = false;
let userPersistTimer = null;
let controlStateLoadedAt = 0;

const DONATION_QRIS_URL = 'https://img-fa672855.vercel.app/foto-1790534975799.jpg';
const MANDATORY_CHANNEL = '@status_builder';
const NOTIFICATION_CHANNEL = '@status_builder';
const JOIN_CACHE_TTL = 30_000;
const REPO_QUOTA_LIMIT = 2;
const REPO_QUOTA_FILE = 'devtools-raven-repo-quota.json';
const BANNED_FILE = 'devtools-raven-banned.json';
const BUILD_FILE = 'devtools-raven-builds.json';
const SETTINGS_FILE = 'devtools-raven-settings.json';
const BUILD_CONCURRENCY_NOTE = 'GitHub Actions';
const OWNER_TELEGRAM_URL = 'https://t.me/RavenZyPT';
const OWNER_WHATSAPP_URL = 'https://wa.me/6288271102065';
const OWNER_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb89MImFHWptXTOThg3G';
const BUY_MESSAGE = 'Saya ingin membeli akses Get Repo/Cari Repo DevTools dengan harga 5k, tolong di acc';
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

// Multipart/form-data dibangun manual pakai Node bawaan (Buffer + crypto),
// SENGAJA tidak pakai package npm 'form-data' — supaya bot tidak bisa
// crash gara-gara 1 dependency kelupaan ke-install (mis. package.json lupa
// ditimpa). Cuma butuh axios yang memang sudah wajib ada dari awal.
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
  return 'Vercel';
}

function errorMessage(error) {
  return error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    'Unknown error';
}

function scrubSensitive(text) {
  let out = String(text ?? '');
  out = out.replace(/(bot_token|token_bot|access_token|api[_-]?key|api[_-]?hash|authorization|bearer)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/ig, 'Bearer [REDACTED]');
  out = out.replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]');
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]');
  return out.slice(0, 6000);
}

function safeError(error) {
  return scrubSensitive(errorMessage(error));
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
  return Number.isInteger(id) && !bannedUsers.has(id);
}

function isUserBanned(id) {
  return bannedUsers.has(Number(id));
}

async function refreshControlStateIfStale() {
  if (Date.now() - controlStateLoadedAt < 15_000) return;
  await loadControlState();
}

function featureIsExemptFromMaintenance(ctx) {
  if (isOwner(ctx)) return true;
  const action = ctx.callbackQuery?.data || '';
  return action === 'home' || action === 'system' || action === 'help_info' || action === 'donation';
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
  if (id !== OWNER_ID && !userPersistTimer) {
    userPersistTimer = setTimeout(() => { userPersistTimer = null; saveUsers().catch(() => {}); }, 750);
  }
}

function joinButtonMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.url('📢 JOIN CHANNEL', `https://t.me/${MANDATORY_CHANNEL.replace(/^@/, '')}`)],
    [Markup.button.callback('🔄 CEK JOIN', 'check_join')],
  ]);
}

function ownerContactMarkup() {
  return Markup.inlineKeyboard([[Markup.button.url('💬 Hubungi Owner', OWNER_TELEGRAM_URL)], [Markup.button.url('💚 WhatsApp Owner', OWNER_WHATSAPP_URL)]]);
}

async function sendJoinGate(ctx, forcePhoto = true) {
  const name = escapeHtml(ctx.from?.username || userDisplayName(ctx.from));
  const caption = [
    `🔒 <b>JOIN CHANNEL WAJIB</b>`,
    BAR,
    `Halo, <b>${name}</b>.`,
    `Untuk memakai DevTools Raven, kamu wajib join <code>${escapeHtml(MANDATORY_CHANNEL)}</code>.`,
    `\n1. Tekan <b>JOIN CHANNEL</b>.`,
    `2. Setelah selesai, tekan <b>/start</b> lagi.`,
    `3. Bot akan otomatis memeriksa status membership.`,
  ].join('\n');
  const photo = path.join(__dirname, '..', 'assets', 'raven-welcome.jpg');
  if (forcePhoto && fs.existsSync(photo)) {
    try { return await ctx.replyWithPhoto({ source: photo }, { caption, parse_mode: 'HTML', ...joinButtonMarkup() }); } catch (_) {}
  }
  return sendPanel(ctx, caption, joinButtonMarkup());
}

function memberStatusAllowed(status) {
  return status === 'creator' || status === 'administrator' || status === 'member' || (status === 'restricted' && true);
}

async function checkMandatoryChannel(userId, force = false) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const cached = joinCache.get(id);
  if (!force && cached && Date.now() - cached.ts < JOIN_CACHE_TTL) return cached.ok;
  try {
    const member = await bot.telegram.getChatMember(MANDATORY_CHANNEL, id);
    const ok = memberStatusAllowed(member?.status) && !(member?.status === 'restricted' && member?.is_member === false);
    joinCache.set(id, { ok, ts: Date.now() });
    return ok;
  } catch (error) {
    console.error('[JOIN CHECK]', errorMessage(error));
    joinCache.set(id, { ok: false, ts: Date.now(), error: true });
    return false;
  }
}

function invalidateJoin(userId) { joinCache.delete(Number(userId)); }

async function enforceJoinGate(ctx) {
  const id = uid(ctx);
  if (!Number.isInteger(id)) return false;
  if (isUserBanned(id)) {
    await sendPanel(ctx, panel({ heading: '<b>AKSES DITOLAK ⛔</b>', body: 'Akun ini sedang diblokir oleh owner.' }), ownerContactMarkup());
    return false;
  }
  const joined = await checkMandatoryChannel(id);
  if (!joined) {
    await sendJoinGate(ctx);
    return false;
  }
  return true;
}

async function requireFeatureAccess(ctx, opts = {}) {
  if (!isAllowed(ctx)) return false;
  if (opts.owner && !isOwner(ctx)) {
    await ctx.answerCbQuery?.('Fitur khusus owner.', { show_alert: true }).catch(() => {});
    return false;
  }
  if (!opts.owner && !featureIsExemptFromMaintenance(ctx) && maintenanceEnabled) {
    await sendPanel(ctx, panel({ heading: '<b>MAINTENANCE 🛠️</b>', body: 'Builder sedang maintenance. Fitur user sementara dinonaktifkan. Owner tetap dapat mengelola sistem.' }), ownerContactMarkup());
    return false;
  }
  return enforceJoinGate(ctx);
}

async function sendGuestMenu(ctx) {
  return sendJoinGate(ctx);
}

bot.use(async (ctx, next) => {
  rememberUser(ctx);
  await refreshControlStateIfStale();
  const id = uid(ctx);
  if (!Number.isInteger(id)) return undefined;
  if (isUserBanned(id)) {
    const isStart = /^\/start(?:\s|$)/i.test(ctx.message?.text?.trim() || '');
    if (isStart) await sendJoinGate(ctx, false);
    return undefined;
  }
  const action = ctx.callbackQuery?.data || '';
  const text = ctx.message?.text?.trim() || '';
  const exemptStart = /^\/start(?:\s|$)/i.test(text);
  if (exemptStart || action === 'check_join') return next();
  if (!await checkMandatoryChannel(id)) {
    await sendJoinGate(ctx, false);
    return undefined;
  }
  if (!isOwner(ctx) && maintenanceEnabled && action && !featureIsExemptFromMaintenance(ctx)) {
    await ctx.answerCbQuery?.('Maintenance aktif.', { show_alert: true }).catch(() => {});
    return undefined;
  }
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
// 4. Menu owner (Users, Broadcast, build controls) HANYA muncul untuk OWNER_ID.
// ─────────────────────────────────────────────

const BAR = '───── ✦ ───── ✦ ─────';
const BRAND = 'DEVTOOLS RAVEN · V3';

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Menu Utama', 'home')]]);
}

function mainMenuMarkup(ctx) {
  const rows = [
    [Markup.button.callback('💥  Build Flutter APK', 'flutter_build'), Markup.button.callback('🌐  Web to APK', 'web_to_apk')],
    [Markup.button.callback('✏️  Rename Project', 'rename_project'), Markup.button.callback('📄  Get Source', 'get_source')],
    [Markup.button.callback('🛡️  Encrypt HTML/JS', 'encrypt_html'), Markup.button.callback('🖼️  Media ke URL', 'media_menu')],
    [Markup.button.callback('📸  Screenshot URL', 'screenshot_url'), Markup.button.callback('📦  Get Repo ZIP', 'repo_zip')],
    [Markup.button.callback('🔎  Cari Repo', 'search_repo'), Markup.button.callback('⏳  Antrian Build', 'build_queue')],
    [Markup.button.callback('📡  Status Server', 'system'), Markup.button.callback('📋  List Web', 'list_web')],
    [Markup.button.callback('🧰  Tools Lainnya', 'tools_menu'), Markup.button.callback('ℹ️  Bantuan', 'help_info')],
    [Markup.button.callback('💝  Donasi', 'donation')],
  ];
  if (ctx && isOwner(ctx)) {
    rows.unshift([Markup.button.callback('👑  OWNER PANEL', 'owner_panel')]);
    rows.push([Markup.button.callback('🚀  Auto Deploy', 'deployment_menu'), Markup.button.callback('🤖  Generate Bot', 'generate_bot')]);
    rows.push([Markup.button.callback('🗑️  Delete Web', 'delete_web')]);
  }
  return Markup.inlineKeyboard(rows);
}

function ownerPanelMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📦 List Build', 'owner_builds'), Markup.button.callback('📥 Get ZIP Build', 'owner_build_picker')],
    [Markup.button.callback('⏹️ Kill Build', 'owner_kill_builds'), Markup.button.callback('🛠️ Maintenance', 'owner_maintenance')],
    [Markup.button.callback('👥 Users', 'users'), Markup.button.callback('🚫 Ban User', 'ban_user')],
    [Markup.button.callback('📋 List Web', 'list_web'), Markup.button.callback('✅ Unban User', 'unban_user')],
    [Markup.button.callback('📢 Broadcast', 'broadcast')],
    [Markup.button.callback('🏠 Menu Utama', 'home')],
  ]);
}

function deploymentMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('▲  Vercel', 'deploy_vercel'), Markup.button.callback('🌐  Netlify', 'deploy_netlify')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function mediaMenuMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️  Foto ke URL', 'photo_url'), Markup.button.callback('🎵  Audio ke URL', 'audio_url')],
    [Markup.button.callback('🎬  Video ke URL', 'video_url')],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

function fileTypeMarkup(platform) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄  Deploy HTML', `${platform}_html`), Markup.button.callback('📦  Deploy ZIP', `${platform}_zip`)],
    [Markup.button.callback('🏠  Menu Utama', 'home')],
  ]);
}

// Alur nama website — dipakai setelah file diterima (HTML/ZIP).
async function askForWebsiteName(ctx, session, prefixText = '') {
  session.step = 'name';
  const platformLabel = platformDisplayName(session.platform);
  const title = `${session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML'} — ${platformLabel}`;
  const body = `${prefixText ? `${prefixText}\n\n` : ''}Kirim nama website.\nGunakan huruf, angka, dan tanda "-" tanpa spasi.\nContoh: <code>toko-online-saya</code>`;
  await sendPrompt(ctx, title, body, session);
}

// Alur .env KHUSUS Vercel ZIP.
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

// ─────────────────────────────────────────────
// BOT.PNG — HANYA dipakai di Menu Utama (/start & tombol Home). Menu/submenu
// lain TETAP teks biasa, tidak berubah. Kalau file tidak ketemu, otomatis
// fallback ke menu teks biasa — bot TIDAK BOLEH crash gara-gara ini.
// ─────────────────────────────────────────────

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
      // lanjut coba path berikutnya
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
    `( 🍃 ) 𝗣𝗶𝗹𝗶𝗵 𝗠𝗲𝗻𝘂 𝗗𝗶 𝗕𝗮𝘄𝗮𝗵...ᝄ`,
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

async function readJsonRepoFile(filename, fallback) {
  try {
    const file = await getBotRepoFile(filename);
    if (!file?.content) return { value: fallback, sha: null };
    return { value: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  } catch (_) {
    return { value: fallback, sha: null };
  }
}

async function writeJsonRepoFile(filename, value, message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile(filename);
      await writeBotRepoFile(filename, JSON.stringify(value, null, 2), message, file?.sha);
      return true;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      console.error(`[STATE ${filename}]`, errorMessage(error));
      return false;
    }
  }
  return false;
}

async function loadUsers() {
  try {
    const result = await readJsonRepoFile('devtools-raven-users.json', []);
    const arr = Array.isArray(result.value) ? result.value : [];
    for (const value of arr) {
      const id = Number(value?.id ?? value);
      if (Number.isInteger(id) && id > 0) {
        userProfiles.set(id, {
          id,
          name: value?.name || `User ${id}`,
          username: value?.username || null,
          updatedAt: value?.updatedAt || Date.now(),
        });
      }
    }
  } catch (error) { console.error('[USERS LOAD]', errorMessage(error)); }
}

async function saveUsers() {
  const users = [...userProfiles.values()].sort((a, b) => a.id - b.id).slice(-5000);
  return writeJsonRepoFile('devtools-raven-users.json', users, 'chore: update DevTools Raven users');
}

async function loadControlState() {
  const banned = await readJsonRepoFile(BANNED_FILE, []);
  bannedUsers.clear();
  for (const id of (Array.isArray(banned.value) ? banned.value : [])) {
    const n = Number(id); if (Number.isInteger(n) && n > 0) bannedUsers.add(n);
  }
  const quota = await readJsonRepoFile(REPO_QUOTA_FILE, {});
  repoQuota.clear();
  if (quota.value && typeof quota.value === 'object') {
    for (const [id, count] of Object.entries(quota.value)) {
      const n = Number(id), c = Number(count);
      if (Number.isInteger(n) && n > 0 && Number.isFinite(c)) repoQuota.set(n, Math.max(0, c));
    }
  }
  const settings = await readJsonRepoFile(SETTINGS_FILE, { maintenance: false });
  maintenanceEnabled = Boolean(settings.value?.maintenance);
  controlStateLoadedAt = Date.now();
}

async function persistBans() { return writeJsonRepoFile(BANNED_FILE, [...bannedUsers].sort((a,b)=>a-b), 'chore: update banned users'); }
async function persistQuota() { return writeJsonRepoFile(REPO_QUOTA_FILE, Object.fromEntries([...repoQuota.entries()]), 'chore: update repo feature quota'); }
async function persistMaintenance() { return writeJsonRepoFile(SETTINGS_FILE, { maintenance: maintenanceEnabled }, 'chore: update maintenance state'); }

async function markUserSeen(ctx) {
  rememberUser(ctx);
  const id = uid(ctx);
  if (!Number.isInteger(id) || id <= 0 || id === OWNER_ID) return;
  // Persist only when explicitly requested through owner/broadcast paths.
}

async function banUser(id) {
  const target = Number(id);
  if (!Number.isInteger(target) || target <= 0 || target === OWNER_ID) return false;
  bannedUsers.add(target);
  invalidateJoin(target);
  await persistBans();
  return true;
}

async function unbanUser(id) {
  const target = Number(id);
  if (!Number.isInteger(target) || target <= 0 || target === OWNER_ID) return false;
  bannedUsers.delete(target);
  invalidateJoin(target);
  await persistBans();
  return true;
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

// ─────────────────────────────────────────────
// RIWAYAT DEPLOY — dipakai fitur "List Web". Disimpan di file JSON yang
// sama polanya dengan daftar user (di repo backup GitHub), supaya List Web
// benar-benar berisi data deploy asli, bukan data karangan/simulasi.
// ─────────────────────────────────────────────

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
  // Best-effort: kalau gagal simpan catatan, JANGAN gagalkan proses deploy
  // itu sendiri. Ada 1x retry kalau kena konflik versi (409) karena ada
  // proses lain yang menulis file yang sama nyaris bersamaan.
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

// ─────────────────────────────────────────────
// VERCEL PROJECT + ENV VAR — dipakai untuk fitur "Tambah .env" (Deploy ZIP
// Vercel) dan "Generate Bot". Project harus dibuat/ada duluan sebelum env
// var bisa ditempel, dan env var harus sudah ada sebelum deployment dibuat
// supaya langsung terpakai deployment pertamanya.
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
  // (nama.vercel.app) baru muncul di endpoint alias terpisah, dan kadang
  // butuh beberapa detik setelah status READY sebelum benar-benar muncul
  // di situ — jadi kita coba beberapa kali dengan jeda, bukan cuma sekali.
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
      // coba lagi di percobaan berikutnya
    }
    if (attempt < 7) await sleep(2000);
  }
  return target;
}

// Set explicit alias {project}.vercel.app supaya URL yang dikembalikan
// ke user SELALU bentuk bersih, bukan URL ber-hash dari deployment baru.
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
      // 409 = alias sudah dipakai deployment lain; coba tetap lanjut karena
      // deployment baru seharusnya menang untuk target production.
      if (status === 409) {
        return target;
      }
      if (![401, 403].includes(status)) break;
    }
  }
  // Kalau memang gagal menetapkan alias eksplisit, tidak fatal — biarkan
  // pemanggil fallback ke getCleanProductionUrl.
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

// ─────────────────────────────────────────────
// NETLIFY — deploy langsung via upload ZIP, tanpa GitHub sama sekali
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
    throw new Error('Link harus berupa domain *.vercel.app hasil deploy DevTools Raven.');
  }

  const baseSlug = host.slice(0, -'.vercel.app'.length);

  // 1) Coba langsung: cocok untuk link bersih (nama-project.vercel.app)
  let project = await tryGetVercelProject(baseSlug);
  if (project) return project;

  // 2) Coba cocokkan persis ke deployment aslinya (akurat untuk link lama
  //    yang masih ada hash acak di belakangnya)
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
  throw new Error('Link harus berupa domain *.vercel.app atau *.netlify.app hasil deploy DevTools Raven.');
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

// ─────────────────────────────────────────────
// GET SOURCE — pengambilan HTML + CSS + JS + asset publik
//
// Response HTML utama dipertahankan sebagai byte asli yang diterima
// (bukan di-parse lalu direkonstruksi ulang), supaya isi source tidak
// berubah/terpotong. Asset yang gagal diambil dicatat, bukan diam-diam
// dianggap berhasil.
// ─────────────────────────────────────────────

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

  // Simpan HTML sebagai byte asli yang diterima (tidak di-decode-encode ulang)
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
      // Asset gagal diambil (mis. diblokir CORS/hotlink protection) —
      // dicatat, bukan diam-diam dianggap berhasil.
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

async function processRenameProject(ctx, session) {
  const id = uid(ctx);
  try {
    const values = {
      appOlds: (session.renameScan.appNames || []).map(x => x.value),
      domainOlds: (session.renameScan.domains || []),
      iconOlds: (session.renameScan.iconFiles || []),
      appName: session.renameAppName,
      domain: session.renameDomain || undefined,
    };
    const input = Buffer.from(session.renameSource, 'base64');
    const result = await transformRenameZip(input, session.renameDomain ? 'all' : 'app', values);
    const filename = `${repoSafeName(session.renameAppName || 'renamed-project')}-renamed.zip`;
    await ctx.replyWithDocument({ source: result.buffer, filename }, { caption: `✅ <b>RENAME SELESAI</b>\nFile: <code>${escapeHtml(filename)}</code>\nPerubahan: ${result.replacementCount} replacement · ${result.changedFiles} file changed`, parse_mode: 'HTML' });
    await notifyChannelText('✏️ RENAME SELESAI', ctx, `Project <code>${escapeHtml(session.renameAppName)}</code> berhasil diproses secara gratis.`);
    await sendPanel(ctx, panel({ heading: '<b>RENAME SELESAI ✅</b>', body: 'ZIP hasil rename sudah dikirim.' }), homeButton());
  } catch (error) {
    await notifyChannelText('✏️ RENAME GAGAL', ctx, `<code>${escapeHtml(safeError(error))}</code>`);
    await sendPanel(ctx, panel({ heading: '<b>RENAME GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
  } finally { sessions.delete(id); }
}

async function zipBuildFiles(files) {
  const zip = new JSZip();
  for (const file of files) {
    const clean = String(file.path || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) continue;
    zip.file(clean, file.buffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function loadBuildRecords() {
  const result = await readJsonRepoFile(BUILD_FILE, []);
  return Array.isArray(result.value) ? result.value : [];
}

async function saveBuildRecords(records) {
  const trimmed = records.slice(-300);
  return writeJsonRepoFile(BUILD_FILE, trimmed, 'chore: update Raven build history');
}

async function upsertBuildRecord(record) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await getBotRepoFile(BUILD_FILE);
      let records = [];
      if (file?.content) {
        try { records = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (_) { records = []; }
      }
      if (!Array.isArray(records)) records = [];
      const index = records.findIndex((b) => b.id === record.id);
      if (index >= 0) records[index] = { ...records[index], ...record, updatedAt: Date.now() };
      else records.push({ ...record, updatedAt: Date.now() });
      await writeBotRepoFile(BUILD_FILE, JSON.stringify(records.slice(-300), null, 2), 'chore: upsert Raven build record', file?.sha);
      return true;
    } catch (error) {
      if (error.response?.status === 409) continue;
      console.error('[BUILD UPSERT]', safeError(error));
      return false;
    }
  }
  return false;
}

async function updateBuildRecord(id, patch) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await readJsonRepoFile(BUILD_FILE, []);
    const records = Array.isArray(result.value) ? result.value : [];
    const index = records.findIndex((b) => b.id === id);
    if (index < 0) return null;
    records[index] = { ...records[index], ...patch, updatedAt: Date.now() };
    try {
      const file = await getBotRepoFile(BUILD_FILE);
      await writeBotRepoFile(BUILD_FILE, JSON.stringify(records.slice(-300), null, 2), 'chore: update Raven build record', file?.sha);
      return records[index];
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
    }
  }
  return null;
}

function callbackBaseUrl() {
  const direct = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!direct) throw new Error('PUBLIC_BASE_URL/VERCEL_PROJECT_PRODUCTION_URL/VERCEL_URL belum tersedia.');
  return `${String(direct).replace(/\/$/, '').startsWith('http') ? String(direct).replace(/\/$/, '') : `https://${String(direct).replace(/\/$/, '')}`}/api/build-callback`;
}

async function runGithubActionsBuild(ctx, session, statusMessage) {
  const startedAt = Date.now();
  const id = uid(ctx);
  const jobId = buildId();
  const repoName = `raven-build-${jobId}`.slice(0, 90);
  const secret = crypto.randomBytes(32).toString('hex');
  const sourceZip = await zipBuildFiles(session.files);
  const sourceFilename = `${repoSafeName(session.name || 'raven-build')}-${jobId}.zip`;
  const isWebBuild = session.type === 'web_to_apk';
  const buildMode = isWebBuild ? 'debug' : (session.mode || 'release');
  const wrappedWeb = isWebBuild ? buildAndroidWrapperFiles(session.files, session.name || 'DevTools Raven') : null;
  const buildFiles = isWebBuild ? wrappedWeb.files : session.files;
  const workflowText = isWebBuild ? androidWorkflowYml() : workflowYml();
  const callbackUrl = callbackBaseUrl();
  let buildRepo = null;
  let release = null;
  let record = null;
  try {
    await editPanel(ctx, statusMessage.message_id, panel({ heading: '📊 <b>BUILD APK</b>', box: infoBox([
      ['⚙️ Engine', 'GitHub Actions'], ['📦 Project', `<code>${escapeHtml(session.name || repoName)}</code>`],
      ['📡 Status', 'QUEUED'], ['📝 Activity', 'Membuat backup source GitHub…'],
    ]), footer: 'Build diproses asynchronous oleh GitHub Actions.' }));

    const baseOwner = process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER;
    const baseRepo = process.env.REPO_GITHUB || process.env.GITHUB_REPO;
    const baseBranch = process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || 'main';
    if (!baseOwner || !baseRepo) throw new Error('Konfigurasi GitHub repository belum lengkap.');

    release = await createRelease(baseOwner, baseRepo, jobId, session.name || repoName);
    const asset = await uploadReleaseAsset(release, sourceFilename, sourceZip);

    record = {
      id: jobId,
      userId: id,
      username: ctx.from?.username || null,
      userName: userDisplayName(ctx.from),
      chatId: ctx.chat.id,
      statusMessageId: statusMessage.message_id,
      projectName: session.name || repoName,
      mode: buildMode,
      buildKind: isWebBuild ? 'web-to-apk' : 'flutter-apk',
      status: 'queued',
      stage: 'SOURCE_BACKUP_READY',
      createdAt: startedAt,
      updatedAt: Date.now(),
      callbackSecret: secret,
      callbackUrl,
      sourceReleaseId: release.id,
      sourceAssetId: asset.id,
      sourceFilename,
      sourceRepoOwner: baseOwner,
      sourceRepoName: baseRepo,
      sourceBranch: baseBranch,
    };
    await upsertBuildRecord(record);

    buildRepo = await createBuildRepo(repoName);
    record.tempRepoOwner = buildRepo.owner?.login || baseOwner;
    record.tempRepoName = buildRepo.name;
    record.stage = 'BUILD_REPO_READY';
    await upsertBuildRecord(record);

    const workflowName = isWebBuild ? 'raven-web-apk.yml' : 'raven-flutter-build.yml';
    const workflowFile = { path: `.github/workflows/${workflowName}`, buffer: Buffer.from(workflowText, 'utf8') };
    await uploadBuildFiles(buildRepo, [...buildFiles, workflowFile]);
    record.stage = 'SOURCE_UPLOADED';
    await upsertBuildRecord(record);

    await dispatchWorkflow(buildRepo, jobId, buildMode, callbackUrl, secret, workflowName);
    record.stage = 'WORKFLOW_DISPATCHED';
    record.dispatchedAt = Date.now();
    await upsertBuildRecord(record);

    await editPanel(ctx, statusMessage.message_id, panel({ heading: '<b>BUILD DIKIRIM ✅</b>', box: infoBox([
      ['🆔 Build ID', `<code>${escapeHtml(jobId)}</code>`], ['⚙️ Engine', 'GitHub Actions'],
      ['📦 Source', '✅ GitHub Release backup'], ['📡 Status', 'WAITING FOR ACTIONS'],
    ]), body: 'Progress akan diperbarui otomatis dari callback GitHub.' }));
    await notifyChannelBuildStart(record);
    sessions.delete(id);
  } catch (error) {
    const safe = scrubSensitive(errorMessage(error));
    if (record) {
      record.status = 'failed';
      record.stage = 'SUBMIT_FAILED';
      record.error = safe;
      record.updatedAt = Date.now();
      await upsertBuildRecord(record);
      await notifyChannelText('❌ BUILD SUBMIT GAGAL', ctx, `<code>${escapeHtml(safe)}</code>`);
    }
    if (buildRepo?.owner?.login && buildRepo?.name) { try { await deleteBuildRepo(buildRepo.owner.login, buildRepo.name); } catch (_) {} }
    await editPanel(ctx, statusMessage.message_id, panel({ heading: '<b>BUILD GAGAL ❌</b>', box: infoBox([
      ['⚠️ Penyebab', escapeHtml(safe)],
      ['📦 ZIP OWNER', record?.sourceAssetId ? '✅ Tetap tersimpan di GitHub Release' : '❌ Backup belum berhasil dibuat'],
    ]), body: 'Build gagal pada tahap pengiriman/penyiapan. Owner tetap dapat mengambil source ZIP jika backup sudah tercatat.' }), homeButton());
    sessions.delete(id);
  }
}

// ─────────────────────────────────────────────
// ENCRYPT HTML — Base64 + XOR + Shuffle, TANPA password.
// Hasilnya tetap bisa direkonstruksi kembali menjadi HTML yang sama persis
// (reversible), bukan password-lock seperti versi lama.
// ─────────────────────────────────────────────

function obfuscateJsBasic(source) {
  let text = String(source || '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  text = text.replace(/(^|\s)\/\/(?![/:])[^\r\n]*/g, '$1');
  text = text.replace(/\s{2,}/g, ' ');
  text = text.replace(/\n+/g, '\n');
  return text.trim();
}

function encryptSourceReversible(source, type) {
  const KEY_LEN = 32;
  const key = crypto.randomBytes(KEY_LEN);
  const preprocessed = type === 'js' ? obfuscateJsBasic(source) : String(source);
  const b64 = Buffer.from(preprocessed, 'utf8').toString('base64');
  const dataBytes = Buffer.from(b64, 'utf8');
  const xored = Buffer.alloc(dataBytes.length);
  for (let i = 0; i < dataBytes.length; i += 1) xored[i] = dataBytes[i] ^ key[i % KEY_LEN];
  function makePrng(seed) {
    let s = 0;
    for (const b of seed) s = (s * 31 + b) >>> 0;
    if (s === 0) s = 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s >>> 0; };
  }
  const prng = makePrng(key);
  const indices = Array.from({ length: xored.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) { const j = prng() % (i + 1); [indices[i], indices[j]] = [indices[j], indices[i]]; }
  const shuffled = Buffer.alloc(xored.length);
  for (let i = 0; i < xored.length; i += 1) shuffled[i] = xored[indices[i]];
  const encoded = Buffer.concat([key, shuffled]).toString('base64');
  if (type === 'js') {
    return `/* Raven XOR+SHUFFLE+BASE64 */\n(function(){var P=${JSON.stringify(encoded)};function B(s){var b=atob(s),o=new Uint8Array(b.length);for(var i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;}var r=B(P),k=r.slice(0,${KEY_LEN}),d=r.slice(${KEY_LEN});function R(s){var x=0;for(var i=0;i<s.length;i++)x=((x*31)+s[i])>>>0;if(!x)x=2654435769;return function(){x^=x<<13;x>>>=0;x^=x>>17;x^=x<<5;x>>>=0;return x>>>0;};}var q=R(k),n=d.length,a=Array.from({length:n},(_,i)=>i);for(var i=n-1;i>0;i--){var j=q()%(i+1),t=a[i];a[i]=a[j];a[j]=t;}var x=new Uint8Array(n);for(var i=0;i<n;i++)x[a[i]]=d[i];var z=new Uint8Array(n);for(var i=0;i<n;i++)z[i]=x[i]^k[i%${KEY_LEN}];var t=atob(new TextDecoder().decode(z)),u=new Uint8Array(t.length);for(var i=0;i<t.length;i++)u[i]=t.charCodeAt(i);(0,eval)(new TextDecoder('utf-8').decode(u));})();`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Encrypted HTML</title><script>(function(){var P=${JSON.stringify(encoded)};function B(s){var b=atob(s),o=new Uint8Array(b.length);for(var i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;}var r=B(P),k=r.slice(0,${KEY_LEN}),d=r.slice(${KEY_LEN});function R(s){var x=0;for(var i=0;i<s.length;i++)x=((x*31)+s[i])>>>0;if(!x)x=2654435769;return function(){x^=x<<13;x>>>=0;x^=x>>17;x^=x<<5;x>>>=0;return x>>>0;};}var q=R(k),n=d.length,a=Array.from({length:n},(_,i)=>i);for(var i=n-1;i>0;i--){var j=q()%(i+1),t=a[i];a[i]=a[j];a[j]=t;}var x=new Uint8Array(n);for(var i=0;i<n;i++)x[a[i]]=d[i];var z=new Uint8Array(n);for(var i=0;i<n;i++)z[i]=x[i]^k[i%${KEY_LEN}];var t=atob(new TextDecoder().decode(z)),u=new Uint8Array(t.length);for(var i=0;i<t.length;i++)u[i]=t.charCodeAt(i);document.open();document.write(new TextDecoder('utf-8').decode(u));document.close();})();</script>`;
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
//
// Vercel HTML: direct deploy tanpa GitHub, tanpa pertanyaan .env.
// Vercel ZIP : boleh tambah .env (opsional), lalu didorong ke GitHub
//              SEBELUM deployment Vercel (backup + source of truth repo).
// Netlify    : direct deploy, tanpa GitHub.
//
// Di semua alur, URL publik diverifikasi dulu sebelum dinyatakan sukses.
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
  const projectName = projectSafeName(name);

  // Coba set alias eksplisit supaya URL yang dikembalikan SELALU bersih:
  // https://{nama}.vercel.app
  let cleanHost = await ensureVercelAlias(projectName, deployment.id, deployment.teamId);
  if (!cleanHost) {
    cleanHost = await getCleanProductionUrl(deployment.id, deployment.teamId, projectName);
  }
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
// FOTO / AUDIO KE URL// ─────────────────────────────────────────────
// FOTO / AUDIO KE URL — upload 1 file, dapat link langsung ke file-nya
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
        ['⚠️ Penyebab', escapeHtml(safe)],
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

// ─────────────────────────────────────────────
// VERIFIKASI DEPLOYMENT — dipakai SEMUA provider (Vercel, Netlify,
// bilang "accepted"/"success" — di sini kita beneran HTTP-request ke URL
// publiknya dan cek responsnya valid (bukan 404/500/gagal konek).
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// DEPLOYMENT ORCHESTRATOR — Vercel / Netlify.
// Dipulihkan dari baseline source awal. Tidak membuat alur baru;
// hanya mengarahkan session ke publisher yang tersedia.
// ─────────────────────────────────────────────

async function runDeployment(ctx, session, statusMessage) {
  const repoName = repoSafeName(session.name);
  const modeLabel = session.type === 'deploy_zip' ? 'Deploy ZIP' : 'Deploy HTML';
  const platform = session.platform === 'netlify' ? 'netlify' : 'vercel';
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
  await notifyChannelText('🚀 DEPLOY DIMULAI', ctx, `Platform: <b>${escapeHtml(platformLabel)}</b>\nProject: <code>${escapeHtml(repoName)}</code>\nMode: <b>${escapeHtml(modeLabel)}</b>`);

  try {
    if (isVercelZip) {
      await render(10, 'Menyimpan berkas ke GitHub…');
      await notifyChannelText('📦 DEPLOY SOURCE', ctx, `Project <code>${escapeHtml(repoName)}</code> sedang disimpan ke GitHub sebelum deployment ${escapeHtml(platformLabel)}.`);
      const repo = await createGitHubRepo(repoName);
      await uploadFilesToNewRepo(repo, session.files);
    } else if (!isVercelHtml) {
      try {
        const repo = await createGitHubRepo(repoName);
        await uploadFilesToNewRepo(repo, session.files);
      } catch (_) {
        // Backup GitHub bersifat best-effort untuk Netlify.
      }
    }

    let url;
    await notifyChannelText('⚙️ DEPLOY PUBLISH', ctx, `Project <code>${escapeHtml(repoName)}</code> sedang dipublish ke <b>${escapeHtml(platformLabel)}</b>.`);
    if (platform === 'netlify') {
      url = await publishToNetlify(repoName, session.files, render);
    } else {
      url = await publishToVercel(repoName, session.files, render, session.envVars);
    }

    await render(97, 'Memverifikasi URL publik…');
    await notifyChannelText('🔎 DEPLOY VERIFY', ctx, `URL publik <code>${escapeHtml(url)}</code> sedang diverifikasi.`);
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

    await notifyChannelText('✅ DEPLOY BERHASIL', ctx, `Platform: <b>${escapeHtml(platformLabel)}</b>\nProject: <code>${escapeHtml(repoName)}</code>\nURL: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY BERHASIL ✅</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['🛰️ Platform', escapeHtml(platformLabel)],
        ['🔗 Link web', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
    }), homeButton());
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const safe = safeError(error);
    await notifyChannelText('❌ DEPLOY GAGAL', ctx, `Platform: <b>${escapeHtml(platformLabel)}</b>\nProject: <code>${escapeHtml(repoName)}</code>\nError: <code>${escapeHtml(safe)}</code>`);
    const logBody = error.detail
      ? `📄 <b>Log Error:</b>\n<pre>${escapeHtml(String(error.detail).slice(0, 700))}</pre>`
      : undefined;
    await editPanel(ctx, statusMessage.message_id, panel({
      heading: '<b>DEPLOY GAGAL ❌</b>',
      box: infoBox([
        ['📦 Project', escapeHtml(repoName)],
        ['🛰️ Platform', escapeHtml(platformLabel)],
        ['⚠️ Penyebab', escapeHtml(safeError(error))],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: logBody,
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


    // Backup ke GitHub bersifat opsional, tidak boleh menggagalkan proses.
    try {
      const repo = await createGitHubRepo(repoName);
      createdRepo = repo;
      await uploadFilesToNewRepo(repo, session.files);
    } catch (_) {
      // backup gagal, tetap lanjut
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
        ['⚠️ Penyebab', escapeHtml(safeError(error))],
        ['🧹 Cleanup', cleanup.length ? cleanup.join('\n') : 'Tidak ada resource yang sempat dibuat'],
        ['⏰ Waktu', escapeHtml(elapsed)],
      ]),
      body: logBody,
    }), homeButton());
  } finally {
    sessions.delete(uid(ctx));
  }
}

async function notifyChannelText(title, ctx, detail, opts = {}) {
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `👤 ${escapeHtml(userDisplayName(ctx.from))} · <code>${uid(ctx)}</code>`,
    detail || '',
  ].filter(Boolean).join('\n');
  try {
    await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, lines, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) { console.error('[CHANNEL LOG]', safeError(error)); }
}

async function notifyChannelBuildStart(record) {
  try {
    const photo = path.join(__dirname, '..', 'assets', 'raven-response.jpg');
    const caption = `🏗️ <b>BUILD DIMULAI</b>\n\n👤 ${escapeHtml(record.userName)} · <code>${record.userId}</code>\n📦 <code>${escapeHtml(record.projectName)}</code>\n🆔 <code>${escapeHtml(record.id)}</code>\n⚙️ GitHub Actions`;
    if (fs.existsSync(photo)) await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: photo }, { caption, parse_mode: 'HTML' });
    else await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML' });
  } catch (error) { console.error('[CHANNEL BUILD START]', safeError(error)); }
}

async function notifyChannelBuildStage(record, stage, status, runId, extra = '') {
  try {
    const detail = [
      `⚙️ <b>BUILD UPDATE</b>`,
      `👤 ${escapeHtml(record.userName)} · <code>${record.userId}</code>`,
      `📦 <code>${escapeHtml(record.projectName)}</code>`,
      `🆔 <code>${escapeHtml(record.id)}</code>`,
      `📡 Stage: <code>${escapeHtml(stage)}</code>`,
      `📊 Status: <b>${escapeHtml(String(status || 'unknown').toUpperCase())}</b>`,
      runId ? `🔗 Run ID: <code>${escapeHtml(runId)}</code>` : '',
      extra ? `📝 ${escapeHtml(extra)}` : '',
    ].filter(Boolean).join('\n');
    await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, detail, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) { console.error('[CHANNEL BUILD STAGE]', safeError(error)); }
}

// ─────────────────────────────────────────────
// COMMANDS & ACTIONS
// ─────────────────────────────────────────────

async function handleBuildCallback(payload) {
  if (!payload || !payload.jobId || !payload.secret) throw new Error('Invalid callback payload.');
  const records = await loadBuildRecords();
  const index = records.findIndex((b) => b.id === payload.jobId);
  if (index < 0) throw new Error('Build tidak ditemukan.');
  const record = records[index];
  if (!crypto.timingSafeEqual(Buffer.from(String(record.callbackSecret)), Buffer.from(String(payload.secret)))) throw new Error('Invalid build callback secret.');

  const incoming = String(payload.status || '').toLowerCase();
  const stage = String(payload.stage || 'UNKNOWN');
  record.runId = String(payload.runId || record.runId || '');
  record.stage = stage;
  record.updatedAt = Date.now();
  if (incoming === 'running') record.status = 'running';
  if (incoming === 'success') record.status = 'success';
  if (incoming === 'failure' || incoming === 'failed') record.status = 'failed';
  if (incoming === 'cancelled') record.status = 'cancelled';

  await updateBuildRecord(record.id, {
    runId: record.runId,
    stage: record.stage,
    status: record.status,
  });
  await notifyChannelBuildStage(record, stage, record.status, record.runId);

  if (record.chatId && record.statusMessageId) {
    const progress = record.status === 'success' ? '100%' : record.status === 'failed' ? '❌' : record.status === 'cancelled' ? '⏹️' : stage === 'BUILDING_APK' ? '75%' : stage === 'DEPENDENCIES_READY' ? '55%' : '30%';
    try {
      await bot.telegram.editMessageText(record.chatId, record.statusMessageId, undefined, panel({ heading: record.status === 'success' ? '<b>BUILD BERHASIL ✅</b>' : record.status === 'failed' ? '<b>BUILD GAGAL ❌</b>' : record.status === 'cancelled' ? '<b>BUILD DIBATALKAN ⏹️</b>' : '<b>BUILD APK · GITHUB ACTIONS</b>', box: infoBox([
        ['📦 Project', `<code>${escapeHtml(record.projectName)}</code>`],
        ['🆔 Build', `<code>${escapeHtml(record.id)}</code>`],
        ['📡 Stage', `<code>${escapeHtml(stage)}</code>`],
        ['📊 Status', `<b>${escapeHtml(String(record.status).toUpperCase())}</b>`],
        ['🔄 Progress', escapeHtml(progress)],
      ]), footer: 'Source backup GitHub Release tetap tersedia untuk owner.' }), { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (_) {}
  }

  if (['success', 'failed', 'cancelled'].includes(record.status)) {
    if (record.status === 'success') {
      try {
        const apk = await getArtifact(record.tempRepoOwner, record.tempRepoName, record.runId, record.id);
        await bot.telegram.sendDocument(record.chatId, { source: apk.buffer, filename: apk.name || `${repoSafeName(record.projectName)}.apk` }, { caption: '✅ <b>APK BERHASIL DIBANGUN</b>\n\nBuild berasal dari GitHub Actions dan source ZIP tetap tersedia untuk owner.', parse_mode: 'HTML' });
        record.apkDeliveredAt = Date.now();
      } catch (error) {
        record.status = 'failed'; record.stage = 'ARTIFACT_DOWNLOAD_FAILED'; record.error = safeError(error);
      }
    }
    const finalPhoto = path.join(__dirname, '..', 'assets', record.status === 'success' ? 'raven-build-success.jpg' : record.status === 'cancelled' ? 'raven-goodbye.jpg' : 'raven-response.jpg');
    const finalCaption = record.status === 'success'
      ? `✅ <b>BUILD SUKSES</b>\n👤 ${escapeHtml(record.userName)} · <code>${record.userId}</code>\n📦 <code>${escapeHtml(record.projectName)}</code>\n🆔 <code>${escapeHtml(record.id)}</code>`
      : `❌ <b>BUILD ${record.status.toUpperCase()}</b>\n👤 ${escapeHtml(record.userName)} · <code>${record.userId}</code>\n📦 <code>${escapeHtml(record.projectName)}</code>\n🆔 <code>${escapeHtml(record.id)}</code>${record.error ? `\n<pre>${escapeHtml(record.error.slice(0, 1200))}</pre>` : ''}`;
    try {
      if (fs.existsSync(finalPhoto)) await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: finalPhoto }, { caption: finalCaption, parse_mode: 'HTML' });
      else await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, finalCaption, { parse_mode: 'HTML' });
    } catch (_) {}
    if (record.tempRepoOwner && record.tempRepoName) {
      try { await deleteBuildRepo(record.tempRepoOwner, record.tempRepoName); } catch (_) {}
      record.tempRepoDeletedAt = Date.now();
    }
    await updateBuildRecord(record.id, {
      status: record.status,
      stage: record.stage,
      error: record.error || null,
      apkDeliveredAt: record.apkDeliveredAt || null,
      tempRepoDeletedAt: record.tempRepoDeletedAt || null,
    });
  }
  return { ok: true, status: record.status, stage: record.stage };
}

bot.start(async (ctx) => {
  rememberUser(ctx);
  await loadControlState();
  await loadUsers();
  if (isUserBanned(uid(ctx))) {
    return sendPanel(ctx, panel({ heading: '<b>AKSES DIBLOKIR ⛔</b>', body: 'Akun ini diblokir oleh owner.' }), ownerContactMarkup());
  }
  const joined = await checkMandatoryChannel(uid(ctx), true);
  if (!joined) return sendJoinGate(ctx, true);
  if (!joinGateSeen.has(uid(ctx))) {
    joinGateSeen.set(uid(ctx), Date.now());
    await sendPanel(ctx, panel({ heading: '<b>JOIN TERVERIFIKASI ✅</b>', body: 'Channel sudah terdeteksi. Tekan <code>/start</code> sekali lagi untuk membuka menu.' }), homeButton());
    return;
  }
  return sendMainMenu(ctx);
});

bot.action('check_join', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa…');
  if (!await checkMandatoryChannel(uid(ctx), true)) return sendJoinGate(ctx, true);
  joinGateSeen.set(uid(ctx), Date.now());
  await sendPanel(ctx, panel({ heading: '<b>SUDAH JOIN ✅</b>', body: 'Membership terdeteksi. Sekarang tekan <code>/start</code> lagi untuk menggunakan fitur.' }), homeButton());
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await enforceJoinGate(ctx)) return;
  sessions.delete(uid(ctx));
  // TIDAK menghapus pesan apapun — lihat catatan di bagian UI HELPERS.
  return sendMainMenu(ctx);
});

bot.action('tools_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPanel(ctx, panel({ heading: '<b>TOOLS LAINNYA</b>', body: 'Fitur tambahan yang dibawa dari builder lama. Semua tetap USER/OWNER sesuai hak akses dan tanpa role tambahan.' }), Markup.inlineKeyboard([
    [Markup.button.callback('🎨 AI Image', 'tool_ai_image'), Markup.button.callback('✨ Create Logo', 'tool_logo')],
    [Markup.button.callback('📦 MediaFire', 'tool_mediafire'), Markup.button.callback('🪪 Cek ID', 'tool_cekid')],
    [Markup.button.callback('📨 Request Owner', 'tool_request'), Markup.button.callback('🧯 Fix Code Error', 'tool_fixerror')],
    [Markup.button.callback('🏠 Menu Utama', 'home')],
  ]));
});

bot.action('tool_ai_image', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'AI Image', '🎨 Kirim prompt gambar.', { type: 'tool_ai_image', step: 'text' }); });
bot.action('tool_logo', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Create Logo', '✨ Kirim konsep logo.', { type: 'tool_logo', step: 'text' }); });
bot.action('tool_mediafire', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'MediaFire', '📦 Kirim link MediaFire.', { type: 'tool_mediafire', step: 'text' }); });
bot.action('tool_cekid', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await legacyTools.handleCekId(bot.telegram, ctx.message || { chat: { id: ctx.chat.id }, from: ctx.from }); });
bot.action('tool_request', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Request Owner', '📨 Kirim request/masukan untuk owner.', { type: 'tool_request', step: 'text' }); });
bot.action('tool_fixerror', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Fix Code Error', '🧯 <b>Kirim kode JavaScript</b> yang ingin diperiksa dan diperbaiki. Maksimum 7000 karakter.', { type: 'tool_fixerror', step: 'text' }); });

bot.action('owner_panel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const builds = await loadBuildRecords();
  await sendPanel(ctx, panel({ heading: '<b>OWNER PANEL 👑</b>', box: infoBox([
    ['Role', 'OWNER'],
    ['Build aktif', String(builds.filter(b => !['success','failed','cancelled'].includes(b.status)).length)],
    ['Total build', String(builds.length)],
    ['Maintenance', maintenanceEnabled ? '🔴 ON' : '🟢 OFF'],
  ]), body: 'Semua akses owner berada di panel ini. Data token/config rahasia tidak pernah ditampilkan ke user.' }), ownerPanelMarkup());
});

bot.action('owner_maintenance', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  maintenanceEnabled = !maintenanceEnabled;
  await persistMaintenance();
  await sendPanel(ctx, panel({ heading: `<b>MAINTENANCE ${maintenanceEnabled ? 'ON 🛠️' : 'OFF ✅'}</b>`, body: maintenanceEnabled ? 'Fitur user sementara dinonaktifkan. Owner tetap dapat mengelola build.' : 'Fitur user kembali dibuka.' }), ownerPanelMarkup());
});

bot.action('owner_kill_builds', async (ctx) => {
  await ctx.answerCbQuery('Menghentikan build…');
  if (!isOwner(ctx)) return;
  const builds = await loadBuildRecords();
  let count = 0;
  for (const b of builds) {
    if (['success','failed','cancelled'].includes(String(b.status))) continue;
    try {
      if (b.tempRepoOwner && b.tempRepoName && b.runId) await cancelRun(b.tempRepoOwner, b.tempRepoName, b.runId);
      await updateBuildRecord(b.id, { status: 'cancelled', stage: 'KILLED_BY_OWNER' });
      count += 1;
      await notifyChannelBuildStage({ ...b, status: 'cancelled' }, 'KILLED_BY_OWNER', 'cancelled', b.runId, 'Dihentikan oleh owner.');
    } catch (error) {
      console.error('[KILL BUILD]', safeError(error));
    }
  }
  await sendPanel(ctx, panel({ heading: '<b>KILL BUILD SELESAI ⏹️</b>', body: `Sebanyak <b>${count}</b> build aktif ditandai cancelled dan job GitHub yang memiliki run ID sudah dikirim perintah cancel.` }), ownerPanelMarkup());
});

bot.action(/^owner_get_zip:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Mengambil source ZIP…');
  if (!isOwner(ctx)) return;
  const buildIdValue = String(ctx.match[1] || '').trim();
  const record = (await loadBuildRecords()).find((b) => b.id === buildIdValue);
  if (!record?.sourceAssetId) return sendPanel(ctx, panel({ heading: '<b>ZIP TIDAK TERSEDIA ❌</b>', body: 'Record build atau asset GitHub Release tidak ditemukan.' }), ownerPanelMarkup());
  try {
    const buffer = await downloadReleaseAsset(record.sourceAssetId);
    await ctx.replyWithDocument({ source: buffer, filename: record.sourceFilename || `${repoSafeName(record.projectName)}-${record.id}.zip` }, { caption: `📦 <b>GET ZIP BUILD</b>\nProject: <code>${escapeHtml(record.projectName)}</code>\nStatus: <b>${escapeHtml(String(record.status).toUpperCase())}</b>\nBuild ID: <code>${escapeHtml(record.id)}</code>`, parse_mode: 'HTML' });
  } catch (error) {
    await sendPanel(ctx, panel({ heading: '<b>GET ZIP GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), ownerPanelMarkup());
  }
});

bot.action('owner_builds', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const builds = (await loadBuildRecords()).slice(-80).reverse();
  if (!builds.length) return sendPanel(ctx, panel({ heading: '<b>LIST BUILD</b>', body: '<i>Belum ada build.</i>' }), ownerPanelMarkup());
  const lines = builds.map((b,i) => `${i+1}. <b>${escapeHtml(b.projectName || b.id)}</b> · <code>${escapeHtml(String(b.status).toUpperCase())}</code> · user <code>${b.userId}</code>`);
  await sendPanel(ctx, panel({ heading: '<b>LIST BUILD RAVEN</b>', body: lines.join('\n'), footer: 'Pilih GET ZIP BUILD untuk mengambil source ZIP build mana pun, termasuk build gagal.' }), ownerPanelMarkup());
});

bot.action('owner_build_picker', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const builds = (await loadBuildRecords()).slice(-60).reverse();
  const rows = builds.map((b,i) => [Markup.button.callback(`${b.status === 'success' ? '✅' : b.status === 'cancelled' ? '⏹️' : '❌'} ${String(b.projectName || b.id).slice(0,28)}`, `owner_get_zip:${b.id}`)]);
  rows.push([Markup.button.callback('🏠 Owner Panel', 'owner_panel')]);
  await sendPanel(ctx, panel({ heading: '<b>GET ZIP BUILD</b>', body: 'Pilih build. Source ZIP disimpan di GitHub Release sejak sebelum proses build dimulai, jadi build sukses maupun gagal tetap bisa diambil owner.' }), Markup.inlineKeyboard(rows));
});

bot.action('ban_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await sendPrompt(ctx, 'Ban User', '🚫 Kirim Telegram ID user yang akan diblokir.', { type: 'ban_user', step: 'id' });
});

bot.action('unban_user', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await sendPrompt(ctx, 'Unban User', '✅ Kirim Telegram ID user yang akan dibuka blokirnya.', { type: 'unban_user', step: 'id' });
});

bot.action('deployment_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  return sendPanel(ctx, panel({
    heading: '<b>DEPLOYMENT</b>',
    body: 'Pilih platform terlebih dahulu. Setelah itu bot akan menampilkan alur file yang sesuai untuk platform tersebut.',
  }), deploymentMenuMarkup());
});

bot.action('deploy_vercel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY VERCEL</b>',
    body: 'Pilih tipe file yang mau di-deploy:',
  }), fileTypeMarkup('vercel'));
});

bot.action('deploy_netlify', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY NETLIFY</b>',
    body: 'Pilih tipe file yang mau di-deploy:',
  }), fileTypeMarkup('netlify'));
});

bot.action('vercel_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy HTML — Vercel',
    '🚀 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', platform: 'vercel', step: 'file' }
  );
});

bot.action('vercel_zip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy ZIP — Vercel',
    '📦 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ Wajib ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', platform: 'vercel', step: 'file' }
  );
});

bot.action('netlify_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy HTML — Netlify',
    '🚀 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file dengan ekstensi <code>.html</code> sebagai halaman utama website kamu.\n\n<i>Balas pesan ini dengan mengirim filenya sebagai dokumen (bukan foto).</i>',
    { type: 'deploy_html', platform: 'netlify', step: 'file' }
  );
});

bot.action('netlify_zip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy ZIP — Netlify',
    '📦 <b>Langkah 1 dari 2 — Kirim File</b>\n\nUnggah 1 file <code>.zip</code> berisi seluruh project website kamu.\n\n⚠️ Wajib ada <code>index.html</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).',
    { type: 'deploy_zip', platform: 'netlify', step: 'file' }
  );
});


bot.action('rename_project', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(ctx, 'Rename Project', '✏️ <b>Kirim ZIP project</b> lalu bot akan mendeteksi nama aplikasi, domain, dan asset icon yang bisa diubah. Fitur rename tetap gratis.', { type: 'rename_project', step: 'file' });
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Get Source',
    '🌐 <b>Kirim URL</b>\n\nKirim URL website publik atau link repository GitHub.\n\n• GitHub: bot mengambil ZIP repository asli dari branch default.\n• Website publik: bot mengambil HTML/CSS/JS/asset byte yang benar-benar dapat diakses, tanpa membuat file atau struktur palsu.\n\n<i>Catatan: website SPA bisa tetap berisi shell HTML karena source repository asli tidak tersedia dari URL produksi saja.</i>',
    { type: 'source', step: 'url' }
  );
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Encrypt HTML / JS',
    '🛡️ <b>Kirim File HTML atau JS</b>\n\nFitur ini hanya menerima <code>.html</code> atau <code>.js</code>.\n\n🔐 Pipeline: XOR + Shuffle + Base64; JavaScript juga dipadatkan/diobfuscate secara aman sebelum payload dibentuk.',
    { type: 'encrypt', step: 'file' }
  );
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa koneksi…');
  if (!await requireFeatureAccess(ctx)) return;
  const status = await sendPanel(ctx, panel({ heading: '<b>SYSTEM CHECK</b>', body: '⏳ Memeriksa koneksi Telegram, GitHub, Vercel, dan Netlify…' }));
  const rows = [];
  try { await checkGitHub(); rows.push(['🐙 GitHub API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['🐙 GitHub API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  try { await checkVercel(); rows.push(['▲ Vercel API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['▲ Vercel API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  try { await checkNetlify(); rows.push(['☁️ Netlify API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['☁️ Netlify API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
  rows.push(['✈️ Telegram', '🟢 <b>Aktif</b>']);
  await editPanel(ctx, status.message_id, panel({ heading: '<b>SYSTEM STATUS</b>', box: infoBox(rows) }), homeButton());
});

bot.action('users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  await loadUsers();
  const ids = [...userProfiles.keys()].filter((x) => x !== OWNER_ID).sort((a, b) => a - b).slice(-100);
  const list = ids.length ? ids.map((x, i) => {
    const p = userProfiles.get(x);
    const state = bannedUsers.has(x) ? '🚫 BANNED' : '✅ USER';
    return `${i + 1}. <b>${escapeHtml(p?.name || `User ${x}`)}</b> · ${state}\n   🆔 <code>${x}</code>${p?.username ? ` · @${escapeHtml(p.username)}` : ''}`;
  }).join('\n\n') : '<i>Belum ada user yang tercatat.</i>';
  await sendPanel(ctx, panel({ heading: '<b>USERS</b>', body: list }), ownerPanelMarkup());
});

bot.action('manage_users', async (ctx) => {
  await ctx.answerCbQuery();
  if (isOwner(ctx)) await sendPanel(ctx, panel({ heading: '<b>ROLE SYSTEM</b>', body: 'Role sistem hanya OWNER dan USER. Tidak ada role tambahan.' }), ownerPanelMarkup());
});

bot.action('list_web', async (ctx) => {
  await ctx.answerCbQuery('Memuat daftar…');
  const all = await loadDeployments();
  const ownerView = isOwner(ctx);
  const supportedDeployments = all.filter((d) => d.platform === 'vercel' || d.platform === 'netlify');
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
      // lewati yang tidak respons
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
  if (!await requireFeatureAccess(ctx)) return;
  return sendPanel(ctx, panel({
    heading: '<b>MEDIA KE URL</b>',
    body: 'Pilih jenis media. File akan diproses sebagai file asli yang dikirim ke bot, lalu dipublikasikan sebagai URL langsung.',
  }), mediaMenuMarkup());
});

bot.action('donation', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const response = await axios.get(DONATION_QRIS_URL, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024,
    });
    const buffer = Buffer.from(response.data);
    const contentType = String(response.headers?.['content-type'] || '');
    if (!contentType.startsWith('image/')) throw new Error('QRIS tidak mengembalikan file gambar.');
    await ctx.replyWithPhoto({ source: buffer }, {
      caption: '💝 <b>Donasi DevTools Raven</b>\n\nScan QRIS pada gambar di atas.',
      parse_mode: 'HTML',
    });
  } catch (error) {
    await sendPanel(ctx, panel({ heading: '<b>QRIS GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
  }
});

bot.action('photo_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Foto ke URL',
    '🖼️ <b>Kirim Foto/Icon</b>\n\nKirim gambar yang mau dijadikan link (untuk dipakai di <code>&lt;img src&gt;</code> project HTML kamu).\n\nFormat didukung: PNG, JPG, GIF, WEBP, SVG, ICO.\n\n<i>Tips: kirim sebagai File/Dokumen (bukan Foto biasa) kalau mau kualitas asli tanpa dikompres Telegram — cocok buat icon/logo yang butuh tajam.</i>',
    { type: 'photo_url', step: 'file' }
  );
});

bot.action('audio_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Audio ke URL',
    '🎵 <b>Kirim File Audio</b>\n\nKirim file audio yang mau dijadikan link (untuk dipakai di <code>&lt;audio src&gt;</code> project HTML kamu).\n\nFormat didukung: MP3, WAV, OGG, M4A, AAC, FLAC.\n\n<i>Kirim sebagai File/Dokumen (bukan Voice Note) supaya kualitas asli tidak dikompres Telegram.</i>',
    { type: 'audio_url', step: 'file' }
  );
});

bot.action('video_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Video ke URL',
    '🎬 <b>Kirim File Video</b>\n\nKirim video yang mau dijadikan URL publik langsung.\n\nFormat didukung: MP4, WEBM, MOV, MKV, OGV.\n\n<i>Kirim sebagai File/Dokumen untuk mempertahankan file asli.</i>',
    { type: 'video_url', step: 'file' }
  );
});

bot.action('screenshot_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Screenshot URL',
    '📸 <b>Kirim URL Website</b>\n\nKirim link website manapun (contoh: <code>https://contoh.com</code>), bot akan mengambil screenshot tampilannya dan mengirim gambarnya ke sini.',
    { type: 'screenshot', step: 'url' }
  );
});

async function consumeRepoQuota(userId) {
  const id = Number(userId);
  if (id === OWNER_ID) return { allowed: true, count: 0, limit: Infinity };
  const current = Number(repoQuota.get(id) || 0);
  if (current >= REPO_QUOTA_LIMIT) return { allowed: false, count: current, limit: REPO_QUOTA_LIMIT };
  repoQuota.set(id, current + 1);
  const persisted = await persistQuota();
  if (!persisted) {
    if (current > 0) repoQuota.set(id, current); else repoQuota.delete(id);
    return { allowed: false, count: current, limit: REPO_QUOTA_LIMIT, error: true };
  }
  return { allowed: true, count: current + 1, limit: REPO_QUOTA_LIMIT };
}

bot.action('repo_zip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Get Repo ZIP',
    '📦 <b>Kirim Link Repository GitHub</b>\n\nContoh: <code>https://github.com/owner/nama-repo</code>\n\nBot akan mengambil ZIP branch default repo tersebut lewat endpoint resmi GitHub, lalu mengirimnya ke sini.\n\n⚠️ Hanya untuk repository <b>public</b>. Batas ukuran kirim Telegram: 50MB.',
    { type: 'repo_zip', step: 'link' }
  );
});

bot.action('search_repo', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Cari Repo GitHub',
    '🔎 <b>Kirim Kata Kunci</b>\n\nContoh: <code>telegram bot starter</code>\n\nBot akan cari repository GitHub publik yang paling relevan. <b>Batas gabungan fitur repo: 2 kali per user.</b> Setelah habis, hubungi owner untuk akses tambahan (5k).',
    { type: 'search_repo', step: 'query' }
  );
});

bot.action('flutter_build', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPanel(ctx, panel({
    heading: '<b>BUILD FLUTTER APK</b>',
    body: 'Pilih mode build. Source ZIP akan dikirim ke repository GitHub sementara dan dikompilasi oleh GitHub Actions.',
  }), Markup.inlineKeyboard([
    [Markup.button.callback('🧪 DEBUG BUILD', 'flutter_mode:debug'), Markup.button.callback('🚀 RELEASE BUILD', 'flutter_mode:release')],
    [Markup.button.callback('🏠 Menu Utama', 'home')],
  ]));
});

bot.action(/^flutter_mode:(debug|release)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  const id = uid(ctx);
  const mode = String(ctx.match[1]);
  sessions.set(id, { type: 'flutter_build', step: 'file', mode, platform: 'github', createdAt: Date.now() });
  await sendPrompt(ctx, `Build Flutter APK — ${mode.toUpperCase()}`, '📦 <b>Kirim ZIP project Flutter</b>\n\nWajib ada <code>pubspec.yaml</code>. Project boleh berada di root ZIP atau satu folder pembungkus. Build akan dilakukan nyata di GitHub Actions.', sessions.get(id));
});

bot.action('web_to_apk', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Build Web ke APK',
    '📱 <b>Kirim Project Web</b>\n\nKirim <code>.zip</code> berisi project web dengan <code>index.html</code>, atau kirim 1 file <code>.html</code>.\n\nBot akan membungkus asset web menjadi aplikasi Android WebView lokal dan membuild APK asli lewat GitHub Actions. Tidak ada browser address bar dan asset lokal tidak perlu refresh dari server web.',
    { type: 'web_to_apk', step: 'file' }
  );
});

bot.action('build_queue', async (ctx) => {
  await ctx.answerCbQuery('Memuat queue…');
  if (!await requireFeatureAccess(ctx)) return;
  const builds = (await loadBuildRecords()).filter((b) => Number(b.userId) === uid(ctx)).slice(-15).reverse();
  if (!builds.length) return sendPanel(ctx, panel({ heading: '<b>ANTRIAN BUILD</b>', body: '<i>Belum ada build kamu.</i>' }), homeButton());
  const body = builds.map((b, i) => `${i + 1}. <b>${escapeHtml(b.projectName || b.id)}</b> · <code>${escapeHtml(String(b.status || '').toUpperCase())}</code> · <code>${escapeHtml(b.stage || '-')}</code>`).join('\n');
  await sendPanel(ctx, panel({ heading: '<b>ANTRIAN / RIWAYAT BUILD</b>', body, footer: 'Status diperbarui otomatis dari callback GitHub Actions.' }), homeButton());
});

bot.action('generate_bot', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Generate Bot',
    '🤖 <b>Langkah 1 — Kirim ZIP Project Bot</b>\n\nUpload ZIP project bot Node.js (model <b>webhook</b>, bukan polling — deploy-nya ke Vercel yang serverless) yang mau dideploy otomatis.\n\n⚠️ Wajib ada <code>package.json</code> di root ZIP (atau di dalam satu folder pembungkus tunggal).\n\n<i>Struktur folder bebas — jumlah & nama file di dalam <code>api/</code> boleh apa saja, bot akan coba deteksi otomatis mana file handler-nya.</i>',
    { type: 'generate_bot', platform: 'vercel', step: 'file' }
  );
});

bot.action(/^gbpick_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
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
  if (!isOwner(ctx)) return;
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.type !== 'generate_bot' || session.step !== 'gb_env_more') return;
  session.step = 'gb_env_key';
  await sendPrompt(ctx, 'Generate Bot — .env', '🔑 <b>Kirim KEY</b> berikutnya\nContoh: <code>ID_PEMILIK</code>', session);
});

bot.action('gb_env_more_done', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
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
      '🚀 Deploy Vercel/Netlify — upload HTML/ZIP, langsung online\n' +
      '⚙️ Tambah .env — isi environment variable sebelum deploy (Vercel ZIP)\n' +
      '💥 Build Flutter APK — debug/release build project Flutter ZIP via GitHub Actions\n' +
      '📱 Web ke APK — build APK Android WebView dari HTML/ZIP menggunakan GitHub Actions\n' +
      '🌐 Get Source — repository GitHub diambil sebagai ZIP asli; website publik hanya mengambil byte source/assets yang benar-benar tersedia\n' +
      '🛡️ Encrypt HTML/JS — hanya .html/.js; pipeline XOR + obfuscation + Base64\n' +
      '🖼️🎵🎬 Foto/Audio/Video ke URL — upload file asli, dapat link langsung\n' +
      '📸 Screenshot URL — ambil gambar tampilan website manapun\n' +
      '📦 Get Repo ZIP — ambil ZIP repo GitHub public\n' +
      '🔎 Cari Repo GitHub — gabungan Get Repo/Cari Repo dibatasi 2 penggunaan per user, setelah itu akses tambahan 5k via owner\n' +
      '🤖 Generate Bot — khusus owner\n' +
      '📋 List Web — user melihat miliknya, owner melihat semuanya; 🗑️ Delete Web khusus owner\n' +
      '📢 Broadcast / 👥 Users — khusus owner\n\n' +
      '<i>Developer: Raven</i>\n' +
      '<i>Note: baca dulu instruksi di tiap menu sebelum bertanya — supaya lebih paham cara pakainya.</i>',
  }), homeButton());
});

bot.action('env_add', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_choice') return;
  session.envVars = session.envVars || [];
  session.step = 'env_key';
  await sendPrompt(ctx, 'Tambah .env', `🔑 <b>Kirim KEY</b> (nama environment variable)\nContoh: <code>TOKEN_GITHUB</code>`, session);
});

bot.action('env_skip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_choice') return;
  await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  await askForWebsiteName(ctx, session);
});

bot.action('env_more_add', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_more') return;
  session.step = 'env_key';
  await sendPrompt(ctx, 'Tambah .env', `🔑 <b>Kirim KEY</b> berikutnya\nContoh: <code>VERCEL_TOKEN</code>`, session);
});

bot.action('env_more_done', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session || session.step !== 'env_more') return;
  const count = session.envVars?.length || 0;
  await askForWebsiteName(ctx, session, `✅ <b>${count}</b> environment variable siap ditambahkan saat deploy.`);
});

bot.action('delete_web', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Delete Web',
    '🗑️ <b>Kirim Link Website</b>\n\nKirim link website hasil deploy DevTools Raven yang ingin dihapus.\nContoh: <code>https://nama-web.vercel.app</code> atau <code>https://nama-web.netlify.app</code>\n\nBot otomatis mengenali platform dari link dan menghapus website beserta repository GitHub yang cocok bila ditemukan.',
    { type: 'delete', step: 'link' }
  );
});

bot.on('text', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  if (maintenanceEnabled && !isOwner(ctx)) { sessions.delete(id); await sendPanel(ctx, panel({ heading: '<b>MAINTENANCE 🛠️</b>', body: 'Fitur user sedang ditutup sementara oleh owner.' }), ownerContactMarkup()); return; }
  const text = ctx.message.text.trim();

  if (session.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);

  if (session.type === 'tool_ai_image' && session.step === 'text') {
    sessions.delete(id);
    await legacyTools.handleAIImage({
      sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts),
      deleteMessage: (chatId, msgId) => ctx.telegram.deleteMessage(chatId, msgId),
      editMessageText: (textValue, options) => ctx.telegram.editMessageText(options.chat_id, options.message_id, undefined, textValue, options),
      sendPhoto: (chatId, photo, opts) => ctx.telegram.sendPhoto(chatId, photo, opts),
    }, { ...ctx.message, text: `/aiimage ${text}` });
    return;
  }
  if (session.type === 'tool_logo' && session.step === 'text') {
    sessions.delete(id);
    await legacyTools.handleLogo({
      sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts),
      deleteMessage: (chatId, msgId) => ctx.telegram.deleteMessage(chatId, msgId),
      editMessageText: (textValue, options) => ctx.telegram.editMessageText(options.chat_id, options.message_id, undefined, textValue, options),
      sendPhoto: (chatId, photo, opts) => ctx.telegram.sendPhoto(chatId, photo, opts),
    }, { ...ctx.message, text: `/createlogo ${text}` });
    return;
  }
  if (session.type === 'tool_mediafire' && session.step === 'text') {
    sessions.delete(id);
    await legacyTools.handleMediaFire({
      sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts),
      editMessageText: (textValue, options) => ctx.telegram.editMessageText(options.chat_id, options.message_id, undefined, textValue, options),
    }, { ...ctx.message, text: `/mediafire ${text}` });
    return;
  }
  if (session.type === 'tool_request' && session.step === 'text') {
    sessions.delete(id);
    await legacyTools.handleReq({ telegram: ctx.telegram, sendMessage: (chatId, text, opts) => ctx.telegram.sendMessage(chatId, text, opts) }, { ...ctx.message, text: `/req ${text}` }, OWNER_ID);
    await notifyChannelText('📨 REQUEST OWNER', ctx, 'Request berhasil diteruskan ke owner.');
    return;
  }
  if (session.type === 'tool_fixerror' && session.step === 'text') {
    sessions.delete(id);
    if (!text || text.length > 7000) {
      await sendPanel(ctx, panel({ heading: '<b>FIX CODE GAGAL ❌</b>', body: 'Kode kosong atau melebihi batas 7000 karakter.' }), homeButton());
      return;
    }
    const status = await sendPanel(ctx, panel({ heading: '<b>FIX CODE ERROR</b>', body: '🧯 Mengirim kode ke engine perbaikan…' }));
    try {
      const endpoint = process.env.FIXERROR_API_URL || 'https://api.ikyyxd.my.id/tools/fixerror';
      const response = await axios.get(endpoint, { params: { code: `apa yang salah pada kode berikut?\n${text}\ntolong perbaiki tanpa ada penjelasan`, lang: 'javascript' }, timeout: 25000, validateStatus: () => true });
      const fixed = String(response.data?.result?.fixed || '').trim();
      if (response.status >= 400 || !fixed) throw new Error(`FIXERROR_HTTP_${response.status}`);
      if (fixed.length <= 3500) {
        await editPanel(ctx, status.message_id, panel({ heading: '<b>FIX CODE SELESAI ✅</b>', body: `<pre>${escapeHtml(fixed)}</pre>` }), homeButton());
      } else {
        await ctx.replyWithDocument({ source: Buffer.from(fixed, 'utf8'), filename: 'fixed-code.js' }, { caption: '✅ <b>FIX CODE SELESAI</b>', parse_mode: 'HTML' });
        await editPanel(ctx, status.message_id, panel({ heading: '<b>FIX CODE SELESAI ✅</b>', body: 'File <code>fixed-code.js</code> sudah dikirim.' }), homeButton());
      }
      await notifyChannelText('🧯 FIX CODE SELESAI', ctx, `Kode user diproses melalui tool fix-error. Panjang hasil: <code>${fixed.length}</code> karakter.`);
    } catch (error) {
      await editPanel(ctx, status.message_id, panel({ heading: '<b>FIX CODE GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
      await notifyChannelText('🧯 FIX CODE GAGAL', ctx, `<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  if (session.type === 'rename_project' && session.step === 'rename_name') {
    const appName = text.slice(0, 80).trim();
    if (!appName) return sendPrompt(ctx, 'Rename Project', '❌ Nama aplikasi tidak boleh kosong.', session);
    session.renameAppName = appName;
    if (session.renameScan.domains.length) {
      session.step = 'rename_domain';
      await sendPrompt(ctx, 'Rename Project', `🌐 Domain lama terdeteksi: <code>${escapeHtml(session.renameScan.domains[0])}</code>\nKirim domain baru atau ketik <code>-</code> untuk melewati.`, session);
    } else {
      session.renameDomain = null;
      session.step = 'rename_done';
      await processRenameProject(ctx, session);
    }
    return;
  }

  if (session.type === 'rename_project' && session.step === 'rename_domain') {
    session.renameDomain = text === '-' ? null : text;
    session.step = 'rename_done';
    await processRenameProject(ctx, session);
    return;
  }

  if ((session.type === 'ban_user' || session.type === 'unban_user') && session.step === 'id') {
    if (!isOwner(ctx)) return;
    const target = Number(text);
    if (!Number.isInteger(target) || target <= 0 || target === OWNER_ID) {
      await sendPrompt(ctx, session.type === 'ban_user' ? 'Ban User' : 'Unban User', '❌ Telegram ID tidak valid atau target adalah owner.', session);
      return;
    }
    try {
      if (session.type === 'ban_user') await banUser(target); else await unbanUser(target);
      sessions.delete(id);
      await sendPanel(ctx, panel({ heading: session.type === 'ban_user' ? '<b>USER DIBLOKIR 🚫</b>' : '<b>USER DIUNBAN ✅</b>', body: `ID <code>${target}</code> sudah ${session.type === 'ban_user' ? 'diblokir' : 'dibuka blokirnya'}.` }), ownerPanelMarkup());
    } catch (error) {
      await sendPanel(ctx, panel({ heading: '<b>GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), ownerPanelMarkup());
    }
    return;
  }

  if (session.type === 'broadcast' && session.step === 'text') {
    if (!isOwner(ctx)) return;
    sessions.delete(id);
    const status = await sendPanel(ctx, panel({ heading: '<b>BROADCAST</b>', body: '⏳ Mengirim pesan ke semua user…' }));

    const targets = [...userProfiles.keys()].filter((x) => x !== id && !bannedUsers.has(x));
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
      await editPanel(ctx, status.message_id, panel({ heading: '<b>GET SOURCE GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
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
      await editPanel(ctx, status.message_id, panel({ heading: '<b>SCREENSHOT GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'repo_zip' && session.step === 'link') {
    sessions.delete(id);
    const quota = await consumeRepoQuota(id);
    if (!quota.allowed) {
      const quotaBody = quota.error ? 'Penyimpanan quota GitHub sedang gagal. Coba lagi nanti.' : 'Batas 2 kali untuk gabungan Cari Repo + Get Repo sudah habis. Hubungi owner untuk membeli akses tambahan <b>5k</b>.';
      await sendPanel(ctx, panel({ heading: quota.error ? '<b>QUOTA TIDAK TERSEDIA ⚠️</b>' : '<b>QUOTA REPO HABIS 🔒</b>', body: quotaBody }), ownerContactMarkup());
      return;
    }
    const status = await sendPanel(ctx, panel({ heading: '<b>GET REPO ZIP</b>', body: `⏳ Memeriksa repository…\nQuota: ${quota.count}/${quota.limit}` }));
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
      await editPanel(ctx, status.message_id, panel({ heading: '<b>GET REPO ZIP GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'search_repo' && session.step === 'query') {
    sessions.delete(id);
    const quota = await consumeRepoQuota(id);
    if (!quota.allowed) {
      const quotaBody = quota.error ? 'Penyimpanan quota GitHub sedang gagal. Coba lagi nanti.' : 'Batas 2 kali untuk gabungan Cari Repo + Get Repo sudah habis. Hubungi owner untuk membeli akses tambahan <b>5k</b>.';
      await sendPanel(ctx, panel({ heading: quota.error ? '<b>QUOTA TIDAK TERSEDIA ⚠️</b>' : '<b>QUOTA REPO HABIS 🔒</b>', body: quotaBody }), ownerContactMarkup());
      return;
    }
    const status = await sendPanel(ctx, panel({ heading: '<b>CARI REPO GITHUB</b>', body: `⏳ Mencari…\nQuota: ${quota.count}/${quota.limit}` }));
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
      await editPanel(ctx, status.message_id, panel({ heading: '<b>PENCARIAN GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'delete' && session.step === 'link') {
    if (!isOwner(ctx)) { sessions.delete(id); await sendPanel(ctx, panel({ heading: '<b>AKSES OWNER</b>', body: 'Delete Web hanya dapat digunakan oleh owner.' }), ownerContactMarkup()); return; }
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
      await editPanel(ctx, status.message_id, panel({ heading: '<b>DELETE GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
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
    await sendPrompt(ctx, 'Video ke URL', `❌ <b>Gagal mengambil video dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, { type: 'video_url', step: 'file' });
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
    await sendPrompt(ctx, 'Foto ke URL', `❌ <b>Gagal mengambil foto dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, { type: 'photo_url', step: 'file' });
  }
});

bot.on('document', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  if (maintenanceEnabled && !isOwner(ctx)) { sessions.delete(id); await sendPanel(ctx, panel({ heading: '<b>MAINTENANCE 🛠️</b>', body: 'Fitur user sedang ditutup sementara oleh owner.' }), ownerContactMarkup()); return; }
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
      await sendPrompt(ctx, 'Foto ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
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
      await sendPrompt(ctx, 'Audio ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
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
      await sendPrompt(ctx, 'Video ke URL', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'rename_project' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, 'Rename Project', '❌ Kirim file <code>.zip</code>.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const files = await extractRenameZip(buffer);
      const scan = scanRenameFiles(files);
      session.renameSource = buffer.toString('base64');
      session.files = files;
      session.renameScan = scan;
      session.step = 'rename_name';
      session.controlMessageId = null;
      await sendPanel(ctx, panel({ heading: '<b>RENAME PROJECT</b>', body: `📱 Nama terdeteksi: <code>${escapeHtml(scan.appNames.slice(0,5).map(x=>x.value).join(' | ') || '-')}</code>\n🌐 Domain terdeteksi: <code>${escapeHtml(scan.domains.slice(0,5).join(' | ') || '-')}</code>\n🎨 Icon terdeteksi: <code>${escapeHtml(scan.iconFiles.slice(0,5).join(' | ') || '-')}</code>\n\nKirim nama aplikasi baru. Contoh: <code>Raven Nova</code>` }), homeButton());
      sessions.set(id, session);
    } catch (error) {
      await sendPrompt(ctx, 'Rename Project', `❌ ZIP tidak valid.\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'flutter_build' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, 'Build Flutter APK', '❌ Kirim file <code>.zip</code> project Flutter.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      const files = await extractZipGeneric(buffer);
      if (!files.some((f) => /(^|\/)pubspec\.yaml$/i.test(f.path))) {
        await sendPrompt(ctx, 'Build Flutter APK', '❌ <b>pubspec.yaml tidak ditemukan.</b> Pastikan ZIP benar-benar berisi project Flutter.', session);
        return;
      }
      session.files = files;
      session.name = repoSafeName(fileName.replace(/\.zip$/i, '')) || 'raven-flutter-build';
      session.step = 'deploying';
      sessions.set(id, session);
      const status = await sendPanel(ctx, panel({
        heading: '📊 <b>BUILD FLUTTER APK</b>',
        box: infoBox([
          ['⚙️ Mode', session.mode.toUpperCase()],
          ['📦 Project', `<code>${escapeHtml(session.name)}</code>`],
          ['🛰️ Engine', 'GitHub Actions'],
          ['📝 Activity', 'Menyiapkan source backup…'],
        ]),
        footer: 'Build nyata. APK dikirim setelah GitHub Actions selesai.',
      }));
      await runGithubActionsBuild(ctx, session, status);
    } catch (error) {
      await sendPrompt(ctx, 'Build Flutter APK', `❌ <b>Project tidak bisa diproses.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
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
          ['🔧 Mode', session.type === 'web_to_apk' ? 'Web to APK' : 'Flutter APK'],
          ['📦 Project', `<code>${escapeHtml(session.name)}</code>`],
          ['🔄 Progress', `<code>${progressBar(0)}</code> 0%`],
          ['📝 Activity', 'Memulai proses…'],
        ]),
        footer: 'Build APK asli sedang diproses.',
      }));
      await runGithubActionsBuild(ctx, session, status);
    } catch (error) {
      await sendPrompt(ctx, 'Build Web ke APK', `❌ <b>Project tidak bisa diproses.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'generate_bot' && session.step === 'file') {
    if (!isOwner(ctx)) return;
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
      await sendPrompt(ctx, 'Generate Bot', `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_html' && session.step === 'file') {
    if (!isOwner(ctx)) return;
    const platformLabel = platformDisplayName(session.platform);
    if (!/\.html?$/i.test(fileName)) {
      await sendPrompt(ctx, `Deploy HTML — ${platformLabel}`, '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code> atau <code>.js</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      session.files = [{ path: 'index.html', buffer }];
      await askEnvChoiceOrName(ctx, session, `📄 File diterima: <code>${escapeHtml(fileName)}</code>`);
    } catch (error) {
      await sendPrompt(ctx, `Deploy HTML — ${platformLabel}`, `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'deploy_zip' && session.step === 'file') {
    if (!isOwner(ctx)) return;
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
      await sendPrompt(ctx, `Deploy ZIP — ${platformLabel}`, `❌ <b>ZIP tidak valid.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'encrypt' && session.step === 'file') {
    if (!/\.(html?|js)$/i.test(fileName)) {
      await sendPrompt(ctx, 'Encrypt HTML / JS', '❌ <b>Format salah.</b>\n\nMenu ini hanya menerima file <code>.html</code> atau <code>.js</code>. Silakan kirim ulang file yang sesuai.', session);
      return;
    }
    try {
      const buffer = await downloadTelegramFile(ctx, document.file_id);
      sessions.delete(id);
      const encrypted = encryptSourceReversible(buffer.toString('utf8'), /\.js$/i.test(fileName) ? 'js' : 'html');
      const outExt = /\.js$/i.test(fileName) ? 'js' : 'html';
      await ctx.replyWithDocument({ source: Buffer.from(encrypted, 'utf8'), filename: `${fileName.replace(/\.(html?|js)$/i, '')}-encrypted.${outExt}` }, { caption: '✅ Source berhasil dienkripsi (XOR + Shuffle + Base64; JS juga diobfuscate).' });
      await sendPanel(ctx, panel({
        heading: '<b>ENCRYPT SELESAI ✅</b>',
        body: 'File terenkripsi sudah dikirim di atas.\n\n🔐 Hasil enkripsi ini <b>reversible</b> — saat dibuka di browser, HTML asli akan direkonstruksi otomatis oleh decoder yang sudah tertanam di dalam file. Tidak perlu password.',
      }), homeButton());
    } catch (error) {
      await sendPrompt(ctx, 'Encrypt HTML / JS', `❌ <b>Gagal mengambil file dari Telegram.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
  }
});


bot.command('cancel', async (ctx) => {
  const session = sessions.get(uid(ctx));
  if (session?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, session.controlMessageId);
  sessions.delete(uid(ctx));
  await sendPanel(ctx, panel({ heading: '<b>DIBATALKAN ↩️</b>', body: 'Proses yang sedang berjalan sudah dibatalkan.' }), homeButton());
});

bot.on('chat_member', async (ctx) => {
  const update = ctx.update?.chat_member;
  if (!update) return;
  const chat = update.chat;
  const newStatus = update.new_chat_member?.status;
  const oldStatus = update.old_chat_member?.status;
  if (!chat || String(chat.username || '').toLowerCase() !== MANDATORY_CHANNEL.replace(/^@/, '').toLowerCase()) return;
  const targetId = Number(update.new_chat_member?.user?.id || update.from?.id || 0);
  if (!targetId) return;
  invalidateJoin(targetId);
  const active = memberStatusAllowed(newStatus) && !(newStatus === 'restricted' && update.new_chat_member?.is_member === false);
  const was = memberStatusAllowed(oldStatus) && !(oldStatus === 'restricted' && update.old_chat_member?.is_member === false);
  if (active === was) return;
  const action = active ? 'JOIN' : 'LEAVE';
  const photo = path.join(__dirname, '..', 'assets', active ? 'raven-welcome.jpg' : 'raven-goodbye.jpg');
  const caption = `${active ? '🌸' : '👋'} <b>USER ${action}</b>\n\n👤 ${escapeHtml(userDisplayName(update.new_chat_member?.user || update.from))}\n🆔 <code>${targetId}</code>\n📣 <code>${escapeHtml(MANDATORY_CHANNEL)}</code>`;
  try {
    if (fs.existsSync(photo)) await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: photo }, { caption, parse_mode: 'HTML' });
    else await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML' });
  } catch (_) {}
});

bot.catch((error) => {
  console.error('[BOT ERROR]', error.response?.data || error.message || error);
});

(async () => {
  await loadUsers();
  await loadControlState();
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
  try {
    const base = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    if (base) {
      const webhookUrl = `${String(base).startsWith('http') ? String(base) : `https://${String(base)}`}/api/bot`;
      await bot.telegram.setWebhook(webhookUrl, { allowed_updates: ['message','callback_query','chat_member','my_chat_member'] });
    }
  } catch (error) {
    console.error('[SET WEBHOOK]', safeError(error));
  }
})();

const webhookHandler = async (req, res) => {
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

module.exports = webhookHandler;
module.exports.handleBuildCallback = handleBuildCallback;
