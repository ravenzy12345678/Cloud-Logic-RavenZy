const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildId, workflowYml, androidWorkflowYml, createRepo: createBuildRepo, uploadFiles: uploadBuildFiles, dispatchWorkflow, dispatchRepositoryEvent, createRelease, uploadReleaseAsset, downloadReleaseAsset, getArtifact, cancelRun, findRunByJobId, downloadRunLogs, deleteRepo: deleteBuildRepo } = require('./build-engine');
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
  TELEGRAM_API_ROOT: process.env.TELEGRAM_API_ROOT || process.env.TELEGRAM_LOCAL_API_ROOT || '',
};

function requireConfig() {
  const required = ['BOT_TOKEN', 'OWNER_ID', 'GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'VERCEL_TOKEN'];
  const missing = required.filter((k) => !ENV[k]);
  if (missing.length) console.error(`[CONFIG] Missing: ${missing.join(', ')}`);
  if (ENV.TELEGRAM_API_ROOT) console.log(`[CONFIG] Custom Telegram API root enabled: ${ENV.TELEGRAM_API_ROOT}`);
}
requireConfig();

const bot = new Telegraf(ENV.BOT_TOKEN, {
  telegram: {
    apiRoot: ENV.TELEGRAM_API_ROOT || 'https://api.telegram.org',
  },
});
const OWNER_ID = Number(ENV.OWNER_ID);
const sessions = new Map();
const userProfiles = new Map();
const bannedUsers = new Set();
const repoQuota = new Map();
const joinCache = new Map();
const joinReadyForStart = new Set();
const lastJoinState = new Map();
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
const PENDING_SESSION_FILE = 'devtools-raven-pending-sessions.json';
const PENDING_SESSION_TTL = 30 * 60 * 1000;
const BUILD_CONCURRENCY_NOTE = 'Server';
const SERVER_LABEL = process.env.BUILD_SERVER_LABEL || 'Server #1';
const OWNER_TELEGRAM_URL = 'https://t.me/RavenZyPT';
const OWNER_WHATSAPP_URL = 'https://wa.me/6288271102065';
const OWNER_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb89MImFHWptXTOThg3G';
const BUY_MESSAGE = 'Saya ingin membeli akses Get Repo/Cari Repo DevTools dengan harga 5k, tolong di acc';
const BUY_ACCESS_URL = `${OWNER_TELEGRAM_URL}?text=${encodeURIComponent(BUY_MESSAGE)}`;

const TELEGRAM_OFFICIAL_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const FLUTTER_REMOTE_SOURCE_LIMIT = 150 * 1024 * 1024;
const FLUTTER_MAX_SOURCE_BYTES = 2_147_483_647;
const FLUTTER_MAX_FILES = 6000;
const FLUTTER_MAX_UNCOMPRESSED = 300 * 1024 * 1024;
const FLUTTER_SKIP_DIRS = new Set([
  '.git', '.dart_tool', 'build', 'node_modules', '.gradle', '.idea', '.vscode', 'coverage',
]);

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
  out = out.replace(/api\.github\.com/ig, 'server-build.internal');
  out = out.replace(/\bGitHub\b/g, 'Server');
  out = out.replace(/\brepositor(y|ies)\b/ig, (m) => (/^[A-Z]/.test(m) ? 'Project' : 'project'));
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
  if (Date.now() - controlStateLoadedAt < 45_000) return;
  if (!controlLoading) controlLoading = loadControlState().catch((error) => console.error('[CONTROL LOAD]', errorMessage(error))).finally(() => { controlLoading = null; });
  await controlLoading;
}

async function ensureUsersLoaded() {
  if (Date.now() - usersLoadedAt < 60_000) return;
  usersLoadedAt = Date.now();
  await loadUsers();
}

function featureIsExemptFromMaintenance(ctx) {
  if (isOwner(ctx)) return true;
  const action = ctx.callbackQuery?.data || '';
  return action === 'home' || action === 'system' || action === 'help_info' || action === 'donation';
}

function userDisplayName(from) {
  const first = String(from?.first_name || '').trim();
  const last = String(from?.last_name || '').trim();
  const raw = `${first} ${last}`.trim();
  const cleaned = raw ? cleanName(raw, 40) : '';
  if (cleaned && cleaned !== 'User') return cleaned;
  return from?.username ? `@${from.username}` : `User ${from?.id || '-'}`;
}

function getNextMemberNumber() {
  let max = 0;
  for (const profile of userProfiles.values()) {
    const n = Number(profile?.memberNo);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

function rememberUser(ctx) {
  const id = uid(ctx);
  if (!Number.isInteger(id) || id <= 0) return;
  const previous = userProfiles.get(id);
  const memberNo = id === OWNER_ID ? null : (Number.isInteger(Number(previous?.memberNo)) ? Number(previous.memberNo) : getNextMemberNumber());
  userProfiles.set(id, {
    ...(previous || {}),
    id,
    name: userDisplayName(ctx.from),
    username: ctx.from?.username || null,
    memberNo,
    updatedAt: Date.now(),
  });
  if (id !== OWNER_ID && !userPersistTimer) {
    userPersistTimer = setTimeout(() => { userPersistTimer = null; saveUsers().catch(() => {}); }, 750);
  }
}

function knownUserCount() {
  return [...userProfiles.keys()].filter((id) => id !== OWNER_ID).length;
}

function formatWib(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const day = String(Number(map.day || 0)).padStart(2, '0');
  const month = String(Number(map.month || 0)).padStart(2, '0');
  return `${day}/${month}/${map.year} · ${map.hour}:${map.minute}:${map.second} WIB`;
}

function premiumHeader(title) {
  return `╭─────────────────────────╮\n   ${title}\n╰────────────────────────╯`;
}

function premiumBox(sectionTitle, lines) {
  const max = Math.max(
    ...lines.map((l) => l.replace(/<[^>]+>/g, '').length),
    sectionTitle.replace(/<[^>]+>/g, '').length
  );
  const width = max + 4;
  const top = `┌${'─'.repeat(width)}┐`;
  const title = `│ ${sectionTitle}${' '.repeat(Math.max(0, width - sectionTitle.replace(/<[^>]+>/g, '').length - 1))}│`;
  const sep = `├${'─'.repeat(width)}┤`;
  const body = lines.map((l) => {
    const plain = l.replace(/<[^>]+>/g, '').length;
    const pad = ' '.repeat(Math.max(0, width - plain - 1));
    return `│ ${l}${pad}│`;
  }).join('\n');
  const bottom = `└${'─'.repeat(width)}┘`;
  return `${top}\n${title}\n${sep}\n${body}\n${bottom}`;
}

function premiumFooter(text) {
  return `\n<i>© ${text}</i>`;
}

function statusEmoji(s) {
  return ({
    success: '🏆', ready: '✅', running: '⚡', building: '🏗️',
    queued: '⏳', failure: '💥', failed: '💥', cancelled: '⏹️',
  })[String(s || '').toLowerCase()] || '📡';
}

function buildHashTags({ id, username, memberNo, kind }) {
  const tags = [];
  if (kind) tags.push(`#${kind}`);
  if (memberNo) tags.push(`#User${memberNo}`);
  if (id) tags.push(`#id${id}`);
  if (username) tags.push(`#${String(username).replace(/[^a-zA-Z0-9]/g, '')}`);
  return tags.join(' ');
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
  const name = escapeHtml(cleanName(ctx.from?.username || userDisplayName(ctx.from)));
  const caption = [
    '🔒 <b>JOIN CHANNEL WAJIB</b>',
    RULE,
    `Halo, <b>${name}</b>.`,
    bq([
      `📢 <b>Channel</b> : <code>${escapeHtml(MANDATORY_CHANNEL)}</code>`,
      '1️⃣ Tekan <b>JOIN CHANNEL</b>',
      '2️⃣ Setelah selesai, tekan <b>/start</b> lagi',
      '3️⃣ Bot otomatis memeriksa membership',
    ]),
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
    await sendPanel(ctx, panel({ heading: '<b>MAINTENANCE 🛠️</b>', body: 'Builder sedang maintenance. Fitur user sementara dinonaktifkan.' }), ownerContactMarkup());
    return false;
  }
  return enforceJoinGate(ctx);
}

async function sendGuestMenu(ctx) {
  return sendJoinGate(ctx);
}

bot.use(async (ctx, next) => {
  if (ctx.updateType !== 'chat_member' && ctx.updateType !== 'my_chat_member' && ctx.chat?.type !== 'private') {
    return undefined;
  }
  if (ctx.updateType === 'chat_member') return next();
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

const BAR = '───── ✦ ───── ✦ ─────';
const BRAND = 'BUILDER BY RAVEN · V3';

function homeButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('🏠  Menu Utama', 'home')]]);
}

function buildRunningButton(jobId) {
  return Markup.inlineKeyboard([[Markup.button.callback('❌  Batalkan Build', `build_cancel:${jobId}`)]]);
}

