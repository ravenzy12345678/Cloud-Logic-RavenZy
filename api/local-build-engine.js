'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');

const DEFAULT_MAX_SOURCE_BYTES = 2_147_483_647; // 2 GiB - matches the UI contract.
const DEFAULT_MAX_UNPACKED_BYTES = 6 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 30_000;
const DEFAULT_QUEUE_CONCURRENCY = 1;
const DEFAULT_PROCESS_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

function safeName(value, fallback = 'build') {
  const out = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return out || fallback;
}

function buildJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function removePath(target) {
  try { await fsp.rm(target, { recursive: true, force: true }); } catch (_) {}
}

function commandExists(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  try {
    const result = spawnSync(lookup, args, { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    '/opt/android-sdk',
    '/usr/lib/android-sdk',
    path.join(process.env.HOME || '', 'Android', 'Sdk'),
    path.join(process.env.HOME || '', 'android-sdk'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
    } catch (_) {}
  }
  return null;
}

async function writeLocalProperties(projectDir) {
  const sdk = resolveAndroidSdk();
  if (!sdk) return null;
  const localPath = path.join(projectDir, 'android', 'local.properties');
  await ensureDir(path.dirname(localPath));
  await fsp.writeFile(localPath, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`, 'utf8');
  return sdk;
}

function appendGradleStability(projectDir) {
  const propPath = path.join(projectDir, 'android', 'gradle.properties');
  if (!fs.existsSync(propPath)) return;
  let content = fs.readFileSync(propPath, 'utf8');
  const desired = {
    'org.gradle.daemon': 'false',
    'org.gradle.workers.max': String(Math.max(1, Math.min(2, Number(process.env.BUILD_GRADLE_WORKERS || 2) || 2))),
    'org.gradle.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8',
    'android.useAndroidX': 'true',
    'android.enableJetifier': 'false',
  };
  for (const [key, value] of Object.entries(desired)) {
    const re = new RegExp(`^${key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}=.*$`, 'm');
    if (re.test(content)) content = content.replace(re, `${key}=${value}`);
    else content += `${content.endsWith('\n') || !content ? '' : '\n'}${key}=${value}\n`;
  }
  fs.writeFileSync(propPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function zipListCommand(zipPath) {
  if (commandExists('unzip')) return ['unzip', ['-Z1', zipPath]];
  if (commandExists('zipinfo')) return ['zipinfo', ['-1', zipPath]];
  return null;
}

async function listZipEntries(zipPath) {
  const spec = zipListCommand(zipPath);
  if (!spec) throw new Error('Tool ZIP tidak tersedia di Server. Install unzip/zipinfo sebelum build.');
  const { output } = await runProcess(spec[0], spec[1], path.dirname(zipPath), {
    timeoutMs: 120000,
    inactivityTimeoutMs: 60000,
    captureLimit: 20 * 1024 * 1024,
  });
  return String(output).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function validateZipEntryName(name) {
  const clean = String(name || '').replace(/\\/g, '/');
  if (!clean || clean.includes('\0')) return false;
  if (clean.startsWith('/')) return false;
  const parts = clean.split('/');
  if (parts.some((part) => part === '..')) return false;
  if (/^[A-Za-z]:\//.test(clean)) return false;
  return true;
}

async function validateZip(zipPath, { maxBytes = DEFAULT_MAX_SOURCE_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const stat = await fsp.stat(zipPath);
  if (!stat.isFile()) throw new Error('Source ZIP tidak ditemukan di Server.');
  if (stat.size <= 0) throw new Error('Source ZIP kosong.');
  if (stat.size > maxBytes) throw new Error(`Source ZIP melebihi batas ${formatBytes(maxBytes)}.`);

  const entries = await listZipEntries(zipPath);
  if (!entries.length) throw new Error('ZIP tidak memiliki file.');
  if (entries.length > maxEntries) throw new Error(`ZIP memiliki terlalu banyak entry (${entries.length}). Maksimum ${maxEntries}.`);
  for (const entry of entries) {
    if (!validateZipEntryName(entry)) throw new Error(`Path ZIP tidak aman: ${entry}`);
  }
  return { size: stat.size, entries: entries.length };
}

async function extractZip(zipPath, targetDir, { onLine } = {}) {
  await ensureDir(targetDir);
  if (!commandExists('unzip')) throw new Error('Tool unzip tidak tersedia di Server. Install unzip sebelum build.');
  await runProcess('unzip', ['-o', '-q', zipPath, '-d', targetDir], targetDir, {
    timeoutMs: 30 * 60 * 1000,
    inactivityTimeoutMs: 10 * 60 * 1000,
    onLine,
    captureLimit: 8 * 1024 * 1024,
  });
}

async function findProjectRoot(baseDir, requiredFile, maxDepth = 3) {
  const queue = [{ dir: baseDir, depth: 0 }];
  while (queue.length) {
    const item = queue.shift();
    const target = path.join(item.dir, requiredFile);
    if (fs.existsSync(target)) return item.dir;
    if (item.depth >= maxDepth) continue;
    let entries;
    try { entries = await fsp.readdir(item.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      if (['.git', '.dart_tool', 'build', 'node_modules', '.gradle', '.idea', '.vscode'].includes(name)) continue;
      queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }
  return null;
}

async function findIndexHtml(root) {
  const direct = path.join(root, 'index.html');
  if (fs.existsSync(direct)) return direct;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth >= 3) continue;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'index.html') return p;
      if (entry.isDirectory()) queue.push({ dir: p, depth: depth + 1 });
    }
  }
  return null;
}

async function copyRecursive(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.cp(src, dest, { recursive: true, force: true, dereference: false });
}

function escapeXml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function androidSafePackage(name) {
  const base = String(name || 'ravenapp').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || 'ravenapp';
  return `com.devtoolsraven.web.${base}`;
}

async function generateWebAndroidProject(templateDir, outputDir, appName, indexRelativePath) {
  if (!fs.existsSync(templateDir)) throw new Error('Template Gradle Android tidak ditemukan di Server.');
  await copyRecursive(templateDir, outputDir);

  const packageName = androidSafePackage(appName);
  const javaRoot = path.join(outputDir, 'app', 'src', 'main', 'java');
  const oldPackageDir = path.join(javaRoot, 'com', 'web2apk', 'app');
  const packageDir = path.join(javaRoot, ...packageName.split('.'));
  if (fs.existsSync(oldPackageDir)) {
    await ensureDir(packageDir);
    const files = await fsp.readdir(oldPackageDir);
    for (const name of files) await copyRecursive(path.join(oldPackageDir, name), path.join(packageDir, name));
    await removePath(path.join(javaRoot, 'com'));
  }

  const buildGradle = path.join(outputDir, 'app', 'build.gradle');
  let appGradle = await fsp.readFile(buildGradle, 'utf8');
  appGradle = appGradle.replace(/applicationId\s+"[^"]+"/, `applicationId "${packageName}"`);
  appGradle = appGradle.replace(/namespace\s+'[^']+'/, `namespace '${packageName}'`);
  await fsp.writeFile(buildGradle, appGradle, 'utf8');

  const stringsPath = path.join(outputDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  if (fs.existsSync(stringsPath)) {
    let strings = await fsp.readFile(stringsPath, 'utf8');
    strings = strings.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${escapeXml(appName)}</string>`);
    await fsp.writeFile(stringsPath, strings, 'utf8');
  }

  const javaFiles = [];
  const stack = [packageDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (/\.java$/i.test(entry.name)) javaFiles.push(p);
    }
  }

  const localUrl = `file:///android_asset/${indexRelativePath.replace(/\\/g, '/')}`;
  const encoded = Buffer.from(localUrl.split('').reverse().join(''), 'utf8').toString('base64');
  for (const javaFile of javaFiles) {
    let source = await fsp.readFile(javaFile, 'utf8');
    source = source.replace(/^package\s+[\w.]+;/m, `package ${packageName};`);
    if (path.basename(javaFile) === 'MainActivity.java') {
      source = `package ${packageName};\n\n` +
        `import android.app.Activity;\n` +
        `import android.os.Bundle;\n` +
        `import android.webkit.WebChromeClient;\n` +
        `import android.webkit.WebSettings;\n` +
        `import android.webkit.WebView;\n\n` +
        `public class MainActivity extends Activity {\n` +
        `    private WebView webView;\n\n` +
        `    @Override\n` +
        `    protected void onCreate(Bundle savedInstanceState) {\n` +
        `        super.onCreate(savedInstanceState);\n` +
        `        webView = new WebView(this);\n` +
        `        WebSettings settings = webView.getSettings();\n` +
        `        settings.setJavaScriptEnabled(true);\n` +
        `        settings.setDomStorageEnabled(true);\n` +
        `        settings.setAllowFileAccess(true);\n` +
        `        settings.setAllowContentAccess(true);\n` +
        `        settings.setMediaPlaybackRequiresUserGesture(false);\n` +
        `        webView.setWebChromeClient(new WebChromeClient());\n` +
        `        webView.loadUrl(\"${localUrl.replace(/\"/g, '\\\"')}\");\n` +
        `        setContentView(webView);\n` +
        `    }\n\n` +
        `    @Override\n` +
        `    public void onBackPressed() {\n` +
        `        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();\n` +
        `    }\n` +
        `}\n`;
    } else {
      source = source.replace(/private static final String ENCODED_URL = \"[^\"]*\";/, `private static final String ENCODED_URL = \"${encoded}\";`);
      source = source.replace(/private static final String FALLBACK_URL = \"[^\"]*\";/, `private static final String FALLBACK_URL = \"${localUrl}\";`);
    }
    await fsp.writeFile(javaFile, source, 'utf8');
  }

  const manifestPath = path.join(outputDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    let manifest = await fsp.readFile(manifestPath, 'utf8');
    manifest = manifest.replace(/android:label="@string\/app_name"/, `android:label="@string/app_name"`);
    await fsp.writeFile(manifestPath, manifest, 'utf8');
  }

  const assetsRoot = path.join(outputDir, 'app', 'src', 'main', 'assets');
  await ensureDir(assetsRoot);
  return { packageName, assetsRoot };
}

function normalizeAssetPath(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('../') || clean === '..' || clean.startsWith('../')) return null;
  return clean;
}

async function copyWebProjectIntoAssets(projectRoot, assetsRoot) {
  await ensureDir(assetsRoot);
  const indexHtml = await findIndexHtml(projectRoot);
  if (!indexHtml) throw new Error('index.html tidak ditemukan pada project web.');
  const relIndex = path.relative(projectRoot, indexHtml).replace(/\\/g, '/');
  const copyRecursiveDir = async (src, dest) => {
    let entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(src, entry.name);
      const relative = path.relative(projectRoot, sourcePath).replace(/\\/g, '/');
      if (!relative || relative.split('/').some((part) => ['.git', 'node_modules', '.gradle', '.dart_tool'].includes(part.toLowerCase()))) continue;
      const targetPath = path.join(assetsRoot, relative);
      if (entry.isDirectory()) await copyRecursiveDir(sourcePath, targetPath);
      else if (entry.isFile()) {
        const safe = normalizeAssetPath(relative);
        if (safe) {
          await ensureDir(path.dirname(targetPath));
          await fsp.copyFile(sourcePath, targetPath);
        }
      }
    }
  };
  await copyRecursiveDir(projectRoot, assetsRoot);
  return relIndex;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

async function runProcess(command, args, cwd, options = {}) {
  const {
    env = process.env,
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    onLine,
    logPath,
    captureLimit = 4 * 1024 * 1024,
    job = null,
  } = options;

  await ensureDir(cwd);
  if (logPath) await ensureDir(path.dirname(logPath));
  let logHandle = null;
  try { if (logPath) logHandle = await fsp.open(logPath, 'a'); } catch (_) {}

  const child = spawn(command, args, {
    cwd,
    env: { ...env, CI: env.CI || '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  let lastActivity = Date.now();
  let lineBuffer = '';
  let timedOut = false;
  if (job && Array.isArray(job.__children)) job.__children.push(child);

  const append = async (text, isErr) => {
    const value = String(text || '');
    if (isErr) stderr += value; else stdout += value;
    const combined = isErr ? `[stderr] ${value}` : value;
    if (logHandle) { try { await logHandle.write(combined); } catch (_) {} }
    lineBuffer += value;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) if (line.trim() && onLine) onLine(line.trim());
  };

  child.stdout.on('data', (d) => { lastActivity = Date.now(); void append(d.toString(), false); });
  child.stderr.on('data', (d) => { lastActivity = Date.now(); void append(d.toString(), true); });

  const kill = async () => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
    } catch (_) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  };

  let timer = null;
  let inactivity = null;
  const cleanup = async () => {
    if (timer) clearTimeout(timer);
    if (inactivity) clearInterval(inactivity);
    if (logHandle) { try { await logHandle.close(); } catch (_) {} }
    if (job && Array.isArray(job.__children)) {
      const index = job.__children.indexOf(child);
      if (index >= 0) job.__children.splice(index, 1);
    }
  };

  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      await kill();
      reject(new Error(`Build dihentikan otomatis setelah melewati batas maksimum ${Math.round(timeoutMs / 60000)} menit.`));
    }, timeoutMs);
    inactivity = setInterval(async () => {
      if (Date.now() - lastActivity > inactivityTimeoutMs) {
        timedOut = true;
        await kill();
        reject(new Error(`Build tidak menghasilkan aktivitas selama ${Math.round(inactivityTimeoutMs / 60000)} menit.`));
      }
    }, 15_000);
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      if (lineBuffer.trim() && onLine) onLine(lineBuffer.trim());
      if (code === 0 && !timedOut) resolve({ code, signal, stdout, stderr });
      else if (!timedOut) {
        const msg = extractProcessError(stdout, stderr) || `Command ${command} gagal dengan exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
        reject(new Error(msg));
      }
    });
  }).finally(cleanup);

  return result;
}

function extractProcessError(stdout, stderr) {
  const all = `${stdout}\n${stderr}`;
  const lines = splitLines(all);
  const priority = lines.filter((line) => /FAILURE:|Execution failed for task|error:|Exception|Could not|A problem occurred|SDK location not found|license/i.test(line));
  const unique = [...new Set(priority)];
  return unique.slice(-8).join('\n').slice(0, 5000);
}

async function copySourceToBuildStorage(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await fsp.copyFile(sourcePath, targetPath);
}

async function streamDownload(url, destination, { maxBytes = DEFAULT_MAX_SOURCE_BYTES, onProgress } = {}) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 180000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: { 'User-Agent': 'Raven-Build-Server/3.0' },
  });
  await ensureDir(path.dirname(destination));
  const totalHeader = Number(response.headers?.['content-length'] || 0);
  if (totalHeader > maxBytes) throw new Error(`Source melebihi batas ${formatBytes(maxBytes)}.`);
  const stream = fs.createWriteStream(destination, { flags: 'w' });
  let downloaded = 0;
  let lastReport = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (downloaded > maxBytes) {
        response.data.destroy(new Error('SOURCE_TOO_LARGE'));
        return;
      }
      const now = Date.now();
      if (onProgress && (now - lastReport > 1000 || (totalHeader && downloaded === totalHeader))) {
        lastReport = now;
        onProgress({ downloaded, total: totalHeader });
      }
    });
    response.data.on('error', fail);
    stream.on('error', fail);
    stream.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    response.data.pipe(stream);
  }).catch(async (err) => {
    try { await response.data.destroy(); } catch (_) {}
    await removePath(destination);
    if (String(err?.message) === 'SOURCE_TOO_LARGE') throw new Error(`Source melebihi batas ${formatBytes(maxBytes)}.`);
    throw err;
  });
  return { bytes: downloaded, total: totalHeader || downloaded };
}

class LocalBuildManager {
  constructor({ rootDir, templateDir, concurrency } = {}) {
    this.rootDir = path.resolve(rootDir || path.join(process.cwd(), 'data', 'builds'));
    this.templateDir = path.resolve(templateDir || path.join(process.cwd(), 'server-build', 'android-template'));
    this.concurrency = Math.max(1, Number(concurrency || process.env.BUILD_CONCURRENCY || DEFAULT_QUEUE_CONCURRENCY));
    this.queue = [];
    this.running = new Map();
    this.allJobs = new Map();
    this.draining = false;
  }

  async init() {
    await ensureDir(this.rootDir);
  }

  enqueue(job) {
    const id = job.id || buildJobId();
    const normalized = { ...job, id, queuedAt: Date.now() };
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ ...normalized, resolve, reject });
      this.allJobs.set(id, { ...normalized, state: 'queued' });
    });
    void this._drain();
    return promise;
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.running.size < this.concurrency) {
        const job = this.queue.shift();
        if (!job) continue;
        this.running.set(job.id, job);
        this.allJobs.set(job.id, { ...job, state: 'running', startedAt: Date.now() });
        void this._run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  async _run(job) {
    try {
      const result = await this._build(job);
      this.allJobs.set(job.id, { ...this.allJobs.get(job.id), state: 'done', completedAt: Date.now() });
      job.resolve(result);
    } catch (error) {
      this.allJobs.set(job.id, { ...this.allJobs.get(job.id), state: 'failed', completedAt: Date.now(), error: error.message });
      job.reject(error);
    } finally {
      this.running.delete(job.id);
      void this._drain();
    }
  }

  async cancel(id) {
    const queuedIndex = this.queue.findIndex((j) => j.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      this.allJobs.set(id, { ...this.allJobs.get(id), state: 'cancelled', completedAt: Date.now() });
      job.reject(Object.assign(new Error('Build dibatalkan user.'), { code: 'BUILD_CANCELLED' }));
      return true;
    }
    const active = this.running.get(id);
    if (!active || !active.__children) return false;
    active.__cancelRequested = true;
    for (const proc of active.__children) {
      try {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM');
        else spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
      } catch (_) {}
    }
    return true;
  }

  async cancelByUser(userId) {
    const id = Number(userId);
    const queued = this.queue.filter((j) => Number(j.userId) === id).map((j) => j.id);
    const active = [...this.running.values()].filter((j) => Number(j.userId) === id).map((j) => j.id);
    for (const jobId of [...queued, ...active]) await this.cancel(jobId);
    return queued.length + active.length;
  }

  async preflight(kind = 'flutter') {
    const result = { ok: true, checks: [] };
    const check = (name, ok, detail) => {
      result.checks.push({ name, ok, detail });
      if (!ok) result.ok = false;
    };

    check('Node.js', Number(process.versions.node.split('.')[0]) >= 18, process.version);
    check('ZIP extractor', commandExists('unzip'), commandExists('unzip') ? 'unzip tersedia' : 'unzip tidak tersedia');
    check('Java', commandExists('java'), commandExists('java') ? 'java tersedia' : 'java tidak tersedia');
    const sdk = resolveAndroidSdk();
    check('Android SDK', Boolean(sdk), sdk || 'ANDROID_SDK_ROOT/ANDROID_HOME tidak ditemukan');
    if (kind === 'flutter') {
      check('Flutter SDK', commandExists(process.env.FLUTTER_BIN || 'flutter'), commandExists(process.env.FLUTTER_BIN || 'flutter') ? 'flutter tersedia' : 'flutter tidak tersedia');
    } else {
      const globalGradle = commandExists(process.env.GRADLE_BIN || 'gradle');
      check('Gradle', globalGradle || fs.existsSync(path.join(this.templateDir, 'gradlew')), globalGradle ? 'gradle tersedia' : 'template wrapper tersedia');
    }
    if (commandExists('java')) {
      try {
        const version = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 5000 });
        const text = `${version.stderr || ''}\n${version.stdout || ''}`;
        const m = text.match(/version\s+"(\d+)(?:\.(\d+))?/i);
        if (m && Number(m[1]) > 17 && Number(m[1]) < 21) check('Java compatibility', false, `Java ${m[1]} tidak ditargetkan oleh template Gradle 7.5/AGP 7.4.2`);
        if (m && Number(m[1]) >= 21 && kind === 'android') check('Java compatibility', false, `Java ${m[1]} tidak cocok dengan template Gradle 7.5/AGP 7.4.2; gunakan Java 17 untuk build ini`);
      } catch (_) {}
    }
    return result;
  }

  async _build(job) {
    const jobDir = path.join(this.rootDir, job.id);
    const logPath = path.join(jobDir, 'build.log');
    const sourcePath = path.join(jobDir, 'source.zip');
    const workingSourcePath = path.join(jobDir, '.source.zip');
    const projectDir = path.join(jobDir, 'project');
    const outputDir = path.join(jobDir, 'output');
    await ensureDir(jobDir);
    job.__children = [];
    let lastHeartbeat = Date.now();

    const update = async (patch) => {
      lastHeartbeat = Date.now();
      if (typeof job.onUpdate === 'function') {
        try { await job.onUpdate({ ...patch, jobId: job.id }); } catch (_) {}
      }
    };
    const heartbeat = setInterval(() => {
      if (typeof job.onHeartbeat === 'function') {
        void job.onHeartbeat({ jobId: job.id, idleMs: Date.now() - lastHeartbeat });
      }
    }, 15_000);

    const run = async (command, args, cwd, opts = {}) => {
      const env = {
        ...process.env,
        ...opts.env,
        TERM: process.env.TERM || 'dumb',
        CI: '1',
      };
      const childPromise = runProcess(command, args, cwd, {
        ...opts,
        env,
        logPath,
        job,
        onLine: async (line) => {
          lastHeartbeat = Date.now();
          if (typeof job.onLine === 'function') {
            try { await job.onLine(line, job); } catch (_) {}
          }
          if (typeof opts.onLine === 'function') {
            try { await opts.onLine(line); } catch (_) {}
          }
        },
      });
      return childPromise;
    };

    try {
      await update({ state: 'running', stage: 'SERVER_READY', progress: 4, detail: 'Server build siap.' });
      if (job.source?.kind === 'telegram' || job.source?.kind === 'url') {
        await update({ stage: 'SOURCE_DOWNLOAD_START', progress: 8, detail: 'Mengunduh source ke Server…' });
        await streamDownload(job.source.url, workingSourcePath, {
          maxBytes: Number(job.maxSourceBytes || DEFAULT_MAX_SOURCE_BYTES),
          onProgress: ({ downloaded, total }) => {
            const ratio = total ? Math.min(1, downloaded / total) : 0;
            const progress = 8 + Math.round(ratio * 10);
            if (typeof job.onUpdate === 'function') void job.onUpdate({ jobId: job.id, stage: 'SOURCE_DOWNLOAD_PROGRESS', progress, detail: total ? `Mengunduh source ${formatBytes(downloaded)} / ${formatBytes(total)}` : `Mengunduh source ${formatBytes(downloaded)}` });
          },
        });
      } else if (job.source?.kind === 'file') {
        await fsp.copyFile(job.source.path, workingSourcePath);
      } else {
        throw new Error('Sumber build tidak dikenali.');
      }

      const zipInfo = await validateZip(workingSourcePath, { maxBytes: Number(job.maxSourceBytes || DEFAULT_MAX_SOURCE_BYTES) });
      await copySourceToBuildStorage(workingSourcePath, sourcePath);
      await update({ stage: 'SOURCE_VALIDATED', progress: 22, detail: `ZIP valid · ${zipInfo.entries} entry · ${formatBytes(zipInfo.size)}` });

      await extractZip(workingSourcePath, projectDir, { onLine: (line) => { if (typeof job.onLine === 'function') void job.onLine(`ZIP: ${line}`); } });
      await update({ stage: 'PROJECT_EXTRACTED', progress: 30, detail: 'Project berhasil diekstrak.' });

      if (job.kind === 'flutter') {
        return await this._buildFlutter(job, projectDir, outputDir, run, update);
      }
      if (job.kind === 'web') {
        return await this._buildWeb(job, projectDir, outputDir, run, update);
      }
      throw new Error(`Jenis build tidak didukung: ${job.kind}`);
    } catch (error) {
      if (job.__cancelRequested || error?.code === 'BUILD_CANCELLED') {
        await update({ state: 'cancelled', stage: 'CANCELLED', progress: 100, detail: 'Build dibatalkan.' });
        throw Object.assign(new Error('Build dibatalkan user.'), { code: 'BUILD_CANCELLED', logPath });
      }
      error.logPath = logPath;
      await update({ state: 'failed', stage: 'BUILD_FAILED', progress: 100, detail: error.message || 'Build gagal.', error: error.message, logPath });
      throw error;
    } finally {
      clearInterval(heartbeat);
      delete job.__children;
      await removePath(projectDir);
      await removePath(workingSourcePath);
      // source.zip intentionally remains in persistent job storage so Owner
      // can retrieve the original source for successful and failed builds.
    }
  }

  async _buildFlutter(job, projectDir, outputDir, run, update) {
    const pubspec = path.join(projectDir, 'pubspec.yaml');
    const androidDir = path.join(projectDir, 'android');
    if (!fs.existsSync(pubspec)) throw new Error('pubspec.yaml tidak ditemukan di root project Flutter.');
    if (!fs.existsSync(androidDir)) throw new Error('Folder android/ tidak ditemukan di project Flutter.');

    const sdk = await writeLocalProperties(projectDir);
    if (!sdk) throw new Error('Android SDK tidak ditemukan. Set ANDROID_HOME/ANDROID_SDK_ROOT di Server.');
    appendGradleStability(projectDir);

    const flutter = process.env.FLUTTER_BIN || 'flutter';
    if (!commandExists(flutter)) throw new Error('Flutter SDK tidak tersedia di Server.');
    if (!commandExists('java')) throw new Error('Java tidak tersedia di Server.');

    await update({ stage: 'TOOLCHAIN_READY', progress: 36, detail: `Flutter + Java + Android SDK siap · SDK ${sdk}` });
    await run(flutter, ['clean'], projectDir, { timeoutMs: 20 * 60 * 1000, inactivityTimeoutMs: 8 * 60 * 1000 });
    await update({ stage: 'DEPENDENCIES_START', progress: 44, detail: 'Mengambil dependency Flutter…' });
    await run(flutter, ['pub', 'get'], projectDir, { timeoutMs: 30 * 60 * 1000, inactivityTimeoutMs: 10 * 60 * 1000 });
    await update({ stage: 'DEPENDENCIES_READY', progress: 55, detail: 'Dependency Flutter siap.' });

    const mode = job.mode === 'debug' ? 'debug' : 'release';
    await update({ stage: 'BUILDING_APK', progress: 62, detail: `Kompilasi Flutter APK ${mode.toUpperCase()} sedang berjalan…` });
    await run(flutter, ['build', 'apk', `--${mode}`], projectDir, {
      timeoutMs: Number(process.env.BUILD_TIMEOUT_MS || 120 * 60 * 1000),
      inactivityTimeoutMs: Number(process.env.BUILD_INACTIVITY_MS || 15 * 60 * 1000),
      onLine: (line) => {
        const low = String(line).toLowerCase();
        if (/built .*\.apk/.test(low)) void update({ stage: 'APK_READY', progress: 94, detail: line });
        else if (/assemble|gradle|compile|linking|packag|running/i.test(low)) void update({ stage: 'BUILDING_APK', progress: 70, detail: line.slice(0, 220) });
      },
    });

    const apkCandidates = [
      path.join(projectDir, 'build', 'app', 'outputs', 'flutter-apk', `app-${mode}.apk`),
      path.join(projectDir, 'build', 'app', 'outputs', 'apk', mode, `app-${mode}.apk`),
    ];
    const apkPath = apkCandidates.find((p) => fs.existsSync(p));
    if (!apkPath) throw new Error('Build command selesai tetapi APK tidak ditemukan di output Flutter.');

    await ensureDir(outputDir);
    const finalName = `${safeName(job.projectName || 'flutter-app')}-${mode}-${Date.now()}.apk`;
    const finalPath = path.join(outputDir, finalName);
    await fsp.copyFile(apkPath, finalPath);
    const size = (await fsp.stat(finalPath)).size;
    await update({ state: 'built', stage: 'APK_READY', progress: 96, detail: `APK siap · ${formatBytes(size)}`, apkPath: finalPath, apkSize: size, apkFilename: finalName, logPath: path.join(this.rootDir, job.id, 'build.log') });
    return { success: true, apkPath: finalPath, apkSize: size, apkFilename: finalName, logPath: path.join(this.rootDir, job.id, 'build.log'), sourcePath: path.join(this.rootDir, job.id, 'source.zip') };
  }

  async _buildWeb(job, projectDir, outputDir, run, update) {
    const indexHtml = await findIndexHtml(projectDir);
    if (!indexHtml) throw new Error('index.html tidak ditemukan di project web.');
    const relIndex = path.relative(projectDir, indexHtml).replace(/\\/g, '/');
    const templateOutput = path.join(this.rootDir, job.id, 'android-web');
    await generateWebAndroidProject(this.templateDir, templateOutput, job.projectName || 'Raven Web', relIndex);
    const assetsRoot = path.join(templateOutput, 'app', 'src', 'main', 'assets');
    const actualIndex = await copyWebProjectIntoAssets(projectDir, assetsRoot);
    await update({ stage: 'PROJECT_VALIDATED', progress: 38, detail: `Web project siap · index.html=${actualIndex}` });

    const sdk = resolveAndroidSdk();
    if (!sdk) throw new Error('Android SDK tidak ditemukan di Server.');
    await update({ stage: 'TOOLCHAIN_READY', progress: 48, detail: `Gradle template siap · SDK ${sdk}` });
    const wrapper = path.join(templateOutput, 'gradlew');
    const globalGradle = process.env.GRADLE_BIN || 'gradle';
    let gradleCmd = null;
    if (fs.existsSync(wrapper) && fs.existsSync(path.join(templateOutput, 'gradle', 'wrapper', 'gradle-wrapper.jar'))) {
      try { await fsp.chmod(wrapper, 0o755); } catch (_) {}
      gradleCmd = wrapper;
    } else if (commandExists(globalGradle)) {
      gradleCmd = globalGradle;
    } else {
      throw new Error('Gradle tidak tersedia. Template membutuhkan Gradle 7.5/AGP 7.4.2 atau global Gradle di Server.');
    }

    const task = 'assembleRelease';
    await update({ stage: 'BUILDING_APK', progress: 62, detail: 'Gradle sedang mengompilasi APK Web…' });
    await run(gradleCmd, [task, '--no-daemon', '--stacktrace', '--max-workers=2'], templateOutput, {
      timeoutMs: Number(process.env.BUILD_TIMEOUT_MS || 90 * 60 * 1000),
      inactivityTimeoutMs: Number(process.env.BUILD_INACTIVITY_MS || 15 * 60 * 1000),
      onLine: (line) => {
        const low = line.toLowerCase();
        if (/assemble|compile|merge|dex|package|resource/i.test(low)) void update({ stage: 'BUILDING_APK', progress: 72, detail: line.slice(0, 220) });
      },
    });

    const apkCandidates = [
      path.join(templateOutput, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
      path.join(templateOutput, 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
    ];
    const apkPath = apkCandidates.find((p) => fs.existsSync(p));
    if (!apkPath) throw new Error('Gradle selesai tetapi APK Web tidak ditemukan.');
    await ensureDir(outputDir);
    const finalName = `${safeName(job.projectName || 'web-app')}-release-${Date.now()}.apk`;
    const finalPath = path.join(outputDir, finalName);
    await fsp.copyFile(apkPath, finalPath);
    const size = (await fsp.stat(finalPath)).size;
    await update({ state: 'built', stage: 'APK_READY', progress: 96, detail: `APK siap · ${formatBytes(size)}`, apkPath: finalPath, apkSize: size, apkFilename: finalName, logPath: path.join(this.rootDir, job.id, 'build.log') });
    return { success: true, apkPath: finalPath, apkSize: size, apkFilename: finalName, logPath: path.join(this.rootDir, job.id, 'build.log'), sourcePath: path.join(this.rootDir, job.id, 'source.zip') };
  }
}

module.exports = {
  LocalBuildManager,
  streamDownload,
  validateZip,
  extractZip,
  findProjectRoot,
  findIndexHtml,
  resolveAndroidSdk,
  commandExists,
  formatBytes,
  buildJobId,
};
