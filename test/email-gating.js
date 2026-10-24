'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const source = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(err => err ? reject(err) : resolve(port)); });
  });
}
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reachkit-email-gating-'));
  for (const file of ['server.js','drafting.js','email-service.js','sms-service.js','x-service.js']) fs.copyFileSync(path.join(source,file), path.join(tmp,file));
  fs.cpSync(path.join(source,'public'), path.join(tmp,'public'), { recursive:true });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT:String(port), HOST:'127.0.0.1', NODE_ENV:'test', NODE_PATH:path.join(source,'node_modules') };
  for (const key of ['DATABASE_URL','DATABASE_SSL','REACHKIT_DATA_DIR','REACHKIT_TEST_EMAIL_OUTBOX','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASSWORD','EMAIL_FROM']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], { cwd:tmp, env, stdio:['ignore','ignore','pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    let ready = false;
    for (let i=0; i<60; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited before readiness: ${stderr}`);
      try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch (_e) {}
      await wait(100);
    }
    assert.ok(ready, `Server did not start: ${stderr}`);
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.email.configured, false);
    const registration = await fetch(base + '/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:'gated@example.test',password:'not-a-real-password-123'}) });
    assert.equal(registration.status, 503, 'Signup must stay unavailable when real email verification cannot be delivered.');
    assert.match((await registration.json()).error, /email delivery is not configured/i);
    const recovery = await fetch(base + '/api/auth/password-reset-request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:'gated@example.test'}) });
    assert.equal(recovery.status, 503, 'Recovery must explain that email delivery needs configuration.');
    console.log('Email configuration gate passed: signup and recovery never claim email delivery when SMTP is absent.');
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => { child.once('exit',resolve); setTimeout(resolve,1000); }); }
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
