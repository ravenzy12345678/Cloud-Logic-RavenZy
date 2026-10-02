'use strict';

const axios = require('axios');
const JSZip = require('jszip');
const crypto = require('crypto');

const GH_API = 'https://api.github.com';

function env() {
  return {
    token: process.env.TOKEN_GITHUB || process.env.GITHUB_TOKEN,
    owner: process.env.PEMILIK_GITHUB || process.env.GITHUB_OWNER,
    repo: process.env.REPO_GITHUB || process.env.GITHUB_REPO,
    branch: process.env.CABANG_GITHUB || process.env.GITHUB_BRANCH || 'main',
  };
}

function headers() {
  const e = env();
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${e.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

async function gh(method, path, data, config = {}) {
  return axios({ method, url: `${GH_API}${path}`, headers: { ...headers(), ...(config.headers || {}) }, data, params: config.params, timeout: config.timeout || 60000, responseType: config.responseType, maxContentLength: config.maxContentLength, maxBodyLength: config.maxBodyLength, validateStatus: config.validateStatus });
}

function safeSlug(value) {
  return String(value || 'build').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'build';
}

function workflowYml() {
  return WORKFLOW;
}

function androidWorkflowYml() {
  return ANDROID_WORKFLOW.replaceAll('\\${{', '${{');
}

async function createRepo(name) {
  const e = env();
  const r = await gh('POST', '/user/repos', { name, description: `Raven Flutter build ${name}`, private: true, auto_init: true });
  if (String(r.data?.owner?.login || '').toLowerCase() !== String(e.owner || '').toLowerCase()) throw new Error('Server token owner mismatch.');
  return r.data;
}

async function getRef(owner, repo, branch) {
  const r = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  return r.data.object.sha;
}

async function getCommit(owner, repo, sha) {
  const r = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(sha)}`);
  return r.data;
}

async function createBlob(owner, repo, buffer) {
  const r = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, { content: Buffer.from(buffer).toString('base64'), encoding: 'base64' }, { maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 120000 });
  return r.data.sha;
}

async function uploadFiles(repo, files) {
  const owner = repo.owner.login;
  const branch = repo.default_branch || 'main';
  const parentSha = await getRef(owner, repo.name, branch);
  const parent = await getCommit(owner, repo.name, parentSha);
  const entries = [];
  for (const file of files) {
    const clean = String(file.path || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) continue;
    entries.push({ path: clean, mode: '100644', type: 'blob', sha: await createBlob(owner, repo.name, file.buffer) });
  }
  if (!entries.length) throw new Error('Tidak ada file source yang valid untuk diupload.');
  const tree = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
  const commit = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/git/commits`, { message: 'build: Raven Flutter source', tree: tree.data.sha, parents: [parentSha] });
  await gh('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.data.sha });
  return { branch, commitSha: commit.data.sha };
}

async function dispatchWorkflow(repo, jobId, mode, callbackUrl, callbackSecret, workflowFile = 'raven-flutter-build.yml', extraInputs = {}) {
  const owner = repo.owner.login;
  const safeWorkflowFile = String(workflowFile || 'raven-flutter-build.yml').replace(/[^a-zA-Z0-9._-]/g, '');
  const inputs = { mode, job_id: jobId, callback_url: callbackUrl, callback_secret: callbackSecret };
  for (const [key, value] of Object.entries(extraInputs || {})) {
    if (value !== undefined && value !== null) inputs[key] = String(value);
  }
  const response = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}/actions/workflows/${encodeURIComponent(safeWorkflowFile)}/dispatches`, {
    ref: repo.default_branch || 'main',
    inputs,
  }, { timeout: 30000, validateStatus: (status) => status >= 200 && status < 300 });
  return { dispatched: true, status: response.status || 204 };
}

async function dispatchRepositoryEvent(repo, eventType, clientPayload = {}) {
  const owner = repo.owner.login;
  const repository = repo.name;
  const response = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/dispatches`, {
    event_type: String(eventType || 'raven_build').slice(0, 100),
    client_payload: Object.fromEntries(
      Object.entries(clientPayload || {}).map(([key, value]) => [String(key).slice(0, 100), (value && typeof value === 'object') ? value : String(value ?? '')])
    ),
  }, { timeout: 30000, validateStatus: (status) => status >= 200 && status < 300 });
  return { dispatched: true, status: response.status || 204 };
}

