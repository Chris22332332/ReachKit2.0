'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

function createEmailService(env = process.env) {
  if (env.NODE_ENV === 'test' && env.REACHKIT_TEST_EMAIL_OUTBOX) {
    const outbox = path.resolve(env.REACHKIT_TEST_EMAIL_OUTBOX);
    fs.mkdirSync(outbox, { recursive: true });
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return {
      configured: true,
      async verify() { return true; },
      async send({ to, subject, text, html, kind }) {
        const info = await transporter.sendMail({ from: env.EMAIL_FROM || 'ReachKit Tests <noreply@example.test>', to, subject, text, html });
        const name = `${Date.now()}-${kind}-${require('node:crypto').randomBytes(6).toString('hex')}.eml`;
        fs.writeFileSync(path.join(outbox, name), info.message, { mode: 0o600 });
        return { accepted: true };
      }
    };
  }

  const host = String(env.SMTP_HOST || '').trim();
  const from = String(env.EMAIL_FROM || '').trim();
  const port = Number(env.SMTP_PORT || 587);
  const user = String(env.SMTP_USER || '');
  const pass = String(env.SMTP_PASSWORD || '');
  const secureSetting = String(env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureSetting === 'true' || port === 465;
  const credentialsMatch = Boolean(user) === Boolean(pass);
  const secureSettingValid = !secureSetting || secureSetting === 'true' || secureSetting === 'false';
  const configured = Boolean(host && from && Number.isInteger(port) && port > 0 && port < 65536 && credentialsMatch && secureSettingValid);
  if (!configured) return { configured: false, async verify() { throw new Error('Email delivery is not configured.'); }, async send() { throw new Error('Email delivery is not configured.'); } };

  const transport = nodemailer.createTransport({
    host, port, secure,
    requireTLS: !secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: true },
    ...(user ? { auth: { user, pass } } : {})
  });
  return {
    configured: true,
    async verify() { return transport.verify(); },
    async send({ to, subject, text, html }) {
      return transport.sendMail({ from, to, subject, text, html });
    }
  };
}

module.exports = { createEmailService };