function mainMenuMarkup(ctx) {
  const rows = [
    [Markup.button.callback('💥  Build Flutter APK', 'flutter_build'), Markup.button.callback('🌐  Web to APK', 'web_to_apk')],
    [Markup.button.callback('✏️  Rename Project', 'rename_project'), Markup.button.callback('📄  Get Source', 'get_source')],
    [Markup.button.callback('🛡️  Encrypt HTML/JS', 'encrypt_html'), Markup.button.callback('🖼️  Media ke URL', 'media_menu')],
    [Markup.button.callback('📸  Screenshot URL', 'screenshot_url'), Markup.button.callback('📦  Get Repo ZIP', 'repo_zip')],
    [Markup.button.callback('🔎  Cari Repo', 'search_repo'), Markup.button.callback('⏳  Antrian Build', 'build_queue')],
    [Markup.button.callback('🎨  AI Image', 'tool_ai_image'), Markup.button.callback('✨  Create Logo', 'tool_logo')],
    [Markup.button.callback('📦  MediaFire', 'tool_mediafire'), Markup.button.callback('🪪  Cek ID', 'tool_cekid')],
    [Markup.button.callback('📨  Request Owner', 'tool_request'), Markup.button.callback('🧯  Fix Code Error', 'tool_fixerror')],
    [Markup.button.callback('📡  Status Server', 'system'), Markup.button.callback('📋  List Web', 'list_web')],
    [Markup.button.callback('ℹ️  Bantuan', 'help_info'), Markup.button.callback('💝  Donasi', 'donation')],
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
    [Markup.button.callback('📦 List & Get ZIP Build', 'owner_builds')],
    [Markup.button.callback('⏹️ Kill Build', 'owner_kill_builds'), Markup.button.callback('🛠️ Maintenance', 'owner_maintenance')],
    [Markup.button.callback('👥 Users', 'users'), Markup.button.callback('🚫 Ban User', 'ban_user')],
    [Markup.button.callback('✅ Unban User', 'unban_user')],
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
  return bq(rows.map(([label, value]) => `${label} : ${value}`));
}

function panel({ heading, box, body, footer } = {}) {
  const parts = [];
  if (heading) parts.push(`${heading}\n${RULE}${box ? `\n${box}` : ''}`);
  else if (box) parts.push(box);
  if (body) parts.push(body);
  if (footer) parts.push(footer);
  return parts.join('\n\n').trim();
}

function progressBar(percent) {
  const total = 10;
  const filled = Math.min(total, Math.max(0, Math.round((percent / 100) * total)));
  return '█'.repeat(filled) + '░'.repeat(total - filled);
}

const ASSET_BUFFERS = require('./assets-embedded');

function getAssetBuffer(filename) {
  return ASSET_BUFFERS[filename] || null;
}

console.log('[ASSETS] loaded:', Object.entries(ASSET_BUFFERS).map(([name, buf]) => `${name}=${buf ? buf.length + 'b' : 'MISSING'}`).join(', '));

function resolveLocalAsset(filename) {
  const candidates = [
    path.join(__dirname, '..', 'assets', filename),
    path.join(process.cwd(), 'assets', filename),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

const RULE = '━━━━━━━━━━━━━━━━━━━━';

function cleanName(value, max = 28) {
  const text = String(value || '').normalize('NFKC').replace(/[\p{M}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!text) return 'User';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function bq(lines) {
  const body = lines.filter((line) => line !== null && line !== undefined && line !== false && line !== '').join('\n');
  return `<blockquote>${body}</blockquote>`;
}

function colorBar(percent, failed = false) {
  const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const filled = Math.round(safe / 10);
  return (failed ? '🟥' : '🟩').repeat(filled) + '⬜'.repeat(10 - filled);
}

let uiThrottle = new Map();
let usersLoadedAt = 0;
let controlLoading = null;

function workerCredentials() {
  const creds = {
    tg_api_id: String(process.env.TELEGRAM_API_ID || process.env.API_ID || '').trim(),
    tg_api_hash: String(process.env.TELEGRAM_API_HASH || process.env.API_HASH || '').trim(),
    bot_token: String(ENV.BOT_TOKEN || '').trim(),
    gh_token: String(ENV.GH_TOKEN || '').trim(),
  };
  const labels = { tg_api_id: 'TELEGRAM_API_ID', tg_api_hash: 'TELEGRAM_API_HASH', bot_token: 'TOKEN_BOT', gh_token: 'TOKEN_GITHUB' };
  const missing = Object.keys(labels).filter((key) => !creds[key]).map((key) => labels[key]);
  if (missing.length) throw new Error(`Environment Vercel belum lengkap: ${missing.join(', ')}`);
  return creds;
}

async function checkWorkflowActive(owner, repo, branch, file) {
  const response = await axios.get(
    `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(file)}`,
    { headers: ghHeaders, params: { ref: branch }, timeout: 20000, validateStatus: () => true }
  );
  if (response.status < 200 || response.status >= 300) throw new Error(`Workflow ${file} tidak tersedia di repo build.`);
  const state = String(response.data?.state || '').toLowerCase();
  if (state && state !== 'active') throw new Error(`Workflow build sedang ${state}.`);
}

function cancelButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Batalkan', 'session_cancel')]]);
}

async function sendSessionPrompt(ctx, session, text) {
  const old = sessions.get(uid(ctx));
  if (old?.controlMessageId) await safeDeleteMessage(ctx, ctx.chat.id, old.controlMessageId);
  const message = await ctx.reply(text, { ...REPLY_OPTS, ...cancelButton() });
  session.controlMessageId = message.message_id;
  sessions.set(uid(ctx), session);
  return message;
}

function bar12(percent) {
  const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const filled = Math.round((safe / 100) * 12);
  return '█'.repeat(filled) + '░'.repeat(12 - filled);
}

function modeLabel(mode, long = false) {
  const m = String(mode || '').toLowerCase();
  if (m === 'release') return long ? '🚀 Release Build' : '🚀 RELEASE';
  if (m === 'debug') return long ? '🐞 Debug Build' : '🐞 DEBUG';
  return String(mode || '-').toUpperCase();
}

function wibClock(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.day}/${map.month}/${map.year}, ${map.hour}.${map.minute}.${map.second} WIB`;
}

function buildPhase(record) {
  const status = String(record?.status || 'running').toLowerCase();
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'failure') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  const stage = String(record?.stage || '').toUpperCase();
  if (['BUILDING_APK', 'APK_READY', 'SENDING_APK', 'APK_UPLOAD_PROGRESS', 'RENAME_PROCESSING', 'RENAME_READY', 'OUTPUT_UPLOAD_PROGRESS', 'BUILDING_WEB_APK', 'LOG_SENT'].includes(stage)) return 'monitor';
  if (['DEPENDENCIES_READY', 'ANDROID_READY', 'TOOLCHAIN_READY', 'PROJECT_VALIDATED', 'ANDROID_SETUP_READY'].includes(stage)) return 'compiling';
  if (['SOURCE_DOWNLOADED', 'SOURCE_VALIDATED', 'SOURCE_BACKUP_START', 'SOURCE_BACKUP_READY', 'SOURCE_UPLOADED', 'BUILD_REPO_READY'].includes(stage)) return 'uploaded';
  return 'downloading';
}

function recordElapsedSeconds(record) {
  if (record?.elapsedSeconds != null && record.elapsedSeconds !== '' && ['success'].includes(String(record.status))) {
    const fromRecord = record.completedAt && record.createdAt ? Math.round((record.completedAt - record.createdAt) / 1000) : null;
    return fromRecord != null ? fromRecord : Math.round(Number(record.elapsedSeconds));
  }
  const end = record?.completedAt || Date.now();
  return record?.createdAt ? Math.max(0, Math.round((end - record.createdAt) / 1000)) : 0;
}

function userBuildPanel(record, detail) {
  const phase = buildPhase(record);
  const percent = Math.max(0, Math.min(100, Number(record.progress || 0)));
  const isWeb = record.buildKind === 'web-to-apk';
  const isRename = record.operation === 'rename_project';
  const sdk = isWeb ? 'Android SDK' : 'Flutter SDK';
  const waktu = formatDurationShort(recordElapsedSeconds(record));
  const who = `👤 <b>Username</b> : ${escapeHtml(cleanName(record.userName || record.username || 'User'))}`;
  const proj = `📦 <b>Project</b> : <code>${escapeHtml(displayValue(record.originalFilename || record.sourceFilename || record.projectName || '-', 40))}</code>`;
  const srv = `🖥️ <b>Server</b> : <code>${escapeHtml(record.serverLabel || SERVER_LABEL)}</code>`;
  const modeRow = isRename ? null : `🔧 <b>Mode</b> : ${escapeHtml(modeLabel(record.mode, true))}`;
  const tail = '<i>Builder By Raven — Cloud Build Service</i>';

  if (phase === 'success') {
    return [
      isRename ? '🎉 <b>RENAME PROJECT SELESAI!</b>' : '🎉 <b>APK BUILD SELESAI!</b>',
      RULE,
      bq([who, proj, modeRow, `⏱ <b>Durasi</b> : ${escapeHtml(waktu)}`, record.apkSize ? `💾 <b>Ukuran</b> : ${escapeHtml(formatBytes(record.apkSize, 2))}` : null, srv]),
      '',
      isRename ? '✅ ZIP siap dipakai! Semoga sukses bray 🔥' : '✅ APK siap install! Semoga sukses bray 🔥',
      tail,
    ].join('\n');
  }

  if (phase === 'failed') {
    return [
      '❌ <b>BUILD GAGAL</b>',
      RULE,
      bq([who, proj, modeRow, `⛔ <b>Step gagal</b> : ${escapeHtml(record.failedStep || buildStageLabel(record.stage))}`, `⏱ <b>Durasi</b> : ${escapeHtml(waktu)}`, srv]),
      '',
      '📄 Log error lengkap dikirim sebagai file TXT.',
      tail,
    ].join('\n');
  }

  if (phase === 'cancelled') {
    return [
      '⏹️ <b>BUILD DIBATALKAN</b>',
      RULE,
      bq([who, proj, `⏱ <b>Durasi</b> : ${escapeHtml(waktu)}`, srv]),
      '',
      'Proses dihentikan atas permintaan.',
      tail,
    ].join('\n');
  }

  const sending = ['APK_READY', 'SENDING_APK', 'APK_UPLOAD_PROGRESS', 'RENAME_READY', 'OUTPUT_UPLOAD_PROGRESS'].includes(String(record.stage || '').toUpperCase());
  const variants = {
    downloading: ['🔄 <b>Mengunduh File...</b>', 'MENGUNDUH', 'Mengambil file ZIP project dari Telegram.'],
    uploaded: ['✅ <b>File Diunduh!</b>', 'MENGUPLOAD', '☁️ Mengupload ke server build...'],
    compiling: ['⚡ <b>[ SEDANG KOMPILASI ]</b>', 'COMPILING', `🚀 ${sdk} sedang kompilasi. Stay tune!`],
    monitor: [
      '⚡ <b>LIVE BUILD MONITOR</b> ⚡',
      sending ? 'SENDING' : (isRename ? 'PROCESSING' : 'COMPILING'),
      sending ? 'Build selesai. File sedang dikirim ke chat kamu.' : (isRename ? 'Source sedang diproses dan diganti nama.' : `${sdk} mengompilasi source code ke APK.`),
    ],
  };
  const [title, statusWord, fallback] = variants[phase] || variants.downloading;
  return [
    title,
    RULE,
    bq([who, proj, srv, `⏱ <b>Waktu</b> : ${escapeHtml(waktu)}`, `📊 <b>Status</b> : ${statusWord} (${percent}%)`, `${colorBar(percent)} <b>${percent}%</b>`]),
    `💬 <i>${escapeHtml(String(detail || fallback).slice(0, 200))}</i>`,
  ].join('\n');
}

function errorLogFileText(record, failedStep, bodyText) {
  return [
    'RAVEN BUILD ERROR LOG',
    `Step gagal : ${failedStep || record.failedStep || record.stage || '-'}`,
    `Build ID   : ${record.id}`,
    `Project    : ${record.originalFilename || record.sourceFilename || record.projectName || '-'}`,
    `Mode       : ${record.mode || '-'}`,
    `Waktu      : ${wibClock()}`,
    '========================================',
    String(bodyText || 'Log tidak tersedia.'),
    '',
  ].join('\n');
}

async function sendErrorLogFile(chatId, record, failedStep, bodyText) {
  const content = errorLogFileText(record, failedStep, scrubSensitive(String(bodyText || '')));
  const caption = [
    '📄 <b>Full Build Error Log</b>',
    '',
    `Step gagal: <b>${escapeHtml(failedStep || record.failedStep || '-')}</b>`,
    '',
    'Gunakan file ini untuk menemukan baris kode yang error secara detail.',
  ].join('\n');
  return bot.telegram.sendDocument(chatId, { source: Buffer.from(content, 'utf8'), filename: `raven-build-error-${record.id}.txt` }, { caption, parse_mode: 'HTML' });
}

async function fetchRunErrorLog(record) {
  const owner = record.tempRepoOwner || record.sourceRepoOwner || ENV.GH_OWNER;
  const repo = record.tempRepoName || record.sourceRepoName || ENV.GH_REPO;
  if (!owner || !repo || !record.runId) return '';
  try {
    const buffer = await downloadRunLogs(owner, repo, record.runId);
    const zip = await JSZip.loadAsync(buffer);
    const parts = [];
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.txt$/i.test(n)).sort();
    for (const name of names) {
      const text = await zip.files[name].async('string');
      parts.push(`######## ${name}\n${text}`);
    }
    return parts.join('\n\n');
  } catch (error) {
    console.error('[RUN LOG]', safeError(error));
    return '';
  }
}

function buildProgressLine(percent) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<code>${progressBar(safePercent)}</code> <b>${safePercent}%</b>`;
}

function buildStageLabel(stage) {
  const labels = {
    WORKFLOW_DISPATCHED: 'Menunggu worker build',
    WORKER_STARTING: 'Worker build sedang dimulai',
    WORKER_READY: 'Worker siap menjalankan proses',
    TELEGRAM_CONNECTING: 'Menghubungkan ke Telegram',
    TELEGRAM_SESSION_READY: 'Koneksi Telegram siap',
    SOURCE_DOWNLOAD_START: 'Mengambil source ZIP dari Telegram',
    SOURCE_DOWNLOAD_PROGRESS: 'Mengunduh source ZIP',
    SOURCE_DOWNLOADED: 'Source ZIP berhasil diterima',
    SOURCE_VALIDATED: 'Validasi ZIP selesai',
    SOURCE_BACKUP_START: 'Menyimpan source ke server',
    SOURCE_BACKUP_READY: 'Source tersimpan dengan aman',
    PROJECT_VALIDATED: 'Project Flutter terdeteksi',
    TOOLCHAIN_READY: 'Flutter, Java, dan Android SDK siap',
    ANDROID_READY: 'Konfigurasi Android siap',
    DEPENDENCIES_READY: 'Dependency project siap',
    BUILDING_APK: 'Kompilasi APK sedang berjalan',
    APK_READY: 'APK berhasil dibuat',
    SENDING_APK: 'Mengirim APK ke chat',
    APK_UPLOAD_PROGRESS: 'Mengirim APK ke chat',
    APK_SENT: 'APK sudah diterima chat tujuan',
    RENAME_PROCESSING: 'Rename project sedang diproses',
    RENAME_READY: 'ZIP hasil rename sudah siap',
    OUTPUT_SENT: 'File hasil sudah diterima chat tujuan',
    LOG_SENT: 'Log error dikirim ke chat',
    ANDROID_SETUP_READY: 'Android SDK siap',
    BUILDING_WEB_APK: 'Kompilasi APK web sedang berjalan',
    FINAL: 'Finalisasi build',
    COMPLETE: 'Build selesai',
    BUILD_FAILED: 'Proses build berhenti karena error',
    TELEGRAM_TRANSFER_FAILED: 'Transfer file Telegram gagal',
    KILLED_BY_OWNER: 'Build dihentikan',
    SUBMIT_FAILED: 'Build gagal dijadwalkan',
  };
  return labels[String(stage || '').toUpperCase()] || String(stage || 'Menyiapkan build');
}

function displayValue(value, max = 42) {
  const raw = String(value ?? '-').trim() || '-';
  return raw.length > max ? `${raw.slice(0, Math.max(1, max - 1))}…` : raw;
}

function formatDurationShort(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (s < 60) return `${s}d`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}d` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}j ${remM}m` : `${h}j`;
}

function buildNotificationCaption(record, { title, status, stage, progress, detail, finishedAt } = {}) {
  const safeStatus = String(status || record.status || 'running').toLowerCase();
  const percent = Math.max(0, Math.min(100, Number(progress ?? record.progress ?? 0)));
  const failed = safeStatus === 'failure' || safeStatus === 'failed';
  const statusLabel = safeStatus === 'success' ? 'SUKSES' : failed ? 'GAGAL' : safeStatus === 'cancelled' ? 'DIBATALKAN' : buildStageLabel(stage || record.stage).toUpperCase();
  const statusIcon = safeStatus === 'success' ? '🏆' : failed ? '❌' : safeStatus === 'cancelled' ? '⏹️' : '⚡';
  const isRename = record.operation === 'rename_project';
  const rows = [
    `👤 <b>Username</b> : ${escapeHtml(cleanName(record.userName || record.username || 'User'))}`,
    `📦 <b>Project</b> : <code>${escapeHtml(displayValue(record.originalFilename || record.sourceFilename || record.projectName || record.sourceLabel || '-', 40))}</code>`,
    `🖥️ <b>Server</b> : <code>${escapeHtml(record.serverLabel || SERVER_LABEL)}</code>`,
    record.apkSize && safeStatus === 'success' ? `💾 <b>${isRename ? 'ZIP' : 'APK'}</b> : ${escapeHtml(formatBytes(record.apkSize, 2))}` : null,
    failed && record.failedStep ? `⛔ <b>Step gagal</b> : ${escapeHtml(record.failedStep)}` : null,
    `⏱ <b>Waktu</b> : ${escapeHtml(formatDurationShort(recordElapsedSeconds(record)))}`,
    `${statusIcon} <b>Status</b> : ${escapeHtml(statusLabel)} (${percent}%)`,
    `${colorBar(percent, failed)} <b>${percent}%</b>`,
  ];
  return [
    '💎 <b>RAVEN BUILD CENTER</b>',
    `<b>${title || '⚡ LIVE BUILD MONITOR'}</b>`,
    RULE,
    bq(rows),
    detail ? `💬 <i>${escapeHtml(String(detail).slice(0, 220))}</i>` : null,
    finishedAt ? `📅 <b>Selesai</b> : ${escapeHtml(finishedAt)}` : null,
    '',
    '<i>Builder By Raven • 2026</i>',
  ].filter((line) => line !== null).join('\n');
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
  const name = escapeHtml(cleanName(ctx.from?.username || userDisplayName(ctx.from)));
  const menuText = [
    `👋 Halo, <b>${name}</b>! Selamat Datang`,
    RULE,
    '🤖 <b>BUILDER BY RAVEN · V3</b>',
    bq([
      '🛠 <b>Developer</b> : RavenZy',
      '📡 <b>Version</b> : 3.0.0',
      '🔮 <b>Status</b> : Online ✅',
    ]),
    '',
    '🍃 <i>Pilih menu di bawah...</i>',
  ].join('\n');
  const photoBuffer = getAssetBuffer('raven-build-success.jpg');
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
  return sendSessionPrompt(ctx, session, panel({ heading: `<b>${escapeHtml(heading)}</b>`, body }));
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

async function loadPendingFlutterSession(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const result = await readJsonRepoFile(PENDING_SESSION_FILE, {});
  const all = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value : {};
  const item = all[String(id)];
  if (!item || Date.now() - Number(item.createdAt || 0) > PENDING_SESSION_TTL) return null;
  if (!['debug', 'release'].includes(String(item.mode))) return null;
  return { type: 'flutter_build', step: 'file', mode: String(item.mode), platform: 'server', transport: 'telegram-mtproto', createdAt: Number(item.createdAt) || Date.now(), persisted: true };
}

async function savePendingFlutterSession(userId, mode) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || !['debug', 'release'].includes(String(mode))) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile(PENDING_SESSION_FILE);
      let all = {};
      if (file?.content) {
        try { all = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (_) { all = {}; }
      }
      if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
      const cutoff = Date.now() - PENDING_SESSION_TTL;
      for (const [key, value] of Object.entries(all)) {
        if (!value || Number(value.createdAt || 0) < cutoff) delete all[key];
      }
      all[String(id)] = { mode: String(mode), createdAt: Date.now() };
      await writeBotRepoFile(PENDING_SESSION_FILE, JSON.stringify(all, null, 2), 'chore: update Raven pending Flutter build session', file?.sha);
      return true;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      console.error('[PENDING SESSION SAVE]', safeError(error));
      return false;
    }
  }
  return false;
}

async function clearPendingFlutterSession(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await getBotRepoFile(PENDING_SESSION_FILE);
      if (!file?.content) return true;
      let all;
      try { all = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (_) { all = {}; }
      if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
      if (!Object.prototype.hasOwnProperty.call(all, String(id))) return true;
      delete all[String(id)];
      await writeBotRepoFile(PENDING_SESSION_FILE, JSON.stringify(all, null, 2), 'chore: clear Raven pending Flutter build session', file.sha);
      return true;
    } catch (error) {
      if (attempt === 0 && error.response?.status === 409) continue;
      console.error('[PENDING SESSION CLEAR]', safeError(error));
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
          memberNo: id === OWNER_ID ? null : (Number.isInteger(Number(value?.memberNo)) ? Number(value.memberNo) : null),
          updatedAt: value?.updatedAt || Date.now(),
        });
      }
    }
  } catch (error) { console.error('[USERS LOAD]', errorMessage(error)); }
}

async function saveUsers() {
  const users = [...userProfiles.values()].sort((a, b) => a.id - b.id).slice(-5000);
  return writeJsonRepoFile('devtools-raven-users.json', users, 'chore: update Builder By Raven users');
}

async function loadControlState() {
  const [banned, quota, settings] = await Promise.all([
    readJsonRepoFile(BANNED_FILE, []),
    readJsonRepoFile(REPO_QUOTA_FILE, {}),
    readJsonRepoFile(SETTINGS_FILE, { maintenance: false }),
  ]);
  bannedUsers.clear();
  for (const id of (Array.isArray(banned.value) ? banned.value : [])) {
    const n = Number(id); if (Number.isInteger(n) && n > 0) bannedUsers.add(n);
  }
  repoQuota.clear();
  if (quota.value && typeof quota.value === 'object') {
    for (const [id, count] of Object.entries(quota.value)) {
      const n = Number(id), c = Number(count);
      if (Number.isInteger(n) && n > 0 && Number.isFinite(c)) repoQuota.set(n, Math.max(0, c));
    }
  }
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
        'chore: record Builder By Raven deployment',
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
        'chore: remove Builder By Raven deployment record',
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
    description: options.description || `Builder By Raven deployment: ${name}`,
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
  const commitSha = await createGitCommit(owner, repo.name, treeSha, parentSha, 'deploy: Builder By Raven website');
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
    { name: 'title', value: 'Builder By Raven deployment' },
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

function isCustomTelegramApiConfigured() {
  return Boolean(ENV.TELEGRAM_API_ROOT);
}

function formatBytes(bytes, digits = 1) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(digits)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function safeTelegramFilename(name) {
  let value = path.basename(String(name || 'raven-flutter-build.zip'))
    .replace(/[\u0000-\u001F\u007F]/g, '_')
    .trim();
  if (!value) value = 'raven-flutter-build.zip';
  if (!/\.zip$/i.test(value)) value += '.zip';
  return value.slice(0, 180);
}

function safeSecretEqual(expected, provided) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(provided ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function callbackSecretHash(secret) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

function isZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'].includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  const ipVersion = require('net').isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }
  if (ipVersion === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
  }
  return false;
}

async function assertSafeRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch (_) {
    throw new Error('URL source tidak valid.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Source URL wajib menggunakan HTTPS.');
  if (isPrivateOrLocalHostname(parsed.hostname)) throw new Error('Host source tidak diizinkan.');
  return parsed;
}

async function downloadHttpsBuffer(rawUrl, label = 'source') {
  const parsed = await assertSafeRemoteUrl(rawUrl);
  const response = await axios.get(parsed.toString(), {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: FLUTTER_REMOTE_SOURCE_LIMIT,
    maxBodyLength: FLUTTER_REMOTE_SOURCE_LIMIT,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Builder-By-Raven/3.0' },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error(`${label} kosong.`);
  if (buffer.length > FLUTTER_REMOTE_SOURCE_LIMIT) throw new Error(`${label} terlalu besar. Maksimal ${formatBytes(FLUTTER_REMOTE_SOURCE_LIMIT)}.`);
  return { buffer, contentType: String(response.headers?.['content-type'] || '') };
}

function parseGitHubRepoUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input).trim());
  } catch (_) {
    return null;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null;
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;

  let ref = null;
  if (parts[2] === 'tree' && parts[3]) ref = parts.slice(3).join('/');
  if (parts[2] === 'archive' && parts.length >= 5 && parts[3] === 'refs' && parts[4] === 'heads') {
    ref = parts.slice(5).join('/') || null;
  }
  return { owner, repo, ref };
}

async function downloadGitHubFlutterRepo(input) {
  const parsed = parseGitHubRepoUrl(input);
  if (!parsed) return null;
  const repoResponse = await axios.get(`${GH_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`, {
    headers: ghHeaders,
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (repoResponse.status >= 400) throw new Error(`Server project tidak dapat diakses (HTTP ${repoResponse.status}).`);
  const defaultBranch = String(repoResponse.data?.default_branch || 'main');
  const ref = parsed.ref || defaultBranch;
  const zipUrl = `${GH_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zipball/${encodeURIComponent(ref)}`;
  const response = await axios.get(zipUrl, {
    headers: ghHeaders,
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: FLUTTER_REMOTE_SOURCE_LIMIT,
    maxBodyLength: FLUTTER_REMOTE_SOURCE_LIMIT,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const buffer = Buffer.from(response.data);
  if (!isZipBuffer(buffer)) throw new Error('Server tidak mengembalikan ZIP project.');
  if (buffer.length > FLUTTER_REMOTE_SOURCE_LIMIT) throw new Error(`ZIP project terlalu besar. Maksimal ${formatBytes(FLUTTER_REMOTE_SOURCE_LIMIT)}.`);
  return {
    buffer,
    label: `Server · ${parsed.owner}/${parsed.repo} · ${ref}`,
    sourceType: 'github',
    sourceName: repoSafeName(parsed.repo),
  };
}

async function downloadFlutterSourceFromText(input) {
  const textValue = String(input || '').trim();
  if (!textValue) throw new Error('URL source kosong.');

  const githubResult = await downloadGitHubFlutterRepo(textValue);
  if (githubResult) return githubResult;

  const { buffer, contentType } = await downloadHttpsBuffer(textValue, 'ZIP source');
  const lowerType = contentType.toLowerCase();
  if (!isZipBuffer(buffer) && !lowerType.includes('zip') && !/\.zip(?:\?|#|$)/i.test(textValue)) {
    throw new Error('URL tidak menunjuk ke file ZIP. Gunakan URL HTTPS langsung ke file .zip.');
  }
  const parsed = new URL(textValue);
  const fallbackName = path.basename(parsed.pathname).replace(/\.zip$/i, '') || 'raven-flutter-build';
  return {
    buffer,
    label: `HTTPS ZIP · ${parsed.hostname}`,
    sourceType: 'https-zip',
    sourceName: repoSafeName(fallbackName),
  };
}

async function downloadTelegramFile(ctx, fileId, declaredSize = 0) {
  const size = Number(declaredSize) || 0;
  if (size > FLUTTER_REMOTE_SOURCE_LIMIT) {
    throw new Error(`TELEGRAM_SOURCE_TOO_BIG: ${formatBytes(size)} melebihi batas build ${formatBytes(FLUTTER_REMOTE_SOURCE_LIMIT)}.`);
  }
  if (size > TELEGRAM_OFFICIAL_DOWNLOAD_LIMIT && !isCustomTelegramApiConfigured()) {
    throw new Error(`FILE_TOO_BIG_TELEGRAM: ${formatBytes(size)} melebihi batas unggah otomatis 20 MB. Kirim URL HTTPS langsung ke ZIP, atau aktifkan Server Upload Besar.`);
  }
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await axios.get(link.href || link, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: size ? FLUTTER_REMOTE_SOURCE_LIMIT : 200 * 1024 * 1024,
    maxBodyLength: size ? FLUTTER_REMOTE_SOURCE_LIMIT : 200 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}

async function extractFlutterZip(buffer) {
  if (!isZipBuffer(buffer)) throw new Error('Source bukan ZIP yang valid.');
  const zip = await JSZip.loadAsync(buffer);
  const raw = [];
  let totalBytes = 0;

  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const clean = normalizeZipPath(entryPath);
    if (!clean) continue;
    if (raw.length >= FLUTTER_MAX_FILES) throw new Error(`Project memiliki terlalu banyak file. Maksimal ${FLUTTER_MAX_FILES} file.`);
    const fileBuffer = await entry.async('nodebuffer');
    totalBytes += fileBuffer.length;
    if (totalBytes > FLUTTER_MAX_UNCOMPRESSED) {
      throw new Error(`Isi ZIP terlalu besar. Maksimal ${formatBytes(FLUTTER_MAX_UNCOMPRESSED)} setelah diekstrak.`);
    }
    raw.push({ path: clean, buffer: fileBuffer });
  }
  if (!raw.length) throw new Error('ZIP kosong.');

  const hasRootPubspec = raw.some((f) => f.path.toLowerCase() === 'pubspec.yaml');
  if (hasRootPubspec) return raw;

  const topFolders = new Set(raw.map((f) => f.path.split('/')[0]));
  if (topFolders.size === 1) {
    const [prefix] = topFolders;
    const flattened = raw
      .map((f) => ({ path: f.path.slice(prefix.length + 1), buffer: f.buffer }))
      .filter((f) => f.path);
    if (flattened.some((f) => f.path.toLowerCase() === 'pubspec.yaml')) return flattened;
  }
  return raw;
}

function sanitizeFlutterBuildFiles(files) {
  const out = [];
  let removedCount = 0;
  let removedBytes = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const clean = normalizeZipPath(file?.path || '');
    if (!clean || !Buffer.isBuffer(file?.buffer)) continue;
    const shouldSkip = clean.split('/').some((part) => FLUTTER_SKIP_DIRS.has(String(part).toLowerCase()));
    if (shouldSkip) {
      removedCount += 1;
      removedBytes += file.buffer.length;
      continue;
    }
    out.push({ path: clean, buffer: file.buffer });
  }
  return { files: out, removedCount, removedBytes };
}

async function startFlutterBuildFromFiles(ctx, session, files, sourceMeta = {}) {
  const id = uid(ctx);
  const sanitized = sanitizeFlutterBuildFiles(files);
  const buildFiles = sanitized.files;
  const pubspec = buildFiles.find((f) => f.path.toLowerCase() === 'pubspec.yaml')
    || buildFiles.find((f) => /(^|\/)pubspec\.yaml$/i.test(f.path));
  if (!pubspec) throw new Error('pubspec.yaml tidak ditemukan. ZIP/URL harus berisi project Flutter.');
  if (!buildFiles.length) throw new Error('Tidak ada file source yang bisa diproses setelah membersihkan cache/generated files.');

  session.files = buildFiles;
  session.name = repoSafeName(sourceMeta.sourceName || session.name || 'raven-flutter-build');
  session.sourceType = sourceMeta.sourceType || session.sourceType || 'telegram';
  session.sourceLabel = sourceMeta.label || session.sourceLabel || 'Telegram ZIP';
  session.cleanedFiles = sanitized.removedCount;
  session.cleanedBytes = sanitized.removedBytes;
  session.step = 'deploying';
  sessions.set(id, session);

  const status = await sendPanel(ctx, panel({
    heading: '💎 <b>RAVEN FLUTTER BUILD</b>',
    box: infoBox([
      ['⚙️ Mode', session.mode.toUpperCase()],
      ['📦 Project', `<code>${escapeHtml(session.name)}</code>`],
      ['📥 Source', escapeHtml(session.sourceLabel)],
      ['🧹 Cleanup', `<b>${sanitized.removedCount}</b> file cache/generated dibuang`],
      ['🛰️ Engine', 'Raven Build Server'],
      ['📝 Activity', 'Source siap dikirim ke build server…'],
    ]),
    footer: 'Build nyata • APK akan dikirim otomatis setelah selesai.',
  }));
  await runGithubActionsBuild(ctx, session, status);
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
    throw new Error('Link harus berupa domain *.vercel.app hasil deploy Builder By Raven.');
  }

  const baseSlug = host.slice(0, -'.vercel.app'.length);

  let project = await tryGetVercelProject(baseSlug);
  if (project) return project;

  project = await findProjectByDeploymentHost(host);
  if (project) return project;

  throw new Error(`Project Vercel untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy Builder By Raven.`);
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
    throw new Error('Link harus berupa domain *.netlify.app hasil deploy Builder By Raven.');
  }

  const baseSlug = host.slice(0, -'.netlify.app'.length);
  let site = await tryGetNetlifySite(baseSlug);
  if (site) return site;

  site = await findNetlifySiteByHost(host);
  if (site) return site;

  throw new Error(`Site Netlify untuk "${host}" tidak ditemukan. Pastikan link sesuai hasil deploy Builder By Raven.`);
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
  throw new Error('Link harus berupa domain *.vercel.app atau *.netlify.app hasil deploy Builder By Raven.');
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
      throw new Error('Project tidak ditemukan (mungkin private, salah nama, atau sudah dihapus).');
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
  if (info.private) throw new Error('Project ini private. Get Source hanya menerima project public.');
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
  return value || 'Builder By Raven';
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
  throw new Error(seen ? 'Build di Server melewati batas waktu.' : 'Server tidak membuat proses build. Silakan coba lagi.');
}

async function downloadGithubArtifact(owner, repo, artifactId) {
  const apiUrl = `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${encodeURIComponent(artifactId)}/zip`;
  const first = await axios.get(apiUrl, { headers: ghHeaders, timeout: 30000, maxRedirects: 0, validateStatus: (status) => status === 302 });
  const location = first.headers?.location;
  if (!location) throw new Error('Server tidak mengembalikan URL unduhan artifact APK.');
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

async function zipBuildFiles(files) {
  const zip = new JSZip();
  for (const file of files) {
    const clean = String(file.path || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) continue;
    zip.file(clean, file.buffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

let buildStoreQueue = Promise.resolve();

function withBuildStoreLock(task) {
  const run = buildStoreQueue.then(task, task);
  buildStoreQueue = run.catch(() => {});
  return run;
}

async function readBuildFile() {
  const file = await getBotRepoFile(BUILD_FILE);
  let records = [];
  if (file?.content) {
    try { records = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (_) { records = []; }
  }
  return { records: Array.isArray(records) ? records : [], sha: file?.sha || null };
}

async function mutateBuildRecords(mutator) {
  return withBuildStoreLock(async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const { records, sha } = await readBuildFile();
        const outcome = mutator(records);
        if (outcome === undefined || outcome === null) return null;
        await writeBotRepoFile(BUILD_FILE, JSON.stringify(records.slice(-300), null, 2), 'chore: update Raven build record', sha);
        return outcome;
      } catch (error) {
        const code = error.response?.status;
        if (code === 409 || code === 422 || code === 502 || code === 503) {
          await sleep(400 + Math.floor(Math.random() * 700) * (attempt + 1));
          continue;
        }
        console.error('[BUILD STORE]', safeError(error));
        return null;
      }
    }
    return null;
  });
}

async function loadBuildRecords() {
  try {
    const { records } = await readBuildFile();
    return records;
  } catch (_) {
    return [];
  }
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

async function runTelegramWorkflowTask(ctx, session, sourceInfo, operation = 'flutter_build') {
  const startedAt = Date.now();
  const userId = uid(ctx);
  const jobId = buildId();
  const secret = crypto.createHmac('sha256', String(ENV.BOT_TOKEN || ENV.GH_TOKEN || 'raven')).update(jobId).digest('hex');
  const callbackUrl = callbackBaseUrl();
  const baseOwner = process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER;
  const baseRepo = process.env.REPO_GITHUB || process.env.GITHUB_REPO;
  const baseBranch = process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || 'main';
  const sourceFilename = safeTelegramFilename(sourceInfo.fileName);
  const sourceSize = Number(sourceInfo.declaredSize || 0);
  const projectName = repoSafeName(
    operation === 'rename_project'
      ? (session.renameAppName || sourceFilename.replace(/\.zip$/i, ''))
      : sourceFilename.replace(/\.zip$/i, '')
  ) || `raven-${operation}`;
  const mode = operation === 'flutter_build' ? (session.mode || 'release') : 'rename';
  if (!baseOwner || !baseRepo) throw new Error('Konfigurasi Server build belum lengkap. Periksa token dan nama project Server pada environment.');
  if (!sourceInfo.chatId || !sourceInfo.messageId) throw new Error('Pesan source Telegram tidak tersedia. Kirim ulang ZIP.');
  if (sourceSize > FLUTTER_MAX_SOURCE_BYTES) throw new Error(`ZIP melebihi batas maksimum ${formatBytes(FLUTTER_MAX_SOURCE_BYTES)}.`);
  const creds = workerCredentials();

  const kind = operation === 'rename_project' ? 'rename-project' : 'flutter-apk';
  const draft = {
    id: jobId, userId, userName: userDisplayName(ctx.from), username: ctx.from?.username || null,
    projectName, mode, sourceFilename, sourceSize, serverLabel: SERVER_LABEL, operation, buildKind: kind,
    status: 'running', stage: 'WORKFLOW_DISPATCHED', progress: 2, createdAt: startedAt,
  };
  const status = await sendPanel(ctx, userBuildPanel(draft), buildRunningButton(jobId));

  const record = {
    id: jobId, userId, username: ctx.from?.username || null, userName: userDisplayName(ctx.from),
    chatId: sourceInfo.chatId, sourceChatId: sourceInfo.chatId, sourceMessageId: sourceInfo.messageId,
    statusMessageId: status.message_id, projectName, mode, buildKind: kind,
    operation, deliveryMethod: 'mtproto', transport: 'telegram-mtproto', serverLabel: SERVER_LABEL,
    status: 'running', stage: 'WORKFLOW_DISPATCHED', progress: 2, createdAt: startedAt, updatedAt: Date.now(),
    callbackSecretHash: callbackSecretHash(secret), callbackUrl, sourceFilename, sourceSize,
    sourceType: 'telegram-direct', sourceLabel: `Telegram Direct · ${sourceSize ? formatBytes(sourceSize) : 'large file'}`,
    sourceRepoOwner: baseOwner, sourceRepoName: baseRepo, sourceBranch: baseBranch,
    sourceStorageOwner: baseOwner, sourceStorageRepo: 'raven-build-storage', sourceReleaseTag: `raven-build-${jobId}`,
    targetChatId: sourceInfo.chatId, targetMessageId: sourceInfo.messageId,
    renameAppName: operation === 'rename_project' ? String(session.renameAppName || '').slice(0, 120) : null,
    renameDomain: operation === 'rename_project' && session.renameDomain ? String(session.renameDomain).slice(0, 253) : null,
  };

  try {
    await Promise.all([
      checkWorkflowActive(baseOwner, baseRepo, baseBranch, 'raven-flutter-telegram-2gb.yml'),
      upsertBuildRecord(record),
    ]);
    const projectNameField = operation === 'rename_project'
      ? `${projectName}|||${record.renameAppName || ''}|||${record.renameDomain || ''}`
      : projectName;
    await Promise.all([
      notifyChannelBuildStart(record),
      dispatchRepositoryEvent(
        { owner: { login: baseOwner }, name: baseRepo, default_branch: baseBranch },
        'raven_flutter_build',
        {
          operation,
          mode,
          job_id: jobId,
          callback_url: callbackUrl,
          source_chat_id: sourceInfo.chatId,
          source_message_id: sourceInfo.messageId,
          source_filename: sourceFilename,
          source_size: sourceSize,
          project_name: projectNameField,
          creds,
        }
      ),
    ]);
    sessions.delete(userId);
    if (operation === 'flutter_build') await clearPendingFlutterSession(userId);
    return record;
  } catch (error) {
    const safe = scrubSensitive(errorMessage(error));
    const failed = { ...record, status: 'failed', stage: 'SUBMIT_FAILED', progress: 0, failedStep: 'Kirim ke server', error: safe, completedAt: Date.now() };
    await Promise.all([
      updateBuildRecord(jobId, { status: 'failed', stage: 'SUBMIT_FAILED', progress: 0, failedStep: 'Kirim ke server', error: safe, completedAt: failed.completedAt }),
      notifyChannelBuildStage(failed, 'SUBMIT_FAILED', 'failed', null, safe),
      editPanel(ctx, status.message_id, userBuildPanel(failed), homeButton()).catch(() => {}),
    ]);
    try { await sendErrorLogFile(ctx.chat.id, failed, 'Kirim ke server', safe); } catch (_) {}
    sessions.delete(userId);
    if (operation === 'flutter_build') await clearPendingFlutterSession(userId);
    return null;
  }
}

async function runTelegramFlutterBuild(ctx, session, sourceInfo) {
  return runTelegramWorkflowTask(ctx, session, sourceInfo, 'flutter_build');
}

async function runTelegramRenameProject(ctx, session, sourceInfo) {
  if (!String(session.renameAppName || '').trim()) throw new Error('Nama aplikasi baru belum diisi.');
  return runTelegramWorkflowTask(ctx, session, sourceInfo, 'rename_project');
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
  const wrappedWeb = isWebBuild ? buildAndroidWrapperFiles(session.files, session.name || 'Builder By Raven') : null;
  const buildFiles = isWebBuild ? wrappedWeb.files : session.files;
  const workflowText = isWebBuild ? androidWorkflowYml() : workflowYml();
  const callbackUrl = callbackBaseUrl();
  let buildRepo = null;
  let release = null;
  let record = null;
  try {
    const baseOwner = process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER;
    const baseRepo = process.env.REPO_GITHUB || process.env.GITHUB_REPO;
    const baseBranch = process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || 'main';
    if (!baseOwner || !baseRepo) throw new Error('Konfigurasi server build belum lengkap.');

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
      originalFilename: session.originalFilename || null,
      sourceSize: session.sourceSizeBytes || sourceZip.length,
      serverLabel: SERVER_LABEL,
      priority: isOwner(ctx) ? 'OWNER' : 'USER',
      operation: isWebBuild ? 'web_to_apk' : 'flutter_build',
      mode: buildMode,
      buildKind: isWebBuild ? 'web-to-apk' : 'flutter-apk',
      status: 'running',
      stage: 'SOURCE_BACKUP_READY',
      progress: 30,
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
      sourceType: session.sourceType || 'telegram',
      sourceLabel: session.sourceLabel || 'Telegram ZIP',
      cleanedFileCount: Number(session.cleanedFiles || 0),
      cleanedBytes: Number(session.cleanedBytes || 0),
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

    record.stage = 'WORKFLOW_DISPATCHED';
    record.progress = 34;
    await editPanel(ctx, statusMessage.message_id, userBuildPanel(record), buildRunningButton(jobId));
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
    await editPanel(ctx, statusMessage.message_id, userBuildPanel({ ...(record || {}), id: record?.id || jobId, userId: id, userName: userDisplayName(ctx.from), originalFilename: session.originalFilename, serverLabel: SERVER_LABEL, mode: buildMode, buildKind: isWebBuild ? 'web-to-apk' : 'flutter-apk', status: 'failed', stage: 'SUBMIT_FAILED', failedStep: 'Kirim ke server', createdAt: startedAt }), homeButton());
    try { await sendErrorLogFile(ctx.chat.id, { id: jobId, originalFilename: session.originalFilename, projectName: session.name, mode: buildMode }, 'Kirim ke server', safe); } catch (_) {}
    sessions.delete(id);
  }
}

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
      await render(10, 'Menyimpan berkas ke Server…');
      await notifyChannelText('📦 DEPLOY SOURCE', ctx, `Project <code>${escapeHtml(repoName)}</code> sedang disiapkan sebelum deployment ${escapeHtml(platformLabel)}.`);
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
    const finishedClock = wibClock();
    await recordDeployment({
      name: repoName,
      platform,
      url,
      ownerId: uid(ctx),
      ownerUsername: ctx.from?.username || null,
      ts: Date.now(),
    });

    await notifyChannelText('✅ DEPLOY BERHASIL', ctx, `Platform: <b>${escapeHtml(platformLabel)}</b>\nProject: <code>${escapeHtml(repoName)}</code>\nURL: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    const whoLabel = ctx.from?.username ? `@${ctx.from.username}` : userDisplayName(ctx.from);
    await editPanel(ctx, statusMessage.message_id, [
      '🎉 <b>WEBSITE BERHASIL DIBUAT!</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      `👤 <b>User</b>: ${escapeHtml(whoLabel)}`,
      `🆔 <b>User ID</b>: <code>${uid(ctx)}</code>`,
      `🌐 <b>Website</b>: <code>${escapeHtml(repoName)}</code>`,
      `🔗 <b>URL</b>: ${escapeHtml(url)}`,
      `🛰️ <b>Platform</b>: ${escapeHtml(platformLabel)}`,
      `⏰ <b>Waktu</b>: ${escapeHtml(finishedClock)}`,
      `⏱ <b>Durasi</b>: ${escapeHtml(elapsed)}`,
      '📊 <b>Status</b>: Berhasil',
    ].join('\n'), Markup.inlineKeyboard([
      [Markup.button.url('🌐 Buka Website', url)],
      [Markup.button.callback('🏠 Menu Utama', 'home')],
    ]));
  } catch (error) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const safe = safeError(error);
    await notifyChannelText('❌ DEPLOY GAGAL', ctx, `Platform: <b>${escapeHtml(platformLabel)}</b>\nProject: <code>${escapeHtml(repoName)}</code>\nError: <code>${escapeHtml(safe)}</code>`);
    const failClock = wibClock();
    await editPanel(ctx, statusMessage.message_id, [
      '❌ <b>WEBSITE GAGAL DIBUAT!</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      '',
      `🌐 <b>Website</b>: <code>${escapeHtml(repoName)}</code>`,
      `🛰️ <b>Platform</b>: ${escapeHtml(platformLabel)}`,
      `⚠️ <b>Penyebab</b>: ${escapeHtml(safe.slice(0, 600))}`,
      `⏰ <b>Waktu</b>: ${escapeHtml(failClock)}`,
      `⏱ <b>Durasi</b>: ${escapeHtml(elapsed)}`,
      '📊 <b>Status</b>: Gagal',
      error.detail ? '\n📄 Log error lengkap dikirim sebagai file TXT.' : '',
    ].filter((l) => l !== '' || false).join('\n'), homeButton());
    if (error.detail) {
      try {
        const content = ['RAVEN DEPLOY ERROR LOG', `Website : ${repoName}`, `Platform: ${platformLabel}`, `Waktu   : ${failClock}`, '========================================', scrubSensitive(String(error.detail)), ''].join('\n');
        await ctx.replyWithDocument({ source: Buffer.from(content, 'utf8'), filename: `raven-deploy-error-${repoName}.txt` }, { caption: '📄 <b>Full Deploy Error Log</b>\n\nGunakan file ini untuk menemukan baris kode yang error secara detail.', parse_mode: 'HTML' });
      } catch (sendError) { console.error('[DEPLOY ERROR LOG]', safeError(sendError)); }
    }
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
        cleanup.push('Server project dibersihkan');
      }
    } catch (cleanupError) { cleanup.push(`Server project gagal dibersihkan: ${errorMessage(cleanupError)}`); }
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
  const caption = [
    '💎 <b>RAVEN LOG CENTER</b>',
    `✨ <b>${escapeHtml(title)}</b>`,
    RULE,
    bq([
      `👤 <b>Username</b> : ${escapeHtml(cleanName(userDisplayName(ctx.from)))}`,
      ctx.from?.username ? `🔗 <b>Tag</b> : @${escapeHtml(ctx.from.username)}` : null,
      `🆔 <b>User ID</b> : <code>${uid(ctx)}</code>`,
      `⏰ <b>Waktu</b> : ${escapeHtml(formatWib())}`,
    ]),
    detail ? bq([detail]) : null,
    '',
    buildHashTags({ id: uid(ctx), username: ctx.from?.username }),
    '<i>Builder By Raven • 2026</i>',
  ].filter((line) => line !== null).join('\n');
  try {
    await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) { console.error('[CHANNEL LOG]', safeError(error)); }
}

