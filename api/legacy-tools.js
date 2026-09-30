'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pickImage(data) {
  const values = [data?.result?.url, data?.result?.image, data?.result?.imageUrl, data?.url, data?.image, data?.imageUrl, data?.data?.url, data?.data?.image];
  return values.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) || null;
}

async function handleAIImage(bot, msg, config = {}) {
  const chatId = msg.chat.id;
  const prompt = String(msg.text || '').replace(/^\/aiimage(?:@\w+)?/i, '').trim();
  if (!prompt) return bot.sendMessage(chatId, '<b>AI IMAGE GENERATOR</b>\n\nKirim prompt gambar.', { parse_mode: 'HTML' });
  const status = await bot.sendMessage(chatId, '🎨 Membuat gambar…', { parse_mode: 'HTML' });
  try {
    const endpoint = process.env.AI_IMAGE_API_URL || 'http://api.ikyyxd.my.id/ai/text2img';
    const apiKey = process.env.AI_IMAGE_API_KEY || '';
    const response = await axios.get(endpoint, { params: { prompt, key: apiKey, apiKey, apikey: apiKey }, responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
    if (response.status >= 400) throw new Error(`AI_IMAGE_HTTP_${response.status}`);
    const contentType = String(response.headers?.['content-type'] || '');
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    if (contentType.startsWith('image/')) return bot.sendPhoto(chatId, Buffer.from(response.data), { caption: '✅ AI IMAGE SELESAI', parse_mode: 'HTML' });
    let data; try { data = JSON.parse(Buffer.from(response.data).toString('utf8')); } catch (_) { data = { url: Buffer.from(response.data).toString('utf8').trim() }; }
    const imageUrl = pickImage(data);
    if (!imageUrl) throw new Error('AI_IMAGE_EMPTY_RESULT');
    return bot.sendPhoto(chatId, imageUrl, { caption: `✅ AI IMAGE SELESAI\n\n<code>${escapeHtml(prompt.slice(0, 700))}</code>`, parse_mode: 'HTML' });
  } catch (error) {
    await bot.editMessageText(`❌ AI IMAGE GAGAL\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleLogo(bot, msg) {
  const chatId = msg.chat.id;
  const prompt = String(msg.text || '').replace(/^\/createlogo(?:@\w+)?/i, '').trim();
  if (!prompt) return bot.sendMessage(chatId, '<b>CREATE LOGO AI</b>\n\nKirim konsep logo.', { parse_mode: 'HTML' });
  const status = await bot.sendMessage(chatId, '🎨 Membuat logo…', { parse_mode: 'HTML' });
  try {
    const endpoints = [process.env.LOGO_API_URL, process.env.AI_IMAGE_API_URL, 'http://api.ikyyxd.my.id/ai/text2img'].filter(Boolean);
    const apiKey = process.env.LOGO_API_KEY || process.env.AI_IMAGE_API_KEY || '';
    let imageUrl = null;
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const r = await axios.get(endpoint, { params: { prompt: `logo ${prompt}`, text: prompt, key: apiKey, apikey: apiKey, apiKey }, responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
        if (r.status >= 400) throw new Error(`LOGO_HTTP_${r.status}`);
        const ct = String(r.headers?.['content-type'] || '');
        if (ct.startsWith('image/')) {
          await bot.deleteMessage(chatId, status.message_id).catch(() => {});
          return bot.sendPhoto(chatId, Buffer.from(r.data), { caption: '✅ CREATE LOGO AI SELESAI', parse_mode: 'HTML' });
        }
        let data; try { data = JSON.parse(Buffer.from(r.data).toString('utf8')); } catch (_) { data = { url: Buffer.from(r.data).toString('utf8').trim() }; }
        imageUrl = pickImage(data);
        if (imageUrl) break;
      } catch (e) { lastError = e; }
    }
    if (!imageUrl) throw lastError || new Error('LOGO_EMPTY_RESULT');
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    return bot.sendPhoto(chatId, imageUrl, { caption: `✅ CREATE LOGO AI SELESAI\n\n<code>${escapeHtml(prompt.slice(0, 800))}</code>`, parse_mode: 'HTML' });
  } catch (error) {
    await bot.editMessageText(`❌ CREATE LOGO GAGAL\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleFixError(bot, msg) {
  const chatId = msg.chat.id;
  const reply = msg.reply_to_message;
  if (!reply) return bot.sendMessage(chatId, '<b>FIX CODE ERROR</b>\n\nReply ke kode JavaScript.', { parse_mode: 'HTML' });
  let code = reply.text || '';
  let fileExt = 'js';
  if (!code && reply.document?.file_id) {
    const file = await bot.getFile(reply.document.file_id);
    const response = await axios.get(`https://api.telegram.org/file/bot${process.env.TOKEN_BOT || process.env.BOT_TOKEN}/${file.file_path}`, { responseType: 'text', timeout: 30000 });
    code = String(response.data || '');
    fileExt = (reply.document.file_name?.split('.').pop() || 'js').replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'js';
  }
  if (!code.trim()) return bot.sendMessage(chatId, '❌ Kode kosong.');
  if (code.length > 5000) return bot.sendMessage(chatId, '❌ Maksimum 5000 karakter.');
  const status = await bot.sendMessage(chatId, '🧯 Memperbaiki kode…', { parse_mode: 'HTML' });
  try {
    const response = await axios.get('https://api.ikyyxd.my.id/tools/fixerror', { params: { code: `apa yang salah pada kode berikut?\n${code}\ntolong perbaiki tanpa ada penjelasan`, lang: 'javascript' }, timeout: 25000, validateStatus: () => true });
    if (response.status >= 400 || !response.data?.result?.fixed) throw new Error('FIXERROR_API_EMPTY_RESULT');
    const fixed = String(response.data.result.fixed);
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    if (fixed.length < 3500) return bot.sendMessage(chatId, `<b>✅ FIX SELESAI</b>\n<pre>${escapeHtml(fixed)}</pre>`, { parse_mode: 'HTML' });
    const out = path.join('/tmp', `fixed_${Date.now()}.${fileExt}`);
    fs.writeFileSync(out, fixed);
    try { return await bot.sendDocument(chatId, out, { caption: '✅ FIX CODE ERROR SELESAI' }); } finally { try { fs.unlinkSync(out); } catch (_) {} }
  } catch (error) {
    await bot.editMessageText(`❌ FIX GAGAL\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleMediaFire(bot, msg) {
  const chatId = msg.chat.id;
  const url = String(msg.text || '').replace(/^\/mediafire(?:@\w+)?/i, '').trim();
  if (!/^https?:\/\/(?:www\.)?mediafire\.com\//i.test(url)) return bot.sendMessage(chatId, '<b>MEDIAFIRE</b>\n\nKirim link MediaFire valid.', { parse_mode: 'HTML' });
  const status = await bot.sendMessage(chatId, '📦 Membaca link MediaFire…');
  try {
    const response = await axios.get(url, { timeout: 30000, headers: { 'user-agent': 'Mozilla/5.0 RavenBuilder' }, maxContentLength: 8 * 1024 * 1024 });
    const html = String(response.data || '');
    const candidates = [...html.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
    const direct = candidates.find((v) => /download|\.zip(?:[?#]|$)|\.apk(?:[?#]|$)|\.js(?:[?#]|$)/i.test(v));
    if (!direct) throw new Error('MEDIAFIRE_DIRECT_LINK_NOT_FOUND');
    await bot.editMessageText(`✅ Link download ditemukan:\n${escapeHtml(direct)}`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    await bot.editMessageText(`❌ MEDIAFIRE GAGAL\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleCekId(bot, msg) {
  const u = msg.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'User';
  const username = u.username ? `@${u.username}` : 'Tidak ada username';
  return bot.sendMessage(msg.chat.id, `🪪 <b>IDENTITAS TELEGRAM</b>\n\n👤 Nama: <b>${escapeHtml(name)}</b>\n🆔 ID: <code>${Number(u.id || 0)}</code>\n🔖 Username: <b>${escapeHtml(username)}</b>\n💬 Chat ID: <code>${escapeHtml(msg.chat.id)}</code>`, { parse_mode: 'HTML' });
}

async function handleReq(bot, msg, ownerId) {
  const text = String(msg.text || '').replace(/^\/req(?:@\w+)?/i, '').trim();
  if (!text) return bot.sendMessage(msg.chat.id, '<b>REQUEST KE OWNER</b>\n\nKirim request setelah menekan menu ini.', { parse_mode: 'HTML' });
  const from = msg.from || {};
  const sender = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'User';
  const username = from.username ? `@${from.username}` : 'Tidak ada username';
  await bot.telegram.sendMessage(ownerId, `📨 <b>REQUEST BARU</b>\n━━━━━━━━━━━━\n👤 ${escapeHtml(sender)} ${escapeHtml(username)}\n🆔 <code>${Number(from.id || 0)}</code>\n\n${escapeHtml(text).slice(0, 3500)}`, { parse_mode: 'HTML' });
  return bot.sendMessage(msg.chat.id, '✅ Request dikirim ke owner.', { parse_mode: 'HTML' });
}

module.exports = { handleAIImage, handleLogo, handleFixError, handleMediaFire, handleCekId, handleReq };
