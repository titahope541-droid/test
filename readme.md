# Articles page and admin upload page

This adds a public **Articles** page and a password-protected **admin page** for publishing articles to the DIRA Foundation website.

## What is included

| File | Purpose |
|---|---|
| `articles.html` | Template for the public articles list at `/articles` |
| `article.html` | Template for a single article at `/articles/your-article-name` |
| `admin.html` | The admin page at `/admin.html` (sign in, write, upload, edit, delete) |
| `server.js` | Small Node.js server: serves your website, renders the articles pages, and runs the admin login and saving |
| `.env.example` | Settings file to copy to `.env` (admin email and password go here) |
| `package.json`, `.gitignore` | Start command and git ignore rules |
| `data/`, `uploads/` | Where articles and images are stored (empty at first, no sample articles) |

No packages need to be installed. You only need **Node.js 18 or newer**.

## Setup

1. Copy all these files into the root folder of your website, next to `index.html`, `about.html` and the other pages.
2. Copy `.env.example` to a new file named `.env`.
3. Open `.env` and set your own values:
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 8 characters, not the example text)
   - `SESSION_SECRET`: a long random string. Create one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SITE_URL`: your real website address, for example `https://www.example.org` (optional, used for canonical links and social previews)
4. Start the site: `node server.js` (or `npm start`).
5. Open `http://localhost:3000/articles` and `http://localhost:3000/admin.html`.

Always open the site through the server. Opening `articles.html` directly from your computer will show template placeholders, not articles.

## Changing the admin email or password

Edit `ADMIN_EMAIL` or `ADMIN_PASSWORD` in `.env` and restart the server. Everyone who was signed in is signed out automatically. If the email or password is missing, too short, or still the example text, nobody can sign in and the admin page says so.

## Publishing an article

1. Go to `/admin.html` and sign in.
2. Fill in the title, an optional summary, the article text and, if you like, an author and a cover image. Large images are resized and cleaned of camera and location data in your browser before upload.
3. Tick **Publish this article on the website** and save. Leave it unticked to keep a draft. Drafts are only visible to you, through the Preview button.
4. Use Edit or Delete in the list at any time.

The article text supports simple formatting: a blank line starts a new paragraph, `## Heading`, `### Smaller heading`, `**bold**`, `*italic*`, lines starting with `- ` for bullets or `1. ` for numbers, `> quote`, and `[link text](https://address)`. Anything else, including HTML, is shown as plain text.

A published article keeps its web address even if you later change its title, so shared links keep working.

## Where your content is stored

- Articles: `data/articles.json` (created automatically, starts empty)
- Cover images: `uploads/`

Back up both. They are listed in `.gitignore` so they are not committed to git.

## Hosting

This needs a host that can run Node.js (a VPS, Render, Railway, or the Node.js app feature of cPanel hosting). It will not work on GitHub Pages or other static-only hosts. Make sure the host keeps the `data/` and `uploads/` folders between restarts (a persistent disk or volume). If your host serves the site over HTTPS through a proxy, set `TRUST_PROXY=true` in `.env` so login cookies are marked secure.

## Add the Articles link to your other pages

The new pages already include it. To show it on the existing pages, add this line after the "Our Work" item in the header menu, the mobile menu and the footer Quick Links:

```html
<li><a href="/articles">Articles</a></li>
```

## Optional search engine settings

- In `robots.txt`, add `Disallow: /admin.html` and `Disallow: /api/`. The admin page already tells search engines not to index it.
- Published articles are not added to a sitemap automatically. Add `/articles` and each article address to `sitemap.xml` if you use one.

## Security notes

- The admin password is stored as plain text in `.env`, so keep that file private and use a strong, unique password. The server never serves `.env`, `data/` or `server.js`.
- After 5 wrong sign-in attempts from one address, sign-in is blocked for 15 minutes.
- Sessions use a signed, HttpOnly cookie and last `SESSION_HOURS` hours (12 by default).
- Use HTTPS on the live site.
