'use strict';
// Node 20+ server. Secrets remain on the server, never in browser JS.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { buildDraftPrompt, cleanDraftResult } = require('./drafting');
const { createEmailService } = require('./email-service');
const { createSmsService } = require('./sms-service');
const { createXService } = require('./x-service');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MIGRATIONS = path.join(ROOT, 'migrations');
let DATA_DIR = path.join(ROOT, 'data');
let PUBLIC_CAMPAIGN_FILE = path.join(DATA_DIR, 'public-campaign.json');
let CLICK_STATS_FILE = path.join(DATA_DIR, 'click-stats.json');
let AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-providers.json');
let USERS_FILE = path.join(DATA_DIR, 'users.json');
let CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
let SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
let AUTH_TOKENS_FILE = path.join(DATA_DIR, 'auth-tokens.json');
let CONVERSION_EVENTS_FILE = path.join(DATA_DIR, 'conversion-events.json');
let SAVINGS_GOALS_FILE = path.join(DATA_DIR, 'savings-goals.json');
let X_CONNECTIONS_FILE = path.join(DATA_DIR, 'x-connections.json');
let X_POSTS_FILE = path.join(DATA_DIR, 'x-posts.json');
let UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
let PORT = Number(process.env.PORT || 3000);

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#') || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
loadEnv();
PORT = Number(process.env.PORT || 3000);
if (process.env.REACHKIT_DATA_DIR && process.env.REACHKIT_DATA_DIR.trim()) {
  DATA_DIR = path.resolve(process.env.REACHKIT_DATA_DIR.trim());
  PUBLIC_CAMPAIGN_FILE = path.join(DATA_DIR, 'public-campaign.json');
  CLICK_STATS_FILE = path.join(DATA_DIR, 'click-stats.json');
  AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-providers.json');
  USERS_FILE = path.join(DATA_DIR, 'users.json');
  CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
  SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
  AUTH_TOKENS_FILE = path.join(DATA_DIR, 'auth-tokens.json');
  CONVERSION_EVENTS_FILE = path.join(DATA_DIR, 'conversion-events.json');
  SAVINGS_GOALS_FILE = path.join(DATA_DIR, 'savings-goals.json');
  X_CONNECTIONS_FILE = path.join(DATA_DIR, 'x-connections.json');
  X_POSTS_FILE = path.join(DATA_DIR, 'x-posts.json');
  UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
}

