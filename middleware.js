export const config = {
  matcher: '/:path*',
};

// Paths that must always be reachable without auth — otherwise the redirect-to-login
// itself would get redirected, and nobody could ever reach the login page or submit it.
const PUBLIC_PATHS = ['/', '/homepage.html', '/login.html', '/api/login', '/api/logout', '/logo-white.png', '/logo-black-transparent.png'];

// Paths that require the admin role specifically, on top of just being logged in.
const ADMIN_ONLY_PATHS = ['/admin.html', '/api/admin-users', '/api/admin-lockouts', '/api/fetch-website-text'];

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

  if (ADMIN_ONLY_PATHS.some(p => url.pathname === p) && payload.role !== 'admin') {
    return new Response('Forbidden — admin access required.', { status: 403 });
  }

  return;
}
