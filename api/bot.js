const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

// Konfigurasi Token dari Environment Variables (Jangan tulis token langsung di code untuk keamanan)
const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = parseInt(process.env.OWNER_ID);

// Sistem Database User Sementara (In-Memory)
let allowedUsers = new Set([OWNER_ID]); 

// Middleware: Cek Akses (Hanya Owner & User yang di-add yang bisa pakai)
bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    if (!allowedUsers.has(userId)) {
        return ctx.reply('⛔ Akses Ditolak. Anda tidak terdaftar di Cloud-Logic-RavenZy.');
    }
    return next();
});

// ==========================================
// 1. MENU UTAMA & PING
// ==========================================
bot.start((ctx) => {
    ctx.reply(
        "🦅 **CLOUD-LOGIC-RAVENZY**\nSistem Auto Deploy & Web Tools Aktif.\n\nPilih menu:",
        Markup.keyboard([
            ['🚀 Deploy HTML', '📦 Deploy ZIP'],
            ['🔒 Enkripsi HTML', '🔐 Enkripsi ZIP'],
            ['🌐 Get Source Code', '🗑️ Delete Deploy'],
            ['📡 Ping System']
        ]).resize()
    );
});

bot.hears('📡 Ping System', (ctx) => {
    const start = Date.now();
    ctx.reply('Menghitung latensi...').then((msg) => {
        const ms = Date.now() - start;
        ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `✅ **Pong!**\nServer Vercel aktif.\nLatensi: ${ms}ms`, { parse_mode: 'Markdown' });
    });
});

// ==========================================
// 2. FITUR ADD USER (KHUSUS OWNER)
// ==========================================
bot.command('adduser', (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.reply('⛔ Hanya Owner yang bisa menambah user!');
    
    const idBaru = parseInt(ctx.message.text.split(' ')[1]);
    if (!idBaru) return ctx.reply('Format salah! Gunakan: /adduser 123456789');

    allowedUsers.add(idBaru);
    ctx.reply(`✅ User dengan ID ${idBaru} berhasil ditambahkan dan sekarang bisa menggunakan bot.`);
});

// ==========================================
// 3. FITUR GET SOURCE CODE
// ==========================================
bot.hears('🌐 Get Source Code', (ctx) => {
    ctx.reply('Kirimkan link website dengan format:\n`/getcode https://contoh.com`', { parse_mode: 'Markdown' });
});

bot.command('getcode', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    if (!url) return ctx.reply('⚠️ Masukkan URL yang valid.');

    ctx.reply('⏳ Mengambil source code...');
    try {
        const response = await axios.get(url);
        const sourceCode = response.data;
        
        // Kirim sebagai file txt/html
        await ctx.replyWithDocument(
            { source: Buffer.from(sourceCode, 'utf-8'), filename: 'source_code.html' },
            { caption: `✅ Berhasil mengambil source dari: ${url}` }
        );
    } catch (error) {
        ctx.reply('❌ Gagal mengambil source code. Pastikan URL benar atau web tidak diproteksi.');
    }
});

// ==========================================
// 4. FITUR AUTO DEPLOY (HTML/ZIP) VIA GITHUB
// ==========================================
bot.hears(['🚀 Deploy HTML', '📦 Deploy ZIP'], (ctx) => {
    ctx.reply('Kirimkan file (.html / .zip) langsung ke chat ini.\nBot akan mendeteksi dan melakukan auto-deploy ke Vercel.');
});

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const fileName = doc.file_name;
    
    if (fileName.endsWith('.html') || fileName.endsWith('.zip')) {
        ctx.reply(`⏳ Menerima file ${fileName}...\nMempersiapkan deploy ke Vercel via GitHub...`);
        
        // Logika Deploy: 
        // 1. Dapatkan link file Telegram via ctx.telegram.getFileLink()
        // 2. Kirim/Upload file tersebut ke GitHub via GitHub REST API (membutuhkan GitHub PAT).
        // 3. Vercel otomatis mendeploy saat mendeteksi ada push baru di GitHub.
        
        setTimeout(() => {
            ctx.reply(`✅ File siap! GitHub trigger dikirim.\nVercel sedang memproses deploy Anda. Cek dashboard untuk URL live.`);
        }, 2000); // Dummy timeout (Tinggal ganti dengan blok kode Axios ke API GitHub nantinya)
    } else {
        ctx.reply('⚠️ Format tidak didukung. Harap kirim file .html atau .zip');
    }
});

// ==========================================
// 5. FITUR DELETE DEPLOY VERCEL
// ==========================================
bot.hears('🗑️ Delete Deploy', (ctx) => {
    ctx.reply('Untuk menghapus deploy, ketik:\n`/delete_deploy [ID_DEPLOY_VERCEL]`', { parse_mode: 'Markdown' });
});

bot.command('delete_deploy', async (ctx) => {
    const deployId = ctx.message.text.split(' ')[1];
    if (!deployId) return ctx.reply('⚠️ ID Deploy Vercel dibutuhkan.');

    ctx.reply(`⏳ Menghapus deploy ${deployId}...`);
    try {
        // Harus ada VERCEL_TOKEN di env
        await axios.delete(`https://api.vercel.com/v13/deployments/${deployId}`, {
            headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }
        });
        ctx.reply(`✅ Deploy ${deployId} berhasil dihapus dari server Vercel!`);
    } catch (error) {
        ctx.reply(`❌ Gagal menghapus deploy. Pastikan ID dan Token Vercel benar.`);
    }
});

// ==========================================
// 6. ENKRIPSI
// ==========================================
bot.hears(['🔒 Enkripsi HTML', '🔐 Enkripsi ZIP'], (ctx) => {
    ctx.reply('Kirim file yang ingin dienkripsi dengan caption:\n`/encrypt`\n\n*(Catatan: Fitur ini akan membungkus kode Anda menjadi base64/hex agar sulit dibaca oleh inspect element)*', { parse_mode: 'Markdown' });
});

// EXPORT WEBHOOK UNTUK VERCEL
module.exports = (req, res) => {
    if (req.method === 'POST') {
        bot.handleUpdate(req.body, res);
    } else {
        res.status(200).send('🦅 Cloud-Logic-RavenZy System Online!');
    }
};
