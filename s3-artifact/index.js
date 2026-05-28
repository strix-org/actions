const core = require('@actions/core');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const fs = require('fs');
const path = require('path');
const https = require('https');

function createClient() {
  return new S3Client({
    endpoint: core.getInput('endpoint', { required: true }),
    region: process.env.AWS_REGION || 'default',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    }),
  });
}

function resolvePrefix() {
  const base = core.getInput('s3-prefix', { required: true }).replace(/\/$/, '');
  const autoPrefix = core.getInput('auto-prefix') === 'true';
  if (!autoPrefix) return base;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '0';
  return `${repo}/${runId}/${base}`.replace(/\/+/g, '/');
}

function collectFiles(localPath) {
  if (!fs.existsSync(localPath)) {
    const dir = path.dirname(localPath);
    const pattern = path.basename(localPath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => matchGlob(f, pattern))
      .map(f => path.join(dir, f))
      .filter(f => fs.statSync(f).isFile());
  }
  if (fs.statSync(localPath).isFile()) return [localPath];
  return walkDir(localPath);
}

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function matchGlob(str, pattern) {
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return re.test(str);
}

async function upload(client) {
  const localPath = core.getInput('path', { required: true });
  const bucket = core.getInput('bucket', { required: true });
  const prefix = resolvePrefix();
  const excludeList = core.getInput('exclude').split(',').map(s => s.trim()).filter(Boolean);

  const files = collectFiles(localPath);
  if (files.length === 0) throw new Error(`No files found at: ${localPath}`);

  for (const file of files) {
    if (excludeList.some(p => matchGlob(path.basename(file), p))) {
      core.info(`Skipping (excluded): ${file}`);
      continue;
    }
    const key = `${prefix}/${path.basename(file)}`;
    core.info(`Uploading ${file} → s3://${bucket}/${key}`);
    await new Upload({
      client,
      params: { Bucket: bucket, Key: key, Body: fs.createReadStream(file) },
    }).done();
  }
}

async function download(client) {
  const destDir = core.getInput('path', { required: true });
  const bucket = core.getInput('bucket', { required: true });
  const prefix = resolvePrefix().replace(/\/$/, '') + '/';

  fs.mkdirSync(destDir, { recursive: true });

  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));

    for (const obj of res.Contents || []) {
      const rel = obj.Key.slice(prefix.length);
      if (!rel) continue;
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      core.info(`Downloading s3://${bucket}/${obj.Key} → ${dest}`);
      const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
      await new Promise((ok, fail) => Body.pipe(fs.createWriteStream(dest)).on('finish', ok).on('error', fail));
    }

    token = res.NextContinuationToken;
  } while (token);
}

async function main() {
  const client = createClient();
  const op = core.getInput('operation', { required: true });
  if (op === 'upload') await upload(client);
  else if (op === 'download') await download(client);
  else throw new Error(`Unknown operation: ${op}`);
}

main().catch(err => core.setFailed(err.message));
