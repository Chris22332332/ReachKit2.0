'use strict';
const crypto=require('node:crypto');

function decodeKey(value) {
  const raw=String(value||'').trim();
  if(/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw,'hex');
  const decoded=Buffer.from(raw,'base64');
  return decoded.length===32?decoded:null;
}
function createXService(env=process.env,fetchImpl=globalThis.fetch) {
  const clientId=String(env.X_CLIENT_ID||'').trim();
  const clientSecret=String(env.X_CLIENT_SECRET||'').trim();
  const key=decodeKey(env.REACHKIT_TOKEN_ENCRYPTION_KEY);
  const configured=Boolean(clientId&&key&&typeof fetchImpl==='function');
  function encrypt(value) {
    if(!key) throw new Error('Set REACHKIT_TOKEN_ENCRYPTION_KEY to a 32-byte key before connecting X.');
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    const ciphertext=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
    return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
  }
  function decrypt(value) {
    if(!key) throw new Error('X token encryption key is not configured.');
    const parts=String(value||'').split('.'); if(parts.length!==3) throw new Error('Stored X credentials are invalid; reconnect the account.');
    try { const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(parts[0],'base64url')); decipher.setAuthTag(Buffer.from(parts[1],'base64url')); return Buffer.concat([decipher.update(Buffer.from(parts[2],'base64url')),decipher.final()]).toString('utf8'); }
    catch(_e) { throw new Error('Stored X credentials could not be decrypted; check the token encryption key or reconnect.'); }
  }
  function authorizationUrl({state,verifier,redirectUri}) {
    if(!configured) throw new Error('X account connection is not configured. Set X_CLIENT_ID and a 32-byte REACHKIT_TOKEN_ENCRYPTION_KEY.');
    const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const url=new URL('https://x.com/i/oauth2/authorize');
    url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:'tweet.write users.read offline.access',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return url.toString();
  }
  async function requestToken(params,redirectUri='') {
    if(!configured) throw new Error('X account connection is not configured.');
    const form=new URLSearchParams(params); form.set('client_id',clientId);
    const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(clientSecret) headers.Authorization='Basic '+Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response=await fetchImpl('https://api.x.com/2/oauth2/token',{method:'POST',headers,body:form,signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||typeof data.access_token!=='string') throw new Error(response.status===401||response.status===403?'X rejected the configured OAuth application or authorization code.':`X token request failed (HTTP ${response.status}).`);
    return {accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:'',expiresAt:Date.now()+Math.max(60,Number(data.expires_in)||7200)*1000,scope:String(data.scope||'')};
  }
  async function exchangeCode({code,verifier,redirectUri}) { return requestToken({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirectUri},redirectUri); }
  async function refresh(refreshToken) { return requestToken({grant_type:'refresh_token',refresh_token:refreshToken}); }
  async function getProfile(accessToken) {
    const response=await fetchImpl('https://api.x.com/2/users/me?user.fields=name,username',{headers:{Authorization:`Bearer ${accessToken}`,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.data||!/^\d+$/.test(String(data.data.id||''))||!/^[A-Za-z0-9_]{1,15}$/.test(String(data.data.username||''))) throw new Error(response.status===401?'X authorization expired or lacks users.read.':`X account lookup failed (HTTP ${response.status}).`);
    return {id:String(data.data.id),username:String(data.data.username),name:String(data.data.name||data.data.username).slice(0,120)};
  }
  async function createPost(accessToken,text) {
    const response=await fetchImpl('https://api.x.com/2/tweets',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.data||!/^\d+$/.test(String(data.data.id||''))) {
      const error=new Error(response.status===401?'X authorization expired or does not include tweet.write.':`X did not accept this post (HTTP ${response.status}${Number.isInteger(data.code)?`, code ${data.code}`:''}).`);
      error.statusCode=response.status===401?401:502;
      throw error;
    }
    return {id:String(data.data.id),text:String(data.data.text||text)};
  }
  return {configured,clientId,encrypt,decrypt,authorizationUrl,exchangeCode,refresh,getProfile,createPost};
}
module.exports={createXService,decodeKey};
