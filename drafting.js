// Human-sounding referral copy helpers. These rules keep the model grounded in facts the owner entered.
'use strict';

const PLATFORM_NAMES = {
  reddit: 'Reddit', 'facebook-group': 'Facebook Group', 'facebook-page': 'Facebook Page or Profile',
  instagram: 'Instagram', tiktok: 'TikTok', x: 'X', discord: 'Discord', linkedin: 'LinkedIn',
  telegram: 'Telegram', youtube: 'YouTube', other: 'the selected platform'
};

function buildDraftPrompt(input) {
  const platformName = PLATFORM_NAMES[input.platform] || 'the selected platform';
  const facts = [
    ['Exact offer / program name', input.programName],
    ['Offer details supplied by the user', input.details],
    ['User instructions for this post', input.postIntent],
    ['Audience', input.audience],
    ['Personal note / extra context', input.context],
    ['Preferred voice', input.voiceNotes]
  ].map(([label, value]) => `${label}: ${value && String(value).trim() ? String(value).trim() : '(not supplied)'}`).join('\n');

  return [
    'You are a natural-sounding social copywriter helping one real person explain a referral offer clearly.',
    'GOAL: write a post that feels like a normal person wrote it, not a company ad, bot, legal notice, or AI explanation. Make it easy to understand and easy to trust by being plain, specific, and honest.',
    `PLATFORM: ${platformName}. DESTINATION: ${input.destination}. TONE: ${input.tone}.`,
    '',
    'FACTS AND CONTEXT — treat these as the only source of truth:',
    facts,
    `Exact referral URL (include exactly once in the post body): ${input.url}`,
    '',
    'WRITING RULES:',
    '- Sound like an ordinary person talking to other people online. Use contractions and natural phrasing where appropriate. Vary sentence length a little. Keep it concise.',
    '- Do not over-explain, lecture, summarize your own writing, or describe the steps unless the user specifically asked you to explain them.',
    '- Do not add headings such as “Offer details”, “Disclosure”, or “Eligibility requirements” inside the post. Do not use a numbered list unless the user explicitly asks for steps.',
    '- Avoid generic ad/bot phrases like “I am excited to share”, “game changer”, “unlock”, “limited-time opportunity”, “Don’t miss out”, “Here is an amazing opportunity”, “I wanted to take a moment”, “Please note”, and “It is important to understand”.',
    '- Do not add boilerplate legal disclaimers, repeated warnings, “no pressure” filler, or multiple paragraphs telling people to check the terms. Include a requirement or limitation only when it is present in the supplied facts and relevant to understanding the offer.',
    '- Include one short, casual, truthful disclosure that this is the user’s referral link and they may receive a reward if a person qualifies. Keep it to one sentence; do not make it a formal disclaimer block.',
    '- Do not invent dollar amounts, points, deadlines, eligibility rules, steps, reward conditions, benefits, statistics, names, or guarantees. Use numbers only when they are clearly supported by the supplied facts.',
    '- Use the exact program name only if one was supplied. Never guess what the offer is or confuse it with a platform, store, or different service. In particular, do not mention “TikTok Shop” or “TT Shop” unless that exact service is named in the supplied facts.',
    '- Do not claim the writer personally tried, earned, received, or verified something unless the supplied facts explicitly say so. Do not manufacture testimonials.',
    '- Follow the user’s writing instructions as guidance, not as words that must be copied verbatim. Do not put private instructions or notes into the public post.',
    '- Make the call to action simple and low-pressure. The person should understand why the link is here and what is known about the offer. Never hide that it is a referral link.',
    '- Fit the platform: for Reddit, avoid sounding like a pasted advertisement and keep it relevant to the community; for Facebook, conversational; for Instagram/TikTok, compact; for X, very concise; for other destinations, use normal platform-appropriate wording.',
    '- Do not write unsolicited DMs or claim the post was approved by the destination. Draft only one post.',
    '',
    'LENGTH:',
    input.tone === 'short' ? 'Aim for 25–55 words plus the URL and the one-sentence referral disclosure.' : input.tone === 'helpful' ? 'Aim for 45–90 words plus the URL and the one-sentence referral disclosure.' : 'Aim for 30–75 words plus the URL and the one-sentence referral disclosure.',
    '',
    'OUTPUT: return only valid JSON with exactly two string keys: "title" and "body". Title should be natural and short (not clickbait); for platforms where titles are not used, make it a short internal label. Body must include the exact referral URL and one natural referral disclosure. No Markdown fences and no explanation outside the JSON.'
  ].join('\n');
}

function numericValues(text) {
  const out = new Set();
  for (const match of String(text || '').matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) out.add(match[0].replace(/,/g, ''));
  return out;
}

function removeUnsupportedMoneyClaims(text, sourceFacts) {
  const known = numericValues(sourceFacts);
  const moneyPattern = /(?:\$\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|bucks|points?|gift\s*cards?|coins?|credits?|percent|%))/i;
  return String(text || '').split(/\n{2,}/).map(paragraph => {
    return paragraph.split(/(?<=[.!?])\s+/).filter(sentence => {
      const match = sentence.match(moneyPattern);
      if (!match) return true;
      const num = match[0].match(/\d[\d,]*(?:\.\d+)?/);
      return Boolean(num && known.has(num[0].replace(/,/g, '')));
    }).join(' ').trim();
  }).filter(Boolean).join('\n\n');
}

