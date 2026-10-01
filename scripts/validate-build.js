'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith('.js')) jsFiles.push(full);
  }
}
walk(root);

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(`Node syntax ${path.relative(root, file)}`, result.status === 0, result.status === 0 ? '' : (result.stderr || result.stdout || 'syntax error').trim().split('\n').slice(-3).join(' '));
}

let packageJson = null;
try { packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (error) { check('package.json valid JSON', false, error.message); }
if (packageJson) {
  check('package.json dependencies', Boolean(packageJson.dependencies?.axios && packageJson.dependencies?.telegraf && packageJson.dependencies?.jszip), 'axios + telegraf + jszip');
  check('start script', packageJson.scripts?.start === 'node server.js', packageJson.scripts?.start || 'missing');
  check('validate script', packageJson.scripts?.validate === 'node scripts/validate-build.js', packageJson.scripts?.validate || 'missing');
}

const required = [
  'server.js',
  'api/bot.js',
  'api/local-build-engine.js',
  'api/assets-embedded.js',
  'server-build/android-template/build.gradle',
  'server-build/android-template/app/build.gradle',
  'server-build/android-template/settings.gradle',
  'server-build/android-template/gradle/wrapper/gradle-wrapper.properties',
];
for (const rel of required) check(`Required file ${rel}`, exists(rel));

if (exists('server-build/android-template/build.gradle')) {
  const build = fs.readFileSync(path.join(root, 'server-build/android-template/build.gradle'), 'utf8');
  check('Gradle template AGP', /com\.android\.application[^\n]*version ['"]7\.4\.2['"]/.test(build), 'AGP 7.4.2');
}
if (exists('server-build/android-template/gradle/wrapper/gradle-wrapper.properties')) {
  const props = fs.readFileSync(path.join(root, 'server-build/android-template/gradle/wrapper/gradle-wrapper.properties'), 'utf8');
  check('Gradle template version', /gradle-7\.5-bin\.zip/.test(props), 'Gradle 7.5 distribution URL');
}

const bot = fs.readFileSync(path.join(root, 'api/bot.js'), 'utf8');
check('Real local build engine wired', /localBuildManager\s*=\s*new LocalBuildManager/.test(bot) && /startLocalBuild\(/.test(bot), 'Server build manager');
check('Build document handler no longer dispatches remote build', !/await runTelegramFlutterBuild\(/.test(bot) && !/await runGithubActionsBuild\(/.test(bot), 'local server flow');
check('Build status uses Server', !/GitHub Actions Worker/.test(bot), 'no build UI worker label');
check('Build cancellation callback exists', /build_cancel:\$\{jobId\}/.test(bot) && /bot\.action\(\/\^build_cancel/.test(bot));
check('Owner build lists exclude owner', /owner_builds.*[\s\S]{0,400}filter\(\(b\) => !isOwnerId\(b\.userId\)\)/.test(bot));
check('Owner ZIP picker excludes owner', /owner_build_picker.*[\s\S]{0,400}filter\(\(b\) => !isOwnerId\(b\.userId\)\)/.test(bot));
check('Duplicate owner List Web button removed', (() => {
  const section = bot.slice(bot.indexOf('function ownerPanelMarkup()'), bot.indexOf('function deploymentMenuMarkup()'));
  return (section.match(/'list_web'/g) || []).length === 0;
})());
check('Build UI has no home/menu button while running', /function buildCancelKeyboard\(jobId\)[\s\S]*?Batalkan Build[\s\S]*?function buildTerminalKeyboard/.test(bot));
check('.env is not part of this build patch', !exists('.env'));

console.log(`\nValidation selesai: ${checks} checks · ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
