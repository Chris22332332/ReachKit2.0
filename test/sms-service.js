'use strict';
const assert = require('node:assert/strict');
const { createSmsService } = require('../sms-service');

async function main() {
  const env = {
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
    TWILIO_AUTH_TOKEN: 'test-auth-token-not-a-real-secret',
    TWILIO_FROM_NUMBER: '+12223334444'
  };
  let calls=0, captured;
  const fakeFetch=async (url,options) => {
    calls += 1; captured={url,options};
    return {ok:true,status:201,json:async()=>({sid:'SM'+'b'.repeat(32),status:'queued'})};
  };
  const unavailable=createSmsService({},fakeFetch);
  assert.equal(unavailable.configured,false);
  await assert.rejects(unavailable.sendOwnerTest('+12223334444'),/not configured/i);
  const sms=createSmsService(env,fakeFetch);
  assert.equal(sms.configured,true);
  await assert.rejects(sms.sendOwnerTest('12345'),/international format/i);
  assert.equal(calls,0,'Invalid numbers must not reach the provider.');
  const accepted=await sms.sendOwnerTest('+12223334444');
  assert.equal(accepted.accepted,true);
  assert.equal(accepted.providerStatus,'queued');
  assert.equal(calls,1);
  assert.equal(captured.url,'https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/Messages.json');
  assert.match(captured.options.headers.Authorization,/^Basic /);
  const form=new URLSearchParams(captured.options.body);
  assert.equal(form.get('To'),'+12223334444');
  assert.match(form.get('Body'),/test message/);
  const badResponse=createSmsService(env,async()=>({ok:false,status:401,json:async()=>({message:'private provider response'})}));
  await assert.rejects(badResponse.sendOwnerTest('+12223334444'),/rejected the configured credentials/i);
  console.log('SMS delivery service tests passed: missing configuration, strict E.164 validation, single fixed test body, authenticated provider request, and sanitized provider errors.');
}
main().catch(err=>{console.error(err);process.exitCode=1;});
