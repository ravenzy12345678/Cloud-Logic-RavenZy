'use strict';

const JSZip = require('jszip');
const path = require('path');

function isTextFile(name) {
  return /\.(dart|yaml|yml|json|xml|gradle|properties|kt|java|js|ts|html|css|md|txt|arb|plist|iml)$/i.test(name);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanRenameFiles(files) {
  const appNames = [];
  const domains = new Set();
  const iconFiles = [];
  const seen = new Set();
  for (const file of files) {
    const name = String(file.path || '').replace(/\\/g, '/');
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name) && /(^|\/)(assets|res|mipmap|drawable|icons?)(\/|$)/i.test(name)) {
      iconFiles.push(name);
    }
    if (!isTextFile(name)) continue;
    let text;
    try { text = file.buffer.toString('utf8'); } catch (_) { continue; }
    const pubspec = /(^|\/)pubspec\.yaml$/i.test(name);
    if (pubspec) {
      const m = text.match(/^name:\s*([^#\r\n]+)\s*$/m);
      if (m?.[1]?.trim()) {
        const value = m[1].trim();
        if (!seen.has(value)) { seen.add(value); appNames.push({ value, source: name }); }
      }
    }
    const title = text.match(/<string[^>]+name=["']app_name["'][^>]*>([^<]+)</i)?.[1]
      || text.match(/android:label=["']([^"']+)["']/i)?.[1];
    if (title?.trim() && !seen.has(title.trim())) {
      const value = title.trim();
      seen.add(value); appNames.push({ value, source: name });
    }
    for (const m of text.matchAll(/https?:\/\/[^\s'"<>`)]+/gi)) {
      const value = m[0].replace(/[),.;]+$/, '');
      if (value) domains.add(value);
    }
  }
  return { appNames, domains: [...domains], iconFiles: [...new Set(iconFiles)] };
}

function replaceAllSafe(text, oldValue, newValue) {
  if (!oldValue || !newValue) return { text, count: 0 };
  const re = new RegExp(escapeRegExp(oldValue), 'g');
  let count = 0;
  const out = String(text).replace(re, () => { count += 1; return String(newValue); });
  return { text: out, count };
}

async function extractZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const files = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!name || name.includes('..')) continue;
    files.push({ path: name.replace(/\\/g, '/'), buffer: await entry.async('nodebuffer') });
  }
  return files;
}

async function transformZip(buffer, mode, values = {}) {
  const files = await extractZip(buffer);
  let changedFiles = 0;
  let replacementCount = 0;
  const renamedFiles = [];
  const appOlds = Array.isArray(values.appOlds) ? values.appOlds : [];
  const domainOlds = Array.isArray(values.domainOlds) ? values.domainOlds : [];
  const iconOlds = Array.isArray(values.iconOlds) ? values.iconOlds : [];
  const output = new JSZip();

  for (const file of files) {
    const originalName = file.path;
    let name = originalName;
    let data = Buffer.from(file.buffer);
    if (isTextFile(name)) {
      let text = data.toString('utf8');
      const before = text;
      const replacements = [];
      if (mode === 'all' || mode === 'app') for (const old of appOlds) replacements.push([old, values.appName]);
      if (mode === 'all' || mode === 'domain') for (const old of domainOlds) replacements.push([old, values.domain]);
      for (const [old, next] of replacements) {
        const r = replaceAllSafe(text, old, next);
        text = r.text; replacementCount += r.count;
      }
      if ((mode === 'all' || mode === 'icon') && values.iconName) {
        for (const old of iconOlds) {
          const base = path.basename(old, path.extname(old));
          if (!base) continue;
          const re = new RegExp(`\\b${escapeRegExp(base)}\\b`, 'g');
          text = text.replace(re, values.iconName);
        }
      }
      if (text !== before) changedFiles += 1;
      data = Buffer.from(text, 'utf8');
    }
    if ((mode === 'all' || mode === 'icon') && values.iconName) {
      const targets = iconOlds.length ? iconOlds : (/(png|jpe?g|webp|gif|svg)$/i.test(name) ? [name] : []);
      if (targets.includes(originalName)) {
        const ext = path.extname(name);
        const dir = path.dirname(name);
        name = `${dir === '.' ? '' : `${dir}/`}${values.iconName}${ext}`.replace(/^\//, '');
        if (name !== originalName) renamedFiles.push({ from: originalName, to: name });
      }
    }
    output.file(name, data);
  }

  return {
    buffer: await output.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    files,
    changedFiles,
    replacementCount,
    renamedFiles,
  };
}

function parseIndexed(raw, max) {
  const value = String(raw || '').trim();
  const m = value.match(/^(all|\d+)\s*\|\s*(.+)$/i);
  if (m) {
    if (m[1].toLowerCase() === 'all') return { mode: 'all', value: m[2].trim() };
    const index = Number(m[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= max) return null;
    return { mode: 'one', index, value: m[2].trim() };
  }
  return max === 1 && value ? { mode: 'one', index: 0, value } : null;
}

module.exports = { extractZip, scanRenameFiles, transformZip, parseIndexed };