async function notifyChannelBuildStart(record) {
  try {
    const caption = buildNotificationCaption(record, {
      title: '🚀 BUILD BARU DIMULAI',
      status: 'running',
      stage: 'WORKFLOW_DISPATCHED',
      progress: 2,
      detail: 'Source diterima. Menunggu worker Server memulai proses.',
    });
    const photoName = 'raven-response.jpg';
    const photoBuffer = getAssetBuffer(photoName);
    let sent = null;
    if (photoBuffer) {
      try {
        sent = await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: photoBuffer }, { caption, parse_mode: 'HTML' });
      } catch (error) { console.error('[CHANNEL BUILD START] sendPhoto failed', safeError(error)); }
    }
    if (!sent) sent = await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
    if (sent?.message_id) {
      record.channelMessageId = sent.message_id;
      record.channelPhotoName = sent.photo ? photoName : null;
      await updateBuildRecord(record.id, { channelMessageId: sent.message_id, channelPhotoName: record.channelPhotoName });
    }
  } catch (error) { console.error('[CHANNEL BUILD START]', safeError(error)); }
}

async function notifyChannelBuildStage(record, stage, status, runId, extra = '') {
  try {
    const s = String(status || '').toLowerCase();
    const currentStage = String(stage || record.stage || 'UNKNOWN');
    const numericProgress = Number(record.progress || 0);
    const progressMap = {
      SUBMIT_FAILED: 0,
      WORKFLOW_DISPATCHED: 2,
      WORKER_STARTING: 6,
      WORKER_READY: 10,
      TELEGRAM_CONNECTING: 12,
      SOURCE_DOWNLOAD_START: 14,
      SOURCE_DOWNLOADED: 24,
      SOURCE_VALIDATED: 30,
      SOURCE_BACKUP_START: 34,
      SOURCE_BACKUP_READY: 38,
      PROJECT_VALIDATED: 46,
      TOOLCHAIN_READY: 54,
      ANDROID_READY: 58,
      DEPENDENCIES_READY: 70,
      ANDROID_SETUP_READY: 40,
      BUILDING_WEB_APK: 70,
      FINAL: 95,
      LOG_SENT: 95,
      BUILDING_APK: 80,
      APK_READY: 91,
      SENDING_APK: 95,
      APK_SENT: 100,
      ARTIFACT_UPLOADED: 91,
      ARTIFACT_DOWNLOAD_FAILED: 95,
      TELEGRAM_TRANSFER_FAILED: 95,
      KILLED_BY_OWNER: 100,
      COMPLETE: 100,
      UNKNOWN: 5,
    };
    let percent = progressMap[currentStage];
    if (currentStage === 'SOURCE_DOWNLOAD_PROGRESS') percent = 14 + Math.round(Math.min(100, numericProgress) * 10 / 100);
    if (currentStage === 'BUILDING_APK') percent = Math.max(78, Math.min(89, numericProgress || 80));
    if (currentStage === 'APK_UPLOAD_PROGRESS' || currentStage === 'OUTPUT_UPLOAD_PROGRESS') percent = 91 + Math.round(Math.min(100, numericProgress) * 8 / 100);
    if (percent == null) percent = s === 'success' ? 100 : s === 'running' ? Math.max(5, numericProgress || 10) : 20;
    percent = Math.max(0, Math.min(100, percent));

    const isRename = record.operation === 'rename_project';
    const beforeMessageId = record.channelMessageId;
    const beforePhoto = record.channelPhotoName || null;
    const title = s === 'success' ? (isRename ? '🏆 RENAME SUKSES TOTAL' : '🏆 BUILD SUKSES TOTAL') :
      (s === 'failure' || s === 'failed') ? (isRename ? '❌ RENAME GAGAL' : '❌ BUILD GAGAL') :
      s === 'cancelled' ? (isRename ? '⏹️ RENAME DIBATALKAN' : '⏹️ BUILD DIBATALKAN') : '⚡ LIVE BUILD MONITORING';
    const finishedAt = (s === 'success' || s === 'failure' || s === 'failed' || s === 'cancelled')
      ? new Date(record.completedAt || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB'
      : null;
    if (runId) record.runId = String(runId);
    record.progress = Math.max(Number(record.progress || 0), percent);

    const caption = buildNotificationCaption(record, {
      title,
      status: s || record.status || 'running',
      stage: currentStage,
      progress: record.progress,
      detail: extra || buildStageLabel(currentStage),
      finishedAt,
    });

    const photoName = s === 'success' ? 'raven-build-success.jpg' : (s === 'cancelled' ? 'raven-goodbye.jpg' : 'raven-response.jpg');
    const photoBuffer = getAssetBuffer(photoName) || getAssetBuffer('raven-response.jpg');
    const photoChanged = photoName !== record.channelPhotoName;
    let edited = false;

    if (record.channelMessageId && photoChanged && photoBuffer) {
      try {
        await bot.telegram.editMessageMedia(NOTIFICATION_CHANNEL, record.channelMessageId, undefined, {
          type: 'photo',
          media: { source: photoBuffer },
          caption,
          parse_mode: 'HTML',
        });
        edited = true;
        record.channelPhotoName = photoName;
      } catch (error) { console.error('[CHANNEL BUILD STAGE] editMessageMedia failed', safeError(error)); }
    }
    if (!edited && record.channelMessageId) {
      try {
        await bot.telegram.editMessageCaption(NOTIFICATION_CHANNEL, record.channelMessageId, undefined, caption, { parse_mode: 'HTML' });
        edited = true;
      } catch (error) { console.error('[CHANNEL BUILD STAGE] editMessageCaption failed', safeError(error)); }
    }
    if (!edited) {
      let sent = null;
      if (photoBuffer) {
        try {
          sent = await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: photoBuffer }, { caption, parse_mode: 'HTML' });
        } catch (error) { console.error('[CHANNEL BUILD STAGE] sendPhoto failed', safeError(error)); }
      }
      if (!sent) sent = await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
      if (sent?.message_id) {
        record.channelMessageId = sent.message_id;
        record.channelPhotoName = sent.photo ? photoName : null;
      }
    }
    if (record.channelMessageId !== beforeMessageId || (record.channelPhotoName || null) !== beforePhoto) {
      await updateBuildRecord(record.id, { channelMessageId: record.channelMessageId, channelPhotoName: record.channelPhotoName || null });
    }
  } catch (error) { console.error('[CHANNEL BUILD STAGE]', safeError(error)); }
}

