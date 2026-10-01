'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortBody(data, max = 900) {
  if (Buffer.isBuffer(data)) return data.toString('utf8', 0, max);
  if (typeof data === 'string') return data.slice(0, max);
  try { return JSON.stringify(data).slice(0, max); } catch (_) { return String(data).slice(0, max); }
}

function pickImage(data) {
  const values = [
    data?.result?.url, data?.result?.image, data?.result?.imageUrl,
    data?.data?.url, data?.data?.image, data?.data?.imageUrl,
    data?.url, data?.image, data?.imageUrl,
    data?.choices?.[0]?.message?.content,
  ];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const m = value.match(/https?:\/\/[^\s)\]}>'"]+/i);
    if (m) return m[0].replace(/[),.;]+$/, '');
  }
  return null;
}

function authHeaders(apiKey) {
  const headers = { 'User-Agent': 'Builder-By-Raven/4.0' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function requestImageEndpoint(endpoint, prompt, apiKey, kind) {
  const errors = [];
  const label = kind === 'logo' ? 'LOGO' : 'AI_IMAGE';
  const variants = [
    { method: 'get', params: { prompt, text: prompt, key: apiKey, apiKey, apikey: apiKey } },
    { method: 'post', data: { prompt, text: prompt, key: apiKey, apiKey, apikey: apiKey } },
  ];
  for (const variant of variants) {
    try {
      const response = await axios({
        url: endpoint,
        method: variant.method,
        params: variant.params,
        data: variant.data,
        responseType: 'arraybuffer',
        timeout: 70000,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
        headers: authHeaders(apiKey),
        validateStatus: () => true,
      });
      const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
      if (response.status >= 200 && response.status < 300) {
        if (contentType.startsWith('image/')) return { buffer: Buffer.from(response.data), contentType };
        let data;
        try { data = JSON.parse(Buffer.from(response.data).toString('utf8')); } catch (_) { data = { url: Buffer.from(response.data).toString('utf8').trim() }; }
        const imageUrl = pickImage(data);
        if (imageUrl) return { url: imageUrl };
        errors.push(`${label}_EMPTY_${variant.method.toUpperCase()}`);
      } else {
        errors.push(`${label}_HTTP_${response.status}: ${shortBody(response.data)}`);
      }
    } catch (error) {
      errors.push(`${label}_${variant.method.toUpperCase()}_${error.code || error.message}`);
    }
  }
  throw new Error(errors.join(' | ').slice(0, 1800) || `${label}_FAILED`);
}

async function pollinationsImage(prompt, apiKey) {
  const encoded = encodeURIComponent(prompt);
  const urls = [
    `https://gen.pollinations.ai/image/${encoded}?model=flux&width=1024&height=1024`,
    `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`,
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 90000,
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
        headers: authHeaders(apiKey),
        validateStatus: () => true,
      });
      const ct = String(response.headers?.['content-type'] || '').toLowerCase();
      if (response.status >= 200 && response.status < 300 && ct.startsWith('image/')) {
        return Buffer.from(response.data);
      }
      errors.push(`POLLINATIONS_HTTP_${response.status}: ${shortBody(response.data, 500)}`);
    } catch (error) {
      errors.push(`POLLINATIONS_${error.code || error.message}`);
    }
  }
  throw new Error(errors.join(' | ').slice(0, 1800) || 'POLLINATIONS_IMAGE_FAILED');
}

async function generateImage(prompt, apiKey, endpoints, kind) {
  const errors = [];
  for (const endpoint of [...new Set(endpoints.filter(Boolean))]) {
    try { return await requestImageEndpoint(endpoint, prompt, apiKey, kind); }
    catch (error) { errors.push(error.message); }
  }
  try { return { buffer: await pollinationsImage(prompt, apiKey) }; }
  catch (error) { errors.push(error.message); }
  throw new Error(errors.join(' | ').slice(0, 2400));
}

async function resolveImage(result) {
  if (result?.buffer) return result.buffer;
  if (result?.url) {
    const response = await axios.get(result.url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 20 * 1024 * 1024, maxBodyLength: 20 * 1024 * 1024, headers: { 'User-Agent': 'Builder-By-Raven/4.0' } });
    return Buffer.from(response.data);
  }
  throw new Error('IMAGE_RESULT_EMPTY');
}

