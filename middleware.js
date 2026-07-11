export const config = {
  matcher: '/:path*',
};

function unauthorized() {
  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Restricted"' },
  });
}

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  const validUser = process.env.SITE_USERNAME || '';
  const validPass = process.env.SITE_PASSWORD || '';

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return unauthorized();
  }

  const base64Credentials = authHeader.split(' ')[1];
  const decoded = atob(base64Credentials);
  const separatorIndex = decoded.indexOf(':');
  const user = decoded.substring(0, separatorIndex);
  const pass = decoded.substring(separatorIndex + 1);

  if (user !== validUser || pass !== validPass) {
    return unauthorized();
  }
}