async function handleBuildCallback(payload) {
  if (!payload || !payload.jobId || payload.secret === undefined) throw new Error('Invalid callback payload.');
  const records = await loadBuildRecords();
  const record = records.find((b) => b.id === payload.jobId);
  if (!record) throw new Error('Build tidak ditemukan.');
  const providedSecret = String(payload.secret ?? '');
  const authenticated = record.callbackSecretHash
    ? safeSecretEqual(record.callbackSecretHash, callbackSecretHash(providedSecret))
    : safeSecretEqual(record.callbackSecret, providedSecret);
  if (!authenticated) throw new Error('Invalid build callback secret.');

  const incoming = String(payload.status || '').toLowerCase();
  const stage = String(payload.stage || 'UNKNOWN');
  const isMtproto = record.deliveryMethod === 'mtproto';
  const terminalSuccess = stage === 'APK_SENT' || stage === 'OUTPUT_SENT';
  const terminalFailure = incoming === 'failure' || incoming === 'failed' || stage === 'TELEGRAM_TRANSFER_FAILED' || stage === 'BUILD_FAILED';
  const terminalCancelled = incoming === 'cancelled' || stage === 'KILLED_BY_OWNER';
  const finalStatuses = ['success', 'failed', 'cancelled'];

  if (String(record.status) === 'cancelled') {
    if (payload.runId) {
      const owner = record.tempRepoOwner || record.sourceRepoOwner || ENV.GH_OWNER;
      const repo = record.tempRepoName || record.sourceRepoName || ENV.GH_REPO;
      cancelRun(owner, repo, payload.runId).catch(() => {});
    }
    return { ok: true, status: 'cancelled', stage: record.stage, ignored: true };
  }
  if (finalStatuses.includes(String(record.status)) && !(terminalFailure && !record.errorLogSentAt && String(record.status) === 'failed')) {
    return { ok: true, status: record.status, stage: record.stage, ignored: true };
  }

  const incomingProgress = Number(payload.progress || payload.percent || 0);
  const previousProgress = Number(record.progress || 0);
  const stageProgress = {
    WORKFLOW_DISPATCHED: 2, WORKER_STARTING: 6, WORKER_READY: 10,
    TELEGRAM_CONNECTING: 12, TELEGRAM_SESSION_READY: 13,
    SOURCE_DOWNLOAD_START: 14, SOURCE_DOWNLOADED: 24, SOURCE_VALIDATED: 30,
    SOURCE_BACKUP_START: 34, SOURCE_BACKUP_READY: 38, PROJECT_VALIDATED: 46,
    TOOLCHAIN_READY: 54, ANDROID_READY: 58, DEPENDENCIES_READY: 70,
    APK_READY: 91, SENDING_APK: 95, APK_SENT: 100, OUTPUT_SENT: 100, LOG_SENT: 95,
    RENAME_PROCESSING: 70, RENAME_READY: 91,
    ANDROID_SETUP_READY: 40, BUILDING_WEB_APK: 70, FINAL: 95,
    KILLED_BY_OWNER: 100, SUBMIT_FAILED: 0,
    TELEGRAM_TRANSFER_FAILED: 95, BUILD_FAILED: 95,
  };
  let computedProgress = stageProgress[stage];
  if (stage === 'BUILDING_APK') computedProgress = Math.max(78, Math.min(89, incomingProgress || 78));
  if (stage === 'SOURCE_DOWNLOAD_PROGRESS') computedProgress = 14 + Math.round(Math.min(100, incomingProgress) * 10 / 100);
  if (stage === 'APK_UPLOAD_PROGRESS' || stage === 'OUTPUT_UPLOAD_PROGRESS') computedProgress = 91 + Math.round(Math.min(100, incomingProgress) * 8 / 100);
  if (computedProgress == null && incomingProgress > 0) computedProgress = incomingProgress;
  record.progress = terminalSuccess ? 100 : Math.max(previousProgress, Math.min(100, Number(computedProgress ?? previousProgress)));
  record.runId = String(payload.runId || record.runId || '');
  record.stage = stage;
  record.updatedAt = Date.now();
  if (payload.operation) record.operation = String(payload.operation).slice(0, 40);
  if (payload.project_name && record.operation !== 'rename_project') record.flutterName = String(payload.project_name).slice(0, 120);
  if (payload.source_filename) record.sourceFilename = safeTelegramFilename(payload.source_filename);
  if (payload.source_size) record.sourceSize = Number(payload.source_size) || record.sourceSize;
  if (payload.apk_size || payload.output_size) record.apkSize = Number(payload.apk_size || payload.output_size) || record.apkSize;
  if (payload.apk_filename || payload.output_filename) record.apkFilename = safeTelegramFilename(payload.apk_filename || payload.output_filename);
  if (payload.output_filename) record.outputFilename = safeTelegramFilename(payload.output_filename);
  if (payload.elapsed_seconds) record.elapsedSeconds = Number(payload.elapsed_seconds) || record.elapsedSeconds;
  if (payload.output_message_id) record.outputMessageId = Number(payload.output_message_id) || record.outputMessageId;
  if (payload.source_release_tag) record.sourceReleaseTag = String(payload.source_release_tag);
  if (payload.source_asset_id) record.sourceAssetId = String(payload.source_asset_id);
  if (payload.source_storage_owner) record.sourceStorageOwner = String(payload.source_storage_owner);
  if (payload.source_storage_repo) record.sourceStorageRepo = String(payload.source_storage_repo);
  if (payload.source_asset_filename) record.sourceAssetFilename = safeTelegramFilename(payload.source_asset_filename);
  if (payload.failed_step) record.failedStep = String(payload.failed_step).slice(0, 80);
  if (payload.log_sent === true || payload.log_sent === 'true') record.logSent = true;
  if (payload.error) record.error = scrubSensitive(String(payload.error).slice(0, 12000));

  if (terminalSuccess) {
    record.status = 'success';
    record.completedAt = Date.now();
    record.apkDeliveredAt = Date.now();
  } else if (terminalCancelled) {
    record.status = 'cancelled';
    record.completedAt = Date.now();
  } else if (terminalFailure) {
    record.status = 'failed';
    record.completedAt = record.completedAt || Date.now();
    record.progress = Math.max(Number(record.progress || 0), 95);
  } else if (!(incoming === 'success' && !isMtproto)) {
    record.status = 'running';
  }

  const progressOnly = ['SOURCE_DOWNLOAD_PROGRESS', 'APK_UPLOAD_PROGRESS', 'OUTPUT_UPLOAD_PROGRESS'].includes(stage) && !terminalSuccess && !terminalFailure && !terminalCancelled;
  if (!progressOnly) await updateBuildRecord(record.id, {
    operation: record.operation || null,
    runId: record.runId,
    stage: record.stage,
    status: record.status,
    progress: record.progress,
    flutterName: record.flutterName || null,
    priority: record.priority || 'USER',
    sourceFilename: record.sourceFilename || null,
    sourceSize: record.sourceSize || null,
    apkSize: record.apkSize || null,
    apkFilename: record.apkFilename || null,
    outputFilename: record.outputFilename || null,
    outputMessageId: record.outputMessageId || null,
    elapsedSeconds: record.elapsedSeconds || null,
    error: record.error || null,
    failedStep: record.failedStep || null,
    logSent: record.logSent || false,
    sourceReleaseTag: record.sourceReleaseTag || null,
    sourceAssetId: record.sourceAssetId || null,
    sourceStorageOwner: record.sourceStorageOwner || null,
    sourceStorageRepo: record.sourceStorageRepo || null,
    sourceAssetFilename: record.sourceAssetFilename || null,
    apkDeliveredAt: record.apkDeliveredAt || null,
    completedAt: record.completedAt || null,
  });

  const skipChannelProgress = ['SOURCE_DOWNLOAD_PROGRESS', 'APK_UPLOAD_PROGRESS', 'OUTPUT_UPLOAD_PROGRESS', 'LOG_SENT'].includes(stage);
  const isFinalNow = ['success', 'failed', 'cancelled'].includes(String(record.status));

  const editUserStatus = async (detail) => {
    if (!record.chatId || !record.statusMessageId) return false;
    if (!isFinalNow && (progressOnly || stage === 'BUILDING_APK')) {
      const last = uiThrottle.get(record.id) || 0;
      if (Date.now() - last < 4000) return false;
      uiThrottle.set(record.id, Date.now());
    }
    try {
      const keyboard = ['success', 'failed', 'cancelled'].includes(String(record.status)) ? homeButton() : buildRunningButton(record.id);
      await bot.telegram.editMessageText(record.chatId, record.statusMessageId, undefined, userBuildPanel(record, detail), { ...REPLY_OPTS, ...(keyboard || {}) });
      return true;
    } catch (error) {
      if (!/not modified/i.test(String(error?.description || error?.message || ''))) console.error('[BUILD USER STATUS]', safeError(error));
      return false;
    }
  };

  const userTask = (async () => {
  if (isMtproto && record.status === 'success') {
    let captionEdited = false;
    if (record.outputMessageId && record.chatId) {
      try {
        await bot.telegram.editMessageCaption(record.chatId, record.outputMessageId, undefined, userBuildPanel(record), { parse_mode: 'HTML', ...(homeButton() || {}) });
        captionEdited = true;
      } catch (error) { console.error('[BUILD CAPTION]', safeError(error)); }
    }
    if (captionEdited && record.statusMessageId) {
      try { await bot.telegram.deleteMessage(record.chatId, record.statusMessageId); } catch (_) { await editUserStatus(); }
    } else {
      await editUserStatus();
    }
  } else if (!(incoming === 'success' && !isMtproto)) {
    await editUserStatus(record.status === 'failed' ? undefined : (stage === 'BUILDING_APK' ? (String(payload.detail || '') || undefined) : undefined));
  }
  })();

  const channelTask = (async () => {
    if (!skipChannelProgress && !(incoming === 'success' && !isMtproto)) {
      await notifyChannelBuildStage(record, stage, record.status, record.runId, record.status === 'failed' ? (record.failedStep || record.stage) : (record.status === 'success' ? 'Selesai' : (payload.detail || buildStageLabel(stage))));
    }
  })();

  await Promise.all([userTask, channelTask]);

  if (isMtproto) {
    if (record.status === 'failed' && !record.errorLogSentAt && record.chatId) {
      if (record.logSent) {
        record.errorLogSentAt = Date.now();
        await updateBuildRecord(record.id, { errorLogSentAt: record.errorLogSentAt });
      } else {
        try {
          await sendErrorLogFile(record.chatId, record, record.failedStep || buildStageLabel(record.stage), record.error || 'Log tidak tersedia.');
          record.errorLogSentAt = Date.now();
          await updateBuildRecord(record.id, { errorLogSentAt: record.errorLogSentAt });
        } catch (error) { console.error('[BUILD ERROR LOG]', safeError(error)); }
      }
    }
    return { ok: true, status: record.status, stage: record.stage };
  }

  const cleanupTempRepo = async () => {
    if (record.tempRepoOwner && record.tempRepoName) {
      try { await deleteBuildRepo(record.tempRepoOwner, record.tempRepoName); } catch (_) {}
    }
  };

  if (incoming === 'success') {
    try {
      const apk = await getArtifact(record.tempRepoOwner, record.tempRepoName, record.runId, record.id);
      record.status = 'success';
      record.stage = 'COMPLETE';
      record.progress = 100;
      record.apkDeliveredAt = Date.now();
      record.completedAt = record.apkDeliveredAt;
      record.apkSize = apk.buffer.length;
      await bot.telegram.sendDocument(record.chatId, { source: apk.buffer, filename: apk.name || `${repoSafeName(record.projectName)}.apk` }, { caption: userBuildPanel(record), parse_mode: 'HTML', ...(homeButton() || {}) });
      await updateBuildRecord(record.id, { status: 'success', stage: 'COMPLETE', progress: 100, apkDeliveredAt: record.apkDeliveredAt, apkSize: record.apkSize, completedAt: record.completedAt });
      if (record.statusMessageId) { try { await bot.telegram.deleteMessage(record.chatId, record.statusMessageId); } catch (_) {} }
      await notifyChannelBuildStage(record, 'COMPLETE', 'success', record.runId, 'Selesai');
    } catch (error) {
      record.status = 'failed';
      record.stage = 'ARTIFACT_DOWNLOAD_FAILED';
      record.failedStep = 'Ambil APK';
      record.error = safeError(error);
      record.completedAt = Date.now();
      await updateBuildRecord(record.id, { status: record.status, stage: record.stage, error: record.error, failedStep: record.failedStep, completedAt: record.completedAt });
      await editUserStatus();
      try { await sendErrorLogFile(record.chatId, record, record.failedStep, record.error); record.errorLogSentAt = Date.now(); } catch (_) {}
      await notifyChannelBuildStage(record, record.stage, record.status, record.runId, record.error);
    }
    await cleanupTempRepo();
    return { ok: true, status: record.status, stage: record.stage };
  }

  if (record.status === 'failed' && !record.errorLogSentAt && record.chatId) {
    const runLog = await fetchRunErrorLog(record);
    const body = runLog || record.error || 'Log tidak tersedia.';
    try {
      await sendErrorLogFile(record.chatId, record, record.failedStep || 'Build APK', body);
      record.errorLogSentAt = Date.now();
      await updateBuildRecord(record.id, { errorLogSentAt: record.errorLogSentAt, failedStep: record.failedStep || 'Build APK' });
    } catch (error) { console.error('[BUILD ERROR LOG]', safeError(error)); }
    await cleanupTempRepo();
  } else if (isFinalNow) {
    await cleanupTempRepo();
  }
  return { ok: true, status: record.status, stage: record.stage };
}

