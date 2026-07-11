export const config = {
  matcher: '/:path*',
};

// Paths that must always be reachable without auth — otherwise the redirect-to-login
// itself would get redirected, and nobody could ever reach the login page or submit it.
const PUBLIC_PATHS = ['/login.html', '/api/login', '/api/logout'];

async function verifyToken(token, secret) {
  if (!token) return false;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return false;

  const expiry = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expiryNum = parseInt(expiry, 10);
  if (!expiryNum || expiryNum < Math.floor(Date.now() / 1000)) return false;

  // Edge middleware runs on the Edge runtime, not Node — use Web Crypto (SubtleCrypto)
  // rather than the Node 'crypto' module the API routes use, since that module isn't
  // available here. Same HMAC-SHA256 scheme, just the Edge-compatible implementation.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expiry));
  const expectedSignature = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  return signature === expectedSignature;
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

  const validPass = process.env.SITE_PASSWORD || '';
  const cookieHeader = request.headers.get('cookie');
  const token = parseCookie(cookieHeader, 'design_lab_auth');

  const isValid = validPass && await verifyToken(token, validPass);
  if (isValid) {
    return;
  }

  const loginUrl = new URL('/login.html', request.url);
  if (url.pathname !== '/') {
    loginUrl.searchParams.set('next', url.pathname + url.search);
  }
  return Response.redirect(loginUrl, 302);
}
