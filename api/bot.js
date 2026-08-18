
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const JSZip = require("jszip");
const crypto = require("crypto");

const ENV = {
  BOT_TOKEN: process.env.TOKEN_BOT || process.env.BOT_TOKEN,
  OWNER_ID: process.env.ID_PEMILIK || process.env.OWNER_ID,
  GH_TOKEN: process.env.TOKEN_GITHUB || process.env.GITHUB_TOKEN,
  GH_OWNER: process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER,
  GH_REPO: process.env.REPO_GITHUB || process.env.GITHUB_REPO,
  GH_BRANCH: process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || "main",
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
};

for (const [k, v] of Object.entries(ENV)) {
  if (!v) console.warn(`[CONFIG] Missing ${k}`);
}

const OWNER_ID = Number(ENV.OWNER_ID);
const bot = new Telegraf(ENV.BOT_TOKEN);

const sessions = new Map();
let allowedUsers = new Set([OWNER_ID]);

const ghHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${ENV.GH_TOKEN}`,
  "X-GitHub-Api-Version": "2026-03-10",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
}

function repoSafeName(name) {
  let n = String(name || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 90);
  if (!n) n = `website-${Date.now()}`;
  return n;
}

function projectSafeName(name) {
  return repoSafeName(name).toLowerCase().replace(/_/g, "-").slice(0, 90);
}

function isAllowed(ctx) {
  return Number(ctx.from?.id) === OWNER_ID || allowedUsers.has(Number(ctx.from?.id));
}

async function denySilently(ctx, next) {
  if (!isAllowed(ctx)) return;
  return next();
}

bot.use(denySilently);

async function getBotRepoFile(path) {
  const url = `https://api.github.com/repos/${ENV.GH_OWNER}/${ENV.GH_REPO}/contents/${encodeURIComponent(path)}`;
  try {
    const r = await axios.get(url, { headers: ghHeaders, params: { ref: ENV.GH_BRANCH } });
    return r.data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function writeBotRepoFile(path, content, message, sha) {
  const url = `https://api.github.com/repos/${ENV.GH_OWNER}/${ENV.GH_REPO}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: ENV.GH_BRANCH,
  };
  if (sha) body.sha = sha;
  return axios.put(url, body, { headers: ghHeaders });
}

async function loadUsers() {
  if (!ENV.GH_TOKEN || !ENV.GH_OWNER || !ENV.GH_REPO) return;
  try {
    const f = await getBotRepoFile("cloud-logic-users.json");
    if (f?.content) {
      const arr = JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
      allowedUsers = new Set(arr.map(Number).filter(Number.isFinite));
      allowedUsers.add(OWNER_ID);
    }
  } catch (e) {
    console.error("[USERS LOAD]", e.response?.data || e.message);
  }
}

async function saveUsers() {
  const current = [...allowedUsers].filter((x) => Number.isFinite(x));
  const f = await getBotRepoFile("cloud-logic-users.json");
  await writeBotRepoFile(
    "cloud-logic-users.json",
    JSON.stringify(current, null, 2),
    "chore: update bot users",
    f?.sha
  );
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚀 Deploy HTML", "deploy_html"), Markup.button.callback("📦 Deploy ZIP", "deploy_zip")],
    [Markup.button.callback("🌐 Get Source", "get_source"), Markup.button.callback("🛡️ Encrypt HTML", "encrypt_html")],
    [Markup.button.callback("🗑️ Delete Web", "delete_web"), Markup.button.callback("📡 System", "system")],
    [Markup.button.callback("👤 Add User", "add_user"), Markup.button.callback("👥 Users", "users")],
  ]);
}

function panel(text) {
  return `☁️ <b>CLOUD LOGIC</b>\n━━━━━━━━━━━━━━━━━━\n${text}`;
}

async function showMenu(ctx, text = "🟢 Sistem siap digunakan.") {
  const body = panel(text);
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(body, { parse_mode: "HTML", ...mainMenu() });
      return;
    }
  } catch (_) {}
  await ctx.reply(body, { parse_mode: "HTML", ...mainMenu() });
}

bot.start((ctx) => showMenu(ctx, `🟢 <b>ONLINE</b>\n\nPilih fitur di bawah.`));

bot.action("home", (ctx) => showMenu(ctx));
bot.action("deploy_html", async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { type: "deploy_html", step: "file" });
  await showMenu(ctx, `🚀 <b>DEPLOY HTML</b>\n\nKirim file <code>.html</code> sekarang.`);
});
bot.action("deploy_zip", async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { type: "deploy_zip", step: "file" });
  await showMenu(ctx, `📦 <b>DEPLOY ZIP</b>\n\nKirim file <code>.zip</code> sekarang.`);
});

bot.action("get_source", async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { type: "source", step: "url" });
  await showMenu(ctx, `🌐 <b>GET SOURCE</b>\n\nKirim URL publik, contoh:\n<code>https://example.com</code>\n\nHanya resource yang memang dapat diakses publik yang dapat diambil.`);
});