function isBuildErrorLog(record) {
  return ['flutter-apk', 'web-to-apk'].includes(String(record?.buildKind || '')) || record?.operation === 'flutter_build';
}

bot.action(/^build_cancel:(.+)$/, async (ctx) => {
  const id = uid(ctx);
  const buildIdValue = String(ctx.match[1] || '').trim();
  const record = (await loadBuildRecords()).find((b) => b.id === buildIdValue);
  if (!record) return ctx.answerCbQuery('Data build tidak ditemukan.', { show_alert: true }).catch(() => {});
  if (Number(record.userId) !== id && !isOwner(ctx)) return ctx.answerCbQuery('Bukan build kamu.', { show_alert: true }).catch(() => {});
  if (['success', 'failed', 'cancelled'].includes(String(record.status))) {
    return ctx.answerCbQuery(`Build sudah ${String(record.status).toUpperCase()}.`, { show_alert: true }).catch(() => {});
  }
  try {
    const owner = record.tempRepoOwner || record.sourceRepoOwner || ENV.GH_OWNER;
    const repo = record.tempRepoName || record.sourceRepoName || ENV.GH_REPO;
    let runId = record.runId;
    if (!runId) {
      try { runId = await findRunByJobId(owner, repo, record.id); } catch (_) { runId = null; }
    }
    if (runId) {
      try { await cancelRun(owner, repo, runId); } catch (error) {
        const code = error.response?.status;
        if (code !== 409 && code !== 404) throw error;
      }
    }
    const updated = { ...record, runId: runId || record.runId || '', status: 'cancelled', stage: 'KILLED_BY_OWNER', progress: 100, completedAt: Date.now(), updatedAt: Date.now() };
    await updateBuildRecord(record.id, { status: updated.status, stage: updated.stage, progress: updated.progress, completedAt: updated.completedAt, runId: updated.runId });
    await notifyChannelBuildStage(updated, 'KILLED_BY_OWNER', 'cancelled', updated.runId, 'Build dibatalkan dari chat.');
    await ctx.answerCbQuery('Build dibatalkan.').catch(() => {});
    await editPanel(ctx, ctx.callbackQuery.message.message_id, userBuildPanel(updated), homeButton());
  } catch (error) {
    await ctx.answerCbQuery(`Gagal membatalkan: ${safeError(error)}`.slice(0, 190), { show_alert: true }).catch(() => {});
  }
});