async function createRelease(owner, repo, jobId, name) {
  const tag = `raven-build-${jobId}`;
  const response = await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`, { tag_name: tag, target_commitish: env().branch, name: `Raven Build ${name}`, body: `Original source backup for Raven build ${jobId}.`, draft: false, prerelease: true, generate_release_notes: false });
  return response.data;
}

async function uploadReleaseAsset(release, filename, buffer) {
  const uploadUrl = String(release.upload_url || '').replace(/\{\?.*\}$/, '');
  if (!uploadUrl) throw new Error('Server release upload URL tidak tersedia.');
  const response = await axios.post(`${uploadUrl}?name=${encodeURIComponent(filename)}`, buffer, { headers: { ...headers(), 'Content-Type': 'application/zip' }, timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: () => true });
  if (response.status < 200 || response.status >= 300) throw new Error(`Server release asset HTTP ${response.status}`);
  return response.data;
}

async function downloadReleaseAsset(assetId) {
  const e = env();
  const response = await axios.get(`${GH_API}/repos/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.repo)}/releases/assets/${encodeURIComponent(assetId)}`, { headers: { ...headers(), Accept: 'application/octet-stream' }, responseType: 'arraybuffer', timeout: 120000, maxContentLength: 120 * 1024 * 1024, maxRedirects: 5, validateStatus: (status) => status >= 200 && status < 400 });
  return Buffer.from(response.data);
}

async function getArtifact(owner, repo, runId, jobId) {
  const list = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/artifacts`, null, { params: { per_page: 100 } });
  const item = (list.data?.artifacts || []).find((a) => a.name === `raven-apk-${jobId}` && !a.expired) || list.data?.artifacts?.find((a) => !a.expired);
  if (!item?.id) throw new Error('Artifact APK tidak ditemukan.');
  const r = await axios.get(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts/${encodeURIComponent(item.id)}/zip`, { headers: { ...headers(), Accept: 'application/octet-stream' }, responseType: 'arraybuffer', timeout: 120000, maxRedirects: 5, validateStatus: (status) => status >= 200 && status < 400, maxContentLength: 120 * 1024 * 1024 });
  const zip = await JSZip.loadAsync(Buffer.from(r.data));
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir && /\.apk$/i.test(name)) return { buffer: await entry.async('nodebuffer'), name: name.split('/').pop() };
  throw new Error('Artifact tidak berisi APK.');
}

async function cancelRun(owner, repo, runId) {
  if (!runId) return false;
  await gh('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/cancel`, null, { timeout: 30000 });
  return true;
}

async function findRunByJobId(owner, repo, jobId) {
  const r = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, null, { params: { per_page: 30 }, timeout: 30000 });
  const runs = r.data?.workflow_runs || [];
  const needle = String(jobId || '');
  const hit = runs.find((x) => String(x.display_title || x.name || '').includes(needle)) || runs.find((x) => x.status !== 'completed' && String(repo).includes(needle));
  return hit ? String(hit.id) : null;
}