function hasReferralDisclosure(body) {
  return /\b(?:referral|affiliate)\s+link\b/i.test(body) &&
    /\b(?:may|might|could|can|will|earn|get|receive|make)\b.{0,100}\b(?:reward|points?|commission|benefit|credit|bonus|something)\b|\b(?:reward|points?|commission|benefit|credit|bonus)\b.{0,100}\b(?:may|might|could|can|will|earn|get|receive|make)\b/i.test(body);
}


function capBodyLength(body, tone, url) {
  const maxWords = tone === 'short' ? 78 : tone === 'helpful' ? 155 : 115;
  let wordsLeft = maxWords;
  const outputParagraphs = [];
  const paragraphs = String(body || '').split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const kept = [];
    const sentences = paragraph.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    for (const sentence of sentences) {
      const disclosure = /\b(?:referral|affiliate)\s+link\b/i.test(sentence) && /\b(?:reward|points?|commission|may receive|might receive|may earn|might earn|may get|might get)\b/i.test(sentence);
      const containsUrl = Boolean(url && sentence.includes(url));
      const count = sentence.split(/\s+/).filter(Boolean).length;
      if (disclosure || containsUrl || wordsLeft >= count) {
        kept.push(sentence);
        if (!disclosure && !containsUrl) wordsLeft -= count;
      }
    }
    if (kept.length) outputParagraphs.push(kept.join(' '));
  }
  return outputParagraphs.join('\n\n').trim();
}

function cleanDraftResult(draft, input) {
  const exactName = String(input.programName || '').trim();
  const offerFacts = String(input.details || '');
  let title = String(draft.title || '').trim().slice(0, 300);
  let body = String(draft.body || '').trim();

  // Treat the exact-name field as authoritative. Writing instructions such as “do not call it TT Shop” must not enable that label.
  const nameSource = exactName || offerFacts;
  if (!/\b(?:tiktok\s+shop|tt\s*shop)\b/i.test(nameSource)) {
    const replacement = exactName || 'this offer';
    title = title.replace(/\bTikTok\s+Shop\b|\bTT\s*Shop\b/gi, replacement);
    body = body.replace(/\bTikTok\s+Shop\b|\bTT\s*Shop\b/gi, replacement);
  }

  // Only offer facts, not style notes or instructions, can authorize a reward amount or points claim.
  title = removeUnsupportedMoneyClaims(title, [offerFacts, exactName].join('\n')).replace(/\s+/g, ' ').trim();
  body = removeUnsupportedMoneyClaims(body, offerFacts);
  body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // If the provider added boilerplate warnings, keep the details the user supplied but discard repetitive generic caveats.
  const boilerplate = /^(?:please (?:check|read|review) (?:the )?(?:current |official )?(?:terms|conditions|eligibility requirements).*|eligibility and rewards? .*depend on .*terms.*|i (?:cannot|can't) guarantee (?:a reward|that anyone.*)|no (?:reward|results?) (?:are )?guaranteed\.?|there (?:is|are) no guarantees?\.?|no pressure (?:at all)?\.?)$/i;
  body = body.split(/\n{2,}/).map(paragraph => paragraph.split(/(?<=[.!?])\s+/).filter(sentence => {
    if (boilerplate.test(sentence.trim())) return false;
    if (/\b(?:here(?:'s| is) an? (?:amazing|great|incredible|fantastic) opportunity|i am excited to share|i'm excited to share|game changer|don't miss out|limited-time opportunity)\b/i.test(sentence)) return false;
    return true;
  }).join(' ').trim()).filter(Boolean).join('\n\n');

  // Keep only one referral disclosure if the model repeats itself, even if both are in one paragraph.
  let keptDisclosure = false;
  body = body.split(/\n{2,}/).map(paragraph => paragraph.split(/(?<=[.!?])\s+/).filter(sentence => {
    const isDisclosure = /\b(?:referral|affiliate)\s+link\b/i.test(sentence) && /\b(?:reward|points?|commission|may receive|might receive|may earn|might earn|may get|might get)\b/i.test(sentence);
    if (!isDisclosure) return true;
    if (keptDisclosure) return false;
    keptDisclosure = true;
    return true;
  }).join(' ').trim()).filter(Boolean).join('\n\n').trim();

  const url = String(input.url || '').trim();
  if (url && !body.includes(url)) body = `${body}${body ? '\n\n' : ''}If you’re interested, here’s my link: ${url}`;
  if (url) {
    let urlCount = 0;
    body = body.replaceAll(url, match => (++urlCount === 1 ? match : ''));
  }
  if (!hasReferralDisclosure(body)) body = `${body}${body ? '\n\n' : ''}Btw, this is my referral link, so I may get a reward if you qualify.`;
  body = capBodyLength(body, input.tone || 'casual', url);
  if (!title) title = input.programName ? `${input.programName} referral link` : 'Sharing my referral link';
  return { title: title.slice(0, 300), body: body.slice(0, 5000) };
}

module.exports = { buildDraftPrompt, cleanDraftResult };