bot.start(async (ctx) => {
  rememberUser(ctx);
  await Promise.all([refreshControlStateIfStale(), ensureUsersLoaded()]);
  const id = uid(ctx);
  if (isUserBanned(id)) {
    return sendPanel(ctx, panel({ heading: '<b>AKSES DIBLOKIR ⛔</b>', body: 'Akun ini diblokir oleh owner.' }), ownerContactMarkup());
  }

  const joined = await checkMandatoryChannel(id, true);
  if (!joined) {
    lastJoinState.set(id, false);
    joinReadyForStart.delete(id);
    return sendJoinGate(ctx, true);
  }

  lastJoinState.set(id, true);
  joinReadyForStart.delete(id);

  return sendMainMenu(ctx);
});

bot.action('check_join', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa…');
  const id = uid(ctx);
  if (!await checkMandatoryChannel(id, true)) {
    lastJoinState.set(id, false);
    joinReadyForStart.delete(id);
    return sendJoinGate(ctx, true);
  }
  lastJoinState.set(id, true);
  joinReadyForStart.delete(id);
  return sendMainMenu(ctx);
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await enforceJoinGate(ctx)) return;
  const homeId = uid(ctx);
  sessions.delete(homeId);
  await Promise.all([sendMainMenu(ctx), clearPendingFlutterSession(homeId)]);
});

bot.action('session_cancel', async (ctx) => {
  await ctx.answerCbQuery('Dibatalkan');
  const cancelId = uid(ctx);
  sessions.delete(cancelId);
  await editPanel(ctx, ctx.callbackQuery.message.message_id, panel({ heading: '❌ <b>DIBATALKAN</b>', body: '<i>Proses dibatalkan. Tidak ada yang dikerjakan.</i>' }), homeButton());
  await clearPendingFlutterSession(cancelId);
});

bot.action('tool_ai_image', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'AI Image', '🎨 Kirim prompt gambar.', { type: 'tool_ai_image', step: 'text' }); });
bot.action('tool_logo', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Create Logo', 'Kirim konsep logo.', { type: 'tool_logo', step: 'text' }); });
bot.action('tool_mediafire', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'MediaFire', 'Kirim link MediaFire.', { type: 'tool_mediafire', step: 'text' }); });
bot.action('tool_cekid', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await legacyTools.handleCekId(bot.telegram, ctx.message || { chat: { id: ctx.chat.id }, from: ctx.from }); });
bot.action('tool_request', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Request Owner', 'Kirim pesan untuk owner.', { type: 'tool_request', step: 'text' }); });
bot.action('tool_fixerror', async (ctx) => { await ctx.answerCbQuery(); if (!await requireFeatureAccess(ctx)) return; await sendPrompt(ctx, 'Fix Code Error', '🧯 <b>Kirim kode JavaScript</b> yang ingin diperiksa dan diperbaiki. Maksimum 7000 karakter.', { type: 'tool_fixerror', step: 'text' }); });

bot.action('owner_panel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const builds = await loadBuildRecords();
  await sendPanel(ctx, panel({ heading: '<b>OWNER PANEL 👑</b>', box: infoBox([
    ['Role', 'OWNER'],
    ['Build aktif', String(builds.filter(b => Number(b.userId) !== OWNER_ID && !['success','failed','cancelled'].includes(b.status)).length)],
    ['Total build', String(builds.filter(b => Number(b.userId) !== OWNER_ID).length)],
    ['Maintenance', maintenanceEnabled ? '🔴 ON' : '🟢 OFF'],
  ]), body: 'Pilih menu owner.' }), ownerPanelMarkup());
});

bot.action('owner_maintenance', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  maintenanceEnabled = !maintenanceEnabled;
  await persistMaintenance();
  await sendPanel(ctx, panel({ heading: `<b>MAINTENANCE ${maintenanceEnabled ? 'ON 🛠️' : 'OFF ✅'}</b>`, body: maintenanceEnabled ? 'Fitur user sementara dinonaktifkan.' : 'Fitur user kembali dibuka.' }), ownerPanelMarkup());
});

bot.action('owner_kill_builds', async (ctx) => {
  await ctx.answerCbQuery('Menghentikan build…');
  if (!isOwner(ctx)) return;
  const builds = await loadBuildRecords();
  let count = 0;
  for (const b of builds) {
    if (['success','failed','cancelled'].includes(String(b.status))) continue;
    try {
      const owner = b.deliveryMethod === 'mtproto' ? (b.sourceRepoOwner || ENV.GH_OWNER) : b.tempRepoOwner;
      const repo = b.deliveryMethod === 'mtproto' ? (b.sourceRepoName || ENV.GH_REPO) : b.tempRepoName;
      let killRunId = b.runId;
      if (!killRunId && owner && repo) { try { killRunId = await findRunByJobId(owner, repo, b.id); } catch (_) { killRunId = null; } }
      if (owner && repo && killRunId) { try { await cancelRun(owner, repo, killRunId); } catch (_) {} }
      await updateBuildRecord(b.id, { status: 'cancelled', stage: 'KILLED_BY_OWNER', progress: 100, updatedAt: Date.now() });
      await notifyChannelBuildStage({ ...b, status: 'cancelled', stage: 'KILLED_BY_OWNER', progress: 100 }, 'KILLED_BY_OWNER', 'cancelled', b.runId, 'Dihentikan oleh owner.');
      count += 1;
    } catch (error) { console.error('[KILL BUILD]', safeError(error)); }
  }
  await sendPanel(ctx, panel({ heading: '<b>KILL BUILD SELESAI ⏹️</b>', body: `Sebanyak <b>${count}</b> build aktif ditandai cancelled.` }), ownerPanelMarkup());
});