async function handleAIImage(bot, msg, config = {}) {
  const chatId = msg.chat.id;
  const prompt = String(msg.text || '').replace(/^\/aiimage(?:@\w+)?/i, '').trim();
  if (!prompt) return bot.sendMessage(chatId, '<b>AI IMAGE GENERATOR</b>\n\nKirim prompt gambar.', { parse_mode: 'HTML' });
  const status = await bot.sendMessage(chatId, '🎨 Membuat gambar…', { parse_mode: 'HTML' });
  try {
    const endpoint = process.env.AI_IMAGE_API_URL || '';
    const apiKey = process.env.AI_IMAGE_API_KEY || process.env.POLLINATIONS_API_KEY || '';
    const result = await generateImage(prompt, apiKey, [endpoint, config.imageEndpoint], 'image');
    const buffer = await resolveImage(result);
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    return bot.sendPhoto(chatId, buffer, { caption: `✅ <b>AI IMAGE SELESAI</b>\n\n<code>${escapeHtml(prompt.slice(0, 700))}</code>`, parse_mode: 'HTML' });
  } catch (error) {
    await bot.editMessageText(`❌ <b>AI IMAGE GAGAL</b>\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handleLogo(bot, msg) {
  const chatId = msg.chat.id;
  const prompt = String(msg.text || '').replace(/^\/createlogo(?:@\w+)?/i, '').trim();
  if (!prompt) return bot.sendMessage(chatId, '<b>CREATE LOGO AI</b>\n\nKirim konsep logo.', { parse_mode: 'HTML' });
  const status = await bot.sendMessage(chatId, '🎨 Membuat logo…', { parse_mode: 'HTML' });
  try {
    const apiKey = process.env.LOGO_API_KEY || process.env.AI_IMAGE_API_KEY || process.env.POLLINATIONS_API_KEY || '';
    const logoPrompt = `professional luxury app logo, clean vector style, centered emblem, premium typography, transparent-looking simple background, ${prompt}`;
    const result = await generateImage(logoPrompt, apiKey, [process.env.LOGO_API_URL, process.env.AI_IMAGE_API_URL], 'logo');
    const buffer = await resolveImage(result);
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    return bot.sendPhoto(chatId, buffer, { caption: `✅ <b>CREATE LOGO AI SELESAI</b>\n\n<code>${escapeHtml(prompt.slice(0, 800))}</code>`, parse_mode: 'HTML' });
  } catch (error) {
    await bot.editMessageText(`❌ <b>CREATE LOGO GAGAL</b>\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
  }
}

async function callFixEndpoint(endpoint, code, apiKey) {
  const prompt = `Review this JavaScript code, identify the real errors, and return ONLY the corrected complete code. Do not explain.\n\n${code}`;
  const errors = [];
  const variants = [
    { method: 'get', params: { code: prompt, lang: 'javascript', key: apiKey, apiKey } },
    { method: 'post', data: { code: prompt, lang: 'javascript', key: apiKey, apiKey } },
  ];
  for (const variant of variants) {
    try {
      const response = await axios({ url: endpoint, method: variant.method, params: variant.params, data: variant.data, timeout: 45000, headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' }, validateStatus: () => true });
      if (response.status >= 200 && response.status < 300) {
        const fixed = String(response.data?.result?.fixed || response.data?.fixed || response.data?.result || response.data?.text || '').trim();
        if (fixed) return fixed.replace(/^```(?:javascript|js)?\s*/i, '').replace(/```$/i, '').trim();
      }
      errors.push(`FIXERROR_HTTP_${response.status}: ${shortBody(response.data)}`);
    } catch (error) { errors.push(`FIXERROR_${variant.method.toUpperCase()}_${error.code || error.message}`); }
  }
  throw new Error(errors.join(' | ').slice(0, 1800));
}

async function pollinationsFix(code, apiKey) {
  const prompt = `Return ONLY the corrected complete JavaScript code for the following code. Preserve its intended behavior. No markdown, no explanation.\n\n${code}`;
  const response = await axios.get(`https://gen.pollinations.ai/text/${encodeURIComponent(prompt)}?model=openai/gpt-5.4-nano`, {
    timeout: 60000,
    headers: authHeaders(apiKey),
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`POLLINATIONS_FIX_HTTP_${response.status}: ${shortBody(response.data)}`);
  const fixed = String(response.data || '').trim().replace(/^```(?:javascript|js)?\s*/i, '').replace(/```$/i, '').trim();
  if (!fixed) throw new Error('POLLINATIONS_FIX_EMPTY');
  return fixed;
}

async function handleFixError(bot, msg) {
  const chatId = msg.chat.id;
  const reply = msg.reply_to_message;
  if (!reply) { await bot.sendMessage(chatId, '<b>FIX CODE ERROR</b>\n\nReply ke kode JavaScript.', { parse_mode: 'HTML' }); return false; }
  let code = reply.text || '';
  let fileExt = 'js';
  if (!code && reply.document?.file_id) {
    const file = await bot.getFile(reply.document.file_id);
    const token = process.env.TOKEN_BOT || process.env.BOT_TOKEN || '';
    const response = await axios.get(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { responseType: 'text', timeout: 30000 });
    code = String(response.data || '');
    fileExt = (reply.document.file_name?.split('.').pop() || 'js').replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'js';
  }
  if (!code.trim()) { await bot.sendMessage(chatId, '❌ Kode kosong.'); return false; }
  if (code.length > 7000) { await bot.sendMessage(chatId, '❌ Maksimum 7000 karakter.'); return false; }
  const status = await bot.sendMessage(chatId, '🧯 Memperbaiki kode…', { parse_mode: 'HTML' });
  try {
    const apiKey = process.env.FIXERROR_API_KEY || process.env.POLLINATIONS_API_KEY || '';
    let fixed;
    try { fixed = await callFixEndpoint(process.env.FIXERROR_API_URL || 'https://api.ikyyxd.my.id/tools/fixerror', code, apiKey); }
    catch (_) { fixed = await pollinationsFix(code, apiKey); }
    await bot.deleteMessage(chatId, status.message_id).catch(() => {});
    if (fixed.length < 3500) { await bot.sendMessage(chatId, `<b>✅ FIX SELESAI</b>\n<pre>${escapeHtml(fixed)}</pre>`, { parse_mode: 'HTML' }); return true; }
    const out = path.join('/tmp', `fixed_${Date.now()}.${fileExt}`);
    fs.writeFileSync(out, fixed);
    try { await bot.sendDocument(chatId, out, { caption: '✅ <b>FIX CODE ERROR SELESAI</b>', parse_mode: 'HTML' }); return true; } finally { try { fs.unlinkSync(out); } catch (_) {} }
  } catch (error) {
    await bot.editMessageText(`❌ <b>FIX GAGAL</b>\n\n<code>${escapeHtml(error.message || error)}</code>`, { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }).catch(() => {});
    return false;
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
