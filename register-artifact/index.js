const core = require('@actions/core');
const https = require('https');
const http = require('http');
const fs = require('fs');

async function post(url, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${token}`,
      },
      rejectUnauthorized: false,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const backendUrl = core.getInput('backend-url', { required: true }).replace(/\/$/, '');
  const token = core.getInput('token', { required: true });
  const endpoint = core.getInput('endpoint') || '/api/admin/artifacts/register';
  const manifestPath = core.getInput('manifest');

  let payload;
  if (manifestPath) {
    payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    core.info(`Registering artifact set manifest ${manifestPath} at ${backendUrl}`);
  } else {
    payload = {
      artifact_type: core.getInput('artifact-type', { required: true }),
      version: core.getInput('version', { required: true }),
      s3_key: core.getInput('s3-key', { required: true }),
      sha256: core.getInput('sha256', { required: true }),
      size_bytes: parseInt(core.getInput('size-bytes', { required: true }), 10),
    };

    const channel = core.getInput('channel');
    if (channel) payload.channel = channel;

    const licenseType = core.getInput('license-type');
    if (licenseType) payload.license_type = licenseType;
    else payload.license_type = null;

    const nativeKey = core.getInput('native-key');
    if (nativeKey) payload.native_key = nativeKey;

    const runUrl = core.getInput('run-url');
    if (runUrl) payload.run_url = runUrl;

    core.info(`Registering ${payload.artifact_type} ${payload.version} at ${backendUrl}`);
    core.info(`S3 key: ${payload.s3_key}`);
  }

  const result = await post(`${backendUrl}${endpoint}`, token, payload);
  core.info(`Registered: HTTP ${result.status}`);
}

main().catch(err => core.setFailed(err.message));