bot.action(/^owner_get_zip:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Menyiapkan source…');
  if (!isOwner(ctx)) return;
  const buildIdValue = String(ctx.match[1] || '').trim();
  const record = (await loadBuildRecords()).find((b) => b.id === buildIdValue);
  if (!record) return sendPanel(ctx, panel({ heading: '<b>ZIP TIDAK TERSEDIA ❌</b>', body: 'Record build tidak ditemukan.' }), ownerPanelMarkup());

  if (Number(record.userId) === OWNER_ID) return sendPanel(ctx, panel({ heading: '<b>ZIP TIDAK TERSEDIA ❌</b>', body: 'Build owner tidak tersedia di daftar user build.' }), ownerPanelMarkup());

  if (record.deliveryMethod === 'mtproto' && record.sourceReleaseTag && record.sourceStorageRepo) {
    try {
      const owner = record.sourceStorageOwner || ENV.GH_OWNER;
      await dispatchRepositoryEvent(
        { owner: { login: record.sourceRepoOwner || ENV.GH_OWNER }, name: record.sourceRepoName || ENV.GH_REPO, default_branch: record.sourceBranch || ENV.GH_BRANCH || 'main' },
        'raven_source_transfer',
        {
          job_id: `source-transfer-${record.id}`,
          creds: workerCredentials(),
          source_storage_owner: owner,
          source_storage_repo: record.sourceStorageRepo,
          source_release_tag: record.sourceReleaseTag,
          source_filename: record.sourceAssetFilename || record.sourceFilename || `${repoSafeName(record.projectName)}.zip`,
          target_chat_id: ctx.from.id,
          project_name: record.projectName || 'raven-build-source',
        }
      );
      return sendPanel(ctx, panel({ heading: '<b>GET ZIP BUILD 📦</b>', box: infoBox([
        ['📦 Project', `<code>${escapeHtml(record.projectName || record.id)}</code>`],
        ['📏 Size', record.sourceSize ? `<b>${escapeHtml(formatBytes(record.sourceSize))}</b>` : '-'],
        ['📡 Transfer', '⚡ <b>Telegram Large File</b>'],
        ['📝 Status', '🔄 Source sedang dikirim ke chat owner…'],
      ]), footer: '<i>Source dikirim langsung ke chat ini lewat server build.</i>' }), ownerPanelMarkup());
    } catch (error) {
      return sendPanel(ctx, panel({ heading: '<b>GET ZIP GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), ownerPanelMarkup());
    }
  }

  if (!record.sourceAssetId) return sendPanel(ctx, panel({ heading: '<b>ZIP TIDAK TERSEDIA ❌</b>', body: 'Source asset tidak tersedia untuk build ini.' }), ownerPanelMarkup());
  try {
    const buffer = await downloadReleaseAsset(record.sourceAssetId);
    await ctx.replyWithDocument({ source: buffer, filename: record.sourceFilename || `${repoSafeName(record.projectName)}-${record.id}.zip` }, { caption: `📦 <b>GET ZIP BUILD</b>\nProject: <code>${escapeHtml(record.projectName)}</code>\nStatus: <b>${escapeHtml(String(record.status).toUpperCase())}</b>`, parse_mode: 'HTML' });
  } catch (error) {
    await sendPanel(ctx, panel({ heading: '<b>GET ZIP GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), ownerPanelMarkup());
  }
});

bot.action('owner_builds', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return;
  const builds = (await loadBuildRecords()).filter((b) => Number(b.userId) !== OWNER_ID).slice(-60).reverse();
  if (!builds.length) return sendPanel(ctx, panel({ heading: '<b>LIST BUILD</b>', body: '<i>Belum ada build.</i>' }), ownerPanelMarkup());
  const icon = (b) => (b.status === 'success' ? '✅' : b.status === 'cancelled' ? '⏹️' : b.status === 'failed' ? '❌' : '⏳');
  const rows = builds.map((b) => [Markup.button.callback(`${icon(b)} ${String(b.originalFilename || b.sourceFilename || b.projectName || b.id).slice(0, 28)}`, `owner_get_zip:${b.id}`)]);
  rows.push([Markup.button.callback('👑 Owner Panel', 'owner_panel')]);
  const done = builds.filter((b) => b.status === 'success').length;
  const bad = builds.filter((b) => b.status === 'failed').length;
  await sendPanel(ctx, panel({
    heading: '<b>LIST BUILD 📦</b>',
    box: infoBox([['📊 Total', String(builds.length)], ['✅ Sukses', String(done)], ['❌ Gagal', String(bad)]]),
    body: 'Pilih build untuk mengambil source ZIP. Build sukses maupun gagal tetap bisa diambil.',
  }), Markup.inlineKeyboard(rows));
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
    body: 'Pilih platform.',
  }), deploymentMenuMarkup());
});

bot.action('deploy_vercel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY VERCEL</b>',
    body: 'Pilih tipe file.',
  }), fileTypeMarkup('vercel'));
});

bot.action('deploy_netlify', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPanel(ctx, panel({
    heading: '<b>DEPLOY NETLIFY</b>',
    body: 'Pilih tipe file.',
  }), fileTypeMarkup('netlify'));
});

bot.action('vercel_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy HTML — Vercel',
    'Kirim file <code>.html</code>.',
    { type: 'deploy_html', platform: 'vercel', step: 'file' }
  );
});

bot.action('vercel_zip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy ZIP — Vercel',
    'Kirim file <code>.zip</code>.\nWajib ada <code>index.html</code>.',
    { type: 'deploy_zip', platform: 'vercel', step: 'file' }
  );
});

bot.action('netlify_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy HTML — Netlify',
    'Kirim file <code>.html</code>.',
    { type: 'deploy_html', platform: 'netlify', step: 'file' }
  );
});

bot.action('netlify_zip', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Deploy ZIP — Netlify',
    'Kirim file <code>.zip</code>.\nWajib ada <code>index.html</code>.',
    { type: 'deploy_zip', platform: 'netlify', step: 'file' }
  );
});

bot.action('rename_project', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(ctx, 'Rename Project', '✏️ <b>Kirim nama aplikasi baru terlebih dahulu.</b>\n\nSetelah itu bot meminta domain baru (opsional), lalu ZIP project dikirim langsung ke Server.', { type: 'rename_project', step: 'rename_name' });
});

bot.action('get_source', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Get Source',
    'Kirim URL website atau link project.',
    { type: 'source', step: 'url' }
  );
});

bot.action('encrypt_html', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Encrypt HTML / JS',
    'Kirim file <code>.html</code> atau <code>.js</code>.\n🔐 XOR + Obfuscation + Base64.',
    { type: 'encrypt', step: 'file' }
  );
});

bot.action('system', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa koneksi…');
  if (!await requireFeatureAccess(ctx)) return;
  const status = await sendPanel(ctx, panel({ heading: '<b>SYSTEM CHECK</b>', body: '⏳ Cek koneksi…' }));
  const rows = [];
  try { await checkGitHub(); rows.push(['🛰️ Server API', '🟢 <b>Terhubung</b>']); } catch (e) { rows.push(['🛰️ Server API', `🔴 <code>${escapeHtml(errorMessage(e))}</code>`]); }
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
    'Kirim pesan broadcast.',
    { type: 'broadcast', step: 'text' }
  );
});

bot.action('media_menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  return sendPanel(ctx, panel({
    heading: '<b>MEDIA KE URL</b>',
    body: 'Pilih jenis media.',
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
      caption: '💝 <b>Donasi Builder By Raven</b>\n\nScan QRIS pada gambar di atas.',
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
    'Kirim gambar.\nFormat: PNG, JPG, GIF, WEBP, SVG, ICO.',
    { type: 'photo_url', step: 'file' }
  );
});

bot.action('audio_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Audio ke URL',
    'Kirim file audio.\nFormat: MP3, WAV, OGG, M4A, AAC, FLAC.',
    { type: 'audio_url', step: 'file' }
  );
});

bot.action('video_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Video ke URL',
    'Kirim file video.\nFormat: MP4, WEBM, MOV, MKV, OGV.',
    { type: 'video_url', step: 'file' }
  );
});

bot.action('screenshot_url', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Screenshot URL',
    'Kirim URL website untuk screenshot.',
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
    'Kirim link project publik.\nBatas gabungan: 2x/user.',
    { type: 'repo_zip', step: 'link' }
  );
});

bot.action('search_repo', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPrompt(
    ctx,
    'Cari Repo',
    'Kirim kata kunci project.\nBatas gabungan: 2x/user. Setelah habis, hubungi owner (5k).',
    { type: 'search_repo', step: 'query' }
  );
});

bot.action('flutter_build', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  await sendPanel(ctx, [
    '🔨 <b>Pilih Mode Build APK</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '🐞 <b>Debug Build</b>',
    '• Build lebih cepat',
    '• Cocok untuk testing',
    '• APK ukuran lebih besar',
    '',
    '🚀 <b>Release Build</b>',
    '• Optimized & production-ready',
    '• APK ukuran lebih kecil',
    '• Cocok untuk Play Store',
  ].join('\n'), Markup.inlineKeyboard([
    [Markup.button.callback('🐞 Debug', 'flutter_mode:debug'), Markup.button.callback('🚀 Release', 'flutter_mode:release')],
    [Markup.button.callback('🏠 Menu Utama', 'home')],
  ]));
});

bot.action(/^flutter_mode:(debug|release)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  const id = uid(ctx);
  const mode = String(ctx.match[1]);
  const oldMessageId = ctx.callbackQuery?.message?.message_id;
  const session = { type: 'flutter_build', step: 'file', mode, platform: 'server', transport: 'telegram-mtproto', createdAt: Date.now() };
  sessions.set(id, session);
  const sendTask = ctx.reply([
    '🔨 <b>SIAP BUILD FLUTTER APK!</b>',
    RULE,
    bq([
      `📦 <b>Mode</b> : ${escapeHtml(modeLabel(mode))}`,
      `🖥️ <b>Server</b> : <code>${escapeHtml(SERVER_LABEL)}</code>`,
      '✅ <b>Format</b> : <code>.zip</code>',
      '✅ <b>Wajib</b> : <code>pubspec.yaml</code>',
      '✅ <b>Maks</b> : 2 GB',
    ]),
    '',
    '<i>Kirim file ZIP project Flutter kamu sekarang!</i>',
  ].join('\n'), { ...REPLY_OPTS, ...cancelButton() });
  const [message] = await Promise.all([
    sendTask,
    oldMessageId ? safeDeleteMessage(ctx, ctx.chat.id, oldMessageId) : null,
    savePendingFlutterSession(id, mode),
  ]);
  session.controlMessageId = message.message_id;
  sessions.set(id, session);
});

bot.action('web_to_apk', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx)) return;
  const session = { type: 'web_to_apk', step: 'file' };
  await sendSessionPrompt(ctx, session, [
    '🌐 <b>SIAP BUILD WEB KE APK!</b>',
    RULE,
    bq([
      '📦 <b>Mode</b> : 🐞 DEBUG',
      `🖥️ <b>Server</b> : <code>${escapeHtml(SERVER_LABEL)}</code>`,
      '✅ <b>Format</b> : <code>.zip</code> / <code>.html</code>',
      '✅ <b>Wajib</b> : <code>index.html</code>',
    ]),
    '',
    '<i>Kirim file ZIP atau HTML web kamu sekarang!</i>',
  ].join('\n'));
});

bot.action('build_queue', async (ctx) => {
  await ctx.answerCbQuery('Memuat queue…');
  if (!await requireFeatureAccess(ctx)) return;
  const builds = (await loadBuildRecords()).filter((b) => Number(b.userId) === uid(ctx)).slice(-15).reverse();
  if (!builds.length) return sendPanel(ctx, panel({ heading: '<b>ANTRIAN BUILD</b>', body: '<i>Belum ada build kamu.</i>' }), homeButton());
  const body = builds.map((b, i) => `${i + 1}. <b>${escapeHtml(b.projectName || b.id)}</b> · <code>${escapeHtml(String(b.status || '').toUpperCase())}</code> · <code>${escapeHtml(b.stage || '-')}</code>`).join('\n');
  await sendPanel(ctx, panel({ heading: '<b>ANTRIAN / RIWAYAT BUILD</b>', body, footer: 'Status diperbarui otomatis dari Server.' }), homeButton());
});