bot.action("encrypt_html", async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { type: "encrypt", step: "file" });
  await showMenu(ctx, `🛡️ <b>ENCRYPT HTML</b>\n\nKirim file <code>.html</code> lalu bot akan meminta password.`);
});

bot.action("system", async (ctx) => {
  await ctx.answerCbQuery();
  const checks = [];
  for (const [name, ok] of [
    ["Telegram", !!ENV.BOT_TOKEN],
    ["GitHub", !!ENV.GH_TOKEN && !!ENV.GH_OWNER && !!ENV.GH_REPO],
    ["Vercel", !!ENV.VERCEL_TOKEN],
  ]) checks.push(`${ok ? "🟢" : "🔴"} ${name}`);
  await showMenu(ctx, `📡 <b>SYSTEM STATUS</b>\n\n${checks.join("\n")}`);
});

bot.action("add_user", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== OWNER_ID) return;
  sessions.set(ctx.from.id, { type: "add_user", step: "id" });
  await showMenu(ctx, `👤 <b>ADD USER</b>\n\nKirim Telegram ID user yang ingin diberi akses.`);
});

bot.action("users", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== OWNER_ID) return;
  const ids = [...allowedUsers].filter((x) => x !== OWNER_ID);
  await showMenu(ctx, `👥 <b>AUTHORIZED USERS</b>\n\nOwner: <code>${OWNER_ID}</code>\nUser tambahan: <b>${ids.length}</b>\n\n${ids.length ? ids.map((x,i)=>`${i+1}. <code>${x}</code>`).join("\n") : "Belum ada user tambahan."}`);
});

bot.action("delete_web", async (ctx) => {
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { type: "delete", step: "id" });
  await showMenu(ctx, `🗑️ <b>DELETE WEB</b>\n\nKirim <b>Deployment ID</b> Vercel yang ingin dihapus.`);
});

async function tgFileBuffer(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const r = await axios.get(link.href || link, { responseType: "arraybuffer", timeout: 120000, maxContentLength: 200 * 1024 * 1024 });
  return Buffer.from(r.data);
}

async function createGitHubRepo(name) {
  const url = "https://api.github.com/user/repos";
  const r = await axios.post(url, {
    name,
    description: `Cloud Logic deployment: ${name}`,
    private: false,
    auto_init: false,
  }, { headers: ghHeaders });
  return r.data;
}

async function uploadFilesToRepo(owner, repo, files) {
  // New repositories are empty; each PUT is serialized intentionally.
  for (const file of files) {
    const path = file.path.replace(/^\/+/, "");
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    await axios.put(url, {
      message: `deploy: add ${path}`,
      content: file.buffer.toString("base64"),
      branch: "main",
    }, { headers: ghHeaders });
  }
}

async function createVercelProject(projectName, owner, repo) {
  const r = await axios.post("https://api.vercel.com/v11/projects", {
    name: projectName,
    framework: null,
    gitRepository: {
      type: "github",
      repo: `${owner}/${repo}`,
    },
  }, {
    headers: {
      Authorization: `Bearer ${ENV.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });
  return r.data;
}

async function waitForDeployment(projectId, projectName, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await axios.get("https://api.vercel.com/v6/deployments", {
      headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` },
      params: { projectId, limit: 5 },
    });
    const d = (r.data.deployments || [])[0];
    if (d) {
      const state = d.state || d.readyState;
      if (["READY", "ERROR", "CANCELED"].includes(state)) return d;
    }
    await sleep(5000);
  }
  return null;
}

async function deployNewSite(fileName, files) {
  const repoName = repoSafeName(fileName);
  const projectName = projectSafeName(repoName);

  let repo;
  try {
    repo = await createGitHubRepo(repoName);
  } catch (e) {
    if (e.response?.status === 422) {
      // Same requested name already exists: do not silently overwrite it.
      throw new Error(`Repository "${repoName}" sudah ada di GitHub. Gunakan nama file berbeda.`);
    }
    throw e;
  }

  await uploadFilesToRepo(ENV.GH_OWNER, repoName, files);

  const project = await createVercelProject(projectName, ENV.GH_OWNER, repoName);
  const deployment = await waitForDeployment(project.id, projectName);

  if (!deployment) {
    return { repo, project, deployment: null };
  }
  if ((deployment.state || deployment.readyState) !== "READY") {
    throw new Error(`Vercel deployment gagal: ${deployment.state || deployment.readyState || "UNKNOWN"}`);
  }
  return { repo, project, deployment };
}

