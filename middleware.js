export const config = {
  matcher: '/:path*',
};

// Paths that must always be reachable without auth — otherwise the redirect-to-login
// itself would get redirected, and nobody could ever reach the login page or submit it.
// Every public marketing page is listed here (launch requirement: the whole site is visible
// to visitors without an account) — only the app itself (ai-design-studio.html), admin.html,
// and the non-auth API endpoints stay behind login.
const PUBLIC_PATHS = [
  '/', '/homepage.html', '/product.html', '/pricing.html', '/enterprise.html', '/news.html',
  '/contact.html', '/terms.html', '/privacy.html', '/cookie-policy.html', '/usage-policy.html', '/login.html',
  '/admin-gate-x7k93qe4.html', // private admin sign-in page (owner-only link; enforcement is server-side in api/login.js)
  '/admin-gate-x7k93qe4', // same page without .html (vercel.json rewrite) — middleware sees the pre-rewrite path
  '/signup.html',
  // Set-password page + endpoint: reached from the approval email by people who, by
  // definition, can't sign in yet. The single-use token in the link is the credential.
  '/set-password.html', '/api/set-password',
  // /api/signup is public for POST (submitting an access request); its admin-only verbs
  // (GET/PATCH/DELETE) re-verify the admin token inside the endpoint itself, same
  // defense-in-depth pattern as api/admin-users.js.
  '/api/signup',
  '/api/contact', // public POST — the Contact form; rate-limited + validated inside the endpoint
  '/api/login', '/api/logout',
  // reCAPTCHA v3 client config — must load on the public form pages (login, signup,
  // contact, enterprise) before any sign-in exists. Contains only the PUBLIC site key.
  '/recaptcha-config.js',
  // SEO: crawlers must reach these without auth (Google Search Console setup).
  '/robots.txt', '/sitemap.xml',
  '/logo-white.png', '/logo-black-transparent.png',
  '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/favicon-48.png', '/favicon-192.png',
  '/favicon-512.png', '/apple-touch-icon.png',
  // Case-study images on the News page — without these, a logged-out visitor's image
  // requests get redirected to login and every picture on that page breaks.
  '/case-bmw.jpg', '/case-rolex.jpg', '/case-redbull.jpg', '/case-natgeo.jpg',
];

// Paths that require the admin role specifically, on top of just being logged in.
const ADMIN_ONLY_PATHS = ['/admin.html', '/api/admin-users', '/api/admin-lockouts', '/api/admin-service-usage'];

/* Verifies the base64(JSON)+"."+signature token and returns the decoded payload
   ({userId, username, role, expiry}) if valid, or null if not. Edge middleware runs on
   the Edge runtime, not Node — Web Crypto (SubtleCrypto) and atob() are used instead of
   the Node 'crypto'/'Buffer' APIs the login endpoint uses, since those aren't available
   here. Same HMAC-SHA256 signing scheme on both sides, just the Edge-compatible half. */
async function verifyToken(token, secret) {
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;

  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const expectedSignature = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (signature !== expectedSignature) return null;

  let payload;
  try {
    payload = JSON.parse(atob(payloadB64));
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

export default async function middleware(request) {
  const url = new URL(request.url);

  // SEO architecture (owner request): the marketing/content tree is fully public.
  // Prefix matching is deliberately strict: '/ar' must match '/ar' or '/ar/...' but
  // NEVER '/ar<anything-else>' — a bare startsWith('/ar') would silently make any
  // future path that merely BEGINS with those letters public.
  const PUBLIC_PREFIXES = ['/solutions', '/industries', '/blog', '/ar'];
  const PUBLIC_SEO_PAGES = ['/ai-exhibition-booth-designer', '/ai-event-concept-generator', '/ai-display-stand-designer', '/ai-image-editor'];
  if (PUBLIC_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/')) ||
      PUBLIC_SEO_PAGES.some(p => url.pathname === p || url.pathname === p + '.html')) {
    return;
  }

  if (PUBLIC_PATHS.some(p => url.pathname === p)) {
    return;
  }

  const signingSecret = process.env.SITE_PASSWORD || '';
  const cookieHeader = request.headers.get('cookie');
  const token = parseCookie(cookieHeader, 'design_lab_auth');

  const payload = signingSecret ? await verifyToken(token, signingSecret) : null;
  if (!payload) {
    const loginUrl = new URL('/login.html', request.url);
    if (url.pathname !== '/') {
      loginUrl.searchParams.set('next', url.pathname + url.search);
    }
    return Response.redirect(loginUrl, 302);
  }

  if (ADMIN_ONLY_PATHS.some(p => url.pathname === p)) {
    if (payload.role !== 'admin') {
      return new Response('Forbidden — admin access required.', { status: 403 });
    }
    // Admin IP allowlist (owner request): even a valid admin cookie only works from the
    // allowlisted IPs — a stolen cookie is useless elsewhere. Unset env = no restriction.
    const allowedIps = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(v => v.trim()).filter(Boolean);
    if (allowedIps.length > 0) {
      const ip = ((request.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim();
      if (!allowedIps.includes(ip)) {
        return new Response('Forbidden — admin access required.', { status: 403 });
      }
    }
  }

  return;
}
