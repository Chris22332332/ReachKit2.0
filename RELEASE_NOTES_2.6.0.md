# ReachKit Pro 2.6.0 — Humanized AI writing

- Kept live server-side AI provider support; the API key remains on the server.
- Added optional exact program name, post intent, and voice notes fields to campaign setup.
- Rebuilt the prompt around concise, conversational copy and grounded facts.
- Added output cleanup for unprovided TT Shop/TikTok Shop cross-program mentions, unsupported numeric reward claims, boilerplate caveats, duplicate disclosure lines, and missing referral URLs.
- Reworked the no-provider fallback to be shorter and more natural, with one short disclosure and no extra generic eligibility paragraph.
- Clearly labels the local fallback as a built-in writer rather than live AI.
- Extended smoke tests for the AI prompt and output cleanup.

The live AI provider is still optional and requires an API provider/key configured in ReachKit Settings. Actual model quality varies by selected provider/model and is not guaranteed. Review every draft for factual accuracy and follow each destination’s rules.
