'use strict';
const assert=require('node:assert/strict');
const {createXService,decodeKey}=require('../x-service');

async function main(){
  const key=Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  assert.equal(decodeKey(key).length,32);
  assert.equal(decodeKey('not-a-key'),null);
  const env={X_CLIENT_ID:'test-client-id',X_CLIENT_SECRET:'test-client-secret',REACHKIT_TOKEN_ENCRYPTION_KEY:key};
  const responses=[
    {access_token:'access-secret',refresh_token:'refresh-secret',expires_in:7200,scope:'tweet.write users.read offline.access'},
    {data:{id:'123456789',username:'reachkit_test',name:'ReachKit Test'}},
    {data:{id:'987654321',text:'A reviewed post'}},
    {access_token:'new-access-secret',refresh_token:'new-refresh-secret',expires_in:7200,scope:'tweet.write users.read offline.access'}
  ];
  const calls=[];
  const service=createXService(env,async(url,options)=>{calls.push({url,options});const data=responses.shift();return {ok:true,status:url.includes('/tweets')?201:200,json:async()=>data};});
  assert.equal(service.configured,true);
  const authorize=new URL(service.authorizationUrl({state:'opaque-state',verifier:'a-secure-verifier',redirectUri:'https://reachkit.example/api/social/x/callback'}));
  assert.equal(authorize.origin,'https://x.com');assert.equal(authorize.searchParams.get('state'),'opaque-state');
  assert.equal(authorize.searchParams.get('scope'),'tweet.write users.read offline.access');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  const tokens=await service.exchangeCode({code:'short-lived-code',verifier:'a-secure-verifier',redirectUri:'https://reachkit.example/api/social/x/callback'});
  assert.equal(tokens.accessToken,'access-secret');assert.equal(tokens.refreshToken,'refresh-secret');
  assert.match(calls[0].url,/oauth2\/token$/);assert.match(calls[0].options.headers.Authorization,/^Basic /);
  const form=new URLSearchParams(calls[0].options.body);assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('code_verifier'),'a-secure-verifier');
  const encrypted=service.encrypt(tokens.accessToken);assert.ok(!encrypted.includes('access-secret'));assert.equal(service.decrypt(encrypted),'access-secret');
  const tampered=encrypted.slice(0,-1)+(encrypted.endsWith('a')?'b':'a');assert.throws(()=>service.decrypt(tampered),/could not be decrypted/i);
  assert.deepEqual(await service.getProfile(tokens.accessToken),{id:'123456789',username:'reachkit_test',name:'ReachKit Test'});
  assert.deepEqual(await service.createPost(tokens.accessToken,'A reviewed post'),{id:'987654321',text:'A reviewed post'});
  assert.equal(JSON.parse(calls[2].options.body).text,'A reviewed post');
  const refreshed=await service.refresh(tokens.refreshToken);assert.equal(refreshed.accessToken,'new-access-secret');assert.equal(new URLSearchParams(calls[3].options.body).get('grant_type'),'refresh_token');
  const disabled=createXService({X_CLIENT_ID:'client',REACHKIT_TOKEN_ENCRYPTION_KEY:''},async()=>{throw new Error('must not call');});
  assert.equal(disabled.configured,false);assert.throws(()=>disabled.authorizationUrl({state:'s',verifier:'v',redirectUri:'http://localhost'}),/not configured/i);
  const failed=createXService(env,async()=>({ok:false,status:429,json:async()=>({message:'private provider detail'})}));
  await assert.rejects(failed.createPost('token','post text'),/X did not accept this post \(HTTP 429\)/i);
  console.log('X service tests passed: PKCE authorize URL, code exchange, encrypted token round-trip/tamper rejection, account lookup, text publishing, refresh rotation, and sanitized provider errors.');
}
main().catch(err=>{console.error(err);process.exitCode=1;});
