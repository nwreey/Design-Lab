# -*- coding: utf-8 -*-
# Wires /ar/ routing, hreflang, sitemap, blog index cards, footer AR links. Run once, delete.
import io, json, os
BASE = os.path.dirname(os.path.abspath(__file__))
S = "https://designslab.ai"

def rd(p):
    with io.open(os.path.join(BASE, p), encoding="utf-8") as f: return f.read()
def wr(p, t):
    with io.open(os.path.join(BASE, p), "w", encoding="utf-8") as f: f.write(t)
    print("updated", p)

# ---- 1. vercel.json rewrites
v = json.loads(rd("vercel.json"))
new_rw = [
    ("/ar", "/ar/index.html"),
    ("/ar/ai-exhibition-booth-designer", "/ar/ai-exhibition-booth-designer.html"),
    ("/ar/ai-event-concept-generator", "/ar/ai-event-concept-generator.html"),
    ("/ar/ai-display-stand-designer", "/ar/ai-display-stand-designer.html"),
    ("/ar/ai-image-editor", "/ar/ai-image-editor.html"),
    ("/ar/blog", "/ar/blog/index.html"),
    ("/ar/blog/ai-exhibition-booth-design-guide", "/ar/blog/ai-exhibition-booth-design-guide.html"),
    ("/ar/blog/exhibition-booth-cost-saudi-uae", "/ar/blog/exhibition-booth-cost-saudi-uae.html"),
    ("/blog/exhibition-stand-cost-dubai-saudi-arabia", "/blog/exhibition-stand-cost-dubai-saudi-arabia.html"),
    ("/blog/exhibition-booth-design-trends-2026", "/blog/exhibition-booth-design-trends-2026.html"),
]
existing = {r["source"] for r in v["rewrites"]}
for src, dst in new_rw:
    if src not in existing:
        v["rewrites"].append({"source": src, "destination": dst})
wr("vercel.json", json.dumps(v, indent=2) + "\n")

# ---- 2. middleware PUBLIC_PREFIXES
m = rd("middleware.js")
old = "const PUBLIC_PREFIXES = ['/solutions/', '/industries/', '/blog'];"
assert old in m
m = m.replace(old, "const PUBLIC_PREFIXES = ['/solutions/', '/industries/', '/blog', '/ar'];")
wr("middleware.js", m)

# ---- 3. sitemap additions
sm = rd("sitemap.xml")
adds = "".join(
    "  <url><loc>%s</loc><changefreq>%s</changefreq><priority>%s</priority></url>\n" % (S + u, c, p)
    for u, c, p in [
        ("/ar", "weekly", "0.9"),
        ("/ar/ai-exhibition-booth-designer", "monthly", "0.9"),
        ("/ar/ai-event-concept-generator", "monthly", "0.9"),
        ("/ar/ai-display-stand-designer", "monthly", "0.9"),
        ("/ar/ai-image-editor", "monthly", "0.9"),
        ("/ar/blog", "weekly", "0.7"),
        ("/ar/blog/ai-exhibition-booth-design-guide", "yearly", "0.6"),
        ("/ar/blog/exhibition-booth-cost-saudi-uae", "yearly", "0.6"),
        ("/blog/exhibition-stand-cost-dubai-saudi-arabia", "yearly", "0.6"),
        ("/blog/exhibition-booth-design-trends-2026", "yearly", "0.6"),
    ])
assert "</urlset>" in sm
sm = sm.replace("</urlset>", adds + "</urlset>")
wr("sitemap.xml", sm)

# ---- 4. hreflang on EN counterpart pages
def hre(en, ar):
    return ('<link rel="alternate" hreflang="en" href="%s">\n'
            '<link rel="alternate" hreflang="ar" href="%s">\n'
            '<link rel="alternate" hreflang="x-default" href="%s">\n' % (en, ar, en))

pairs = [
    ("ai-exhibition-booth-designer.html", S + "/ai-exhibition-booth-designer", S + "/ar/ai-exhibition-booth-designer"),
    ("ai-event-concept-generator.html", S + "/ai-event-concept-generator", S + "/ar/ai-event-concept-generator"),
    ("ai-display-stand-designer.html", S + "/ai-display-stand-designer", S + "/ar/ai-display-stand-designer"),
    ("ai-image-editor.html", S + "/ai-image-editor", S + "/ar/ai-image-editor"),
    ("blog/index.html", S + "/blog/", S + "/ar/blog"),
]
for f, en, ar in pairs:
    t = rd(f)
    if 'hreflang="ar"' in t: continue
    canon = '<link rel="canonical" href="%s">' % en
    assert canon in t, f
    t = t.replace(canon, canon + "\n" + hre(en, ar).rstrip())
    wr(f, t)

# homepage has no canonical — add canonical + hreflang after <title> line
t = rd("homepage.html")
if 'rel="canonical"' not in t:
    marker = "<title>DesignsLab AI"
    i = t.index(marker); j = t.index("</title>", i) + len("</title>")
    ins = '\n<link rel="canonical" href="%s/">\n%s' % (S, hre(S + "/", S + "/ar").rstrip())
    t = t[:j] + ins + t[j:]
    wr("homepage.html", t)

# ---- 5. blog/index.html: add 2 new EN cards
t = rd("blog/index.html")
anchor = '<div class="seo-card"><h3><a href="/blog/how-ai-is-changing-exhibition-booth-design"'
new_cards = ('<div class="seo-card"><h3><a href="/blog/exhibition-stand-cost-dubai-saudi-arabia" style="text-decoration:none;">How Much Does an Exhibition Stand Cost in Dubai &amp; Saudi Arabia? (2026)</a></h3><p>Real 2026 per-sqm price ranges in Dubai and Riyadh, the five biggest cost drivers, and how design decisions control the budget before the build starts.</p></div>'
             '<div class="seo-card"><h3><a href="/blog/exhibition-booth-design-trends-2026" style="text-decoration:none;">Exhibition Booth Design Trends 2026</a></h3><p>Hero elements, AI-assisted concepting, warm materiality, hospitality-first layouts, and auditable sustainability — what actually wins attention this year.</p></div>')
assert anchor in t
t = t.replace(anchor, new_cards + anchor)
wr("blog/index.html", t)

# ---- 6. add العربية link in footer-bottom of the 5 EN counterpart pages + homepage
ar_map = {
    "homepage.html": "/ar",
    "ai-exhibition-booth-designer.html": "/ar/ai-exhibition-booth-designer",
    "ai-event-concept-generator.html": "/ar/ai-event-concept-generator",
    "ai-display-stand-designer.html": "/ar/ai-display-stand-designer",
    "ai-image-editor.html": "/ar/ai-image-editor",
    "blog/index.html": "/ar/blog",
}
for f, ar_url in ar_map.items():
    t = rd(f)
    if 'lang-alt-link' in t: continue
    old = '<div class="footer-copy">'
    assert old in t, f
    t = t.replace(old, '<div style="margin-bottom:10px;"><a class="lang-alt-link" href="%s" style="font-size:13px;font-weight:700;color:var(--ink);text-decoration:none;">العربية 🌐</a></div>\n      <div class="footer-copy">' % ar_url, 1)
    wr(f, t)

print("WIRING DONE")
