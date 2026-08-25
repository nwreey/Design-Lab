import crypto from 'crypto';
import { sendTransactionalEmail, buildBrandedEmail } from '../lib/email.js';

/* ================= Email system diagnostic (admin only) =================
   Built to answer "why didn't the email arrive?" in one click instead of digging
   through Vercel logs. Runs ON the server (which, unlike a browser or dev sandbox,
   can reach Mandrill's API) and reports each link in the chain:

     1. keyConfigured   — is MANDRILL_API_KEY actually set in this deployment?
     2. ping            — does Mandrill accept the key? ("PONG!")
     3. domain          — designslab.ai's status in Mandrill: verified? DKIM valid?
                          SPF valid? (this is the usual silent killer — sends come
                          back status "rejected", reason "unsigned", when the
                          sending domain isn't verified)
     4. testSend        — optional (?send=1&to=you@x.com): sends one real branded
                          test email and reports Mandrill's exact per-recipient
                          response, including any reject_reason.

   GET, admin token required (same verification as api/admin-users.js). The API key
   itself is never echoed back — only booleans/statuses. */

function verifyTokenNode(token, secret) {
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;
  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  if (signature !== expectedSignature) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload.expiry || payload.expiry < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function mandrillCall(path, body) {
  const response = await fetch('https://mandrillapp.com/api/1.0/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { httpOk: response.ok, status: response.status, data };
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';
  const token = parseCookie(req.headers.cookie, 'design_lab_auth');
  const payload = verifyTokenNode(token, signingSecret);
  if (!payload || payload.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin access required.' } });
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed. Use GET.' } });
    return;
  }

  const apiKey = process.env.MANDRILL_API_KEY;
  const report = {
    keyConfigured: !!apiKey,
    ping: null,
    domain: null,
    testSend: null,
    verdict: '',
  };

  if (!apiKey) {
    report.verdict = 'MANDRILL_API_KEY is NOT set in this deployment — no email can be sent. Add it in Vercel → Settings → Environment Variables, then REDEPLOY (env changes only apply to new deployments).';
    res.status(200).json(report);
    return;
  }

  // 2. Key validity
  try {
    const ping = await mandrillCall('users/ping.json', { key: apiKey });
    report.ping = ping.httpOk && ping.data === 'PONG!' ? 'ok' : { failed: true, response: ping.data };
    if (report.ping !== 'ok') {
      report.verdict = 'The Mandrill API key is set but Mandrill rejected it (see ping). Check the key in Mailchimp Transactional → Settings → API keys.';
      res.status(200).json(report);
      return;
    }
  } catch (err) {
    report.ping = { failed: true, error: String(err && err.message) };
    report.verdict = 'Could not reach the Mandrill API from the server.';
    res.status(200).json(report);
    return;
  }

  // 3. Sending-domain status for designslab.ai
  try {
    const domains = await mandrillCall('senders/domains.json', { key: apiKey });
    const d = Array.isArray(domains.data) ? domains.data.find(x => x.domain === 'designslab.ai') : null;
    if (!d) {
      report.domain = { found: false };
      report.verdict = 'designslab.ai is not registered as a sending domain in this Mandrill account — add and verify it in Mailchimp Transactional → Settings → Domains.';
    } else {
      report.domain = {
        found: true,
        verified: !!d.verified_at || !!d.valid_signing,
        verified_at: d.verified_at || null,
        dkim_valid: d.dkim ? !!d.dkim.valid : null,
        spf_valid: d.spf ? !!d.spf.valid : null,
        last_tested_at: d.last_tested_at || null,
      };
      if (!report.domain.verified || report.domain.dkim_valid === false) {
        report.verdict = 'The domain exists in Mandrill but is not fully verified/signing — click "Test DNS Settings" / verify the domain in Mailchimp Transactional → Settings → Domains. Until then every send is rejected as "unsigned".';
      }
    }
  } catch (err) {
    report.domain = { error: String(err && err.message) };
  }

  // 4. Optional real test send
  const wantSend = (req.query && req.query.send) === '1';
  const to = (req.query && req.query.to) || '';
  if (wantSend && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    const html = buildBrandedEmail({
      previewText: 'Test email from the DesignsLab AI email system diagnostic.',
      greeting: 'Email system test ✔',
      paragraphs: [
        'This is a test email sent from the admin Email System Check on designslab.ai.',
        'If you are reading this, Mandrill delivery from <strong>notification@designslab.ai</strong> is working.',
      ],
      footnote: 'Triggered manually by an admin. Safe to delete.',
    });
    report.testSend = await sendTransactionalEmail({ toEmail: to, toName: 'Admin Test', subject: 'Email system test | DesignsLab AI', html });
  }

  if (!report.verdict) {
    report.verdict = report.testSend
      ? (report.testSend.sent
          ? 'Everything works — Mandrill accepted the test email. If earlier emails never arrived, check the recipient\'s spam folder and Mandrill\'s Outbound activity log.'
          : 'Key and domain look fine, but the test send failed: ' + (report.testSend.error || 'unknown reason') + '.')
      : 'Key valid and domain checked — add &send=1&to=your@email.com to this URL (or use the admin panel button) to fire a real test email.';
  }

  res.status(200).json(report);
}
