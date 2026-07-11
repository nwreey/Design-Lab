export default async function handler(req, res) {
  res.setHeader('Set-Cookie', 'design_lab_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.status(200).json({ ok: true });
}
