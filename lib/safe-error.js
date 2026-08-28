/* ================= Provider-name scrubbing for user-facing errors =================
   OWNER RULE: users must never see anything identifying the AI/service providers behind
   DesignsLab (Gemini/Google, OpenAI/GPT, Luma, Mandrill, Neon, etc.). Full raw errors
   still go to console.error (Vercel function logs) and lib/usage-log.js for diagnosis —
   this module only cleans what is SENT to the browser.

   scrubProviderText(text): replaces provider identifiers with neutral wording and strips
   model strings; if the result still looks like provider chatter (very long/technical),
   callers should prefer their own generic fallback message instead.

   CommonJS on purpose — same mixed ESM/CJS interop reasoning as lib/usage-log.js. */

const PROVIDER_PATTERNS = [
  [/\bgemini[-\s\w.]*\b/gi, 'the design engine'],
  [/\bgoogle(\s+cloud)?\b/gi, 'the design engine'],
  [/\bopen\s?ai\b/gi, 'the design engine'],
  [/\bgpt[-\w.]*\b/gi, 'the design engine'],
  [/\bdall[-\s]?e\b/gi, 'the design engine'],
  [/\banthropic\b/gi, 'the design engine'],
  [/\bclaude\b/gi, 'the design engine'],
  [/\bluma(\s?labs)?(\s?ai)?\b/gi, 'the design engine'],
  [/\bmandrill\b/gi, 'the email service'],
  [/\bmailchimp\b/gi, 'the email service'],
  [/\bneon\b/gi, 'the database'],
  [/\bgenerativelanguage[\w.]*/gi, 'the design engine'],
  [/\bapi\.openai\.com\b/gi, 'the design engine'],
  [/\bx-goog[\w-]*/gi, ''],
  [/model:\s*["'\w.-]+/gi, ''],
  [/\(HTTP \d+[^)]*\)/gi, ''],
];

function scrubProviderText(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of PROVIDER_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Collapse the artifacts scrubbing leaves behind.
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

/* One generic, on-brand message per failure family — used when the real error is too
   provider-specific to be worth showing even scrubbed. */
const GENERIC_IMAGE_ERROR = 'The design engine could not produce an image for this request. Please try again — if it keeps happening, contact support.';
const GENERIC_TEXT_ERROR = 'The design engine could not process this request. Please try again — if it keeps happening, contact support.';

module.exports = { scrubProviderText, GENERIC_IMAGE_ERROR, GENERIC_TEXT_ERROR };
