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
    const s = net.createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(err => err ? reject(err) : resolve(port)); });
  });
}
async function start(tmp, port) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', EMAIL_FROM:'ReachKit Tests <noreply@example.test>', REACHKIT_TEST_EMAIL_OUTBOX:path.join(tmp,'email-outbox'), NODE_PATH:path.join(source,'node_modules') };
  delete env.DATABASE_URL; delete env.DATABASE_SSL; delete env.REACHKIT_DATA_DIR;
  const child = spawn(process.execPath, ['server.js'], { cwd: tmp, env, stdio: ['ignore','ignore','pipe'] });
  let log = '';
  child.stderr.on('data', b => { log += b.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i=0; i<60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await fetch(base + '/api/status')).ok) return { child, base }; } catch (_e) {}
    await wait(100);
  }
  child.kill(); throw new Error(`server did not start: ${log}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill(); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1500); });
}
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reachkit-session-'));
  fs.copyFileSync(path.join(source, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(source, 'drafting.js'), path.join(tmp, 'drafting.js'));
  fs.copyFileSync(path.join(source, 'email-service.js'), path.join(tmp, 'email-service.js'));
  fs.copyFileSync(path.join(source, 'sms-service.js'), path.join(tmp, 'sms-service.js'));
  fs.copyFileSync(path.join(source, 'x-service.js'), path.join(tmp, 'x-service.js'));
  fs.cpSync(path.join(source, 'public'), path.join(tmp, 'public'), { recursive:true });
  const port = await freePort(); let running;
  try {
    running = await start(tmp, port);
    const reg = await fetch(running.base + '/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'restart@example.test', password:'restart-test-password-123' }) });
    assert.equal(reg.status, 201);
    const verifyFile = fs.readdirSync(path.join(tmp,'email-outbox')).find(name => name.includes('-verify-'));
    assert.ok(verifyFile, 'Registration must generate a verification email.');
    const verifyRaw = fs.readFileSync(path.join(tmp,'email-outbox',verifyFile),'utf8');
    const decodedEmail = verifyRaw.replace(/=(?:\r\n|\n)/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    const verifyToken = decodedEmail.match(/[?&]verify=([A-Za-z0-9_-]{40,50})/)?.[1];
    assert.ok(verifyToken, 'Verification email must contain a tokenized link.');
    assert.equal((await fetch(running.base + '/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:verifyToken }) })).status, 200);
    const verifiedLogin = await fetch(running.base + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'restart@example.test', password:'restart-test-password-123' }) });
    assert.equal(verifiedLogin.status, 200);
    const cookie = String(verifiedLogin.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^reachkit_session=/);
    await stop(running.child);
    running = await start(tmp, port);
    const session = await (await fetch(running.base + '/api/auth/session', { headers:{Cookie:cookie} })).json();
    assert.equal(session.authenticated, true, 'Persistent session remains valid after server restart.');
    const rejectedOrigin = await fetch(running.base + '/api/auth/logout', { method:'POST', headers:{Cookie:cookie,Origin:running.base.replace('http:','https:'),'Content-Type':'application/json'}, body:'{}' });
    assert.equal(rejectedOrigin.status, 403, 'CSRF origin checks must include the request scheme.');
    const logout = await fetch(running.base + '/api/auth/logout', { method:'POST', headers:{Cookie:cookie,Origin:running.base,'Content-Type':'application/json'}, body:'{}' });
    assert.equal(logout.status, 200);
    const expired = await (await fetch(running.base + '/api/auth/session', { headers:{Cookie:cookie} })).json();
    assert.equal(expired.authenticated, false, 'Logout invalidates the persistent server-side session.');
    const login = await fetch(running.base + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:'restart@example.test',password:'restart-test-password-123'}) });
    const expiringCookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const storePath = path.join(tmp,'data','sessions.json'), store = JSON.parse(fs.readFileSync(storePath,'utf8'));
    store.sessions[0].expiresAt = Date.now() - 1; fs.writeFileSync(storePath,JSON.stringify(store));
    const pastExpiry = await (await fetch(running.base + '/api/auth/session', { headers:{Cookie:expiringCookie} })).json();
    assert.equal(pastExpiry.authenticated, false, 'Expired sessions are rejected.');
    console.log('Persistent session test passed: sessions survive restart, logout invalidates them, and expired sessions are rejected.');
  } finally { if (running) await stop(running.child); fs.rmSync(tmp, { recursive:true, force:true }); }
}
main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