bot.action('generate_bot', async (ctx) => {
  await ctx.answerCbQuery();
  if (!await requireFeatureAccess(ctx, { owner: true })) return;
  await sendPrompt(
    ctx,
    'Generate Bot',
    'Kirim ZIP project bot Node.js.\nWajib ada <code>package.json</code>.',
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
  await sendPrompt(ctx, 'Generate Bot', '🚀 <b>Langkah Terakhir — Nama Bot</b>\n\nKirim nama project untuk bot ini (huruf, angka, dan tanda "-" saja, tanpa spasi).\nContoh: <code>bot-kedua-saya</code>', session);
});

bot.action('help_info', async (ctx) => {
  await ctx.answerCbQuery();
  await sendPanel(ctx, panel({
    heading: '<b>ℹ️ TENTANG BOT INI</b>',
    body:
      '<b>Builder By Raven V3</b> menyediakan utilitas deployment, pengelolaan project, media, source, dan otomasi bot dengan API resmi.\n\n<b>Ringkasan fitur:</b>\n' +
      '🚀 Deploy Vercel/Netlify — upload HTML/ZIP, langsung online\n' +
      '⚙️ Tambah .env — isi environment variable sebelum deploy (Vercel ZIP)\n' +
      '💥 Build Flutter APK — debug/release build project Flutter ZIP via Server\n' +
      '📱 Web ke APK — build APK Android WebView dari HTML/ZIP menggunakan Server\n' +
      '🌐 Get Source — project diambil sebagai ZIP asli; website publik hanya mengambil byte source/assets yang benar-benar tersedia\n' +
      '🛡️ Encrypt HTML/JS — hanya .html/.js; pipeline XOR + obfuscation + Base64\n' +
      '🖼️🎵🎬 Foto/Audio/Video ke URL — upload file asli, dapat link langsung\n' +
      '📸 Screenshot URL — ambil gambar tampilan website manapun\n' +
      '📦 Get Repo ZIP — ambil ZIP repo public\n' +
      '🔎 Cari Repo — gabungan Get Repo/Cari Repo dibatasi 2 penggunaan per user, setelah itu akses tambahan 5k via owner\n' +
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
    '🗑️ <b>Kirim Link Website</b>\n\nKirim link website hasil deploy Builder By Raven yang ingin dihapus.\nContoh: <code>https://nama-web.vercel.app</code> atau <code>https://nama-web.netlify.app</code>\n\nBot otomatis mengenali platform dari link dan menghapus website beserta server project yang cocok bila ditemukan.',
    { type: 'delete', step: 'link' }
  );
});

bot.on('text', async (ctx) => {
  const id = uid(ctx);
  const session = sessions.get(id);
  if (!session) return;
  if (maintenanceEnabled && !isOwner(ctx)) { sessions.delete(id); await sendPanel(ctx, panel({ heading: '<b>MAINTENANCE 🛠️</b>', body: 'Fitur user sedang ditutup sementara oleh owner.' }), ownerContactMarkup()); return; }
  const text = ctx.message.text.trim();

  if ((session.type === 'flutter_build' || session.type === 'web_to_apk') && session.step === 'file') return;

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
    try {
      const fixed = await legacyTools.handleFixError({
        sendMessage: (chatId, textValue, opts) => ctx.telegram.sendMessage(chatId, textValue, opts),
        deleteMessage: (chatId, msgId) => ctx.telegram.deleteMessage(chatId, msgId),
        editMessageText: (textValue, options) => ctx.telegram.editMessageText(options.chat_id, options.message_id, undefined, textValue, options),
        sendDocument: (chatId, source, opts) => ctx.telegram.sendDocument(chatId, source, opts),
        getFile: (fileId) => ctx.telegram.getFile(fileId),
      }, {
        ...ctx.message,
        text: '',
        reply_to_message: { text },
      });
      await notifyChannelText(fixed ? '🧯 FIX CODE SELESAI' : '🧯 FIX CODE GAGAL', ctx, fixed ? 'Kode user berhasil diproses melalui tool fix-error.' : 'Tool fix-error mengembalikan status gagal.');
    } catch (error) {
      await notifyChannelText('🧯 FIX CODE GAGAL', ctx, `<code>${escapeHtml(safeError(error))}</code>`);
      await sendPanel(ctx, panel({ heading: '<b>FIX CODE GAGAL ❌</b>', body: `<code>${escapeHtml(safeError(error))}</code>` }), homeButton());
    }
    return;
  }

  if (session.type === 'rename_project' && session.step === 'rename_name') {
    const appName = text.slice(0, 80).trim();
    if (!appName) return sendPrompt(ctx, 'Rename Project', '❌ Nama aplikasi tidak boleh kosong.', session);
    session.renameAppName = appName;
    session.step = 'rename_domain';
    await sendPrompt(ctx, 'Rename Project', '🌐 <b>Domain baru</b> (opsional).\nKetik domain baru, misalnya <code>example.com</code>, atau <code>-</code> untuk melewati.', session);
    return;
  }

  if (session.type === 'rename_project' && session.step === 'rename_domain') {
    session.renameDomain = text === '-' ? null : text;
    session.step = 'file';
    await sendPrompt(ctx, 'Rename Project', '📦 <b>Terakhir: kirim ZIP project langsung ke chat.</b>\n\nBot akan memproses ZIP di worker Server, jadi file besar tidak dikirim lewat request Vercel.', session);
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
      await ctx.replyWithDocument({ source: result.buffer, filename: result.originalRepository ? `${repoSafeName(result.fullName)}-source.zip` : 'source-public.zip' }, { caption: result.originalRepository ? '✅ Project asli berhasil diambil sebagai ZIP.' : '✅ Source publik asli yang tersedia berhasil dibundel menjadi ZIP.' });
      const noteLines = [];
      if (result.originalRepository) {
        noteLines.push(`✅ Project asli diambil lewat endpoint resmi.
🌿 Branch: <code>${escapeHtml(result.branch)}</code>`);
      } else if (result.isSpaLikely) {
        noteLines.push('⚠️ Website ini kemungkinan React/Vue/Next.js (SPA) — ZIP berisi byte source/assets publik yang benar-benar dapat diambil, bukan source project yang direka-reka.');
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
      const quotaBody = quota.error ? 'Penyimpanan quota sedang gagal. Coba lagi nanti.' : 'Batas 2 kali untuk gabungan Cari Repo + Get Repo sudah habis. Hubungi owner untuk membeli akses tambahan <b>5k</b>.';
      await sendPanel(ctx, panel({ heading: quota.error ? '<b>QUOTA TIDAK TERSEDIA ⚠️</b>' : '<b>QUOTA REPO HABIS 🔒</b>', body: quotaBody }), ownerContactMarkup());
      return;
    }
    const status = await sendPanel(ctx, panel({ heading: '<b>GET REPO ZIP</b>', body: `⏳ Memeriksa project…\nQuota: ${quota.count}/${quota.limit}` }));
    try {
      const { owner, repo } = parseGithubRepoUrl(text);
      const info = await getPublicRepoInfo(owner, repo);
      if (info.private) throw new Error('Project ini private, tidak bisa diambil ZIP-nya lewat fitur ini.');
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET REPO ZIP</b>',
        body: `📦 <code>${escapeHtml(info.full_name)}</code>\n🌿 Branch: <code>${escapeHtml(info.default_branch)}</code>\n\n⏳ Mengunduh ZIP…`,
      }));
      const zipBuffer = await downloadRepoZip(owner, repo, info.default_branch);
      await ctx.replyWithDocument({ source: zipBuffer, filename: `${info.name}-${info.default_branch}.zip` }, { caption: `✅ Source ZIP dari ${info.full_name}` });
      await editPanel(ctx, status.message_id, panel({
        heading: '<b>GET REPO ZIP SELESAI ✅</b>',
        box: infoBox([
          ['📦 Project', escapeHtml(info.full_name)],
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
      const quotaBody = quota.error ? 'Penyimpanan quota sedang gagal. Coba lagi nanti.' : 'Batas 2 kali untuk gabungan Cari Repo + Get Repo sudah habis. Hubungi owner untuk membeli akses tambahan <b>5k</b>.';
      await sendPanel(ctx, panel({ heading: quota.error ? '<b>QUOTA TIDAK TERSEDIA ⚠️</b>' : '<b>QUOTA REPO HABIS 🔒</b>', body: quotaBody }), ownerContactMarkup());
      return;
    }
    const status = await sendPanel(ctx, panel({ heading: '<b>CARI REPO</b>', body: `⏳ Mencari…\nQuota: ${quota.count}/${quota.limit}` }));
    try {
      const items = await searchGithubRepos(text, 5);
      if (!items.length) {
        await editPanel(ctx, status.message_id, panel({ heading: '<b>CARI REPO</b>', body: '<i>Tidak ada hasil ditemukan.</i>' }), homeButton());
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

      let repoStatus = '⚠️ Project tidak ditemukan otomatis';
      try {
        const repo = await findGithubRepoByProjectName(target.name);
        if (repo) {
          await editPanel(ctx, status.message_id, panel({
            heading: '<b>DELETE WEB</b>',
            body: `🛰️ Platform: <b>${escapeHtml(platformLabel)}</b>\n🌐 Project: <code>${escapeHtml(target.name)}</code>\n✅ Website ${escapeHtml(platformLabel)} dihapus.\n\n⏳ Menghapus project…`,
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
          ['📁 Project', escapeHtml(repoStatus)],
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
  let session = sessions.get(id);
  if (!session) {
    const persistedFlutter = await loadPendingFlutterSession(id);
    if (persistedFlutter) {
      session = persistedFlutter;
      sessions.set(id, session);
    }
  }
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
    const declaredSize = Number(document.file_size || 0);
    if (declaredSize > FLUTTER_MAX_SOURCE_BYTES) {
      await sendPrompt(ctx, 'Rename Project', `❌ <b>ZIP terlalu besar.</b>\n\nMaksimum: <code>${escapeHtml(formatBytes(FLUTTER_MAX_SOURCE_BYTES))}</code>.`, session);
      return;
    }
    try {
      await runTelegramRenameProject(ctx, session, {
        chatId: ctx.chat.id,
        messageId: ctx.message?.message_id,
        fileName: safeTelegramFilename(fileName),
        declaredSize,
      });
    } catch (error) {
      await sendPrompt(ctx, 'Rename Project', `❌ <b>Project tidak bisa diproses.</b>\n\n<code>${escapeHtml(safeError(error))}</code>`, session);
    }
    return;
  }

  if (session.type === 'flutter_build' && session.step === 'file') {
    if (!/\.zip$/i.test(fileName)) {
      await sendPrompt(ctx, 'Build Flutter APK', '❌ <b>Format salah.</b>\n\nKirim file <code>.zip</code> project Flutter.', session);
      return;
    }
    const declaredSize = Number(document.file_size || 0);
    if (declaredSize > FLUTTER_MAX_SOURCE_BYTES) {
      await sendPrompt(ctx, 'Build Flutter APK', `❌ <b>ZIP terlalu besar.</b>\n\nUkuran: <code>${escapeHtml(formatBytes(declaredSize))}</code>\nMaksimum: <b>${escapeHtml(formatBytes(FLUTTER_MAX_SOURCE_BYTES))}</b>.`, session);
      return;
    }
    try {
      await runTelegramFlutterBuild(ctx, session, { chatId: ctx.chat.id, messageId: ctx.message?.message_id, fileName: safeTelegramFilename(fileName), declaredSize });
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
      session.originalFilename = fileName;
      session.sourceSizeBytes = Number(document.file_size || buffer.length || 0);
      const status = await sendPanel(ctx, userBuildPanel({
        id: 'pending', userId: id, userName: userDisplayName(ctx.from), originalFilename: fileName,
        sourceSize: session.sourceSizeBytes, mode: 'debug', serverLabel: SERVER_LABEL,
        buildKind: 'web-to-apk', status: 'running', stage: 'SOURCE_DOWNLOADED', progress: 5, createdAt: Date.now(),
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
  if (!chat || String(chat.username || '').toLowerCase() !== MANDATORY_CHANNEL.replace(/^@/, '').toLowerCase()) return;

  const target = update.new_chat_member?.user || update.old_chat_member?.user;
  const targetId = Number(target?.id || 0);
  if (!targetId) return;

  const newStatus = update.new_chat_member?.status;
  const oldStatus = update.old_chat_member?.status;
  const active = memberStatusAllowed(newStatus) && !(newStatus === 'restricted' && update.new_chat_member?.is_member === false);
  const was = memberStatusAllowed(oldStatus) && !(oldStatus === 'restricted' && update.old_chat_member?.is_member === false);
  if (active === was) return;

  invalidateJoin(targetId);
  lastJoinState.set(targetId, active);
  if (active) joinReadyForStart.add(targetId);
  else joinReadyForStart.delete(targetId);

  const previous = userProfiles.get(targetId);
  const memberNo = Number.isInteger(Number(previous?.memberNo)) ? Number(previous.memberNo) : getNextMemberNumber();
  userProfiles.set(targetId, {
    ...(previous || {}),
    id: targetId,
    name: userDisplayName(target),
    username: target?.username || null,
    memberNo,
    updatedAt: Date.now(),
  });
  if (!userPersistTimer) {
    userPersistTimer = setTimeout(() => { userPersistTimer = null; saveUsers().catch(() => {}); }, 750);
  }

  const realNo = Number(userProfiles.get(targetId)?.memberNo || memberNo);
  const username = target?.username ? `@${target.username}` : `User${targetId}`;
  const isJoin = active;

  const caption = [
    '💎 <b>RAVEN MEMBER CENTER</b>',
    `<b>${isJoin ? '🎉 USER BARU BERGABUNG' : '👋 USER KELUAR CHANNEL'}</b>`,
    RULE,
    bq([
      `👤 <b>Nama</b> : ${escapeHtml(cleanName(userDisplayName(target)))}`,
      `🆔 <b>ID</b> : <code>${escapeHtml(targetId)}</code>`,
      `🔗 <b>Username</b> : <code>${escapeHtml(username)}</code>`,
      `🏅 <b>Member</b> : #${realNo}`,
      `📌 <b>Status</b> : ${isJoin ? '🟢 JOIN' : '🔴 LEAVE'}`,
      `⏰ <b>Waktu</b> : ${escapeHtml(formatWib())}`,
    ]),
    '',
    isJoin ? '💬 <i>Selamat datang. Semoga nyaman menggunakan layanan Builder By Raven.</i>' : '💬 <i>Terima kasih sudah mampir. Sampai jumpa kembali.</i>',
    '<i>Builder By Raven • 2026</i>',
  ].join('\n');

  const photoBuffer = getAssetBuffer(isJoin ? 'raven-welcome.jpg' : 'raven-goodbye.jpg');

  try {
    if (photoBuffer) {
      try {
        await bot.telegram.sendPhoto(NOTIFICATION_CHANNEL, { source: photoBuffer }, { caption, parse_mode: 'HTML' });
        return;
      } catch (error) { console.error('[CHANNEL MEMBER LOG] sendPhoto failed', safeError(error)); }
    }
    await bot.telegram.sendMessage(NOTIFICATION_CHANNEL, caption, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    console.error('[CHANNEL MEMBER LOG]', safeError(error));
  }
});

(async () => {
  await loadUsers();
  await loadControlState();
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
      const info = await bot.telegram.getWebhookInfo().catch(() => null);
      const allowed = ['message', 'callback_query', 'chat_member', 'my_chat_member'];
      const sameAllowed = Array.isArray(info?.allowed_updates) && allowed.every((u) => info.allowed_updates.includes(u));
      if (!info || info.url !== webhookUrl || !sameAllowed) {
        await bot.telegram.setWebhook(webhookUrl, { allowed_updates: allowed });
      }
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
  return res.status(200).send('Builder By Raven Bot Online');
};

module.exports = webhookHandler;
module.exports.handleBuildCallback = handleBuildCallback;