async function zipFiles(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean || clean.includes("../") || clean.startsWith("../")) continue;
    files.push({ path: clean, buffer: await entry.async("nodebuffer") });
  }
  if (!files.length) throw new Error("ZIP kosong.");
  if (!files.some(f => f.path.toLowerCase() === "index.html")) {
    throw new Error("ZIP harus memiliki index.html di root atau gunakan HTML biasa.");
  }
  return files;
}

async function getPublicSource(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("URL harus http/https.");
  const r = await axios.get(u.href, {
    timeout: 30000,
    responseType: "text",
    maxContentLength: 10 * 1024 * 1024,
    headers: { "User-Agent": "Cloud-Logic-SourceFetcher/1.0" },
  });
  const html = String(r.data);
  const zip = new JSZip();
  zip.file("index.html", html);

  const urls = new Set();
  const add = (x) => {
    try {
      const abs = new URL(x, u.href);
      if (abs.protocol === "http:" || abs.protocol === "https:") urls.add(abs.href);
    } catch (_) {}
  };

  for (const m of html.matchAll(/<(?:script|link|img|source)[^>]+(?:src|href)=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);

  let count = 0;
  for (const asset of urls) {
    if (count >= 100) break;
    try {
      const ar = await axios.get(asset, { responseType: "arraybuffer", timeout: 15000, maxContentLength: 10 * 1024 * 1024, headers: { "User-Agent": "Cloud-Logic-SourceFetcher/1.0" } });
      const parsed = new URL(asset);
      let base = parsed.pathname.replace(/^\/+/, "") || `asset-${count}`;
      if (base.endsWith("/")) base += `asset-${count}`;
      zip.file(`assets/${base.split("/").pop()}`, Buffer.from(ar.data));
      count++;
    } catch (_) {}
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function encryptedHtml(html, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(Buffer.from(password), salt, 200000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(html, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b) => b.toString("base64");
  return `<!doctype html><meta charset="utf-8"><title>Encrypted HTML</title><body><div id="app">Enter password</div><script>
(async()=>{const enc=${JSON.stringify(b64(ciphertext))},salt=${JSON.stringify(b64(salt))},iv=${JSON.stringify(b64(iv))},tag=${JSON.stringify(b64(tag))};
const p=prompt("Password:");if(!p)return;
const b64u=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(p),"PBKDF2",false,["deriveKey"]);
const key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:b64u(salt),iterations:200000,hash:"SHA-256"},k,{name:"AES-GCM",length:256},false,["decrypt"]);
try{const c=new Uint8Array([...b64u(enc),...b64u(tag)]);const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:b64u(iv)},key,c);document.open();document.write(new TextDecoder().decode(plain));document.close()}catch(e){document.body.innerHTML="<h3>Wrong password or corrupted file.</h3>"}})();
</script>`;
}

bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const text = ctx.message.text.trim();

  if (s.type === "add_user" && s.step === "id") {
    if (ctx.from.id !== OWNER_ID) return;
    const id = Number(text);
    if (!Number.isInteger(id) || id <= 0) return showMenu(ctx, "❌ Telegram ID tidak valid.");
    allowedUsers.add(id);
    try {
      await saveUsers();
      sessions.delete(ctx.from.id);
      return showMenu(ctx, `✅ User <code>${id}</code> berhasil ditambahkan.`);
    } catch (e) {
      allowedUsers.delete(id);
      return showMenu(ctx, `❌ Gagal menyimpan user.\n<code>${esc(e.response?.data?.message || e.message)}</code>`);
    }
  }

  if (s.type === "source" && s.step === "url") {
    sessions.delete(ctx.from.id);
    try {
      const zip = await getPublicSource(text);
      await ctx.replyWithDocument({ source: zip, filename: "source-public.zip" }, { caption: "✅ Source publik berhasil dibundel menjadi ZIP." });
      return showMenu(ctx);
    } catch (e) {
      return showMenu(ctx, `❌ Get Source gagal.\n<code>${esc(e.message)}</code>`);
    }
  }

  if (s.type === "delete" && s.step === "id") {
    sessions.delete(ctx.from.id);
    try {
      await axios.delete(`https://api.vercel.com/v13/deployments/${encodeURIComponent(text)}`, {
        headers: { Authorization: `Bearer ${ENV.VERCEL_TOKEN}` },
      });
      return showMenu(ctx, `✅ Deployment <code>${esc(text)}</code> berhasil dihapus.`);
    } catch (e) {
      return showMenu(ctx, `❌ Delete gagal.\n<code>${esc(e.response?.data?.error?.message || e.message)}</code>`);
    }
  }

  if (s.type === "encrypt" && s.step === "password") {
    s.password = text;
    s.step = "confirm";
    return showMenu(ctx, "🔐 Konfirmasi password: kirim password yang sama.");
  }

  if (s.type === "encrypt" && s.step === "confirm") {
    if (text !== s.password) return showMenu(ctx, "❌ Password berbeda. Ulangi proses Enkripsi HTML.");
    s.confirmed = true;
    return showMenu(ctx, "❌ File belum diterima pada sesi ini. Kirim ulang file HTML dari menu Enkripsi HTML.");
  }

  if ((s.type === "deploy_html" || s.type === "deploy_zip") && s.step === "name") {
    const name = repoSafeName(text);
    s.name = name;
    s.step = "deploying";
    await showMenu(ctx, `🚀 <b>DEPLOYING</b>\n\n📦 Repository: <code>${esc(name)}</code>\n⬆️ GitHub: ⏳\n⚡ Vercel: ⏳`);
    try {
      const result = await deployNewSite(name, s.files);
      sessions.delete(ctx.from.id);
      if (!result.deployment) return showMenu(ctx, `⚠️ Repository berhasil dibuat, tetapi Vercel belum mengembalikan deployment dalam batas waktu.`);
      const url = result.deployment.url ? `https://${result.deployment.url}` : `https://${projectSafeName(name)}.vercel.app`;
      return showMenu(ctx, `✅ <b>DEPLOY SUCCESS</b>\n\n📦 Repo: <a href="${esc(result.repo.html_url)}">${esc(result.repo.full_name)}</a>\n🌐 URL: <a href="${esc(url)}">${esc(url)}</a>\n⚡ Status: READY`,);
    } catch (e) {
      sessions.delete(ctx.from.id);
      return showMenu(ctx, `❌ <b>DEPLOY GAGAL</b>\n\n<code>${esc(e.response?.data?.error?.message || e.message)}</code>`);
    }
  }
});

bot.on("document", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;
  const doc = ctx.message.document;
  const name = doc.file_name || "file";

  if (s.type === "encrypt" && s.step === "file") {
    if (!name.toLowerCase().endsWith(".html")) return showMenu(ctx, "❌ Enkripsi HTML hanya menerima file .html.");
    try {
      const buffer = await tgFileBuffer(ctx, doc.file_id);
      s.fileBuffer = buffer;
      s.fileName = name;
      s.step = "password";
      return showMenu(ctx, "🔐 File diterima.\n\nKirim password enkripsi.");
    } catch (e) {
      return showMenu(ctx, `❌ Gagal mengambil file.\n<code>${esc(e.message)}</code>`);
    }
  }

  if (s.type === "deploy_html" && s.step === "file") {
    if (!name.toLowerCase().endsWith(".html")) return showMenu(ctx, "❌ Kirim file .html.");
    try {
      const buffer = await tgFileBuffer(ctx, doc.file_id);
      s.files = [{ path: "index.html", buffer }];
      s.step = "name";
      return showMenu(ctx, "📄 HTML diterima.\n\nSekarang kirim <b>nama repository/website</b> tanpa spasi.");
    } catch (e) {
      return showMenu(ctx, `❌ Gagal mengambil file.\n<code>${esc(e.message)}</code>`);
    }
  }

  if (s.type === "deploy_zip" && s.step === "file") {
    if (!name.toLowerCase().endsWith(".zip")) return showMenu(ctx, "❌ Kirim file .zip.");
    try {
      const buffer = await tgFileBuffer(ctx, doc.file_id);
      const files = await zipFiles(buffer);
      s.files = files;
      s.step = "name";
      return showMenu(ctx, `📦 ZIP diterima.\n📁 ${files.length} file ditemukan.\n\nKirim <b>nama repository/website</b> tanpa spasi.`);
    } catch (e) {
      return showMenu(ctx, `❌ ZIP tidak valid.\n<code>${esc(e.message)}</code>`);
    }
  }
});

bot.command("adduser", async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  const id = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isInteger(id) || id <= 0) return ctx.reply("Format: /adduser 123456789");
  allowedUsers.add(id);
  try { await saveUsers(); await ctx.reply(`✅ User ${id} ditambahkan.`); }
  catch (e) { allowedUsers.delete(id); await ctx.reply(`❌ Gagal menyimpan: ${e.message}`); }
});

bot.command("cancel", async (ctx) => {
  sessions.delete(ctx.from.id);
  await showMenu(ctx, "↩️ Proses dibatalkan.");
});

bot.catch((err, ctx) => {
  console.error("[BOT ERROR]", err.response?.data || err.message || err);
});

(async () => {
  await loadUsers();
  // Vercel webhook mode: no polling here.
})();

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).send("OK");
    } catch (e) {
      console.error("[WEBHOOK]", e.response?.data || e.message || e);
      return res.status(500).send("Webhook error");
    }
  }
  return res.status(200).send("☁️ Cloud Logic Bot Online");
};