async function getRun(owner, repo, runId) {
  const r = await gh('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`);
  return r.data;
}

async function downloadRunLogs(owner, repo, runId) {
  const r = await axios.get(`${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}/logs`, { headers: { ...headers(), Accept: 'application/vnd.github+json' }, responseType: 'arraybuffer', timeout: 120000, maxRedirects: 5, validateStatus: (status) => status >= 200 && status < 400, maxContentLength: 50 * 1024 * 1024 });
  return Buffer.from(r.data);
}

async function deleteRepo(owner, repo) {
  await gh('DELETE', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

function buildId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

const WORKFLOW = "name: Raven Flutter Build\n\non:\n  workflow_dispatch:\n    inputs:\n      mode:\n        description: Build mode\n        required: true\n        default: release\n        type: choice\n        options: [debug, release]\n      job_id:\n        description: Raven build id\n        required: true\n        type: string\n      callback_url:\n        description: Raven callback URL\n        required: true\n        type: string\n      callback_secret:\n        description: Per-build callback secret\n        required: true\n        type: string\n\npermissions:\n  contents: read\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n      - name: Checkout source\n        uses: actions/checkout@v4\n\n      - name: Setup Java 17\n        uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: '17'\n\n      - name: Setup Flutter\n        uses: subosito/flutter-action@v2\n        with:\n          channel: stable\n          cache: true\n\n      - name: Setup Android SDK\n        uses: android-actions/setup-android@v3\n\n      - name: Notify setup\n        env:\n          INPUT_CALLBACK_URL: ${{ inputs.callback_url }}\n          INPUT_CALLBACK_SECRET: ${{ inputs.callback_secret }}\n          INPUT_JOB_ID: ${{ inputs.job_id }}\n        shell: bash\n        run: |\n          curl -fsS -X POST -H 'content-type: application/json' \"$INPUT_CALLBACK_URL\" -d \"{\\\"jobId\\\":\\\"$INPUT_JOB_ID\\\",\\\"secret\\\":\\\"$INPUT_CALLBACK_SECRET\\\",\\\"status\\\":\\\"RUNNING\\\",\\\"stage\\\":\\\"SETUP_READY\\\",\\\"runId\\\":\\\"$GITHUB_RUN_ID\\\"}\" || true\n\n      - name: Locate Flutter project\n        id: project\n        shell: bash\n        run: |\n          set -e\n          PROJECT_DIR=\"$(find . -maxdepth 6 -name pubspec.yaml -print -quit | xargs -r dirname)\"\n          if [ -z \"$PROJECT_DIR\" ]; then PROJECT_DIR='.'; fi\n          echo \"dir=$PROJECT_DIR\" >> \"$GITHUB_OUTPUT\"\n          echo \"Flutter project: $PROJECT_DIR\"\n\n      - name: Flutter pub get\n        working-directory: ${{ steps.project.outputs.dir }}\n        env:\n          INPUT_CALLBACK_URL: ${{ inputs.callback_url }}\n          INPUT_CALLBACK_SECRET: ${{ inputs.callback_secret }}\n          INPUT_JOB_ID: ${{ inputs.job_id }}\n        shell: bash\n        run: |\n          set -e\n          flutter --version\n          flutter pub get\n          curl -fsS -X POST -H 'content-type: application/json' \"$INPUT_CALLBACK_URL\" -d \"{\\\"jobId\\\":\\\"$INPUT_JOB_ID\\\",\\\"secret\\\":\\\"$INPUT_CALLBACK_SECRET\\\",\\\"status\\\":\\\"RUNNING\\\",\\\"stage\\\":\\\"DEPENDENCIES_READY\\\",\\\"runId\\\":\\\"$GITHUB_RUN_ID\\\"}\" || true\n\n      - name: Flutter build\n        working-directory: ${{ steps.project.outputs.dir }}\n        env:\n          INPUT_CALLBACK_URL: ${{ inputs.callback_url }}\n          INPUT_CALLBACK_SECRET: ${{ inputs.callback_secret }}\n          INPUT_JOB_ID: ${{ inputs.job_id }}\n        shell: bash\n        run: |\n          set -e\n          curl -fsS -X POST -H 'content-type: application/json' \"$INPUT_CALLBACK_URL\" -d \"{\\\"jobId\\\":\\\"$INPUT_JOB_ID\\\",\\\"secret\\\":\\\"$INPUT_CALLBACK_SECRET\\\",\\\"status\\\":\\\"RUNNING\\\",\\\"stage\\\":\\\"BUILDING_APK\\\",\\\"runId\\\":\\\"$GITHUB_RUN_ID\\\"}\" || true\n          flutter build apk --${{ inputs.mode }} --no-pub\n\n      - name: Upload APK artifact\n        if: success()\n        uses: actions/upload-artifact@v4\n        with:\n          name: raven-apk-${{ inputs.job_id }}\n          path: ${{ steps.project.outputs.dir }}/build/app/outputs/flutter-apk/*.apk\n          if-no-files-found: error\n          retention-days: 7\n\n      - name: Final callback\n        if: always()\n        env:\n          INPUT_CALLBACK_URL: ${{ inputs.callback_url }}\n          INPUT_CALLBACK_SECRET: ${{ inputs.callback_secret }}\n          INPUT_JOB_ID: ${{ inputs.job_id }}\n          JOB_STATUS: ${{ job.status }}\n        shell: bash\n        run: |\n          curl -fsS -X POST -H 'content-type: application/json' \"$INPUT_CALLBACK_URL\" -d \"{\\\"jobId\\\":\\\"$INPUT_JOB_ID\\\",\\\"secret\\\":\\\"$INPUT_CALLBACK_SECRET\\\",\\\"status\\\":\\\"$JOB_STATUS\\\",\\\"stage\\\":\\\"FINAL\\\",\\\"runId\\\":\\\"$GITHUB_RUN_ID\\\"}\" || true\n"

const ANDROID_WORKFLOW = String.raw`name: Raven Web to APK

on:
  workflow_dispatch:
    inputs:
      mode:
        description: Build mode (reserved)
        required: true
        default: debug
        type: string
      job_id:
        description: Raven build id
        required: true
        type: string
      callback_url:
        description: Raven callback URL
        required: true
        type: string
      callback_secret:
        description: Per-build callback secret
        required: true
        type: string

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout source
        uses: actions/checkout@v4

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup Android SDK
        uses: android-actions/setup-android@v3

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.7'

      - name: Install Android SDK packages
        run: |
          yes | sdkmanager --licenses >/dev/null 2>&1 || true
          sdkmanager "platforms;android-35" "build-tools;35.0.0"

      - name: Notify setup
        env:
          INPUT_CALLBACK_URL: \${{ inputs.callback_url }}
          INPUT_CALLBACK_SECRET: \${{ inputs.callback_secret }}
          INPUT_JOB_ID: \${{ inputs.job_id }}
        shell: bash
        run: |
          payload=$(printf '{"jobId":"%s","secret":"%s","status":"RUNNING","stage":"ANDROID_SETUP_READY","runId":"%s"}' "$INPUT_JOB_ID" "$INPUT_CALLBACK_SECRET" "$GITHUB_RUN_ID")
          curl -fsS -X POST -H 'content-type: application/json' "$INPUT_CALLBACK_URL" -d "$payload" || true

      - name: Android build
        env:
          INPUT_CALLBACK_URL: \${{ inputs.callback_url }}
          INPUT_CALLBACK_SECRET: \${{ inputs.callback_secret }}
          INPUT_JOB_ID: \${{ inputs.job_id }}
        shell: bash
        run: |
          set -e
          payload=$(printf '{"jobId":"%s","secret":"%s","status":"RUNNING","stage":"BUILDING_WEB_APK","runId":"%s"}' "$INPUT_JOB_ID" "$INPUT_CALLBACK_SECRET" "$GITHUB_RUN_ID")
          curl -fsS -X POST -H 'content-type: application/json' "$INPUT_CALLBACK_URL" -d "$payload" || true
          set +e
          gradle :app:assembleDebug --no-daemon --stacktrace 2>&1 | tee "$RUNNER_TEMP/gradle.log"
          RC=$PIPESTATUS
          set -e
          exit $RC

      - name: Upload APK artifact
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: raven-apk-\${{ inputs.job_id }}
          path: app/build/outputs/apk/debug/app-debug.apk
          if-no-files-found: error
          retention-days: 7

      - name: Final callback
        if: always()
        env:
          INPUT_CALLBACK_URL: \${{ inputs.callback_url }}
          INPUT_CALLBACK_SECRET: \${{ inputs.callback_secret }}
          INPUT_JOB_ID: \${{ inputs.job_id }}
          JOB_STATUS: \${{ job.status }}
        shell: bash
        run: |
          python3 - <<'PY'
          import json, os, urllib.request
          log = ''
          try:
              log = open(os.path.join(os.environ['RUNNER_TEMP'], 'gradle.log'), 'rb').read()[-9000:].decode('utf-8', 'replace')
          except Exception:
              log = ''
          status = os.environ.get('JOB_STATUS', 'failure').lower()
          payload = {'jobId': os.environ['INPUT_JOB_ID'], 'secret': os.environ['INPUT_CALLBACK_SECRET'], 'status': status, 'stage': 'FINAL', 'runId': os.environ.get('GITHUB_RUN_ID', ''), 'progress': 95}
          if status != 'success':
              payload['stage'] = 'BUILD_FAILED'
              payload['failed_step'] = 'Build APK'
              payload['error'] = log or 'Build gagal sebelum log Gradle tersedia.'
          req = urllib.request.Request(os.environ['INPUT_CALLBACK_URL'], data=json.dumps(payload).encode(), headers={'content-type': 'application/json'}, method='POST')
          try:
              urllib.request.urlopen(req, timeout=25).read()
          except Exception as exc:
              print('callback failed', exc)
          PY
`;

module.exports = { env, workflowYml, androidWorkflowYml, safeSlug, createRepo, uploadFiles, dispatchWorkflow, dispatchRepositoryEvent, createRelease, uploadReleaseAsset, downloadReleaseAsset, getArtifact, cancelRun, findRunByJobId, getRun, downloadRunLogs, deleteRepo, buildId };
