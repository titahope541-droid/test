#!/usr/bin/env python3
"""Fill in everything that depends on the production domain.

Usage:  python3 tools/set_site_url.py https://example.org

Run from the project root (or anywhere; paths are resolved from this file).
It is safe to run again: previous output is replaced, not duplicated.

What it does
  * adds <link rel="canonical">, og:url, og:image and twitter:image to every page
  * adds "url" and "logo" to the Organization JSON-LD on index.html
  * writes sitemap.xml
  * adds the Sitemap line to robots.txt
"""
import datetime, json, os, re, sys

PAGES = ["index.html", "about.html", "work.html", "partner.html", "involve.html", "contact.html"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if len(sys.argv) != 2 or not sys.argv[1].startswith(("http://", "https://")):
    sys.exit("Usage: python3 tools/set_site_url.py https://your-real-domain")
base = sys.argv[1].rstrip("/")

def url_for(page):
    return base + "/" if page == "index.html" else f"{base}/{page}"

for page in PAGES:
    path = os.path.join(ROOT, page)
    html = open(path, encoding="utf-8").read()
    block = (
        f'<!-- seo-domain:start -->\n'
        f'    <link rel="canonical" href="{url_for(page)}">\n'
        f'    <meta property="og:url" content="{url_for(page)}">\n'
        f'    <meta property="og:image" content="{base}/logo.png">\n'
        f'    <meta name="twitter:image" content="{base}/logo.png">\n'
        f'    <!-- seo-domain:end -->'
    )
    html = re.sub(r"<!-- seo-domain:start -->.*?<!-- seo-domain:end -->", lambda m: block, html, flags=re.S)
    if page == "index.html":
        def patch(m):
            data = json.loads(m.group(2))
            data["url"] = base + "/"
            data["logo"] = base + "/logo.png"
            return m.group(1) + json.dumps(data, indent=2, ensure_ascii=False) + m.group(3)
        html = re.sub(r'(<script type="application/ld\+json" id="org-jsonld">\s*)(.*?)(\s*</script>)', patch, html, flags=re.S)
    open(path, "w", encoding="utf-8", newline="\n").write(html)

today = datetime.date.today().isoformat()
urls = "\n".join(f"  <url><loc>{url_for(p)}</loc><lastmod>{today}</lastmod></url>" for p in PAGES)
open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8").write(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "\n</urlset>\n")

rp = os.path.join(ROOT, "robots.txt")
robots = [l for l in open(rp, encoding="utf-8").read().splitlines() if not l.lower().startswith("sitemap:")]
robots.append(f"Sitemap: {base}/sitemap.xml")
open(rp, "w", encoding="utf-8").write("\n".join(robots) + "\n")
print("Done. Canonical, Open Graph, JSON-LD url/logo, sitemap.xml and robots.txt updated for", base)
