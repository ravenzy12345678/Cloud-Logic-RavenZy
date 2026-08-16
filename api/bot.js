const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = parseInt(process.env.OWNER_ID);

let allowedUsers = new Set([OWNER_ID]); 

bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    if (!allowedUsers.has(userId)) {
        return ctx.reply('⛔ Akses Ditolak. Anda tidak terdaftar di Cloud-Logic-RavenZy.');
    }
    return next();
});

bot.start((ctx) => {
    ctx.reply(
        "🦅 **CLOUD-LOGIC-RAVENZY**\nSistem Auto Deploy & Web Tools Aktif.\n\nPilih menu:",
        Markup.keyboard([
            ['🚀 Deploy HTML', '📦 Deploy ZIP'],
            ['🔒 Enkripsi HTML', '🔐 Enkripsi ZIP'],
            ['🌐 Get Source Code', '📡 Ping System']
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

bot.command('adduser', (ctx) => {
    if (ctx.from.id !== OWNER_ID) return ctx.reply('⛔ Hanya Owner yang bisa menambah user!');
    
    const idBaru = parseInt(ctx.message.text.split(' ')[1]);
    if (!idBaru) return ctx.reply('Format salah! Gunakan: /adduser 123456789');

    allowedUsers.add(idBaru);
    ctx.reply(`✅ User dengan ID ${idBaru} berhasil ditambahkan.`);
});

bot.hears('🌐 Get Source Code', (ctx) => {
    ctx.reply('Kirimkan link website dengan format:\n`/getcode https://contoh.com`', { parse_mode: 'Markdown' });
});

bot.command('getcode', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    if (!url) return ctx.reply('⚠️ Masukkan URL yang valid.');

    ctx.reply('⏳ Mengambil source code...');
    try {
        const response = await axios.get(url);
        await ctx.replyWithDocument(
            { source: Buffer.from(response.data, 'utf-8'), filename: 'source_code.html' },
            { caption: `✅ Berhasil mengambil source dari: ${url}` }
        );
    } catch (error) {
        ctx.reply('❌ Gagal mengambil source code.');
    }
});

bot.hears(['🚀 Deploy HTML', '📦 Deploy ZIP'], (ctx) => {
    ctx.reply('Kirimkan file (.html / .zip) langsung ke chat ini untuk di-deploy.');
});

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    if (doc.file_name.endsWith('.html') || doc.file_name.zip) {
        ctx.reply(`⏳ Menerima file ${doc.file_name}...\nDiproses ke Vercel via GitHub.`);
    } else {
        ctx.reply('⚠️ Harap kirim file .html atau .zip');
    }
});

module.exports = (req, res) => {
    if (req.method === 'POST') {
        bot.handleUpdate(req.body, res);
    } else {
        res.status(200).send('🦅 Cloud-Logic-RavenZy System Online!');
    }
};