let pgPool = null;
let pgDriverError = null;
function postgresPoolOptions(connectionString) {
  const parsed = new URL(connectionString);
  let urlMode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
  const hasCertificateFiles = ['sslrootcert','sslcert','sslkey'].some(key => parsed.searchParams.has(key));
  if (!urlMode && hasCertificateFiles) urlMode = 'verify-full';
  if (urlMode === 'prefer') urlMode = 'verify-full';
  const override = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  const mode = override || urlMode;
  if (process.env.NODE_ENV === 'production' && mode === 'disable') throw new Error('TLS cannot be disabled for production PostgreSQL connections.');
  let ssl;
  if (mode === 'disable') ssl = false;
  else if (['require','verify-ca','verify-full'].includes(mode)) {
    ssl = { rejectUnauthorized:true };
    const caPath = process.env.DATABASE_SSL_CA || parsed.searchParams.get('sslrootcert');
    if (caPath) ssl.ca = fs.readFileSync(path.resolve(caPath), 'utf8');
    const certPath = parsed.searchParams.get('sslcert'), keyPath = parsed.searchParams.get('sslkey');
    if (certPath) ssl.cert = fs.readFileSync(path.resolve(certPath), 'utf8');
    if (keyPath) ssl.key = fs.readFileSync(path.resolve(keyPath), 'utf8');
  } else if (mode) throw new Error('DATABASE_SSL must be blank, require, verify-ca, verify-full, or disable (development only).');
  // node-postgres lets sslmode/sslrootcert in the URL replace the explicit TLS object.
  // Remove those parameters so production cannot silently fall back to unverified TLS.
  for (const key of ['sslmode','sslrootcert','sslcert','sslkey']) parsed.searchParams.delete(key);
  return { connectionString:parsed.toString(), ssl };
}
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      ...postgresPoolOptions(process.env.DATABASE_URL),
      max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
    });
    pgPool.on('error', err => console.error('ReachKit PostgreSQL pool error:', err.message));
  } catch (err) { pgDriverError = err; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const adminPassword = (process.env.REACHKIT_ADMIN_PASSWORD || '').trim();
const conversionWebhookSecret = String(process.env.REACHKIT_CONVERSION_WEBHOOK_SECRET || '');
const emailService = createEmailService(process.env);
const smsService = createSmsService(process.env);
const xService = createXService(process.env);
const adminSessions = new Map();
const accountLoginWindows = new Map();
const accountRegisterWindows = new Map();
const accountEmailWindows = new Map();
const accountTokenWindows = new Map();
const conversionWebhookWindows = new Map();
const adminLoginWindows = new Map();
const adminMessageTestWindows = new Map();
const xOAuthStates = new Map();
const xConnectWindows = new Map();
const xPostWindows = new Map();
const requestWindows = new Map();
let localCampaignEventQueue = Promise.resolve();
let analyticsHashKey = null;
let lastUniqueFingerprintCleanupDay = '';
let localConversionEventQueue = Promise.resolve();
let localSavingsGoalQueue = Promise.resolve();
let localXDataQueue = Promise.resolve();
const MAX_BODY = 32 * 1024;
const AI_WINDOW_MS = 15 * 60 * 1000;
const AI_MAX_REQUESTS = 20;

function readStore(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_e) { return fallback; }
}
function writeStore(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
const AI_PROVIDERS = {
  google: { label: 'Google Gemini', family: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/app/apikey', access: 'Free quota is available for some models and regions; quotas and data terms vary.', keyHint: 'AIza…' },
  openrouter: { label: 'OpenRouter', family: 'openai', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', access: 'Has a changing catalog of free models plus paid models. Choose a model marked FREE / :free.', keyHint: 'sk-or-v1-…' },
  groq: { label: 'Groq', family: 'openai', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', access: 'Free developer access is available with account-specific rate limits.', keyHint: 'gsk_…' },
  cerebras: { label: 'Cerebras', family: 'openai', base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai/', access: 'A free tier is listed; limits and available models depend on account access.', keyHint: 'Paste your Cerebras key' },
  mistral: { label: 'Mistral AI', family: 'openai', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys/', access: 'Free API access is available to eligible accounts; limits apply.', keyHint: 'Paste your Mistral key' },
  huggingface: { label: 'Hugging Face Router', family: 'openai', base: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens', access: 'Free credits and provider access vary by model/account. Some calls may be paid.', keyHint: 'hf_…' },
  openai: { label: 'OpenAI', family: 'openai', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', access: 'API billing is separate from a ChatGPT subscription; do not assume it is free.', keyHint: 'sk-…' },
  anthropic: { label: 'Anthropic Claude', family: 'anthropic', base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', access: 'API billing is separate from Claude Pro/Max subscriptions; do not assume it is free.', keyHint: 'sk-ant-…' },
  deepseek: { label: 'DeepSeek', family: 'openai', base: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', access: 'Check current API prices and account credits before use; model access can change.', keyHint: 'Paste your DeepSeek key' },
  together: { label: 'Together AI', family: 'openai', base: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys', access: 'Some model offers may be free, but availability and account pricing vary.', keyHint: 'Paste your Together key' },
  fireworks: { label: 'Fireworks AI', family: 'openai', base: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/api-keys', access: 'Trial credits or paid usage may apply; check your account before generating.', keyHint: 'Paste your Fireworks key' },
  xai: { label: 'xAI', family: 'openai', base: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai/', access: 'Check current account pricing and credits; not assumed to be free.', keyHint: 'Paste your xAI key' },
  cohere: { label: 'Cohere', family: 'cohere', base: 'https://api.cohere.com', keyUrl: 'https://dashboard.cohere.com/api-keys', access: 'Trial and developer limits depend on account and current terms.', keyHint: 'Paste your Cohere key' }
};

function readAiStore() {
  const raw = readStore(AI_CONFIG_FILE, { version: 1, activeProvider: '', providers: {} });
  if (!raw || typeof raw !== 'object') return { version: 1, activeProvider: '', providers: {} };
  if (!raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) raw.providers = {};
  if (typeof raw.activeProvider !== 'string') raw.activeProvider = '';
  for (const id of Object.keys(raw.providers)) if (!AI_PROVIDERS[id] || !raw.providers[id] || typeof raw.providers[id].apiKey !== 'string') delete raw.providers[id];
  return raw;
}
function writeAiStore(store) {
  // Keys are kept in a server-only data file, never returned through API responses or stored in browser localStorage.
  writeStore(AI_CONFIG_FILE, store);
  try { fs.chmodSync(AI_CONFIG_FILE, 0o600); } catch (_e) { /* Windows does not use POSIX mode bits. */ }
}
function activeAiSettings() {
  const store = readAiStore();
  const configured = store.providers[store.activeProvider];
  if (configured && configured.apiKey && configured.model) return { providerId: store.activeProvider, ...configured };
  // API keys are configured only through the protected Settings UI, not from .env.
  return null;
}
function safeProviderList(store) {
  return Object.entries(store.providers).filter(([id, v]) => AI_PROVIDERS[id] && v && v.apiKey).map(([id, v]) => ({
    id, label: AI_PROVIDERS[id].label, model: v.model || '',
    models: Array.isArray(v.models) ? v.models.slice(0, 300).map(m => ({ id: m.id, name: m.name || m.id, free: Boolean(m.free) })) : [],
    modelCount: Array.isArray(v.models) ? v.models.length : 0,
    freeModelCount: Array.isArray(v.models) ? v.models.filter(m => m.free).length : 0,
    active: store.activeProvider === id,
    updatedAt: v.updatedAt || ''
  }));
}
function detectProviderFromKey(key) {
  const k = String(key || '').trim();
  if (k.startsWith('sk-or-v1-')) return 'openrouter';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'google';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('hf_')) return 'huggingface';
  if (k.startsWith('sk-proj-')) return 'openai';
  return '';
}
function providerAuthHeaders(providerId, key) {
  const p = AI_PROVIDERS[providerId];
  if (providerId === 'google') return {};
  if (providerId === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  return { Authorization: `Bearer ${key}` };
}
async function fetchProviderJson(url, providerId, key, extraHeaders = {}) {
  const headers = { Accept: 'application/json', ...providerAuthHeaders(providerId, key), ...extraHeaders };
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(16000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    let detail = data && data.error && (data.error.message || data.error) || data && data.message || '';
    if (typeof detail !== 'string') detail = '';
    detail = detail.replaceAll(key, '[redacted]').replace(/\s+/g, ' ').slice(0, 220);
    const err = new Error(response.status === 401 || response.status === 403 ? 'The provider rejected that API key or its permissions.' : `Provider model lookup failed (${response.status})${detail ? ': ' + detail : '.'}`);
    err.statusCode = 400;
    throw err;
  }
  return data;
}
function normalizeProviderModel(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || m.name || m.model || '').replace(/^models\//, '').trim();
  if (!id || id.length > 240) return null;
  const lower = id.toLowerCase();
  if (/embed|whisper|transcri|moderation|tts-|text-to-speech|image|dall-e|video|speech|audio|rerank|classifier/.test(lower)) return null;
  const pricePrompt = m.pricing && Number(m.pricing.prompt !== undefined ? m.pricing.prompt : m.pricing.input);
  const priceCompletion = m.pricing && Number(m.pricing.completion !== undefined ? m.pricing.completion : m.pricing.output);
  const free = /(^|[/:_-])free($|[/:_-])/.test(lower) || lower.endsWith(':free') || (m.pricing && Number.isFinite(pricePrompt) && Number.isFinite(priceCompletion) && pricePrompt === 0 && priceCompletion === 0);
  return { id, name: String(m.display_name || m.displayName || m.name || m.id || id).replace(/^models\//, '').slice(0, 160), free };
}
async function fetchProviderModels(providerId, apiKey) {
  const p = AI_PROVIDERS[providerId];
  if (!p) throw new Error('Choose a supported provider first.');
  let data;
  if (providerId === 'google') {
    const url = `${p.base}/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
    data = await fetchProviderJson(url, providerId, apiKey);
    const arr = Array.isArray(data.models) ? data.models.filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent')) : [];
    return finalizeModelList(arr.map(m => normalizeProviderModel({ id: m.name, displayName: m.displayName })), providerId);
  }
  if (providerId === 'anthropic') {
    data = await fetchProviderJson(`${p.base}/models?limit=1000`, providerId, apiKey);
    return finalizeModelList(Array.isArray(data.data) ? data.data.map(normalizeProviderModel) : [], providerId);
  }
  if (providerId === 'cohere') {
    data = await fetchProviderJson(`${p.base}/v1/models?endpoint=chat&limit=1000`, providerId, apiKey);
    const arr = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
    return finalizeModelList(arr.map(normalizeProviderModel), providerId);
  }
  data = await fetchProviderJson(`${p.base}/models`, providerId, apiKey);
  const arr = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const models = arr.map(normalizeProviderModel).filter(Boolean);
  return finalizeModelList(models, providerId);
}
function finalizeModelList(models, providerId) {
  const seen = new Set();
  let usable = models.filter(m => m && m.id && !seen.has(m.id) && seen.add(m.id));
  if (providerId === 'openrouter') {
    // `:free` endpoints are only free while OpenRouter lists them as such; availability/quotas can change.
    usable = usable.filter(m => !/embedding|image|audio|transcription|moderation/i.test(m.id));
  }
  if (!usable.length) throw new Error('The API key worked, but no chat-capable models were found for this account. Check the provider dashboard.');
  usable.sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name));
  return usable.slice(0, 300);
}
function chooseDefaultModel(models, providerId) {
  if (!models.length) return '';
  if (providerId === 'openrouter') {
    const free = models.find(m => m.free || m.id.endsWith(':free'));
    if (free) return free.id;
  }
  if (providerId === 'google') {
    const flash = models.find(m => /flash/i.test(m.id) && !/embedding/i.test(m.id));
    if (flash) return flash.id;
  }
  if (providerId === 'groq' || providerId === 'cerebras') {
    const general = models.find(m => /llama|qwen|gpt-oss|deepseek/i.test(m.id));
    if (general) return general.id;
  }
  return models[0].id;
}
async function generateProviderText(providerId, apiKey, model, prompt) {
  const p = AI_PROVIDERS[providerId];
  if (providerId === 'google') {
    const url = `${p.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json' } }), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Google Gemini request failed. Check model access, quota, or API key.');
    return (data.candidates || []).flatMap(c => c.content && Array.isArray(c.content.parts) ? c.content.parts : []).map(part => part.text || '').join('\n');
  }
  if (providerId === 'anthropic') {
    const response = await fetch(`${p.base}/messages`, { method: 'POST', headers: { ...providerAuthHeaders(providerId, apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Anthropic request failed. Check API account credits, model access, or key.');
    return Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n') : '';
  }
  if (providerId === 'cohere') {
    const response = await fetch(`${p.base}/v2/chat`, { method: 'POST', headers: { ...providerAuthHeaders(providerId, apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Cohere request failed. Check API account limits, model access, or key.');
    return Array.isArray(data.message && data.message.content) ? data.message.content.map(c => c.text || '').join('\n') : '';
  }
  const response = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { ...providerAuthHeaders(providerId, apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.75, max_tokens: 900 }), signal: AbortSignal.timeout(25000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${p.label} request failed. Check API credits, model access, limits, or key.`);
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return Array.isArray(content) ? content.map(part => part.text || '').join('\n') : (typeof content === 'string' ? content : '');
}

function getPublicCampaign() {
  const value = readStore(PUBLIC_CAMPAIGN_FILE, null);
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
  try {
    const u = new URL(value.url);
    if (u.protocol !== 'https:') return null;
  } catch (_e) { return null; }
  return value;
}
function getClickStats() {
  const s = readStore(CLICK_STATS_FILE, { total: 0, daily: {} });
  if (!s || typeof s !== 'object') return { total: 0, daily: {} };
  if (!Number.isInteger(s.total) || s.total < 0) s.total = 0;
  if (!s.daily || typeof s.daily !== 'object' || Array.isArray(s.daily)) s.daily = {};
  return s;
}
function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const ix = part.indexOf('=');
    if (ix < 0) continue;
    if (part.slice(0, ix).trim() === name) { try { return decodeURIComponent(part.slice(ix + 1).trim()); } catch (_e) { return ''; } }
  }
  return '';
}
function getAdminSession(req) {
  const token = getCookie(req, 'reachkit_admin');
  if (!token) return false;
  const item = adminSessions.get(token);
  if (!item || item.expiresAt <= Date.now()) { adminSessions.delete(token); return false; }
  return true;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const requestProto = ['http','https'].includes(forwardedProto) ? forwardedProto : (req.socket && req.socket.encrypted ? 'https' : 'http');
    return parsed.host === req.headers.host && parsed.protocol === `${requestProto}:`;
  } catch (_e) { return false; }
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function renderLandingPage(campaign) {
  const title = escapeHtml(campaign.title || 'Referral offer');
  const details = escapeHtml(campaign.details || '').replace(/\r?\n/g, '<br>');
  const campaignName = escapeHtml(campaign.name || 'Referral offer');
  const destination = escapeHtml(new URL(campaign.url).hostname);
  const destinationUrl = escapeHtml(campaign.url);
  const publishedAt = campaign.publishedAt ? new Date(campaign.publishedAt).toISOString().slice(0, 10) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f8ff"><meta name="description" content="Clear details about ${title}"><title>${title} — referral details</title><style>
    :root{color-scheme:light;--ink:#18213b;--muted:#66728d;--line:#e5e9f3;--violet:#6658ee}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top left,#ece9ff 0,transparent 48%),linear-gradient(135deg,#f8fbff,#f4f8fc);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink)}main{width:min(680px,100%);background:#fff;border:1px solid var(--line);border-radius:28px;padding:clamp(24px,5vw,48px);box-shadow:0 24px 70px #18213b12}.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:14px;color:var(--muted)}.mark{width:36px;height:36px;display:grid;place-items:center;border-radius:12px;background:var(--violet);color:#fff;font-size:21px}.eyebrow{margin-top:35px;color:#7566e9;font-size:12px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase}h1{font-size:clamp(30px,6vw,48px);letter-spacing:-1.8px;line-height:1.08;margin:12px 0 19px}.details{font-size:16px;color:#4f5d79;overflow-wrap:anywhere}.disclosure{margin:24px 0;padding:16px 18px;background:#f6f7ff;border:1px solid #e9e8ff;border-radius:14px;color:#535f7d;font-size:13px}.cta{display:flex;justify-content:center;align-items:center;width:100%;padding:15px 20px;margin-top:24px;border-radius:13px;background:var(--violet);color:white;text-decoration:none;font-weight:800;box-shadow:0 9px 24px #6658ee33}.cta:hover{filter:brightness(.97);transform:translateY(-1px)}.fine{font-size:12px;color:#8a94a9;margin:17px 0 0;overflow-wrap:anywhere}.foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:28px;padding-top:17px;color:#8a94a9;font-size:11px}.foot a{color:#6658ee}
    </style></head><body><main><div class="brand"><span class="mark">↗</span><span>ReachKit · ${campaignName}</span></div><div class="eyebrow">referral offer details</div><h1>${title}</h1><div class="details">${details}</div><div class="disclosure"><strong>referral disclosure:</strong> this is a referral link. The person sharing it may receive a reward if you qualify. Rewards and eligibility depend on the provider's current terms; nothing is guaranteed.</div><div style="margin:22px 0 8px"><h2 style="font-size:18px;margin:0 0 10px">how to follow the official process</h2><ol style="padding-left:22px;margin:0;color:#4f5d79;font-size:13px;line-height:1.6"><li>Check the program's current age, region, account, and offer requirements.</li><li>Continue on the official site and sign in yourself using your own account. Never share passwords with the person referring you.</li><li>Complete only the qualifying actions shown by the provider.</li><li>Check the official rewards page; only the provider can confirm eligibility and credit points.</li></ol></div><a class="cta" href="${destinationUrl}" target="_blank" rel="nofollow sponsored noopener noreferrer" data-track-click>Open the actual referral link <span aria-hidden="true">&nbsp;↗</span></a><p class="fine">Destination: <strong>${destination}</strong>. The button opens this destination directly; clicks are counted in aggregate and no visitor identity is stored.</p><p class="fine">Read the provider's current terms before signing up. I can't guarantee that everyone will qualify. This page is independently operated and is not an official provider page. No passwords or account details are collected here.</p><div class="foot"><span>updated ${publishedAt || 'recently'}</span><a href="https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam" rel="noopener noreferrer">Share only where referral links are allowed</a></div></main><script>const cta=document.querySelector('[data-track-click]');if(cta)cta.addEventListener('click',()=>{try{const body=new Blob(['{}'],{type:'application/json'});if(navigator.sendBeacon)navigator.sendBeacon('/api/click',body);else fetch('/api/click',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});}catch(_e){}});</script></body></html>`;
}
function adminRequired(req, res) {
  if (!adminPassword) { sendJson(res, 503, { error: 'Admin publishing is disabled. Set REACHKIT_ADMIN_PASSWORD in .env and restart the server.' }); return false; }
  if (!getAdminSession(req)) { sendJson(res, 401, { error: 'Admin session expired. Unlock publishing again.' }); return false; }
  if (!sameOrigin(req)) { sendJson(res, 403, { error: 'Cross-origin request rejected.' }); return false; }
  return true;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY'
  });
  res.end(body);
}
function securityHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self' https://www.reddit.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
}
function getClientKey(req) { return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown'; }
function adminLoginAllowed(req) {
  const now = Date.now(); const key = getClientKey(req);
  let item = adminLoginWindows.get(key);
  if (!item || now - item.start > 15 * 60 * 1000) item = { start: now, count: 0 };
  item.count += 1; adminLoginWindows.set(key, item);
  if (adminLoginWindows.size > 500) for (const [k, v] of adminLoginWindows) if (now - v.start > 15 * 60 * 1000) adminLoginWindows.delete(k);
  return item.count <= 10;
}
function aiRateAllowed(req) {
  const now = Date.now(); const key = getClientKey(req);
  let state = requestWindows.get(key);
  if (!state || now - state.start > AI_WINDOW_MS) state = { start: now, count: 0 };
  state.count += 1; requestWindows.set(key, state);
  // Occasional cleanup so the map doesn't grow forever in a long-running local server.
  if (requestWindows.size > 500) {
    for (const [k, v] of requestWindows) if (now - v.start > AI_WINDOW_MS) requestWindows.delete(k);
  }
  return state.count <= AI_MAX_REQUESTS;
}
async function readJson(req, maxBytes = MAX_BODY) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch (_e) { throw Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }); }
}
async function readRawJson(req, maxBytes = 16 * 1024) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch (_e) { throw Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }); }
  return { raw, body };
}
function readUsers() {
  const store = readStore(USERS_FILE, { users: [] });
  if (!store || typeof store !== 'object' || !Array.isArray(store.users)) return { users: [] };
  store.users = store.users.filter(u => u && typeof u.id === 'string' && typeof u.email === 'string' && typeof u.passwordSalt === 'string' && typeof u.passwordHash === 'string');
  return store;
}
function writeUsers(store) { writeStore(USERS_FILE, store); }
function readCampaigns() {
  const store = readStore(CAMPAIGNS_FILE, { campaigns: [] });
  if (!store || typeof store !== 'object' || !Array.isArray(store.campaigns)) return { campaigns: [] };
  store.campaigns = store.campaigns.filter(c => c && typeof c.id === 'string' && typeof c.ownerId === 'string' && typeof c.slug === 'string');
  return store;
}
function writeCampaigns(store) { writeStore(CAMPAIGNS_FILE, store); }
async function ensureDatabaseSchema() {
  if (!pgPool) return;
  await pgPool.query(`CREATE TABLE IF NOT EXISTS reachkit_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS reachkit_campaigns (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES reachkit_users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT NOT NULL, name TEXT NOT NULL,
    details TEXT NOT NULL, image_path TEXT NOT NULL, image_data BYTEA, published BOOLEAN NOT NULL DEFAULT TRUE,
    clicks INTEGER NOT NULL DEFAULT 0, daily_clicks JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await pgPool.query('CREATE TABLE IF NOT EXISTS reachkit_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  if (fs.existsSync(MIGRATIONS)) {
    const migrations = fs.readdirSync(MIGRATIONS).filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for (const name of migrations) {
      const seen = await pgPool.query('SELECT 1 FROM reachkit_schema_migrations WHERE name=$1', [name]);
      if (seen.rowCount) continue;
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        const sql = fs.readFileSync(path.join(MIGRATIONS,name), 'utf8');
        for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await client.query(statement);
        await client.query('INSERT INTO reachkit_schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (err) { await client.query('ROLLBACK'); throw new Error(`Database migration ${name} failed: ${err.message}`); }
      finally { client.release(); }
    }
  }
}
function readSavingsGoals() {
  const store = readStore(SAVINGS_GOALS_FILE, { goals:[] });
  return store && Array.isArray(store.goals) ? store : { goals:[] };
}
function normalizeSavingsGoal(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Goal data must be an object.'), { statusCode:400 });
  const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g,' ').slice(0,80) : '';
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : 'USD';
  const amount = value => {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 999999999.99) return null;
    const cents = Math.round(number * 100);
    return Number.isSafeInteger(cents) ? cents / 100 : null;
  };
  const targetAmount = amount(body.targetAmount), currentAmount = amount(body.currentAmount);
  if (!title) throw Object.assign(new Error('Give your goal a name.'), { statusCode:400 });
  if (targetAmount === null || targetAmount <= 0) throw Object.assign(new Error('Enter a target greater than zero and below 1 billion.'), { statusCode:400 });
  if (currentAmount === null) throw Object.assign(new Error('Enter a valid current amount (zero is okay).'), { statusCode:400 });
  if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('Currency must be a three-letter code.'), { statusCode:400 });
  const rawDate = typeof body.targetDate === 'string' ? body.targetDate.trim() : '';
  const targetDate = rawDate || null;
  if (targetDate) {
    const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(targetDate) ? new Date(`${targetDate}T00:00:00Z`) : null;
    if (!dateValue || !Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0,10) !== targetDate) throw Object.assign(new Error('Choose a valid target date.'), { statusCode:400 });
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0,300) : '';
  return { title,targetAmount,currentAmount,currency,targetDate,note };
}
async function listUserSavingsGoals(ownerId) {
  if (pgPool) {
    const result = await pgPool.query('SELECT id,owner_id,title,target_amount,current_amount,currency,target_date,note,created_at,updated_at FROM reachkit_savings_goals WHERE owner_id=$1 ORDER BY created_at DESC', [ownerId]);
    return result.rows.map(row => ({ id:row.id,ownerId:row.owner_id,title:row.title,targetAmount:Number(row.target_amount),currentAmount:Number(row.current_amount),currency:row.currency,targetDate:row.target_date ? String(row.target_date).slice(0,10) : null,note:row.note||'',createdAt:row.created_at,updatedAt:row.updated_at }));
  }
  return readSavingsGoals().goals.filter(goal => goal.ownerId === ownerId).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function saveUserSavingsGoal(ownerId, values, goalId = '') {
  const now = new Date().toISOString();
  if (pgPool) {
    if (goalId) {
      const updated = await pgPool.query(`UPDATE reachkit_savings_goals SET title=$3,target_amount=$4,current_amount=$5,currency=$6,target_date=$7,note=$8,updated_at=$9
        WHERE id=$1 AND owner_id=$2 RETURNING id`, [goalId,ownerId,values.title,values.targetAmount,values.currentAmount,values.currency,values.targetDate,values.note,now]);
      return updated.rowCount ? (await listUserSavingsGoals(ownerId)).find(goal => goal.id === goalId) : null;
    }
    const count = await pgPool.query('SELECT count(*)::int AS count FROM reachkit_savings_goals WHERE owner_id=$1', [ownerId]);
    if (Number(count.rows[0].count) >= 20) throw Object.assign(new Error('You can save up to 20 personal goals.'), { statusCode:409 });
    const goal = { id:crypto.randomUUID(),ownerId,...values,createdAt:now,updatedAt:now };
    await pgPool.query(`INSERT INTO reachkit_savings_goals(id,owner_id,title,target_amount,current_amount,currency,target_date,note,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [goal.id,ownerId,goal.title,goal.targetAmount,goal.currentAmount,goal.currency,goal.targetDate,goal.note,now,now]);
    return goal;
  }
  let saved = null;
  const run = localSavingsGoalQueue.then(() => {
    const store = readSavingsGoals();
    if (goalId) {
      const index = store.goals.findIndex(goal => goal.id === goalId && goal.ownerId === ownerId);
      if (index < 0) return;
      store.goals[index] = { ...store.goals[index],...values,updatedAt:now }; saved = store.goals[index];
    } else {
      if (store.goals.filter(goal => goal.ownerId === ownerId).length >= 20) throw Object.assign(new Error('You can save up to 20 personal goals.'), { statusCode:409 });
      saved = { id:crypto.randomUUID(),ownerId,...values,createdAt:now,updatedAt:now }; store.goals.push(saved);
    }
    writeStore(SAVINGS_GOALS_FILE,store);
  });
  localSavingsGoalQueue = run.catch(() => {});
  await run;
  return saved;
}
async function deleteUserSavingsGoal(ownerId, goalId) {
  if (pgPool) {
    const result = await pgPool.query('DELETE FROM reachkit_savings_goals WHERE id=$1 AND owner_id=$2 RETURNING id', [goalId,ownerId]);
    return Boolean(result.rowCount);
  }
  let deleted = false;
  const run = localSavingsGoalQueue.then(() => {
    const store = readSavingsGoals(), count = store.goals.length;
    store.goals = store.goals.filter(goal => !(goal.id === goalId && goal.ownerId === ownerId));
    deleted = store.goals.length !== count;
    if (deleted) writeStore(SAVINGS_GOALS_FILE,store);
  });
  localSavingsGoalQueue = run.catch(() => {});
  await run;
  return deleted;
}
function readXConnections() {
  const data=readStore(X_CONNECTIONS_FILE,{connections:[]});
  return data&&Array.isArray(data.connections)?data:{connections:[]};
}
function readXPosts() {
  const data=readStore(X_POSTS_FILE,{posts:[]});
  return data&&Array.isArray(data.posts)?data:{posts:[]};
}
function safeXConnection(record) {
  return record?{connected:true,username:record.username,displayName:record.displayName,connectedAt:record.connectedAt,expiresAt:Number(record.expiresAt)}:{connected:false,username:'',displayName:'',connectedAt:'',expiresAt:0};
}
async function getUserXConnection(ownerId) {
  if(pgPool){const result=await pgPool.query('SELECT owner_id,x_user_id,username,display_name,access_token_encrypted,refresh_token_encrypted,expires_at,connected_at,updated_at FROM reachkit_x_connections WHERE owner_id=$1',[ownerId]);const r=result.rows[0];return r?{ownerId:r.owner_id,xUserId:r.x_user_id,username:r.username,displayName:r.display_name,accessTokenEncrypted:r.access_token_encrypted,refreshTokenEncrypted:r.refresh_token_encrypted,expiresAt:Number(r.expires_at),connectedAt:r.connected_at,updatedAt:r.updated_at}:null;}
  return readXConnections().connections.find(item=>item.ownerId===ownerId)||null;
}
async function saveUserXConnection(record) {
  if(pgPool){await pgPool.query(`INSERT INTO reachkit_x_connections(owner_id,x_user_id,username,display_name,access_token_encrypted,refresh_token_encrypted,expires_at,connected_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id) DO UPDATE SET x_user_id=EXCLUDED.x_user_id,username=EXCLUDED.username,display_name=EXCLUDED.display_name,access_token_encrypted=EXCLUDED.access_token_encrypted,refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`,[record.ownerId,record.xUserId,record.username,record.displayName,record.accessTokenEncrypted,record.refreshTokenEncrypted,record.expiresAt,record.connectedAt,record.updatedAt]);return;}
  const run=localXDataQueue.then(()=>{const data=readXConnections(),i=data.connections.findIndex(item=>item.ownerId===record.ownerId);if(i<0)data.connections.push(record);else data.connections[i]=record;writeStore(X_CONNECTIONS_FILE,data);});localXDataQueue=run.catch(()=>{});await run;
}
async function deleteUserXConnection(ownerId) {
  if(pgPool){await pgPool.query('DELETE FROM reachkit_x_connections WHERE owner_id=$1',[ownerId]);return;}
  const run=localXDataQueue.then(()=>{const data=readXConnections();data.connections=data.connections.filter(item=>item.ownerId!==ownerId);writeStore(X_CONNECTIONS_FILE,data);});localXDataQueue=run.catch(()=>{});await run;
}
async function listUserXPosts(ownerId) {
  if(pgPool){const result=await pgPool.query('SELECT id,x_post_id,username,text,created_at FROM reachkit_x_posts WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',[ownerId]);return result.rows.map(r=>({id:r.id,postId:r.x_post_id,username:r.username,text:r.text,createdAt:r.created_at,url:`https://x.com/${encodeURIComponent(r.username)}/status/${r.x_post_id}`}));}
  return readXPosts().posts.filter(item=>item.ownerId===ownerId).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100).map(item=>({id:item.id,postId:item.postId,username:item.username,text:item.text,createdAt:item.createdAt,url:`https://x.com/${encodeURIComponent(item.username)}/status/${item.postId}`}));
}
async function saveUserXPost(ownerId,username,post) {
  const record={id:crypto.randomUUID(),ownerId,postId:post.id,username,text:post.text,createdAt:new Date().toISOString()};
  if(pgPool){await pgPool.query('INSERT INTO reachkit_x_posts(id,owner_id,x_post_id,username,text,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(x_post_id) DO NOTHING',[record.id,record.ownerId,record.postId,record.username,record.text,record.createdAt]);return record;}
  const run=localXDataQueue.then(()=>{const data=readXPosts();if(!data.posts.some(item=>item.postId===record.postId)){data.posts.push(record);writeStore(X_POSTS_FILE,data);}return record;});localXDataQueue=run.catch(()=>{});return await run;
}
async function freshXAccessToken(ownerId,record) {
  if(record.expiresAt>Date.now()+120000)return xService.decrypt(record.accessTokenEncrypted);
  if(!record.refreshTokenEncrypted)throw Object.assign(new Error('X access expired. Disconnect and reconnect your account.'),{statusCode:401});
  const refreshed=await xService.refresh(xService.decrypt(record.refreshTokenEncrypted));
  record.accessTokenEncrypted=xService.encrypt(refreshed.accessToken);
  if(refreshed.refreshToken)record.refreshTokenEncrypted=xService.encrypt(refreshed.refreshToken);
  record.expiresAt=refreshed.expiresAt;record.updatedAt=new Date().toISOString();await saveUserXConnection(record);
  return refreshed.accessToken;
}
function xWeightedLength(text) {
  const normalized=String(text||'').normalize('NFC').replace(/https?:\/\/[^\s<>]+/gi,'x'.repeat(23));
  return Array.from(normalized).reduce((total,char)=>{
    const cp=char.codePointAt(0);
    const wide=cp>=0x1100&&(cp<=0x11ff||cp>=0x2e80&&cp<=0xa4cf||cp>=0xac00&&cp<=0xd7af||cp>=0xf900&&cp<=0xfaff||cp>=0xfe10&&cp<=0xfe6f||cp>=0xff00&&cp<=0xff60||cp>=0x1f000);
    return total+(wide?2:1);
  },0);
}
function xRedirectUri(req) {
  const explicit=String(process.env.X_REDIRECT_URI||'').trim();
  const uri=explicit||`${accountLinkOrigin(req)}/api/social/x/callback`;
  const parsed=new URL(uri);
  if(parsed.username||parsed.password||parsed.pathname!=='/api/social/x/callback'||parsed.search||parsed.hash||(process.env.NODE_ENV==='production'&&parsed.protocol!=='https:')) throw new Error('X_REDIRECT_URI must be the exact HTTPS callback URL /api/social/x/callback in production.');
  return parsed.toString();
}
async function getUsersStore() {
  if (!pgPool) return readUsers();
  const result = await pgPool.query('SELECT id,email,display_name,password_salt,password_hash,created_at,email_verified_at FROM reachkit_users');
  return { users: result.rows.map(r => ({ id:r.id, email:r.email, displayName:r.display_name, passwordSalt:r.password_salt, passwordHash:r.password_hash, createdAt:r.created_at, emailVerifiedAt:r.email_verified_at || null })) };
}
async function persistUserStore(store, user) {
  if (!pgPool) { writeUsers(store); return; }
  await pgPool.query('INSERT INTO reachkit_users(id,email,display_name,password_salt,password_hash,created_at,email_verified_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [user.id,user.email,user.displayName,user.passwordSalt,user.passwordHash,user.createdAt,user.emailVerifiedAt || null]);
}
async function updateUserRecord(user) {
  if (pgPool) {
    await pgPool.query('UPDATE reachkit_users SET email_verified_at=$2,password_salt=$3,password_hash=$4 WHERE id=$1', [user.id,user.emailVerifiedAt || null,user.passwordSalt,user.passwordHash]);
    return;
  }
  const store = readUsers(), index = store.users.findIndex(item => item.id === user.id);
  if (index < 0) throw new Error('Account no longer exists.');
  store.users[index] = user; writeUsers(store);
}
function readAuthTokens() {
  const data = readStore(AUTH_TOKENS_FILE, { tokens: [] });
  return data && Array.isArray(data.tokens) ? data : { tokens: [] };
}
function hashAuthToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
async function issueAuthToken(userId, purpose, lifetimeMs) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  const record = { tokenHash:hashAuthToken(token), userId, purpose, createdAt:now, expiresAt:now + lifetimeMs };
  if (pgPool) {
    await pgPool.query(`INSERT INTO reachkit_auth_tokens(token_hash,user_id,purpose,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id,purpose) DO UPDATE
      SET token_hash=EXCLUDED.token_hash,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`, [record.tokenHash,userId,purpose,now,record.expiresAt]);
  } else {
    const store = readAuthTokens();
    store.tokens = store.tokens.filter(item => item.expiresAt > now && !(item.userId === userId && item.purpose === purpose));
    store.tokens.push(record); writeStore(AUTH_TOKENS_FILE, store);
  }
  return token;
}
async function consumeAuthToken(token, purpose) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const tokenHash = hashAuthToken(token), now = Date.now();
  if (pgPool) {
    const result = await pgPool.query('DELETE FROM reachkit_auth_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>$3 RETURNING user_id', [tokenHash,purpose,now]);
    return result.rows[0]?.user_id || null;
  }
  const store = readAuthTokens(), record = store.tokens.find(item => item.tokenHash === tokenHash && item.purpose === purpose && item.expiresAt > now);
  store.tokens = store.tokens.filter(item => item.tokenHash !== tokenHash);
  writeStore(AUTH_TOKENS_FILE, store);
  return record ? record.userId : null;
}
async function removeUserAuthTokens(userId) {
  if (pgPool) { await pgPool.query('DELETE FROM reachkit_auth_tokens WHERE user_id=$1', [userId]); return; }
  const store = readAuthTokens(); store.tokens = store.tokens.filter(item => item.userId !== userId); writeStore(AUTH_TOKENS_FILE, store);
}
async function getCampaignStore() {
  if (!pgPool) return readCampaigns();
  const result = await pgPool.query('SELECT id,owner_id,slug,url,title,name,details,image_path,image_data,published,clicks,daily_clicks,unique_clicks,daily_unique_clicks,views,daily_views,created_at,updated_at FROM reachkit_campaigns');
  return { campaigns: result.rows.map(r => ({ id:r.id, ownerId:r.owner_id, slug:r.slug, url:r.url, title:r.title, name:r.name, details:r.details, imagePath:r.image_path, imageDataBuffer:r.image_data || null, published:r.published, clicks:r.clicks, dailyClicks:r.daily_clicks || {}, uniqueClicks:Number(r.unique_clicks)||0, dailyUniqueClicks:r.daily_unique_clicks||{}, views:Number(r.views)||0, dailyViews:r.daily_views||{}, createdAt:r.created_at, updatedAt:r.updated_at })) };
}
function analyticsKey() {
  if (analyticsHashKey) return analyticsHashKey;
  const configured = String(process.env.REACHKIT_ANALYTICS_HASH_SECRET || '').trim();
  if (configured) {
    if (configured.length < 32) throw new Error('REACHKIT_ANALYTICS_HASH_SECRET must contain at least 32 characters.');
    analyticsHashKey = Buffer.from(configured, 'utf8');
    return analyticsHashKey;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Set REACHKIT_ANALYTICS_HASH_SECRET to a stable random value of at least 32 characters in production.');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keyFile = path.join(DATA_DIR, 'analytics-hash-key');
  try {
    const key = fs.readFileSync(keyFile);
    if (key.length === 32) { analyticsHashKey = key; return key; }
  } catch (_e) {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { flag: 'w', mode: 0o600 });
  analyticsHashKey = key;
  return key;
}
function campaignClickFingerprint(req, campaignId, day) {
  let address = req.socket && req.socket.remoteAddress || '';
  if (String(process.env.REACHKIT_TRUST_PROXY || '').trim().toLowerCase() === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const candidates = forwarded.split(',').map(value => value.trim());
      const proxyAddress = candidates.find(value => net.isIP(value));
      if (proxyAddress) address = proxyAddress;
    }
  }
  if (address.startsWith('::ffff:')) address = address.slice(7);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
  return crypto.createHmac('sha256', analyticsKey()).update(`${day}\0${campaignId}\0${address}\0${userAgent}`).digest('hex');
}
function normalizeConversionEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Webhook JSON must be an object.'), { statusCode: 400 });
  const eventId = typeof value.eventId === 'string' ? value.eventId.trim() : '';
  const conversionId = typeof value.conversionId === 'string' ? value.conversionId.trim() : '';
  const provider = typeof value.provider === 'string' ? value.provider.trim().toLowerCase() : '';
  const campaignSlug = typeof value.campaignSlug === 'string' ? value.campaignSlug.trim().toLowerCase() : '';
  const statuses = new Set(['signup','qualified','rewarded','rejected','reversed']);
  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(conversionId)) throw Object.assign(new Error('eventId and conversionId must be stable, provider-issued identifiers.'), { statusCode: 400 });
  if (!/^[a-z0-9][a-z0-9._-]{1,59}$/.test(provider)) throw Object.assign(new Error('provider must be a short provider identifier.'), { statusCode: 400 });
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(campaignSlug)) throw Object.assign(new Error('campaignSlug is invalid.'), { statusCode: 400 });
  if (!statuses.has(status)) throw Object.assign(new Error('status must be signup, qualified, rewarded, rejected, or reversed.'), { statusCode: 400 });
  const amount = value.rewardAmount === undefined || value.rewardAmount === null || value.rewardAmount === '' ? null : Number(value.rewardAmount);
  const currency = value.currency === undefined || value.currency === null || value.currency === '' ? null : String(value.currency).trim().toUpperCase();
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 100000000)) throw Object.assign(new Error('rewardAmount must be between 0 and 100000000.'), { statusCode: 400 });
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('currency must be a three-letter currency code.'), { statusCode: 400 });
  if ((amount === null) !== (currency === null)) throw Object.assign(new Error('Provide both rewardAmount and currency, or neither.'), { statusCode: 400 });
  if (amount !== null && status !== 'rewarded') throw Object.assign(new Error('A reward amount is only accepted for a rewarded event.'), { statusCode: 400 });
  const occurredAt = value.occurredAt === undefined ? new Date().toISOString() : String(value.occurredAt);
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 366 * 86400000) throw Object.assign(new Error('occurredAt must be a valid timestamp within the last or next 366 days.'), { statusCode: 400 });
  return { provider, eventId, conversionId, campaignSlug, status, rewardAmount:amount, currency, occurredAt:new Date(timestamp).toISOString() };
}
function validWebhookSignature(raw, supplied) {
  if (!conversionWebhookSecret || typeof supplied !== 'string') return false;
  const signature = supplied.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac('sha256', conversionWebhookSecret).update(raw).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
async function recordConversionEvent(event) {
  if (pgPool) {
    const campaign = await pgPool.query('SELECT id FROM reachkit_campaigns WHERE slug=$1', [event.campaignSlug]);
    if (!campaign.rowCount) return { missingCampaign:true };
    const inserted = await pgPool.query(`INSERT INTO reachkit_conversion_events(provider,event_id,campaign_id,conversion_id,status,reward_amount,currency,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider,event_id) DO NOTHING RETURNING event_id`, [event.provider,event.eventId,campaign.rows[0].id,event.conversionId,event.status,event.rewardAmount,event.currency,event.occurredAt]);
    return { duplicate:!inserted.rowCount };
  }
  let result;
  const run = localConversionEventQueue.then(() => {
    const campaign = readCampaigns().campaigns.find(item => item.slug === event.campaignSlug);
    if (!campaign) { result = { missingCampaign:true }; return; }
    const store = readStore(CONVERSION_EVENTS_FILE, { events:[] });
    if (store.events.some(item => item.provider === event.provider && item.eventId === event.eventId)) { result = { duplicate:true }; return; }
    store.events.push({ ...event, campaignId:campaign.id, receivedAt:new Date().toISOString() });
    writeStore(CONVERSION_EVENTS_FILE, store); result = { duplicate:false };
  });
  localConversionEventQueue = run.catch(() => {});
  await run;
  return result || { duplicate:false };
}
async function getUserConversionEvents(ownerId) {
  if (pgPool) {
    const result = await pgPool.query(`WITH latest AS (
      SELECT e.provider,e.event_id,e.conversion_id,e.status,e.reward_amount,e.currency,e.occurred_at,c.slug,c.title,
        row_number() OVER(PARTITION BY e.provider,e.conversion_id ORDER BY e.occurred_at DESC,e.received_at DESC) AS rn
      FROM reachkit_conversion_events e JOIN reachkit_campaigns c ON c.id=e.campaign_id WHERE c.owner_id=$1
    ) SELECT provider,event_id AS "eventId",conversion_id AS "conversionId",status,reward_amount AS "rewardAmount",currency,occurred_at AS "occurredAt",slug,title
      FROM latest WHERE rn=1 ORDER BY occurred_at DESC LIMIT 500`, [ownerId]);
    return result.rows.map(row => ({ ...row, rewardAmount:row.rewardAmount === null ? null : Number(row.rewardAmount) }));
  }
  const owned = new Map(readCampaigns().campaigns.filter(item => item.ownerId === ownerId).map(item => [item.id,item]));
  const data = readStore(CONVERSION_EVENTS_FILE, { events:[] });
  const latest = new Map();
  for (const event of data.events.filter(item => owned.has(item.campaignId))) {
    const key = `${event.provider}:${event.conversionId}`, previous = latest.get(key);
    if (!previous || `${event.occurredAt}:${event.receivedAt}` > `${previous.occurredAt}:${previous.receivedAt}`) latest.set(key,event);
  }
  return [...latest.values()].sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0,500).map(event => {
    const campaign = owned.get(event.campaignId);
    return { provider:event.provider,eventId:event.eventId,conversionId:event.conversionId,status:event.status,rewardAmount:event.rewardAmount,currency:event.currency,occurredAt:event.occurredAt,slug:campaign.slug,title:campaign.title };
  });
}
function summarizeConversionEvents(events) {
  const current = events.filter(event => !['rejected','reversed'].includes(event.status));
  const rewarded = current.filter(event => event.status === 'rewarded' && event.rewardAmount !== null && event.rewardAmount !== undefined);
  const rewards = {};
  for (const event of rewarded) rewards[event.currency] = (rewards[event.currency] || 0) + Number(event.rewardAmount || 0);
  return { reportedSignups:current.length, reportedQualified:current.filter(event => ['qualified','rewarded'].includes(event.status)).length,
    reportedRewards:rewarded.length, rewardsByCurrency:rewards, events };
}
async function getUserConversionSummary(ownerId) {
  if (!pgPool) {
    const ownedIds = new Set(readCampaigns().campaigns.filter(item => item.ownerId === ownerId).map(item => item.id));
    const all = readStore(CONVERSION_EVENTS_FILE,{events:[]});
    const latest = new Map();
    for (const event of (Array.isArray(all.events) ? all.events : []).filter(item => ownedIds.has(item.campaignId))) {
      const key = `${event.provider}:${event.conversionId}`, previous = latest.get(key);
      if (!previous || `${event.occurredAt}:${event.receivedAt}` > `${previous.occurredAt}:${previous.receivedAt}`) latest.set(key,event);
    }
    const summary = summarizeConversionEvents([...latest.values()]); delete summary.events; return summary;
  }
  const counts = await pgPool.query(`WITH ranked AS (
    SELECT e.status,e.reward_amount,row_number() OVER(PARTITION BY e.provider,e.conversion_id ORDER BY e.occurred_at DESC,e.received_at DESC) AS rn
    FROM reachkit_conversion_events e JOIN reachkit_campaigns c ON c.id=e.campaign_id WHERE c.owner_id=$1
  ) SELECT status,count(*)::int AS count FROM ranked WHERE rn=1 GROUP BY status`,[ownerId]);
  const totals = await pgPool.query(`WITH ranked AS (
    SELECT e.status,e.reward_amount,e.currency,row_number() OVER(PARTITION BY e.provider,e.conversion_id ORDER BY e.occurred_at DESC,e.received_at DESC) AS rn
    FROM reachkit_conversion_events e JOIN reachkit_campaigns c ON c.id=e.campaign_id WHERE c.owner_id=$1
  ) SELECT currency,SUM(reward_amount)::numeric AS total FROM ranked WHERE rn=1 AND status='rewarded' AND reward_amount IS NOT NULL GROUP BY currency`,[ownerId]);
  const countsByStatus = Object.fromEntries(counts.rows.map(row => [row.status,Number(row.count)]));
  return { reportedSignups:(countsByStatus.signup||0)+(countsByStatus.qualified||0)+(countsByStatus.rewarded||0),
    reportedQualified:(countsByStatus.qualified||0)+(countsByStatus.rewarded||0),
    reportedRewards:totals.rowCount,
    rewardsByCurrency:Object.fromEntries(totals.rows.map(row => [row.currency,Number(row.total)])) };
}
function removeLocalCampaignConversionEvents(campaignIds) {
  if (pgPool || !Array.isArray(campaignIds) || !campaignIds.length) return;
  const ids = new Set(campaignIds), store = readStore(CONVERSION_EVENTS_FILE,{events:[]});
  store.events = (Array.isArray(store.events) ? store.events : []).filter(event => !ids.has(event.campaignId));
  writeStore(CONVERSION_EVENTS_FILE,store);
}
async function persistCampaignStore(store, campaign) {
  if (!pgPool) { writeCampaigns(store); return; }
  await pgPool.query(`INSERT INTO reachkit_campaigns(id,owner_id,slug,url,title,name,details,image_path,image_data,published,clicks,daily_clicks,unique_clicks,daily_unique_clicks,views,daily_views,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16::jsonb,$17,$18)
    ON CONFLICT(id) DO UPDATE SET slug=EXCLUDED.slug,url=EXCLUDED.url,title=EXCLUDED.title,name=EXCLUDED.name,details=EXCLUDED.details,image_path=EXCLUDED.image_path,image_data=EXCLUDED.image_data,published=EXCLUDED.published,updated_at=EXCLUDED.updated_at`,
    [campaign.id,campaign.ownerId,campaign.slug,campaign.url,campaign.title,campaign.name,campaign.details,campaign.imagePath,campaign.imageDataBuffer || null,Boolean(campaign.published),Number(campaign.clicks)||0,JSON.stringify(campaign.dailyClicks || {}),Number(campaign.uniqueClicks)||0,JSON.stringify(campaign.dailyUniqueClicks||{}),Number(campaign.views)||0,JSON.stringify(campaign.dailyViews||{}),campaign.createdAt,campaign.updatedAt]);
}
function recordLocalCampaignEvent(slug, kind, day = new Date().toISOString().slice(0,10), fingerprint = '') {
  const run = localCampaignEventQueue.then(() => {
    const store = readCampaigns(), campaign = store.campaigns.find(c => c.slug === slug && c.published);
    if (!campaign) return null;
    const field = kind === 'click' ? 'clicks' : 'views';
    const dailyField = kind === 'click' ? 'dailyClicks' : 'dailyViews';
    campaign[field] = (Number(campaign[field]) || 0) + 1;
    campaign[dailyField] = campaign[dailyField] && typeof campaign[dailyField] === 'object' ? campaign[dailyField] : {};
    campaign[dailyField][day] = (Number(campaign[dailyField][day]) || 0) + 1;
    for (const key of Object.keys(campaign[dailyField])) if (key < new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10)) delete campaign[dailyField][key];
    if (kind === 'click' && fingerprint) {
      campaign.uniqueClickFingerprints = campaign.uniqueClickFingerprints && typeof campaign.uniqueClickFingerprints === 'object' ? campaign.uniqueClickFingerprints : {};
      campaign.uniqueClickFingerprints[day] = Array.isArray(campaign.uniqueClickFingerprints[day]) ? campaign.uniqueClickFingerprints[day] : [];
      if (!campaign.uniqueClickFingerprints[day].includes(fingerprint)) {
        campaign.uniqueClickFingerprints[day].push(fingerprint);
        campaign.uniqueClicks = (Number(campaign.uniqueClicks) || 0) + 1;
        campaign.dailyUniqueClicks = campaign.dailyUniqueClicks && typeof campaign.dailyUniqueClicks === 'object' ? campaign.dailyUniqueClicks : {};
        campaign.dailyUniqueClicks[day] = (Number(campaign.dailyUniqueClicks[day]) || 0) + 1;
      }
      for (const key of Object.keys(campaign.uniqueClickFingerprints)) if (key < new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10)) { delete campaign.uniqueClickFingerprints[key]; delete campaign.dailyUniqueClicks[key]; }
    }
    writeCampaigns(store);
    return campaign;
  });
  localCampaignEventQueue = run.catch(() => null);
  return run;
}
function hashSessionToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function readSessionStore() {
  const data = readStore(SESSIONS_FILE, { sessions: [] });
  return data && Array.isArray(data.sessions) ? data : { sessions: [] };
}
async function createAccountSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now(), expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  const record = { tokenHash: hashSessionToken(token), userId: user.id, createdAt: now, expiresAt };
  if (pgPool) await pgPool.query('INSERT INTO reachkit_sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)', [record.tokenHash,record.userId,record.expiresAt,record.createdAt]);
  else { const store = readSessionStore(); store.sessions = store.sessions.filter(s => s && s.expiresAt > now); store.sessions.push(record); writeStore(SESSIONS_FILE, store); }
  return token;
}
async function getAccountUser(req) {
  const token = getCookie(req, 'reachkit_session');
  if (!token) return null;
  const tokenHash = hashSessionToken(token), now = Date.now();
  let userId = '';
  if (pgPool) {
    const result = await pgPool.query('SELECT user_id FROM reachkit_sessions WHERE token_hash=$1 AND expires_at>$2', [tokenHash,now]);
    userId = result.rows[0] && result.rows[0].user_id || '';
  } else {
    const sessions = readSessionStore().sessions;
    const record = sessions.find(s => s && s.tokenHash === tokenHash && s.expiresAt > now);
    userId = record && record.userId || '';
  }
  if (!userId) return null;
  const users = await getUsersStore(), user = users.users.find(u => u.id === userId);
  return user ? { id:user.id, email:user.email, displayName:user.displayName, createdAt:user.createdAt, emailVerifiedAt:user.emailVerifiedAt || null } : null;
}
async function destroyAccountSession(token) {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  if (pgPool) await pgPool.query('DELETE FROM reachkit_sessions WHERE token_hash=$1', [tokenHash]);
  else { const store = readSessionStore(); store.sessions = store.sessions.filter(s => s && s.tokenHash !== tokenHash); writeStore(SESSIONS_FILE, store); }
}
async function destroyUserSessions(userId) {
  if (pgPool) await pgPool.query('DELETE FROM reachkit_sessions WHERE user_id=$1', [userId]);
  else { const store = readSessionStore(); store.sessions = store.sessions.filter(s => s && s.userId !== userId); writeStore(SESSIONS_FILE, store); }
}
function safeUser(user) { return user ? { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt, emailVerified: Boolean(user.emailVerifiedAt) } : null; }
async function accountRequired(req, res) {
  if (!sameOrigin(req)) { sendJson(res, 403, { error: 'Cross-origin request rejected.' }); return null; }
  const user = await getAccountUser(req);
  if (!user) { sendJson(res, 401, { error: 'Sign in to manage your referral pages.' }); return null; }
  return user;
}
function accountRateAllowed(map, req, max, windowMs = 15 * 60 * 1000) {
  const now = Date.now(); const key = getClientKey(req);
  let item = map.get(key);
  if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
  item.count += 1; map.set(key, item);
  if (map.size > 1000) for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k);
  return item.count <= max;
}
function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function accountLinkOrigin(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) {
    const url = new URL(configured);
    if (url.username || url.password || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin in production.');
    return url.origin;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Set PUBLIC_BASE_URL to the public HTTPS origin before enabling account email.');
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) throw new Error('Set PUBLIC_BASE_URL before sending account email from a non-local host.');
  return `${req.socket?.encrypted ? 'https' : 'http'}://${host}`;
}
function emailRateAllowed(req, action) {
  return accountRateAllowed(accountEmailWindows, req, action === 'verify' ? 4 : 4, 60 * 60 * 1000);
}
async function sendAccountEmail(req, user, purpose) {
  const verify = purpose === 'verify-email';
  const token = await issueAuthToken(user.id, purpose, verify ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000);
  const origin = accountLinkOrigin(req);
  const url = new URL('/', origin);
  url.searchParams.set(verify ? 'verify' : 'reset', token);
  const label = verify ? 'Verify your ReachKit email' : 'Reset your ReachKit password';
  const explanation = verify
    ? 'Verify that you own this email address to activate your ReachKit account. This link expires in 24 hours.'
    : 'Use this single-use link to choose a new ReachKit password. It expires in 30 minutes. If you did not request it, ignore this message.';
  await emailService.send({
    to: user.email, kind: verify ? 'verify' : 'reset', subject: label,
    text: `${label}\n\n${explanation}\n\n${url.toString()}\n\nIf you did not request this, you can ignore this email.`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#18213b"><main style="max-width:560px;margin:30px auto;padding:24px;border:1px solid #e5e9f3;border-radius:16px"><h1 style="font-size:22px">${escapeHtml(label)}</h1><p>${escapeHtml(explanation)}</p><p><a href="${escapeHtml(url.toString())}" style="display:inline-block;padding:12px 18px;background:#6658ee;color:#fff;text-decoration:none;border-radius:8px">${verify ? 'Verify email' : 'Reset password'}</a></p><p style="font-size:12px;color:#66728d">If the button does not work, open this address:<br>${escapeHtml(url.toString())}</p></main></body></html>`
  });
}
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: digest.toString('hex') };
}
function passwordMatches(password, user) {
  try {
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(user.passwordSalt, 'hex'), 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_e) { return false; }
}
function setAccountCookie(res, token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `reachkit_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`);
}
function slugFrom(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
}
function campaignSlugAvailable(slug, campaignId = '') {
  const reserved = new Set(['api', 'join', 'media', 'assets', 'settings', 'login', 'register', 'favicon-ico']);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug) || reserved.has(slug)) return false;
  return !readCampaigns().campaigns.some(c => c.slug === slug && c.id !== campaignId);
}
function imageDimensions(buffer, type) {
  if (type === 'png' && buffer.length >= 24) return { width:buffer.readUInt32BE(16), height:buffer.readUInt32BE(20) };
  if (type === 'jpeg') {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        return { height:buffer.readUInt16BE(offset + 3), width:buffer.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  if (type === 'webp' && buffer.length >= 30) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width:1+buffer.readUIntLE(24,3), height:1+buffer.readUIntLE(27,3) };
    if (chunk === 'VP8L' && buffer[20] === 0x2f) {
      return { width:1+buffer[21]+((buffer[22]&0x3f)<<8), height:1+((buffer[22]>>6)&3)+(buffer[23]<<2)+((buffer[24]&0x0f)<<10) };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width:buffer.readUInt16LE(26)&0x3fff, height:buffer.readUInt16LE(28)&0x3fff };
    }
  }
  return null;
}
function requestBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    try { const u = new URL(configured); if (u.protocol === 'https:' && u.host) return u.origin; } catch (_e) {}
  }
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(rawHost) || !['http','https'].includes(proto)) return 'https://example.invalid';
  return `${proto}://${rawHost}`;
}
function saveCampaignImage(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error('Upload a PNG, JPG, or WebP image.'), { statusCode: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 3 * 1024 * 1024) throw Object.assign(new Error('Image must be 3 MB or smaller.'), { statusCode: 413 });
  const isPng = buffer.length > 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!(isPng && match[1] === 'png') && !(isJpeg && match[1] === 'jpeg') && !(isWebp && match[1] === 'webp')) throw Object.assign(new Error('The file contents do not match a supported image type.'), { statusCode: 400 });
  const dimensions = imageDimensions(buffer, match[1]);
  if (!dimensions || !dimensions.width || !dimensions.height || dimensions.width > 12000 || dimensions.height > 12000 || dimensions.width * dimensions.height > 40000000) throw Object.assign(new Error('Image dimensions are invalid or exceed the 40-megapixel upload limit.'), { statusCode: 400 });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `${crypto.randomUUID()}.${ext}`;
  const imagePath = `/media/${filename}`;
  if (!pgPool) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer, { flag: 'wx', mode: 0o600 });
  }
  return { path: imagePath, buffer: pgPool ? buffer : null };
}
function publicCampaignSafe(campaign, req) {
  const base = requestBaseUrl(req);
  return {
    id: campaign.id, slug: campaign.slug, title: campaign.title, name: campaign.name, details: campaign.details,
    url: campaign.url, imagePath: campaign.imagePath || '/og-default.png', published: Boolean(campaign.published),
    createdAt: campaign.createdAt, updatedAt: campaign.updatedAt, clicks: Number(campaign.clicks) || 0, uniqueClicks:Number(campaign.uniqueClicks)||0, views: Number(campaign.views)||0,
    shareUrl: `${base}/r/${campaign.slug}`
  };
}
function renderSharedCampaignPage(campaign, baseUrl) {
  const title = escapeHtml(campaign.title || 'Referral offer');
  const detailsText = String(campaign.details || '');
  const details = escapeHtml(detailsText).replace(/\r?\n/g, '<br>');
  const description = escapeHtml(detailsText.replace(/\s+/g, ' ').slice(0, 260));
  const name = escapeHtml(campaign.name || 'Referral offer');
  const destinationUrl = escapeHtml(campaign.url);
  const destination = escapeHtml(new URL(campaign.url).hostname);
  const imagePath = campaign.imagePath || '/og-default.png';
  const imageUrl = escapeHtml(`${baseUrl}${imagePath.startsWith('/') ? imagePath : '/' + imagePath}`);
  const canonicalUrl = escapeHtml(`${baseUrl}/r/${campaign.slug}`);
  const publishedAt = campaign.updatedAt ? new Date(campaign.updatedAt).toISOString().slice(0, 10) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f8ff"><meta name="description" content="${description}"><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="website"><meta property="og:site_name" content="ReachKit"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:url" content="${canonicalUrl}"><meta property="og:image" content="${imageUrl}"><meta property="og:image:secure_url" content="${imageUrl}"><meta property="og:image:type" content="${imagePath.endsWith('.jpg') ? 'image/jpeg' : imagePath.endsWith('.webp') ? 'image/webp' : 'image/png'}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${imageUrl}"><title>${title} — referral details</title><style>
:root{color-scheme:light;--ink:#18213b;--muted:#66728d;--line:#e5e9f3;--violet:#6658ee}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at top left,#ece9ff 0,transparent 48%),linear-gradient(135deg,#f8fbff,#f4f8fc);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink)}main{width:min(700px,100%);background:#fff;border:1px solid var(--line);border-radius:28px;padding:clamp(20px,4vw,44px);box-shadow:0 24px 70px #18213b12}.cover{display:block;width:100%;max-height:390px;object-fit:cover;aspect-ratio:1200/630;border-radius:17px;border:1px solid var(--line);background:#f5f6ff}.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:14px;color:var(--muted)}.mark{width:36px;height:36px;display:grid;place-items:center;border-radius:12px;background:var(--violet);color:#fff;font-size:21px}.eyebrow{margin-top:28px;color:#7566e9;font-size:12px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase}h1{font-size:clamp(30px,6vw,48px);letter-spacing:-1.8px;line-height:1.08;margin:12px 0 19px}.details{font-size:16px;color:#4f5d79;overflow-wrap:anywhere}.disclosure{margin:24px 0;padding:16px 18px;background:#f6f7ff;border:1px solid #e9e8ff;border-radius:14px;color:#535f7d;font-size:13px}.cta{display:flex;justify-content:center;align-items:center;width:100%;padding:15px 20px;margin-top:24px;border-radius:13px;background:var(--violet);color:white;text-decoration:none;font-weight:800;box-shadow:0 9px 24px #6658ee33}.cta:hover{filter:brightness(.97);transform:translateY(-1px)}.fine{font-size:12px;color:#8a94a9;margin:17px 0 0;overflow-wrap:anywhere}.foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:28px;padding-top:17px;color:#8a94a9;font-size:11px}.foot a{color:#6658ee}
</style></head><body><main><div class="brand"><span class="mark">↗</span><span>ReachKit · ${name}</span></div>${`<img class="cover" src="${imageUrl}" alt="${title}" width="1200" height="630" fetchpriority="high">`}<div class="eyebrow">referral offer details</div><h1>${title}</h1><div class="details">${details}</div><div class="disclosure"><strong>referral disclosure:</strong> this is a referral link. The person sharing it may receive a reward if you qualify. Rewards and eligibility depend on the provider's current terms; nothing is guaranteed.</div><div style="margin:22px 0 8px"><h2 style="font-size:18px;margin:0 0 10px">how to follow the official process</h2><ol style="padding-left:22px;margin:0;color:#4f5d79;font-size:13px;line-height:1.6"><li>Check the program's current age, region, account, and offer requirements.</li><li>Continue on the official site and sign in yourself using your own account. Never share passwords with the person referring you.</li><li>Complete only the qualifying actions shown by the provider.</li><li>Check the official rewards page; only the provider can confirm eligibility and credit points.</li></ol></div><a class="cta" href="${destinationUrl}" target="_blank" rel="nofollow sponsored noopener noreferrer" data-track-click>Open the actual referral link <span aria-hidden="true">&nbsp;↗</span></a><p class="fine">Destination: <strong>${destination}</strong>. Click totals and approximate unique browser/network-day estimates are recorded. Raw network addresses and user-agent strings are not saved in analytics. <a href="/privacy.html">Privacy details</a>.</p><p class="fine">Read the provider's current terms before signing up. No reward is guaranteed. This page is independently operated and is not an official provider page. No passwords or account details are collected here.</p><div class="foot"><span>updated ${publishedAt || 'recently'}</span><span>Share only where referral links are allowed</span><span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></span></div></main><script>const cta=document.querySelector('[data-track-click]');if(cta)cta.addEventListener('click',()=>{try{fetch('/api/click/${campaign.slug}',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>{});}catch(_e){}});</script></body></html>`;
}
function sendCampaignNotFound(res) {
  securityHeaders(res, 'text/html; charset=utf-8');
  res.writeHead(404, { 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Referral page not found</title><body style="font:16px system-ui;max-width:620px;margin:14vh auto;padding:24px;color:#18213b"><h1>This referral page is unavailable.</h1><p>The link may be incorrect or the owner may have unpublished it.</p><p><a href="/">Open ReachKit</a></p></body></html>');
}

function outputText(data) {
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  if (!Array.isArray(data.output)) return '';
  return data.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(item => item.type === 'output_text').map(item => item.text || '').join('\n');
}
async function handleAiDraft(req, res) {
  if (!aiRateAllowed(req)) return sendJson(res, 429, { error: 'AI draft limit reached for now. Use the built-in draft generator or try later.' });
  const active = activeAiSettings();
  if (process.env.NODE_ENV === 'production' && !(await getAccountUser(req)) && !getAdminSession(req)) return sendJson(res, 401, { error: 'Sign in before using the shared server-side AI provider.' });
  if (!active) return sendJson(res, 503, { error: 'No AI provider is connected. The built-in draft generator still works; add a provider in Settings.' });
  let body;
  try { body = await readJson(req); }
  catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1600) : '';
  const programName = typeof body.programName === 'string' ? body.programName.trim().slice(0, 120) : '';
  const postIntent = typeof body.postIntent === 'string' ? body.postIntent.trim().slice(0, 600) : '';
  const voiceNotes = typeof body.voiceNotes === 'string' ? body.voiceNotes.trim().slice(0, 400) : '';
  const audience = typeof body.audience === 'string' ? body.audience.trim().slice(0, 300) : '';
  const context = typeof body.context === 'string' ? body.context.trim().slice(0, 500) : '';
  const allowedPlatforms = ['reddit', 'facebook-group', 'facebook-page', 'instagram', 'tiktok', 'x', 'discord', 'linkedin', 'telegram', 'youtube', 'other'];
  const platform = allowedPlatforms.includes(body.platform) ? body.platform : 'reddit';
  const destination = typeof body.destination === 'string' ? body.destination.trim().slice(0, 120) : (typeof body.community === 'string' ? body.community.trim().slice(0, 120) : '');
  const tone = ['casual', 'helpful', 'short'].includes(body.tone) ? body.tone : 'casual';
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (_e) { return sendJson(res, 400, { error: 'Enter a valid referral URL.' }); }
  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.includes('.')) return sendJson(res, 400, { error: 'Referral links must use HTTPS.' });
  if (!destination || details.length < 12) return sendJson(res, 400, { error: 'Add a platform destination and a clear, accurate offer description.' });

  const prompt = buildDraftPrompt({ url, details, programName, postIntent, voiceNotes, audience, context, platform, destination, tone });

  try {
    const raw = (await generateProviderText(active.providerId, active.apiKey, active.model, prompt)).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let draft;
    try { draft = JSON.parse(raw); } catch (_e) { return sendJson(res, 502, { error: 'AI returned an unexpected format. Try generating again or use the built-in writer.' }); }
    if (typeof draft.title !== 'string' || typeof draft.body !== 'string') return sendJson(res, 502, { error: 'AI response was incomplete. Use the built-in generator instead.' });
    const polished = cleanDraftResult(draft, { url, details, programName, postIntent, voiceNotes, audience, context, tone });
    return sendJson(res, 200, { ...polished, platform, provider: AI_PROVIDERS[active.providerId]?.label || 'AI Provider', model: active.model });
  } catch (err) {
    const safe = err && typeof err.message === 'string' ? err.message.slice(0, 260) : 'Provider request failed.';
    return sendJson(res, 502, { error: safe });
  }
}

async function handleAiProviderConnect(req, res) {
  if (!adminRequired(req, res)) return;
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
  const providerId = typeof body.provider === 'string' ? body.provider : '';
  const provider = AI_PROVIDERS[providerId];
  if (!provider) return sendJson(res, 400, { error: 'Choose a provider from the list.' });
  const store = readAiStore();
  const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = suppliedKey || (store.providers[providerId] && store.providers[providerId].apiKey) || '';
  if (!apiKey || apiKey.length < 8 || apiKey.length > 3000 || /[\r\n]/.test(apiKey)) return sendJson(res, 400, { error: 'Paste a valid API key for this provider.' });
  try {
    const models = await fetchProviderModels(providerId, apiKey);
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    const model = models.some(m => m.id === requestedModel) ? requestedModel : (store.providers[providerId] && models.some(m => m.id === store.providers[providerId].model) ? store.providers[providerId].model : chooseDefaultModel(models, providerId));
    store.providers[providerId] = { apiKey, model, models, updatedAt: new Date().toISOString() };
    store.activeProvider = providerId;
    writeAiStore(store);
    return sendJson(res, 200, { ok: true, activeProvider: providerId, activeModel: model, providers: safeProviderList(store), modelsDetected: models.length, freeModelsDetected: models.filter(m => m.free).length });
  } catch (err) {
    return sendJson(res, 400, { error: (err && err.message ? err.message : 'Could not connect to provider.').slice(0, 300) });
  }
}
async function handleAiProviderRefresh(req, res) {
  if (!adminRequired(req, res)) return;
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
  const providerId = typeof body.provider === 'string' ? body.provider : '';
  const store = readAiStore();
  const saved = store.providers[providerId];
  if (!AI_PROVIDERS[providerId] || !saved || !saved.apiKey) return sendJson(res, 404, { error: 'That provider is not connected yet.' });
  try {
    const models = await fetchProviderModels(providerId, saved.apiKey);
    if (!models.some(m => m.id === saved.model)) saved.model = chooseDefaultModel(models, providerId);
    saved.models = models; saved.updatedAt = new Date().toISOString();
    writeAiStore(store);
    return sendJson(res, 200, { ok: true, providers: safeProviderList(store), modelsDetected: models.length, freeModelsDetected: models.filter(m => m.free).length });
  } catch (err) { return sendJson(res, 400, { error: (err && err.message ? err.message : 'Could not refresh model list.').slice(0, 300) }); }
}
async function handleAiProviderActivate(req, res) {
  if (!adminRequired(req, res)) return;
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
  const providerId = typeof body.provider === 'string' ? body.provider : '';
  const store = readAiStore(); const saved = store.providers[providerId];
  if (!AI_PROVIDERS[providerId] || !saved || !saved.apiKey) return sendJson(res, 404, { error: 'Connect that provider first.' });
  const model = typeof body.model === 'string' ? body.model : saved.model;
  if (!Array.isArray(saved.models) || !saved.models.some(m => m.id === model)) return sendJson(res, 400, { error: 'Choose a model from the detected model list, then save again.' });
  saved.model = model; store.activeProvider = providerId; writeAiStore(store);
  return sendJson(res, 200, { ok: true, activeProvider: providerId, activeModel: model, providers: safeProviderList(store) });
}
async function handleAiProviderTest(req, res) {
  if (!adminRequired(req, res)) return;
  if (!aiRateAllowed(req)) return sendJson(res, 429, { error: 'AI request limit reached for now. Wait a bit before running another model test.' });
  let body;
  try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
  const providerId = typeof body.provider === 'string' ? body.provider : '';
  const store = readAiStore(); const saved = store.providers[providerId];
  if (!AI_PROVIDERS[providerId] || !saved || !saved.apiKey) return sendJson(res, 404, { error: 'Connect that provider first.' });
  const model = typeof body.model === 'string' && body.model ? body.model : saved.model;
  if (!Array.isArray(saved.models) || !saved.models.some(m => m.id === model)) return sendJson(res, 400, { error: 'Choose a model from the detected list first.' });
  try {
    const answer = (await generateProviderText(providerId, saved.apiKey, model, 'Reply with exactly this sentence and nothing else: ReachKit AI test successful.')).trim();
    if (!answer) return sendJson(res, 502, { error: 'Provider accepted the request but returned an empty response. Try another model.' });
    return sendJson(res, 200, { ok: true, provider: AI_PROVIDERS[providerId].label, model, preview: answer.slice(0, 180) });
  } catch (err) {
    return sendJson(res, 502, { error: (err && err.message ? err.message : 'The selected model failed its test.').slice(0, 260) });
  }
}
function handleAiProviderRemove(req, res, providerId) {
  if (!adminRequired(req, res)) return;
  const store = readAiStore();
  if (!store.providers[providerId]) return sendJson(res, 404, { error: 'That provider is not connected.' });
  delete store.providers[providerId];
  if (store.activeProvider === providerId) store.activeProvider = Object.keys(store.providers)[0] || '';
  writeAiStore(store);
  return sendJson(res, 200, { ok: true, activeProvider: store.activeProvider, providers: safeProviderList(store) });
}

const server = http.createServer((req, res) => {
  routeRequest(req, res).catch(err => {
    console.error('ReachKit request failed:', err && err.stack ? err.stack : err);
    if (res.writableEnded) return;
    if (!res.headersSent) sendJson(res, 500, { error: 'The server could not complete that request. Check the service logs.' });
    else res.end();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
async function routeRequest(req, res) {
  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
  catch (_e) { return sendJson(res, 400, { error: 'Invalid URL.' }); }

  if(pathname==='/api/social/x/callback'&&req.method==='GET'){
    const query=new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams;
    const state=String(query.get('state')||''),pending=xOAuthStates.get(state);
    xOAuthStates.delete(state);
    const finish=(result)=>{res.writeHead(303,{Location:`/?social=${result}`, 'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();};
    if(!pending||pending.expiresAt<=Date.now())return finish('x-error');
    if(query.has('error')||!query.get('code'))return finish('x-denied');
    try{
      if(!xService.configured)throw new Error('X integration is no longer configured.');
      const tokens=await xService.exchangeCode({code:query.get('code'),verifier:pending.verifier,redirectUri:pending.redirectUri});
      const scopes=new Set(tokens.scope.split(/[ ,]+/).filter(Boolean));
      if(!['tweet.write','users.read','offline.access'].every(scope=>scopes.has(scope)))throw new Error('X authorization did not grant the required posting, account-read, and offline-access scopes.');
      const profile=await xService.getProfile(tokens.accessToken);
      if(!(await getUsersStore()).users.some(user=>user.id===pending.ownerId))throw new Error('ReachKit account no longer exists.');
      const now=new Date().toISOString();
      await saveUserXConnection({ownerId:pending.ownerId,xUserId:profile.id,username:profile.username,displayName:profile.name,accessTokenEncrypted:xService.encrypt(tokens.accessToken),refreshTokenEncrypted:tokens.refreshToken?xService.encrypt(tokens.refreshToken):'',expiresAt:tokens.expiresAt,connectedAt:now,updatedAt:now});
      return finish('x-connected');
    }catch(err){console.error('ReachKit X authorization failed:',err&&err.message||'provider error');return finish('x-error');}
  }

  if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, { ok:true });
  if (pathname === '/api/webhooks/conversions' && req.method === 'POST') {
    if (!conversionWebhookSecret) return sendJson(res, 503, { error:'Conversion webhooks are not configured.' });
    if (!accountRateAllowed(conversionWebhookWindows, req, 120, 60 * 60 * 1000)) return sendJson(res, 429, { error:'Too many conversion events. Retry later.' });
    let raw, body;
    try { ({ raw, body } = await readRawJson(req)); } catch (err) { return sendJson(res, err.statusCode || 400, { error:err.message }); }
    if (!validWebhookSignature(raw, req.headers['x-reachkit-signature'])) return sendJson(res, 401, { error:'Webhook signature is invalid.' });
    let event;
    try { event = normalizeConversionEvent(body); } catch (err) { return sendJson(res, err.statusCode || 400, { error:err.message }); }
    try {
      const saved = await recordConversionEvent(event);
      if (saved.missingCampaign) return sendJson(res, 404, { error:'Campaign slug was not found.' });
      return sendJson(res, 200, { ok:true, duplicate:Boolean(saved.duplicate), source:event.provider, attribution:'authenticated-webhook-report' });
    } catch (_err) { return sendJson(res, 500, { error:'Could not store this conversion event. Retry with the same eventId.' }); }
  }
  if (pathname === '/readyz' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      if (pgPool) await pgPool.query('SELECT 1');
      if (process.env.NODE_ENV === 'production' && !pgPool) return sendJson(res, 503, { ok:false, error:'Production database is not configured.' });
      return sendJson(res, 200, { ok:true, database:pgPool ? 'connected' : 'local-development', emailConfigured:emailService.configured });
    } catch (_err) { return sendJson(res, 503, { ok:false, error:'The database is not ready.' }); }
  }

  // Public multi-user accounts and campaign API. Passwords are scrypt-hashed; secrets never leave this server.
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!accountRateAllowed(accountRegisterWindows, req, 5)) return sendJson(res, 429, { error: 'Too many account creation attempts. Try again later.' });
    if (!emailService.configured) return sendJson(res, 503, { error: 'Email verification is required, but email delivery is not configured. Set the SMTP_* and EMAIL_FROM settings, then restart ReachKit.' });
    try { accountLinkOrigin(req); } catch (err) { return sendJson(res, 503, { error: err.message }); }
    let body;
    try { body = await readJson(req, 16 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const email = validEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = String(body.displayName || '').trim().slice(0, 60);
    if (!email) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 200) return sendJson(res, 400, { error: 'Use a password between 10 and 200 characters.' });
    const users = await getUsersStore();
    if (users.users.some(u => u.email === email)) return sendJson(res, 409, { error: 'An account with that email already exists. Sign in instead.' });
    const hashed = hashPassword(password);
    const user = { id: crypto.randomUUID(), email, displayName: displayName || email.split('@')[0].slice(0, 60), passwordSalt: hashed.salt, passwordHash: hashed.hash, createdAt: new Date().toISOString(), emailVerifiedAt: null };
    users.users.push(user);
    try { await persistUserStore(users, user); } catch (err) { return sendJson(res, err && err.code === '23505' ? 409 : 500, { error: err && err.code === '23505' ? 'An account with that email already exists. Sign in instead.' : 'Could not create account. Check database or persistent storage settings.' }); }
    try { await sendAccountEmail(req, user, 'verify-email'); }
    catch (err) { console.error('ReachKit verification email could not be delivered:', err && (err.code || err.name) || 'email transport error'); return sendJson(res, 502, { error: 'The account was created, but its verification email could not be sent. Check the email-service settings and use Resend verification email.' }); }
    return sendJson(res, 201, { ok: true, user: safeUser(user), emailVerificationRequired: true, message: 'Check your email and verify your address before signing in.' });
  }
  if (pathname === '/api/auth/verification' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!emailRateAllowed(req, 'verify')) return sendJson(res, 429, { error: 'Too many email requests. Wait an hour and try again.' });
    if (!emailService.configured) return sendJson(res, 503, { error: 'Email delivery is not configured. Set SMTP_* and EMAIL_FROM, then restart ReachKit.' });
    try { accountLinkOrigin(req); } catch (err) { return sendJson(res, 503, { error: err.message }); }
    let body; try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const email = validEmail(body.email); if (!email) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    const user = (await getUsersStore()).users.find(item => item.email === email);
    if (user && !user.emailVerifiedAt) {
      try { await sendAccountEmail(req, user, 'verify-email'); }
      catch (err) { console.error('ReachKit verification email could not be delivered:', err && (err.code || err.name) || 'email transport error'); return sendJson(res, 502, { error: 'The verification email could not be sent. Check the email-service settings and try again.' }); }
    }
    return sendJson(res, 200, { ok: true, message: 'If that address has an unverified ReachKit account, a fresh verification link has been sent.' });
  }
  if (pathname === '/api/auth/verify' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!accountRateAllowed(accountTokenWindows, req, 20)) return sendJson(res, 429, { error: 'Too many verification attempts. Try again later.' });
    let body; try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const userId = await consumeAuthToken(body.token, 'verify-email');
    if (!userId) return sendJson(res, 400, { error: 'This verification link is invalid, expired, or already used. Request a new one.' });
    const store = await getUsersStore(), user = store.users.find(item => item.id === userId);
    if (!user) return sendJson(res, 400, { error: 'This verification link is no longer valid. Request a new one.' });
    user.emailVerifiedAt = new Date().toISOString();
    await updateUserRecord(user); await removeUserAuthTokens(userId);
    return sendJson(res, 200, { ok: true, emailVerified: true, message: 'Email verified. You can now sign in.' });
  }
  if (pathname === '/api/auth/password-reset-request' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!emailRateAllowed(req, 'reset')) return sendJson(res, 429, { error: 'Too many email requests. Wait an hour and try again.' });
    if (!emailService.configured) return sendJson(res, 503, { error: 'Password recovery is unavailable because email delivery is not configured. Set SMTP_* and EMAIL_FROM, then restart ReachKit.' });
    try { accountLinkOrigin(req); } catch (err) { return sendJson(res, 503, { error: err.message }); }
    let body; try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const email = validEmail(body.email); if (!email) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    const user = (await getUsersStore()).users.find(item => item.email === email && item.emailVerifiedAt);
    if (user) {
      try { await sendAccountEmail(req, user, 'reset-password'); }
      catch (err) { console.error('ReachKit password reset email could not be delivered:', err && (err.code || err.name) || 'email transport error'); return sendJson(res, 502, { error: 'The reset email could not be sent. Check the email-service settings and try again.' }); }
    }
    return sendJson(res, 200, { ok: true, message: 'If a verified account exists for that address, a password reset link has been sent.' });
  }
  if (pathname === '/api/auth/password-reset' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!accountRateAllowed(accountTokenWindows, req, 10)) return sendJson(res, 429, { error: 'Too many password reset attempts. Try again later.' });
    let body; try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 10 || password.length > 200) return sendJson(res, 400, { error: 'Use a password between 10 and 200 characters.' });
    const userId = await consumeAuthToken(body.token, 'reset-password');
    if (!userId) return sendJson(res, 400, { error: 'This reset link is invalid, expired, or already used. Request a new one.' });
    const store = await getUsersStore(), user = store.users.find(item => item.id === userId);
    if (!user || !user.emailVerifiedAt) return sendJson(res, 400, { error: 'This reset link is no longer valid. Request a new one.' });
    const hashed = hashPassword(password); user.passwordSalt = hashed.salt; user.passwordHash = hashed.hash;
    await updateUserRecord(user); await destroyUserSessions(userId); await removeUserAuthTokens(userId);
    setAccountCookie(res, '', 0);
    return sendJson(res, 200, { ok: true, message: 'Password updated. Sign in with your new password.' });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!accountRateAllowed(accountLoginWindows, req, 10)) return sendJson(res, 429, { error: 'Too many sign-in attempts. Try again later.' });
    let body;
    try { body = await readJson(req, 16 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const email = validEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const users = await getUsersStore();
    const user = email ? users.users.find(u => u.email === email) : null;
    if (!user || !passwordMatches(password, user)) return sendJson(res, 401, { error: 'Email or password was incorrect.' });
    if (!user.emailVerifiedAt) return sendJson(res, 403, { error: 'Verify your email before signing in. Use Resend verification email to get a fresh link.' });
    const token = await createAccountSession(user);
    setAccountCookie(res, token, 7 * 24 * 60 * 60);
    return sendJson(res, 200, { ok: true, user: safeUser(user) });
  }
  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const user = await getAccountUser(req);
    return sendJson(res, 200, { authenticated: Boolean(user), user: safeUser(user), emailVerificationRequired: true });
  }
  if (pathname === '/api/auth/account' && req.method === 'DELETE') {
    const sessionUser = await accountRequired(req, res); if (!sessionUser) return;
    let body;
    try { body = await readJson(req, 16 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const allUsers = await getUsersStore();
    const user = allUsers.users.find(u => u.id === sessionUser.id);
    if (!user || !passwordMatches(typeof body.password === 'string' ? body.password : '', user)) return sendJson(res, 401, { error: 'Enter the correct password to delete this account.' });
    try {
      if (pgPool) {
        await pgPool.query('DELETE FROM reachkit_users WHERE id = $1', [user.id]);
      } else {
        const userStore = readUsers(); const campaignStore = readCampaigns();
        const removed = campaignStore.campaigns.filter(c => c.ownerId === user.id);
        const goalsStore = readSavingsGoals(); goalsStore.goals = goalsStore.goals.filter(goal => goal.ownerId !== user.id);
        const connections = readXConnections(); connections.connections = connections.connections.filter(item => item.ownerId !== user.id);
        const xPosts = readXPosts(); xPosts.posts = xPosts.posts.filter(item => item.ownerId !== user.id);
        campaignStore.campaigns = campaignStore.campaigns.filter(c => c.ownerId !== user.id);
        userStore.users = userStore.users.filter(u => u.id !== user.id);
        writeCampaigns(campaignStore); writeUsers(userStore); writeStore(SAVINGS_GOALS_FILE,goalsStore); writeStore(X_CONNECTIONS_FILE,connections); writeStore(X_POSTS_FILE,xPosts);
        removeLocalCampaignConversionEvents(removed.map(c => c.id));
        for (const c of removed) if (c.imagePath && c.imagePath.startsWith('/media/')) {
          const filename = path.basename(c.imagePath);
          if (/^[a-f0-9-]+\.(?:png|jpg|webp)$/i.test(filename)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (_e) {} }
        }
      }
      await destroyUserSessions(user.id);
      await removeUserAuthTokens(user.id);
      setAccountCookie(res, '', 0);
      return sendJson(res, 200, { ok: true, deleted: true });
    } catch (_e) { return sendJson(res, 500, { error: 'Could not remove this account from storage. Try again later.' }); }
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    const token = getCookie(req, 'reachkit_session'); if (token) await destroyAccountSession(token);
    setAccountCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  }
  if(pathname==='/api/account/social/x/status'&&req.method==='GET'){
    const user=await accountRequired(req,res);if(!user)return;
    const connection=await getUserXConnection(user.id);
    return sendJson(res,200,{configured:xService.configured,connection:safeXConnection(connection),posts:await listUserXPosts(user.id)});
  }
  if(pathname==='/api/account/social/x/connect'&&req.method==='POST'){
    const user=await accountRequired(req,res);if(!user)return;
    try{await readJson(req,1024);}catch(err){return sendJson(res,err.statusCode||400,{error:err.message});}
    if(!xService.configured)return sendJson(res,503,{error:'X connection is not configured. Set X_CLIENT_ID and REACHKIT_TOKEN_ENCRYPTION_KEY in the server environment, then restart.'});
    if(!accountRateAllowed(xConnectWindows,req,3,60*60*1000))return sendJson(res,429,{error:'Too many X connection attempts. Wait an hour and try again.'});
    try{
      const redirectUri=xRedirectUri(req),state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url');
      const now=Date.now();for(const[key,value]of xOAuthStates)if(!value||value.expiresAt<=now)xOAuthStates.delete(key);
      if(xOAuthStates.size>=1000)return sendJson(res,503,{error:'Too many pending X connection requests. Try again later.'});
      xOAuthStates.set(state,{ownerId:user.id,verifier,redirectUri,expiresAt:now+10*60*1000});
      return sendJson(res,200,{authorizationUrl:xService.authorizationUrl({state,verifier,redirectUri})});
    }catch(err){return sendJson(res,400,{error:err.message||'Could not start X authorization.'});}
  }
  if(pathname==='/api/account/social/x/connection'&&req.method==='DELETE'){
    const user=await accountRequired(req,res);if(!user)return;
    try{await deleteUserXConnection(user.id);return sendJson(res,200,{ok:true,connection:{connected:false}});}
    catch(_err){return sendJson(res,500,{error:'Could not disconnect X from this account.'});}
  }
  if(pathname==='/api/account/social/x/posts'&&req.method==='GET'){
    const user=await accountRequired(req,res);if(!user)return;
    return sendJson(res,200,{posts:await listUserXPosts(user.id)});
  }
  if(pathname==='/api/account/social/x/posts'&&req.method==='POST'){
    const user=await accountRequired(req,res);if(!user)return;
    let body;try{body=await readJson(req,12*1024);}catch(err){return sendJson(res,err.statusCode||400,{error:err.message});}
    const text=typeof body.text==='string'?body.text.trim():'';
    if(!text)return sendJson(res,400,{error:'Post text is required.'});
    const weighted=xWeightedLength(text);if(weighted>280)return sendJson(res,400,{error:`This post is approximately ${weighted} weighted characters; X allows up to 280.`});
    if(!xService.configured)return sendJson(res,503,{error:'X posting is not configured.'});
    if(!accountRateAllowed(xPostWindows,req,5,60*60*1000))return sendJson(res,429,{error:'Posting limit reached for this server. Wait an hour before posting again.'});
    try{
      const connection=await getUserXConnection(user.id);if(!connection)return sendJson(res,409,{error:'Connect your X account before posting.'});
      const accessToken=await freshXAccessToken(user.id,connection),posted=await xService.createPost(accessToken,text),createdAt=new Date().toISOString();
      try{await saveUserXPost(user.id,connection.username,posted);}
      catch(_storeErr){console.error('ReachKit could not persist successful X post metadata.');return sendJson(res,202,{ok:true,historySaved:false,post:{id:posted.id,text:posted.text,username:connection.username,url:`https://x.com/${encodeURIComponent(connection.username)}/status/${posted.id}`,createdAt},message:'X published the post, but ReachKit could not save its history. Check X before retrying.'});}
      return sendJson(res,201,{ok:true,historySaved:true,post:{id:posted.id,text:posted.text,username:connection.username,url:`https://x.com/${encodeURIComponent(connection.username)}/status/${posted.id}`,createdAt}});
    }catch(err){return sendJson(res,err.statusCode||502,{error:err.message||'X could not publish this post. Check your connection and X account permissions.'});}
  }
  if (pathname === '/api/account/campaigns' && req.method === 'GET') {
    const user = await getAccountUser(req);
    if (!user) return sendJson(res, 401, { error: 'Sign in to view your referral pages.' });
    const campaigns = (await getCampaignStore()).campaigns.filter(c => c.ownerId === user.id).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return sendJson(res, 200, { campaigns: campaigns.map(c => publicCampaignSafe(c, req)) });
  }
  if (pathname === '/api/account/conversions' && req.method === 'GET') {
    const user = await accountRequired(req, res); if (!user) return;
    const events = await getUserConversionEvents(user.id);
    return sendJson(res, 200, { ...await getUserConversionSummary(user.id), events, attribution:'authenticated source reports; not independently verified by ReachKit' });
  }
  if (pathname === '/api/account/goals' && req.method === 'GET') {
    const user = await accountRequired(req,res); if (!user) return;
    return sendJson(res,200,{ goals:await listUserSavingsGoals(user.id) });
  }
  if (pathname === '/api/account/goals' && req.method === 'POST') {
    const user = await accountRequired(req,res); if (!user) return;
    if (!sameOrigin(req)) return sendJson(res,403,{ error:'Cross-origin request rejected.' });
    let body; try { body=await readJson(req,16*1024); } catch (err) { return sendJson(res,err.statusCode||400,{ error:err.message }); }
    let values; try { values=normalizeSavingsGoal(body); } catch (err) { return sendJson(res,err.statusCode||400,{ error:err.message }); }
    try { const goal=await saveUserSavingsGoal(user.id,values); return sendJson(res,201,{ goal }); }
    catch (err) { return sendJson(res,err.statusCode||500,{ error:err.statusCode ? err.message : 'Could not save this goal.' }); }
  }
  const savingGoalRoute = pathname.match(/^\/api\/account\/goals\/([a-f0-9-]{36})$/i);
  if (savingGoalRoute && req.method === 'PUT') {
    const user = await accountRequired(req,res); if (!user) return;
    if (!sameOrigin(req)) return sendJson(res,403,{ error:'Cross-origin request rejected.' });
    let body; try { body=await readJson(req,16*1024); } catch (err) { return sendJson(res,err.statusCode||400,{ error:err.message }); }
    let values; try { values=normalizeSavingsGoal(body); } catch (err) { return sendJson(res,err.statusCode||400,{ error:err.message }); }
    try { const goal=await saveUserSavingsGoal(user.id,values,savingGoalRoute[1]); return goal ? sendJson(res,200,{ goal }) : sendJson(res,404,{ error:'Goal not found.' }); }
    catch (_err) { return sendJson(res,500,{ error:'Could not update this goal.' }); }
  }
  if (savingGoalRoute && req.method === 'DELETE') {
    const user = await accountRequired(req,res); if (!user) return;
    if (!sameOrigin(req)) return sendJson(res,403,{ error:'Cross-origin request rejected.' });
    try { const deleted=await deleteUserSavingsGoal(user.id,savingGoalRoute[1]); return deleted ? sendJson(res,200,{ ok:true }) : sendJson(res,404,{ error:'Goal not found.' }); }
    catch (_err) { return sendJson(res,500,{ error:'Could not delete this goal.' }); }
  }
  if (pathname === '/api/account/export' && req.method === 'GET') {
    const user = await accountRequired(req, res); if (!user) return;
    const campaigns = (await getCampaignStore()).campaigns.filter(c => c.ownerId === user.id);
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(), user: safeUser(user),
      campaigns: campaigns.map(c => publicCampaignSafe(c, req)),
      savingsGoals: await listUserSavingsGoals(user.id),
      xPosts: await listUserXPosts(user.id),
      conversionReports: { ...await getUserConversionSummary(user.id), events:await getUserConversionEvents(user.id), attribution:'authenticated source reports; not independently verified by ReachKit' },
      notice: 'Savings goals, X post history, and referral pages are included. Social authorization tokens are never exported. Browser-local drafts, destinations, AI preferences, and manually entered results remain separate and are not included.'
    });
  }
  if (pathname === '/api/account/campaigns' && req.method === 'POST') {
    const user = await accountRequired(req, res); if (!user) return;
    let body;
    try { body = await readJson(req, 4 * 1024 * 1024 + 128 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : 'Referral offer';
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1800) : '';
    let parsed;
    try { parsed = new URL(url); } catch (_e) { return sendJson(res, 400, { error: 'Enter a valid referral URL that uses HTTPS.' }); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) return sendJson(res, 400, { error: 'Referral destinations must use HTTPS.' });
    if (!title) return sendJson(res, 400, { error: 'Add a title for the public referral page.' });
    if (details.length < 12) return sendJson(res, 400, { error: 'Write an accurate offer description with at least 12 characters.' });
    const store = await getCampaignStore();
    let existing = null;
    if (body.id) {
      existing = store.campaigns.find(c => c.id === body.id && c.ownerId === user.id);
      if (!existing) return sendJson(res, 404, { error: 'That page was not found in your account.' });
    } else if (store.campaigns.filter(c => c.ownerId === user.id).length >= 30) {
      return sendJson(res, 429, { error: 'This account has reached the 30-page starter limit.' });
    }
    const requestedSlugRaw = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const requestedSlug = slugFrom(requestedSlugRaw || (existing && existing.slug) || title);
    if (!requestedSlug || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(requestedSlug) || ['api','join','media','assets','settings','login','register','favicon-ico'].includes(requestedSlug) || store.campaigns.some(c => c.slug === requestedSlug && c.id !== (existing ? existing.id : ''))) return sendJson(res, 409, { error: 'That custom link is unavailable. Try another short, unique URL name.' });
    let imagePath = existing && existing.imagePath ? existing.imagePath : '/og-default.png';
    let newlySavedImage = null;
    try {
      if (body.imageDataUrl) { newlySavedImage = saveCampaignImage(body.imageDataUrl); imagePath = newlySavedImage.path; }
      const now = new Date().toISOString();
      const campaign = existing ? {
        ...existing, url, title, name: name || 'Referral offer', details, slug: requestedSlug, imagePath,
        published: true, updatedAt: now
      } : {
        id: crypto.randomUUID(), ownerId: user.id, url, title, name: name || 'Referral offer', details,
        slug: requestedSlug, imagePath, published: true, clicks: 0, createdAt: now, updatedAt: now
      };
      if (newlySavedImage && pgPool) campaign.imageDataBuffer = newlySavedImage.buffer;
      if (existing) store.campaigns = store.campaigns.map(c => c.id === existing.id ? campaign : c);
      else store.campaigns.push(campaign);
      await persistCampaignStore(store, campaign);
      if (newlySavedImage && !pgPool && existing && existing.imagePath && existing.imagePath.startsWith('/media/')) {
        const oldName = path.basename(existing.imagePath);
        if (/^[0-9a-f-]+\.(?:png|jpg|webp)$/.test(oldName) && oldName !== path.basename(newlySavedImage.path)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, oldName)); } catch (_e) {} }
      }
      return sendJson(res, existing ? 200 : 201, { ok: true, campaign: publicCampaignSafe(campaign, req) });
    } catch (err) {
      if (newlySavedImage && !pgPool) { try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(newlySavedImage.path))); } catch (_e) {} }
      if (err && err.code === '23505') return sendJson(res, 409, { error: 'That custom link is already in use. Try a different name.' });
      return sendJson(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'Could not save this page. Check your database or persistent storage settings.' });
    }
  }
  const deleteCampaignMatch = pathname.match(/^\/api\/account\/campaigns\/([a-f0-9-]{36})\/delete$/i);
  if (deleteCampaignMatch && req.method === 'DELETE') {
    const user = await accountRequired(req, res); if (!user) return;
    try {
      let imagePath = '';
      if (pgPool) {
        const result = await pgPool.query('DELETE FROM reachkit_campaigns WHERE id=$1 AND owner_id=$2 RETURNING image_path', [deleteCampaignMatch[1],user.id]);
        if (!result.rowCount) return sendJson(res, 404, { error: 'Page not found.' });
        imagePath = result.rows[0].image_path || '';
      } else {
        const store = readCampaigns(), existing = store.campaigns.find(c => c.id === deleteCampaignMatch[1] && c.ownerId === user.id);
        if (!existing) return sendJson(res, 404, { error: 'Page not found.' });
        imagePath = existing.imagePath || ''; store.campaigns = store.campaigns.filter(c => c.id !== existing.id); writeCampaigns(store); removeLocalCampaignConversionEvents([existing.id]);
      }
      if (!pgPool && imagePath.startsWith('/media/')) {
        const filename = path.basename(imagePath);
        if (/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/i.test(filename)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (_e) {} }
      }
      return sendJson(res, 200, { ok:true, deleted:true });
    } catch (_e) { return sendJson(res, 500, { error: 'Could not delete this page. Try again later.' }); }
  }
  const accountCampaignAction = pathname.match(/^\/api\/account\/campaigns\/([a-f0-9-]{36})$/i);
  if (accountCampaignAction && req.method === 'DELETE') {
    const user = await accountRequired(req, res); if (!user) return;
    const store = await getCampaignStore();
    const campaign = store.campaigns.find(c => c.id === accountCampaignAction[1] && c.ownerId === user.id);
    if (!campaign) return sendJson(res, 404, { error: 'Page not found.' });
    campaign.published = false; campaign.updatedAt = new Date().toISOString();
    try { await persistCampaignStore(store, campaign); } catch (_e) { return sendJson(res, 500, { error: 'Could not unpublish this page.' }); }
    return sendJson(res, 200, { ok: true, campaign: publicCampaignSafe(campaign, req) });
  }
  const clickMatch = pathname.match(/^\/api\/click\/([a-z0-9-]{1,48})$/);
  if (clickMatch && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    try { await readJson(req, 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const day = new Date().toISOString().slice(0,10);
    if (pgPool) {
      const fingerprintClient = await pgPool.connect();
      try {
        await fingerprintClient.query('BEGIN');
        const selected = await fingerprintClient.query('SELECT id FROM reachkit_campaigns WHERE slug=$1 AND published=true', [clickMatch[1]]);
        if (!selected.rowCount) { await fingerprintClient.query('ROLLBACK'); return sendJson(res, 404, { error: 'Published referral page not found.' }); }
        const campaignId = selected.rows[0].id;
        const fingerprint = campaignClickFingerprint(req, campaignId, day);
        const unique = await fingerprintClient.query(`INSERT INTO reachkit_unique_click_fingerprints(campaign_id,event_day,fingerprint)
          VALUES($1,$2,$3) ON CONFLICT(campaign_id,event_day,fingerprint) DO NOTHING RETURNING fingerprint`, [campaignId,day,fingerprint]);
        const incrementUnique = unique.rowCount ? 1 : 0;
        const updated = await fingerprintClient.query(`UPDATE reachkit_campaigns SET clicks=clicks+1,
          daily_clicks=jsonb_set(COALESCE(daily_clicks,'{}'::jsonb),ARRAY[$2::text],to_jsonb(COALESCE((daily_clicks->>$2)::bigint,0)+1),true),
          unique_clicks=unique_clicks+$3,
          daily_unique_clicks=CASE WHEN $3=1 THEN jsonb_set(COALESCE(daily_unique_clicks,'{}'::jsonb),ARRAY[$2::text],to_jsonb(COALESCE((daily_unique_clicks->>$2)::bigint,0)+1),true) ELSE COALESCE(daily_unique_clicks,'{}'::jsonb) END
          WHERE id=$1 AND published=true RETURNING clicks,unique_clicks`, [campaignId,day,incrementUnique]);
        if (!updated.rowCount) { await fingerprintClient.query('ROLLBACK'); return sendJson(res, 404, { error: 'Published referral page not found.' }); }
        await fingerprintClient.query('COMMIT');
        if (lastUniqueFingerprintCleanupDay !== day) {
          lastUniqueFingerprintCleanupDay = day;
          pgPool.query("DELETE FROM reachkit_unique_click_fingerprints WHERE event_day < CURRENT_DATE - INTERVAL '30 days'").catch(err => console.error('ReachKit analytics retention cleanup failed:', err.message));
        }
        return sendJson(res, 200, { ok:true, clicks:Number(updated.rows[0].clicks), uniqueClicks:Number(updated.rows[0].unique_clicks) });
      } catch (err) {
        await fingerprintClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { fingerprintClient.release(); }
    }
    const current = readCampaigns().campaigns.find(campaign => campaign.slug === clickMatch[1] && campaign.published);
    if (!current) return sendJson(res, 404, { error: 'Published referral page not found.' });
    const fingerprint = campaignClickFingerprint(req, current.id, day);
    const campaign = await recordLocalCampaignEvent(clickMatch[1], 'click', day, fingerprint);
    if (!campaign) return sendJson(res, 404, { error: 'Published referral page not found.' });
    return sendJson(res, 200, { ok:true, clicks:Number(campaign.clicks)||0, uniqueClicks:Number(campaign.uniqueClicks)||0 });
  }
  const publicCampaignPageMatch = pathname.match(/^\/r\/([a-z0-9-]{1,48})\/?$/);
  if (publicCampaignPageMatch && req.method === 'GET') {
    let campaign;
    if (pgPool) {
      const day = new Date().toISOString().slice(0,10);
      const seen = await pgPool.query(`UPDATE reachkit_campaigns SET views=views+1,
        daily_views=jsonb_set(COALESCE(daily_views,'{}'::jsonb), ARRAY[$2::text],
          to_jsonb(COALESCE((daily_views->>$2)::bigint,0)+1), true)
        WHERE slug=$1 AND published=true RETURNING id`, [publicCampaignPageMatch[1],day]);
      if (seen.rowCount) campaign = (await getCampaignStore()).campaigns.find(c => c.id === seen.rows[0].id);
    } else {
      campaign = await recordLocalCampaignEvent(publicCampaignPageMatch[1], 'view');
    }
    if (!campaign) return sendCampaignNotFound(res);
    securityHeaders(res, 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.writeHead(200); return res.end(renderSharedCampaignPage(campaign, requestBaseUrl(req)));
  }
  const mediaMatch = pathname.match(/^\/media\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/i);
  if (mediaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const filename = mediaMatch[1];
    const target = path.join(UPLOADS_DIR, filename);
    if (pgPool) {
      try {
        const imageResult = await pgPool.query('SELECT image_data FROM reachkit_campaigns WHERE image_path = $1 AND image_data IS NOT NULL LIMIT 1', [`/media/${filename}`]);
        const imageBuffer = imageResult.rows[0] && imageResult.rows[0].image_data;
        if (!imageBuffer || imageBuffer.length > 3 * 1024 * 1024) return sendJson(res, 404, { error: 'Image not found.' });
        const ext = path.extname(filename).toLowerCase();
        securityHeaders(res, ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Length', imageBuffer.length);
        return res.end(imageBuffer);
      } catch (_e) { return sendJson(res, 503, { error: 'Image storage is temporarily unavailable.' }); }
    }
    fs.stat(target, (statErr, stat) => {
      if (statErr || !stat.isFile() || stat.size > 3 * 1024 * 1024) return sendJson(res, 404, { error: 'Image not found.' });
      const ext = path.extname(filename).toLowerCase();
      securityHeaders(res, ext === '.png' ? 'image/png' : ext === '.jpg' ? 'image/jpeg' : 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(target).pipe(res);
    });
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    const publicCampaign = getPublicCampaign();
    const clicks = getClickStats();
    const publicAccounts = await getUsersStore();
    const publicCampaigns = await getCampaignStore();
    return sendJson(res, 200, {
      ok: true,
      ai: (() => { const active = activeAiSettings(); const aiStore = readAiStore(); const pid = active ? active.providerId : ''; return { configured: Boolean(active), mode: active ? 'server-api' : 'built-in', provider: active ? (AI_PROVIDERS[pid]?.label || 'AI provider') : 'Local draft engine', model: active ? active.model : '', providerCount: safeProviderList(aiStore).length }; })(),
      reddit: { connected: false, mode: 'review-and-submit', note: 'No Reddit API credentials or approval are configured. This app does not mass-post or send unsolicited DMs.' },
      publicPage: { published: Boolean(publicCampaign), clicks: clicks.total, path: '/join', adminPasswordConfigured: Boolean(adminPassword) },
      storage: pgPool ? 'PostgreSQL stores accounts, campaigns, click counts, and uploaded images' : 'local JSON files and local uploads; configure PostgreSQL or a persistent disk for stable hosting',
      email: { configured: emailService.configured, verificationRequired: true, recovery: emailService.configured },
      conversions: { webhookConfigured:Boolean(conversionWebhookSecret), mode:conversionWebhookSecret ? 'signed-source-reports' : 'unavailable', label:'Authenticated source reports are not independently certified by ReachKit.' },
      accountPages: { enabled: true, campaignCount: publicCampaigns.campaigns.length, accountCount: publicAccounts.users.length, maxCampaignsPerAccount: 30, emailVerification: true, imageUploads: true, socialPreviewMetadata: true, database: Boolean(pgPool) }
    });
  }
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!adminPassword) return sendJson(res, 503, { error: 'Set REACHKIT_ADMIN_PASSWORD in .env and restart the server before unlocking publishing.' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    if (!adminLoginAllowed(req)) return sendJson(res, 429, { error: 'Too many unlock attempts. Wait 15 minutes and try again.' });
    let body;
    try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const supplied = typeof body.password === 'string' ? body.password : '';
    const a = Buffer.from(adminPassword, 'utf8'); const b = Buffer.from(supplied, 'utf8');
    const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!matches) return sendJson(res, 401, { error: 'Password did not match.' });
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    for (const [k, v] of adminSessions) if (v.expiresAt <= Date.now()) adminSessions.delete(k);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `reachkit_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`);
    return sendJson(res, 200, { ok: true, expiresInHours: 8 });
  }
  if (pathname === '/api/admin/session' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated: Boolean(adminPassword && getAdminSession(req)), passwordConfigured: Boolean(adminPassword) });
  }
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = getCookie(req, 'reachkit_admin'); if (token) adminSessions.delete(token);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `reachkit_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/admin/message-tools' && req.method === 'GET') {
    return sendJson(res, 200, { authenticated:Boolean(adminPassword && getAdminSession(req)), passwordConfigured:Boolean(adminPassword), emailConfigured:emailService.configured, smsConfigured:smsService.configured });
  }
  if (pathname === '/api/admin/test-email' && req.method === 'POST') {
    if (!adminRequired(req, res)) return;
    let body;
    try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error:err.message }); }
    if (body.consent !== true) return sendJson(res, 400, { error:'Confirm that this is your address or that you have permission to send one test message.' });
    const to = validEmail(body.to);
    if (!to) return sendJson(res, 400, { error:'Enter a valid email address you own or have permission to test.' });
    if (!emailService.configured) return sendJson(res, 503, { error:'Email is not configured. Set SMTP_HOST and EMAIL_FROM in the private server environment, then restart.' });
    if (!accountRateAllowed(adminMessageTestWindows, req, 3, 60 * 60 * 1000)) return sendJson(res, 429, { error:'Too many test messages. Wait an hour and try again.' });
    try {
      await emailService.send({ to, kind:'test', subject:'ReachKit delivery test', text:'ReachKit test message. You requested this one-time delivery test.', html:'<!doctype html><html><body><p>ReachKit test message. You requested this one-time delivery test.</p></body></html>' });
      return sendJson(res, 200, { ok:true, accepted:true, message:'The configured email service accepted the test message. Check your inbox and spam folder.' });
    } catch (err) {
      console.error('ReachKit test email failed:', err && (err.code || err.name) || 'email transport error');
      return sendJson(res, 502, { error:'The email provider did not accept the test message. Check its host, credentials, sender authorization, and service logs.' });
    }
  }
  if (pathname === '/api/admin/test-sms' && req.method === 'POST') {
    if (!adminRequired(req, res)) return;
    let body;
    try { body = await readJson(req, 8 * 1024); } catch (err) { return sendJson(res, err.statusCode || 400, { error:err.message }); }
    if (body.consent !== true) return sendJson(res, 400, { error:'Confirm that this is your number or that you have permission to send one test message.' });
    const rawTo = String(body.to || '').trim();
    const digits = rawTo.replace(/[\s().-]/g, '');
    const to = /^\d{10}$/.test(digits) ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : digits;
    if (!/^\+[1-9]\d{7,14}$/.test(to)) return sendJson(res, 400, { error:'Enter a valid number in international format, such as +12223334444.' });
    if (!smsService.configured) return sendJson(res, 503, { error:'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in the private server environment, then restart.' });
    if (!accountRateAllowed(adminMessageTestWindows, req, 3, 60 * 60 * 1000)) return sendJson(res, 429, { error:'Too many test messages. Wait an hour and try again.' });
    try {
      const result = await smsService.sendOwnerTest(to);
      return sendJson(res, 200, { ok:true, accepted:true, providerStatus:result.providerStatus, message:'Twilio accepted the test message. Carrier delivery can take a moment and is not guaranteed by API acceptance.' });
    } catch (err) {
      return sendJson(res, err.statusCode || 502, { error:err.statusCode ? err.message : 'The SMS provider could not accept this test message. Check sender registration, destination, credentials, and service logs.' });
    }
  }
  if (pathname === '/api/public-offer' && req.method === 'GET') {
    const campaign = getPublicCampaign();
    const clicks = getClickStats();
    return sendJson(res, 200, campaign ? { published: true, title: campaign.title, name: campaign.name, details: campaign.details, path: '/join', clicks: clicks.total, updatedAt: campaign.publishedAt } : { published: false, path: '/join', clicks: clicks.total });
  }
  if (pathname === '/api/public-offer' && req.method === 'POST') {
    if (!adminRequired(req, res)) return;
    let body;
    try { body = await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : 'Referral offer';
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 1600) : '';
    let parsed;
    try { parsed = new URL(url); } catch (_e) { return sendJson(res, 400, { error: 'Enter a valid referral URL in Campaign setup first.' }); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.')) return sendJson(res, 400, { error: 'The referral URL must use HTTPS.' });
    if (!title || details.length < 12) return sendJson(res, 400, { error: 'Add a page title and an accurate offer description (at least 12 characters).' });
    const campaign = { url, title, name: name || 'Referral offer', details, publishedAt: new Date().toISOString() };
    try { writeStore(PUBLIC_CAMPAIGN_FILE, campaign); }
    catch (_e) { return sendJson(res, 500, { error: 'Could not save the public campaign. Check folder permissions.' }); }
    return sendJson(res, 200, { ok: true, published: true, path: '/join', clicks: getClickStats().total, updatedAt: campaign.publishedAt });
  }
  if (pathname === '/api/click-stats' && req.method === 'GET') {
    if (!adminPassword) return sendJson(res, 503, { error: 'Set REACHKIT_ADMIN_PASSWORD in .env before viewing click analytics.' });
    if (!getAdminSession(req)) return sendJson(res, 401, { error: 'Unlock publishing to view click analytics.' });
    return sendJson(res, 200, getClickStats());
  }
  if (pathname === '/api/click' && req.method === 'POST') {
    try { await readJson(req); } catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
    if (!getPublicCampaign()) return sendJson(res, 404, { error: 'No public referral page is published.' });
    // Aggregate button-click count only. No IP address, profile, or other visitor identifier is persisted.
    const stats = getClickStats();
    const day = new Date().toISOString().slice(0, 10);
    stats.total += 1; stats.daily[day] = (Number(stats.daily[day]) || 0) + 1;
    for (const key of Object.keys(stats.daily)) if (key < new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) delete stats.daily[key];
    try { writeStore(CLICK_STATS_FILE, stats); } catch (_e) { return sendJson(res, 500, { error: 'Could not record this click.' }); }
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/ai/providers' && req.method === 'GET') {
    const store = readAiStore();
    const authenticated = Boolean(adminPassword && getAdminSession(req));
    return sendJson(res, 200, {
      authenticated, passwordConfigured: Boolean(adminPassword),
      catalog: Object.entries(AI_PROVIDERS).map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl, access: p.access, keyHint: p.keyHint, family: p.family })),
      providers: authenticated ? safeProviderList(store) : [],
      activeProvider: authenticated ? store.activeProvider : ''
    });
  }
  if (pathname === '/api/ai/providers/connect' && req.method === 'POST') return handleAiProviderConnect(req, res);
  if (pathname === '/api/ai/providers/refresh' && req.method === 'POST') return handleAiProviderRefresh(req, res);
  if (pathname === '/api/ai/providers/activate' && req.method === 'POST') return handleAiProviderActivate(req, res);
  if (pathname === '/api/ai/providers/test' && req.method === 'POST') return handleAiProviderTest(req, res);
  const removeProviderMatch = pathname.match(/^\/api\/ai\/providers\/([a-z0-9_-]+)$/);
  if (removeProviderMatch && req.method === 'DELETE') return handleAiProviderRemove(req, res, removeProviderMatch[1]);
  if (pathname === '/api/ai/draft' && req.method === 'POST') return handleAiDraft(req, res);
  if ((pathname === '/join' || pathname === '/join/') && req.method === 'GET') {
    const campaign = getPublicCampaign();
    if (!campaign) {
      securityHeaders(res, 'text/html; charset=utf-8');
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Referral page not published</title><body style="font:16px system-ui;max-width:620px;margin:14vh auto;padding:24px;color:#18213b"><h1>This referral page is not published yet.</h1><p>The campaign owner needs to publish an offer from ReachKit first.</p></body></html>');
    }
    securityHeaders(res, 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200); return res.end(renderLandingPage(campaign));
  }
  if (pathname === '/api/public-offer' && req.method === 'DELETE') {
    if (!adminRequired(req, res)) return;
    try { if (fs.existsSync(PUBLIC_CAMPAIGN_FILE)) fs.unlinkSync(PUBLIC_CAMPAIGN_FILE); }
    catch (_e) { return sendJson(res, 500, { error: 'Could not unpublish the page. Check folder permissions.' }); }
    return sendJson(res, 200, { ok: true, published: false });
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API endpoint not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });

  let relative;
  try { relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch (_e) { return sendJson(res, 400, { error: 'Invalid path.' }); }
  const target = path.resolve(PUBLIC, '.' + relative);
  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' });
  fs.stat(target, (statErr, stat) => {
    if (statErr || !stat.isFile()) return sendJson(res, 404, { error: 'File not found.' });
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    securityHeaders(res, type);
    res.setHeader('Cache-Control', path.extname(target) === '.html' ? 'no-store' : 'private, max-age=300');
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(target);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    stream.pipe(res);
  });
}

async function startServer() {
  if (conversionWebhookSecret && conversionWebhookSecret.length < 32) throw new Error('REACHKIT_CONVERSION_WEBHOOK_SECRET must contain at least 32 characters when configured.');
  const analyticsSecret = String(process.env.REACHKIT_ANALYTICS_HASH_SECRET || '').trim();
  if (analyticsSecret && analyticsSecret.length < 32) throw new Error('REACHKIT_ANALYTICS_HASH_SECRET must contain at least 32 characters when configured.');
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.DATABASE_URL || !pgPool) throw new Error('Set DATABASE_URL and install the PostgreSQL dependency before starting a production deployment.');
    if (adminPassword.length < 16) throw new Error('Set REACHKIT_ADMIN_PASSWORD to a unique value with at least 16 characters.');
    if (analyticsSecret.length < 32) throw new Error('Set REACHKIT_ANALYTICS_HASH_SECRET to a stable random value of at least 32 characters in production.');
    const publicOrigin = String(process.env.PUBLIC_BASE_URL || '').trim();
    let publicUrl;
    try { publicUrl = new URL(publicOrigin); } catch (_e) { throw new Error('Set PUBLIC_BASE_URL to the public HTTPS origin.'); }
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin with no path, query, or credentials.');
    if (!emailService.configured) throw new Error('Configure SMTP_HOST and EMAIL_FROM (and SMTP credentials when required) before production startup.');
    try { await emailService.verify(); } catch (_e) { throw new Error('The configured SMTP service could not be reached or authenticated. Check SMTP settings.'); }
  }
  if (process.env.DATABASE_URL && pgDriverError) throw new Error('DATABASE_URL could not be prepared for a safe PostgreSQL connection. Check the pg dependency, URL syntax, TLS mode, and CA settings.');
  if (pgPool) { await ensureDatabaseSchema(); console.log('ReachKit multi-user accounts/campaigns are using PostgreSQL.'); }
  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`ReachKit is running at http://127.0.0.1:${PORT}`);
    const active = activeAiSettings();
    console.log(`AI draft mode: ${active ? `server-side ${AI_PROVIDERS[active.providerId]?.label || 'AI provider'} (${active.model})` : 'built-in generator (connect an API in Settings for AI models)'}`);
    console.log('Public campaign pages use human-reviewed referral links; no account sign-in for invitees or automated reward credit is performed.');
  });
}
startServer().catch(err => { console.error(`Could not start ReachKit: ${err.message}`); process.exitCode = 1; });
server.on('error', err => { console.error(`Could not start ReachKit: ${err.message}`); process.exitCode = 1; });
let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`ReachKit received ${signal}; closing cleanly.`);
  const forceExit = setTimeout(() => { console.error('ReachKit shutdown timed out.'); process.exit(1); }, 10000);
  forceExit.unref();
  server.close(async () => {
    try { if (pgPool) await pgPool.end(); process.exitCode = 0; }
    catch (_err) { process.exitCode = 1; }
    clearTimeout(forceExit);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
