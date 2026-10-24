'use strict';

function createSmsService(env = process.env, fetchImpl = globalThis.fetch) {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(env.TWILIO_FROM_NUMBER || '').trim();
  const configured = /^AC[a-f0-9]{32}$/i.test(accountSid) && authToken.length >= 16 && /^\+[1-9]\d{7,14}$/.test(from) && typeof fetchImpl === 'function';
  return {
    configured,
    async sendOwnerTest(to) {
      if (!configured) throw new Error('SMS delivery is not configured.');
      if (!/^\+[1-9]\d{7,14}$/.test(String(to || ''))) throw new Error('Enter a phone number in international format (for example, +12223334444).');
      const form = new URLSearchParams({
        To: String(to), From: from,
        Body: 'ReachKit test message. You requested this one-time delivery test. Reply STOP to opt out.'
      });
      const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: form,
        signal: AbortSignal.timeout(12000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
          ? 'Twilio rejected the configured credentials or sender.'
          : `Twilio could not accept this test message (HTTP ${response.status}${Number.isInteger(data.code) ? `, code ${data.code}` : ''}).`);
        error.statusCode = 502;
        throw error;
      }
      if (!data || typeof data.sid !== 'string' || !/^SM[a-f0-9]{32}$/i.test(data.sid)) {
        const error = new Error('Twilio returned an unexpected response; message delivery could not be confirmed.');
        error.statusCode = 502;
        throw error;
      }
      return { accepted: true, providerMessageId: data.sid, providerStatus: String(data.status || 'queued').slice(0, 24) };
    }
  };
}

module.exports = { createSmsService };
