
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");

const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER_ID = Number(process.env.OWNER_ID);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

let users = new Set([OWNER_ID]);

const menu = Markup.keyboard([
  ["🚀 Deploy HTML", "📦 Deploy ZIP"],
  ["🌐 Get HTML", "🛡 Encrypt HTML"],
  ["📡 Ping System", "👤 Add User"]
]).resize();

bot.start((ctx) => {
  ctx.reply(
`⚙️ CLOUD LOGIC — RAVEN
━━━━━━━━━━━━━━━━

🚀 Deploy HTML
📦 Deploy ZIP
🌐 Get HTML
🛡 Encrypt HTML
📡 System Status

━━━━━━━━━━━━━━━━
👑 Developer: Raven`,
    menu
  );
});

bot.use((ctx,next)=>{
  if(!ctx.from || users.has(ctx.from.id)) return next();
  return ctx.reply("⛔ Akses ditolak.");
});

bot.hears("📡 Ping System", ctx=>{
  ctx.reply("✅ CLOUD LOGIC ONLINE\n⚡ auto deploy aktive");
});

bot.command("adduser", ctx=>{
  if(ctx.from.id !== OWNER_ID) return ctx.reply("Owner only.");
  const id = Number(ctx.message.text.split(" ")[1]);
  if(!id) return ctx.reply("Gunakan /adduser ID");
  users.add(id);
  ctx.reply("✅ User berhasil ditambahkan.");
});

bot.hears("🌐 Get HTML", ctx=>{
  ctx.reply("Gunakan:\n/getcode https://website.com");
});

bot.command("getcode", async ctx=>{
  const url = ctx.message.text.split(" ")[1];
  if(!url) return ctx.reply("URL tidak ada.");

  try{
    const r = await axios.get(url);
    await ctx.replyWithDocument({
      source: Buffer.from(r.data),
      filename:"source.html"
    });
  }catch(e){
    ctx.reply("❌ Gagal mengambil source.");
  }
});

async function uploadGithub(path, content){
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  await axios.put(url,{
    message:`Cloud Logic Deploy ${path}`,
    content:content.toString("base64"),
    branch:GITHUB_BRANCH
  },{
    headers:{
      Authorization:`Bearer ${GITHUB_TOKEN}`,
      Accept:"application/vnd.github+json"
    }
  });
}

bot.hears(["🚀 Deploy HTML","📦 Deploy ZIP"], ctx=>{
  ctx.reply("📤 Kirim file HTML atau ZIP.");
});

bot.on("document", async ctx=>{
  const file = ctx.message.document;
  const name = file.file_name || "";
  const size = (file.file_size || 0) / 1024 / 1024;

  if(!name.endsWith(".html") && !name.endsWith(".zip"))
    return ctx.reply("❌ Hanya HTML/ZIP.");

  const limit = name.endsWith(".html") ? 20 : 100;

  if(size > limit)
    return ctx.reply(`❌ Maksimal ${limit}MB.`);

  try{
    await ctx.reply("⏳ Mengupload ke GitHub...");

    const link = await ctx.telegram.getFileLink(file.file_id);
    const response = await axios.get(link.href,{
      responseType:"arraybuffer"
    });

    await uploadGithub(name, Buffer.from(response.data));

    ctx.reply(
`✅ DEPLOY BERHASIL

📁 File: ${name}
☁️ GitHub: Updated
🚀 Vercel: Menunggu build`
    );

  }catch(e){
    ctx.reply("❌ Deploy gagal: "+e.message);
  }
});

bot.hears("🛡 Encrypt HTML", ctx=>{
  ctx.reply("Fitur enkripsi siap dikembangkan.");
});

module.exports=(req,res)=>{
  if(req.method==="POST"){
    bot.handleUpdate(req.body,res);
  }else{
    res.status(200).send("CLOUD LOGIC RAVEN ONLINE");
  }
};
