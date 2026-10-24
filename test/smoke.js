'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const source = path.resolve(__dirname, '..');
const password = 'smoke-test-password-not-for-real-use';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function latestEmail(outbox, purpose) {
  const files = fs.readdirSync(outbox).filter(name => name.includes(`-${purpose}-`)).sort((a,b) => fs.statSync(path.join(outbox,a)).mtimeMs - fs.statSync(path.join(outbox,b)).mtimeMs || a.localeCompare(b));
  assert.ok(files.length, `Expected a ${purpose} email to be generated.`);
  return fs.readFileSync(path.join(outbox, files[files.length - 1]), 'utf8');
}
function tokenFromEmail(raw, key) {
  const decoded = raw.replace(/=(?:\r\n|\n)/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  const match = decoded.match(new RegExp(`[?&]${key}=([A-Za-z0-9_-]{40,50})`));
  assert.ok(match, `Expected a ${key} token in the generated email.`);
  return match[1];
}
async function waitForServer(baseUrl, child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error('Server exited before it became ready. ' + (child.__getTestLogs ? child.__getTestLogs() : ''));
    try { const res = await fetch(baseUrl + '/api/status'); if (res.ok) return; } catch (_e) {}
    await sleep(200);
  }
  throw new Error('Server did not become ready in time.');
}
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reachkit-smoke-'));
  const emailOutbox = path.join(tmp, 'email-outbox');
  fs.copyFileSync(path.join(source, 'server.js'), path.join(tmp, 'server.js'));
  fs.copyFileSync(path.join(source, 'drafting.js'), path.join(tmp, 'drafting.js'));
  fs.copyFileSync(path.join(source, 'email-service.js'), path.join(tmp, 'email-service.js'));
  fs.copyFileSync(path.join(source, 'sms-service.js'), path.join(tmp, 'sms-service.js'));
  fs.copyFileSync(path.join(source, 'x-service.js'), path.join(tmp, 'x-service.js'));
  fs.cpSync(path.join(source, 'public'), path.join(tmp, 'public'), { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', REACHKIT_ADMIN_PASSWORD: password };
  testEnv.REACHKIT_CONVERSION_WEBHOOK_SECRET = 'test-only-webhook-secret-with-32-bytes-minimum';
  // The smoke test must use isolated temporary JSON storage even when the developer's shell has hosted DB variables.
  delete testEnv.DATABASE_URL;
  delete testEnv.DATABASE_SSL;
  delete testEnv.REACHKIT_DATA_DIR;
  testEnv.PUBLIC_BASE_URL = '';
  testEnv.EMAIL_FROM = 'ReachKit Tests <noreply@example.test>';
  testEnv.REACHKIT_TEST_EMAIL_OUTBOX = emailOutbox;
  testEnv.NODE_PATH = path.join(source, 'node_modules');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: tmp,
    env: testEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  child.__getTestLogs = () => logs;
  try {
    await waitForServer(baseUrl, child);
    const status = await (await fetch(baseUrl + '/api/status')).json();
    assert.equal(status.ok, true);
    assert.equal(status.email.configured, true);
    assert.equal(status.email.verificationRequired, true);
    assert.equal(status.conversions.webhookConfigured, true);
    assert.equal((await fetch(baseUrl + '/healthz')).status, 200);
    assert.equal((await fetch(baseUrl + '/readyz')).status, 200, 'Local JSON mode is ready for development checks.');
    assert.equal(status.publicPage.adminPasswordConfigured, true);
    assert.equal(status.publicPage.published, false);

    const homeResponse = await fetch(baseUrl + '/');
    assert.equal(homeResponse.status, 200);
    const homeHtml = await homeResponse.text();
    assert.match(homeHtml, /AI API providers \+ model auto-detection/);
    assert.match(homeHtml, /Facebook Group/);
    assert.match(homeHtml, /Instagram/);
    assert.match(homeHtml, /TikTok/);
    assert.match(homeHtml, /Referral helper/);
    assert.match(homeHtml, /helperOpenLink/);
    assert.match(homeHtml, /Never use fake accounts or share passwords/);
    assert.match(homeHtml, /create your own public referral pages/);
    assert.match(homeHtml, /Cover image \/ link preview/);
    assert.match(homeHtml, /social preview crawlers/);
    assert.match(homeHtml, /Resend verification email/);
    assert.match(homeHtml, /Forgot password\?/);
    assert.match(homeHtml, /Choose a new password/);
    const appScript = await (await fetch(baseUrl + '/app.js')).text();
    assert.match(appScript, /platformOpenUrl/);
    assert.match(appScript, /destinationId/);
    assert.match(appScript, /knownProviderFromKey/);
    assert.match(appScript, /\/api\/ai\/providers\/test/);

    const providerInfoRes = await fetch(baseUrl + '/api/ai/providers');
    assert.equal(providerInfoRes.status, 200);
    const providerInfo = await providerInfoRes.json();
    assert.equal(providerInfo.authenticated, false);
    assert.ok(providerInfo.catalog.length >= 12, 'The Settings UI should expose multiple AI providers.');
    assert.deepEqual(providerInfo.providers, [], 'Connected provider details stay private until admin unlock.');
    assert.ok(!JSON.stringify(providerInfo).includes('apiKey"'), 'Catalog response must not expose API keys.');
    const lockedAiConnect = await fetch(baseUrl + '/api/ai/providers/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', apiKey: 'not-a-real-key' })
    });
    assert.equal(lockedAiConnect.status, 401, 'API keys can only be configured after admin unlock.');
    const lockedAiTest = await fetch(baseUrl + '/api/ai/providers/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' })
    });
    assert.equal(lockedAiTest.status, 401, 'Model tests must require an unlocked admin session.');


    const drafting = require(path.join(source, 'drafting.js'));
    const prompt = drafting.buildDraftPrompt({
      url: 'https://example.com/referral', details: 'Use my invite link to join the TT Pro referral offer. Qualifying signups may earn points.',
      programName: 'TT Pro', postIntent: 'Get interested people to join through my link', voiceNotes: 'casual, simple, a little slang; not formal',
      audience: 'people interested in the offer', context: '', platform: 'facebook-group', destination: 'a group where promotion is allowed', tone: 'casual'
    });
    assert.match(prompt, /ordinary person/);
    assert.match(prompt, /Do not add boilerplate legal disclaimers/);
    assert.match(prompt, /Never guess what the offer is/);
    assert.match(prompt, /do not mention “TikTok Shop” or “TT Shop” unless/i);
    assert.match(homeHtml, /Exact app \/ offer name/);
    assert.match(homeHtml, /What do you want the post to get across/);
    const polished = drafting.cleanDraftResult({
      title: 'An amazing TT Shop offer: $100!',
      body: `TikTok Shop has a $100 reward! Here is a great opportunity! Please check the current terms and conditions.\n\nUse my link: https://example.com/referral\n\nI may get a reward if you qualify through my referral link. I may receive a reward if you qualify through my referral link.`
    }, { url: 'https://example.com/referral', details: 'Use my invite link to join the TT Pro referral offer. Qualifying signups may earn points.', programName: 'TT Pro', postIntent: 'Get interested people to join through my link; do not call it TT Shop or mention $100.', voiceNotes: 'casual, simple', audience: 'people interested', context: '', tone: 'casual' });
    assert.doesNotMatch(polished.title + ' ' + polished.body, /TikTok Shop|TT Shop/i);
    assert.doesNotMatch(polished.title + ' ' + polished.body, /\$100/);
    assert.match(polished.body, /https:\/\/example\.com\/referral/);
    assert.equal((polished.body.match(/referral link/gi) || []).length, 1, 'AI output should have one concise referral disclosure');


    const longBody = Array.from({ length: 28 }, (_, i) => `Extra explanation sentence ${i + 1} goes on and on with details that were not requested.`).join(' ') + ' https://example.com/referral Btw, this is my referral link, so I may get a reward if you qualify.';
    const concise = drafting.cleanDraftResult({ title: 'A referral', body: longBody }, { url: 'https://example.com/referral', details: 'Short factual offer.', programName: 'Demo', tone: 'short' });
    assert.ok(concise.body.split(/\s+/).length < 100, 'short tone should cap overlong AI output');
    assert.equal(concise.body.split('https://example.com/referral').length - 1, 1, 'the referral URL should not be repeated');

    const noPage = await fetch(baseUrl + '/join');
    assert.equal(noPage.status, 404);

    // Multi-user account signup, private campaign ownership, uploaded image, social metadata, and click tracking.
    const imageBuffer = fs.readFileSync(path.join(source, 'public', 'og-default.png'));
    const imageDataUrl = 'data:image/png;base64,' + imageBuffer.toString('base64');
    const registerA = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', displayName: 'Owner', password: 'test-password-123' })
    });
    assert.equal(registerA.status, 201);
    const registerAData = await registerA.json();
    assert.equal(registerAData.user.email, 'owner@example.test');
    assert.equal(registerAData.emailVerificationRequired, true);
    assert.equal(registerA.headers.get('set-cookie'), null, 'An unverified account must not receive an authenticated session.');
    const preVerificationLogin = await fetch(baseUrl + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'owner@example.test', password:'test-password-123' }) });
    assert.equal(preVerificationLogin.status, 403, 'Unverified accounts cannot sign in.');
    const verifyTokenA = tokenFromEmail(latestEmail(emailOutbox, 'verify'), 'verify');
    const storedTokens = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'auth-tokens.json'), 'utf8')).tokens;
    assert.ok(storedTokens.some(item => item.tokenHash === crypto.createHash('sha256').update(verifyTokenA).digest('hex') && item.purpose === 'verify-email'), `The verification token was not found in storage (email token length ${verifyTokenA.length}; records ${storedTokens.length}; purposes ${storedTokens.map(item => item.purpose).join(',')}).`);
    const resendVerification = await fetch(baseUrl + '/api/auth/verification', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'OWNER@example.test' }) });
    assert.equal(resendVerification.status, 200);
    const verifyTokenA2 = tokenFromEmail(latestEmail(emailOutbox, 'verify'), 'verify');
    const supersededVerify = await fetch(baseUrl + '/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:verifyTokenA }) });
    assert.equal(supersededVerify.status, 400, 'Resending verification replaces the old token.');
    const verifyA = await fetch(baseUrl + '/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:verifyTokenA2 }) });
    assert.equal(verifyA.status, 200, JSON.stringify(await verifyA.clone().json()));
    assert.equal((await verifyA.json()).emailVerified, true);
    const reusedVerifyA = await fetch(baseUrl + '/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:verifyTokenA2 }) });
    assert.equal(reusedVerifyA.status, 400, 'Email verification tokens are single-use.');
    const duplicateRegister = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'OWNER@example.test', displayName: 'Duplicate', password: 'test-password-123' })
    });
    assert.equal(duplicateRegister.status, 409, 'Email addresses are unique case-insensitively.');
    assert.ok(!JSON.stringify(registerAData).includes('passwordHash'));
    const badSignIn = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'not-the-password' })
    });
    assert.equal(badSignIn.status, 401);
    const goodSignIn = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'OWNER@example.test', password: 'test-password-123' })
    });
    assert.equal(goodSignIn.status, 200);
    let accountCookieA = String(goodSignIn.headers.get('set-cookie') || '').split(';')[0];
    assert.match(accountCookieA, /^reachkit_session=/);

    const resetRequest = await fetch(baseUrl + '/api/auth/password-reset-request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'owner@example.test' }) });
    assert.equal(resetRequest.status, 200);
    const expiredResetToken = tokenFromEmail(latestEmail(emailOutbox, 'reset'), 'reset');
    const authTokenPath = path.join(tmp, 'data', 'auth-tokens.json');
    const authTokenStore = JSON.parse(fs.readFileSync(authTokenPath, 'utf8'));
    authTokenStore.tokens.find(item => item.purpose === 'reset-password').expiresAt = Date.now() - 1;
    fs.writeFileSync(authTokenPath, JSON.stringify(authTokenStore));
    const expiredReset = await fetch(baseUrl + '/api/auth/password-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:expiredResetToken, password:'owner-new-password-456' }) });
    assert.equal(expiredReset.status, 400, 'Expired recovery tokens are rejected.');
    const secondResetRequest = await fetch(baseUrl + '/api/auth/password-reset-request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'owner@example.test' }) });
    assert.equal(secondResetRequest.status, 200);
    const resetToken = tokenFromEmail(latestEmail(emailOutbox, 'reset'), 'reset');
    const resetResponse = await fetch(baseUrl + '/api/auth/password-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:resetToken, password:'owner-new-password-456' }) });
    assert.equal(resetResponse.status, 200);
    const reusedReset = await fetch(baseUrl + '/api/auth/password-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:resetToken, password:'owner-new-password-789' }) });
    assert.equal(reusedReset.status, 400, 'Password reset tokens are single-use.');
    assert.equal((await (await fetch(baseUrl + '/api/auth/session', { headers:{Cookie:accountCookieA} })).json()).authenticated, false, 'Password reset invalidates existing sessions.');
    const oldPasswordLogin = await fetch(baseUrl + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'owner@example.test', password:'test-password-123' }) });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(baseUrl + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'owner@example.test', password:'owner-new-password-456' }) });
    assert.equal(newPasswordLogin.status, 200);
    accountCookieA = String(newPasswordLogin.headers.get('set-cookie') || '').split(';')[0];
    const oversizedImage = Buffer.from(imageBuffer); oversizedImage.writeUInt32BE(13000, 16);
    const rejectedImage = await fetch(baseUrl + '/api/account/campaigns', {
      method:'POST', headers:{'Content-Type':'application/json',Cookie:accountCookieA},
      body:JSON.stringify({ title:'Bad image', slug:'bad-image', url:'https://example.com/ref', details:'A sufficiently clear offer description.', imageDataUrl:'data:image/png;base64,'+oversizedImage.toString('base64') })
    });
    assert.equal(rejectedImage.status, 400, 'Oversized image dimensions must be rejected server-side.');

    const createCampaignA = await fetch(baseUrl + '/api/account/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: accountCookieA },
      body: JSON.stringify({
        title: 'Real share test', name: 'Owner campaign', slug: 'real-share-test',
        url: 'https://example.com/referral?source=reachkit',
        details: 'This test offer has real details and does not guarantee reward credit.', imageDataUrl
      })
    });
    assert.equal(createCampaignA.status, 201);
    const createdA = (await createCampaignA.json()).campaign;
    assert.equal(createdA.shareUrl, baseUrl + '/r/real-share-test');
    assert.equal(createdA.published, true);
    assert.match(createdA.imagePath, /^\/media\/[a-f0-9-]+\.png$/);

    const sharedPageResponse = await fetch(baseUrl + '/r/real-share-test');
    assert.equal(sharedPageResponse.status, 200);
    const sharedPageHtml = await sharedPageResponse.text();
    assert.match(sharedPageHtml, /property="og:title" content="Real share test"/);
    assert.match(sharedPageHtml, /property="og:description"/);
    assert.match(sharedPageHtml, /property="og:image" content="http:\/\//);
    assert.match(sharedPageHtml, /name="twitter:card" content="summary_large_image"/);
    assert.match(sharedPageHtml, /data-track-click/);
    assert.match(sharedPageHtml, /example\.com/);
    const imageResponse = await fetch(baseUrl + createdA.imagePath);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type') || '', /image\/png/);

    const newClick = await fetch(baseUrl + '/api/click/real-share-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent':'ReachKitTest/Browser-A' }, body: '{}'
    });
    assert.equal(newClick.status, 200);
    assert.equal((await newClick.json()).uniqueClicks, 1, 'The first browser/network-day click should count once.');
    const repeatClick = await fetch(baseUrl + '/api/click/real-share-test', {
      method:'POST',headers:{'Content-Type':'application/json','User-Agent':'ReachKitTest/Browser-A'},body:'{}'
    });
    assert.equal((await repeatClick.json()).uniqueClicks, 1, 'Repeated clicks by the same browser/network on the same day must be deduplicated.');
    const differentBrowserClick = await fetch(baseUrl + '/api/click/real-share-test', {
      method:'POST',headers:{'Content-Type':'application/json','User-Agent':'ReachKitTest/Browser-B'},body:'{}'
    });
    assert.equal((await differentBrowserClick.json()).uniqueClicks, 2, 'A different browser fingerprint should count as another approximate unique click.');
    const rawCampaignStore = fs.readFileSync(path.join(tmp,'data','campaigns.json'),'utf8');
    assert.ok(!rawCampaignStore.includes('ReachKitTest/Browser-'), 'Raw user-agent strings must not be persisted for click analytics.');
    assert.match(rawCampaignStore,/uniqueClickFingerprints[\s\S]*[a-f0-9]{64}/, 'Only a keyed fingerprint should be stored for deduplication.');
    const signedEvent = async event => {
      const raw = JSON.stringify(event);
      const signature = crypto.createHmac('sha256', testEnv.REACHKIT_CONVERSION_WEBHOOK_SECRET).update(raw).digest('hex');
      return fetch(baseUrl + '/api/webhooks/conversions', { method:'POST', headers:{'Content-Type':'application/json','x-reachkit-signature':`sha256=${signature}`}, body:raw });
    };
    const conversionEvent = { provider:'test-provider',eventId:'event-001',conversionId:'conversion-001',campaignSlug:'real-share-test',status:'rewarded',rewardAmount:4.5,currency:'USD',occurredAt:new Date().toISOString() };
    const unsignedEvent = await fetch(baseUrl + '/api/webhooks/conversions', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(conversionEvent) });
    assert.equal(unsignedEvent.status, 401, 'Conversion events without a valid HMAC must be rejected.');
    assert.equal((await signedEvent(conversionEvent)).status, 200);
    assert.equal((await signedEvent(conversionEvent)).status, 200, 'Webhook retries should be idempotent.');
    const signedConversionReports = await (await fetch(baseUrl + '/api/account/conversions', { headers:{Cookie:accountCookieA} })).json();
    assert.equal(signedConversionReports.reportedQualified, 1);
    assert.equal(signedConversionReports.reportedRewards, 1);
    assert.equal(signedConversionReports.rewardsByCurrency.USD, 4.5);
    assert.match(signedConversionReports.attribution, /not independently verified/);
    const reversal = { ...conversionEvent,eventId:'event-002',status:'reversed',rewardAmount:undefined,currency:undefined,occurredAt:new Date(Date.now()+1000).toISOString() };
    assert.equal((await signedEvent(reversal)).status, 200);
    const afterReversal = await (await fetch(baseUrl + '/api/account/conversions', { headers:{Cookie:accountCookieA} })).json();
    assert.equal(afterReversal.reportedSignups, 0, 'Reversed and rejected events must not count as active referrals.');
    const listA = await (await fetch(baseUrl + '/api/account/campaigns', { headers: { Cookie: accountCookieA } })).json();
    assert.equal(listA.campaigns.length, 1);
    assert.equal(listA.campaigns[0].clicks, 3);
    assert.equal(listA.campaigns[0].uniqueClicks, 2);
    assert.equal((await fetch(baseUrl+'/api/account/goals')).status,401,'Savings goals require an authenticated account.');
    assert.equal((await fetch(baseUrl+'/api/account/social/x/status')).status,401,'X connections require a signed-in account.');
    const goalInput={title:'Emergency fund',targetAmount:1000,currentAmount:125.5,currency:'USD',targetDate:'2027-06-30',note:'My own target'};
    const invalidGoal=await fetch(baseUrl+'/api/account/goals',{method:'POST',headers:{'Content-Type':'application/json',Cookie:accountCookieA},body:JSON.stringify({...goalInput,targetDate:'2027-02-31'})});
    assert.equal(invalidGoal.status,400,'Invalid target dates must be rejected.');
    const createGoal=await fetch(baseUrl+'/api/account/goals',{method:'POST',headers:{'Content-Type':'application/json',Cookie:accountCookieA},body:JSON.stringify(goalInput)});
    assert.equal(createGoal.status,201);
    const savedGoal=(await createGoal.json()).goal;
    assert.equal(savedGoal.title,'Emergency fund'); assert.equal(savedGoal.currentAmount,125.5); assert.equal(savedGoal.targetAmount,1000);
    const ownGoals=await (await fetch(baseUrl+'/api/account/goals',{headers:{Cookie:accountCookieA}})).json();
    assert.equal(ownGoals.goals.length,1,'Saved goals must be listed from account storage.');
    const xStatus=await fetch(baseUrl+'/api/account/social/x/status',{headers:{Cookie:accountCookieA}});
    assert.equal(xStatus.status,200);assert.equal((await xStatus.json()).configured,false,'X posting must be shown as unavailable without app credentials and token encryption.');
    const xConnectNotConfigured=await fetch(baseUrl+'/api/account/social/x/connect',{method:'POST',headers:{'Content-Type':'application/json',Cookie:accountCookieA},body:'{}'});
    assert.equal(xConnectNotConfigured.status,503,'The app must not pretend X was connected without OAuth app configuration.');
    const updateGoal=await fetch(baseUrl+`/api/account/goals/${savedGoal.id}`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:accountCookieA},body:JSON.stringify({...goalInput,title:'Emergency fund updated',currentAmount:200})});
    assert.equal(updateGoal.status,200); assert.equal((await updateGoal.json()).goal.currentAmount,200,'Users can edit their current amount and target.');
    await Promise.all(Array.from({ length: 20 }, () => fetch(baseUrl + '/api/click/real-share-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })));
    const afterConcurrentClicks = await (await fetch(baseUrl + '/api/account/campaigns', { headers: { Cookie: accountCookieA } })).json();
    assert.equal(afterConcurrentClicks.campaigns[0].clicks, 23, 'Concurrent local clicks must not overwrite one another.');
    assert.equal(afterConcurrentClicks.campaigns[0].uniqueClicks, 3, 'Concurrent repeated requests from one browser/network should be deduplicated.');
    assert.ok(afterConcurrentClicks.campaigns[0].views >= 1, 'Public page views should be counted separately from outbound clicks.');
    const accountExport = await fetch(baseUrl + '/api/account/export', { headers:{Cookie:accountCookieA} });
    assert.equal(accountExport.status, 200);
    const exportedData = await accountExport.json();
    assert.equal(exportedData.campaigns.length, 1);
    assert.equal(exportedData.savingsGoals.length,1,'Account export must include saved goals.');
    assert.ok(!JSON.stringify(exportedData).includes('passwordHash'), 'Account export must not include password hashes.');

    const registerB = await fetch(baseUrl + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'another@example.test', displayName: 'Another', password: 'different-password-123' })
    });
    assert.equal(registerB.status, 201);
    const verifyTokenB = tokenFromEmail(latestEmail(emailOutbox, 'verify'), 'verify');
    assert.equal((await fetch(baseUrl + '/api/auth/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token:verifyTokenB }) })).status, 200);
    const loginB = await fetch(baseUrl + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:'another@example.test', password:'different-password-123' }) });
    assert.equal(loginB.status, 200);
    const accountCookieB = String(loginB.headers.get('set-cookie') || '').split(';')[0];
    const listB = await (await fetch(baseUrl + '/api/account/campaigns', { headers: { Cookie: accountCookieB } })).json();
    assert.equal(listB.campaigns.length, 0, 'Accounts must not see each other campaigns.');
    const goalsB = await (await fetch(baseUrl+'/api/account/goals',{headers:{Cookie:accountCookieB}})).json();
    assert.equal(goalsB.goals.length,0,'Accounts must not see another user’s savings goals.');
    const goalBResponse = await fetch(baseUrl+'/api/account/goals',{method:'POST',headers:{'Content-Type':'application/json',Cookie:accountCookieB},body:JSON.stringify({...goalInput,title:'Private account B goal'})});
    assert.equal(goalBResponse.status,201,'An account can create its own goal.');
    const modifyGoalAsB=await fetch(baseUrl+`/api/account/goals/${savedGoal.id}`,{method:'PUT',headers:{'Content-Type':'application/json',Cookie:accountCookieB},body:JSON.stringify(goalInput)});
    assert.equal(modifyGoalAsB.status,404,'A user must not edit another account’s goal.');
    const deleteGoalAsB=await fetch(baseUrl+`/api/account/goals/${savedGoal.id}`,{method:'DELETE',headers:{Cookie:accountCookieB}});
    assert.equal(deleteGoalAsB.status,404,'A user must not delete another account’s goal.');
    const conversionReportsB = await (await fetch(baseUrl + '/api/account/conversions', { headers:{Cookie:accountCookieB} })).json();
    assert.equal(conversionReportsB.reportedSignups, 0, 'A user must not see another account’s conversion reports.');
    const forbiddenUnpublish = await fetch(baseUrl + '/api/account/campaigns/' + createdA.id, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: accountCookieB }, body: '{}'
    });
    assert.equal(forbiddenUnpublish.status, 404, 'A user must not be able to modify another account campaign.');
    const unpublishA = await fetch(baseUrl + '/api/account/campaigns/' + createdA.id, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: accountCookieA }, body: '{}'
    });
    assert.equal(unpublishA.status, 200);
    assert.equal((await fetch(baseUrl + '/r/real-share-test')).status, 404);
    const permanentDelete = await fetch(baseUrl + '/api/account/campaigns/' + createdA.id + '/delete', { method: 'DELETE', headers: { Cookie: accountCookieA } });
    assert.equal(permanentDelete.status, 200);
    const deleteB = await fetch(baseUrl + '/api/auth/account', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: accountCookieB },
      body: JSON.stringify({ password: 'different-password-123' })
    });
    assert.equal(deleteB.status, 200);
    const localGoalsAfterDeleteB = JSON.parse(fs.readFileSync(path.join(tmp,'data','savings-goals.json'),'utf8')).goals;
    assert.equal(localGoalsAfterDeleteB.some(goal => goal.title === 'Private account B goal'),false,'Deleting an account must purge that account’s goals.');
    const deletedSession = await (await fetch(baseUrl + '/api/auth/session', { headers: { Cookie: accountCookieB } })).json();
    assert.equal(deletedSession.authenticated, false);
    const deleteA = await fetch(baseUrl + '/api/auth/account', { method:'DELETE',headers:{'Content-Type':'application/json',Cookie:accountCookieA},body:JSON.stringify({password:'owner-new-password-456'}) });
    assert.equal(deleteA.status,200);
    const finalGoalsAfterDeleteA = JSON.parse(fs.readFileSync(path.join(tmp,'data','savings-goals.json'),'utf8')).goals;
    assert.equal(finalGoalsAfterDeleteA.some(goal => goal.id === savedGoal.id),false,'Deleting an account must purge its owned goals.');

    const wrong = await fetch(baseUrl + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' })
    });
    assert.equal(wrong.status, 401);

    const unauthorized = await fetch(baseUrl + '/api/public-offer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/refer', title: 'Test offer', details: 'A clear offer description.' })
    });
    assert.equal(unauthorized.status, 401);

    const login = await fetch(baseUrl + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^reachkit_admin=/);

    const mailTools = await (await fetch(baseUrl+'/api/admin/message-tools',{headers:{Cookie:cookie}})).json();
    assert.equal(mailTools.authenticated,true);
    assert.equal(mailTools.smsConfigured,false,'SMS must be shown as unavailable without Twilio credentials.');
    const emailNoConsent = await fetch(baseUrl+'/api/admin/test-email',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({to:'owner@example.test'})});
    assert.equal(emailNoConsent.status,400,'Email test requires an explicit permission confirmation.');
    const emailTest = await fetch(baseUrl+'/api/admin/test-email',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({to:'owner@example.test',consent:true})});
    assert.equal(emailTest.status,200,'The configured test-only mail transport must accept the one-time email test.');
    assert.match(fs.readFileSync(path.join(emailOutbox,fs.readdirSync(emailOutbox).find(name=>name.includes('-test-'))),'utf8'),/ReachKit test message/);
    const smsNoConsent = await fetch(baseUrl+'/api/admin/test-sms',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({to:'+12223334444'})});
    assert.equal(smsNoConsent.status,400,'SMS test requires an explicit consent confirmation.');
    const smsNotConfigured = await fetch(baseUrl+'/api/admin/test-sms',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({to:'+12223334444',consent:true})});
    assert.equal(smsNotConfigured.status,503,'SMS must not claim delivery without Twilio configuration.');
    const unlockedProviders = await (await fetch(baseUrl + '/api/ai/providers', { headers: { Cookie: cookie } })).json();
    assert.equal(unlockedProviders.authenticated, true);
    assert.ok(unlockedProviders.catalog.some(p => p.id === 'openrouter'));
    const missingProvider = await fetch(baseUrl + '/api/ai/providers/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ provider: 'openai', model: 'gpt-whatever' })
    });
    assert.equal(missingProvider.status, 404);

    const publish = await fetch(baseUrl + '/api/public-offer', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        url: 'https://example.com/ref?source=smoke&hello=world',
        title: 'Test referral offer', name: 'Test campaign',
        details: 'This is a clear test offer with no guaranteed reward claims.'
      })
    });
    assert.equal(publish.status, 200);
    assert.equal((await publish.json()).published, true);

    const landingRes = await fetch(baseUrl + '/join');
    assert.equal(landingRes.status, 200);
    const html = await landingRes.text();
    assert.match(html, /Test referral offer/);
    assert.match(html, /referral disclosure/);
    assert.match(html, /href="https:\/\/example\.com\/ref\?source=smoke&amp;hello=world"/);
    assert.match(html, /data-track-click/);
    assert.match(html, /how to follow the official process/);
    assert.match(html, /only the provider can confirm eligibility and credit points/i);

    const trackedClick = await fetch(baseUrl + '/api/click', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(trackedClick.status, 200);
    const stats = await fetch(baseUrl + '/api/click-stats', { headers: { Cookie: cookie } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).total, 1);

    const unpublish = await fetch(baseUrl + '/api/public-offer', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(unpublish.status, 200);
    assert.equal((await fetch(baseUrl + '/join')).status, 404);

    console.log('ReachKit smoke tests passed: verified-email signup, single-use/expiring password recovery, capture-only email delivery test, SMS consent/configuration gate, multi-user privacy, account-owned savings-goal CRUD/isolation/export/deletion, signed conversion webhook rejection/idempotency/reversal, uploads, page views/clicks, approximate unique-click deduplication/privacy, account exports/deletion, metadata, AI guards, and multi-platform UI.');
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 1200);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.stack || err.message || err); process.exitCode = 1; });
