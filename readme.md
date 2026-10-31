# Articles page and admin upload page

This adds a public **Articles** page and a password-protected **admin page** for publishing articles to the DIRA Foundation website.

## What is included

| File | Purpose |
|---|---|
| `articles.html` | Template for the public articles list at `/articles` |
| `article.html` | Template for a single article at `/articles/your-article-name` |
| `admin.html` | The admin page at `/admin.html` (sign in, write, upload, edit, delete) |
| `server.js` | Node.js server: serves the website, renders articles and connects the admin API to MongoDB and Cloudinary |
| `netlify.toml` | Netlify static-site, Function, redirect and header configuration |
| `netlify/functions/server.js` | Netlify Function entry point for the backend |
| `.env.example` | Settings file to copy to `.env` (admin email and password go here) |
| `package.json`, `.gitignore` | Start command and git ignore rules |
| `data/`, `uploads/` | Legacy local article/image storage; new content is stored in MongoDB and Cloudinary |

You need **Node.js 18 or newer**, a MongoDB database and a Cloudinary account.

## Setup

1. Copy all these files into the root folder of your website, next to `index.html`, `about.html` and the other pages.
2. Install the server dependencies with `npm install`.
3. Create a MongoDB database/user and a Cloudinary account.
4. Copy `.env.example` to a new file named `.env`.
5. Open `.env` and set your own values:
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 8 characters, not the example text)
   - `MONGODB_URI` from your MongoDB deployment, including your database name in the connection string
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` from the Cloudinary Console
   - `SESSION_SECRET`: a long random string. Create one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SITE_URL`: your real website address, for example `https://www.example.org` (optional, used for canonical links and social previews)
6. Start the site: `npm start`.
7. Open `http://localhost:3000/articles` and `http://localhost:3000/admin.html`.

The server checks MongoDB and Cloudinary configuration at startup. Database credentials and Cloudinary secrets stay on the server and must never be added to browser code or committed.

Always open the site through the server. Opening `articles.html` directly from your computer will show template placeholders, not articles.

## Changing the admin email or password

Edit `ADMIN_EMAIL` or `ADMIN_PASSWORD` in `.env` and restart the server. Everyone who was signed in is signed out automatically. If the email or password is missing, too short, or still the example text, nobody can sign in and the admin page says so.

## Publishing an article

1. Go to `/admin.html` and sign in.
2. Fill in the title, an optional summary, the article text and, if you like, an author and a header image. To add an image within the text, place the cursor where it should go, enter an image description and choose a file under **Add an image in the article text**. Large images are resized and cleaned of camera and location data in your browser before upload.
3. Tick **Publish this article on the website** and save. Leave it unticked to keep a draft. Drafts are only visible to you, through the Preview button.
4. Use Edit or Delete in the list at any time.

The three most recently published articles also appear on the homepage after they load.

The article text supports simple formatting: a blank line starts a new paragraph, `## Heading`, `### Smaller heading`, `**bold**`, `*italic*`, lines starting with `- ` for bullets or `1. ` for numbers, `> quote`, `[link text](https://address)`, and images inserted with the admin upload control. The control inserts a Markdown image reference to the Cloudinary asset. Anything else, including HTML, is shown as plain text.

A published article keeps its web address even if you later change its title, so shared links keep working.

## Where your content is stored

- Articles: the `articles` collection in the configured MongoDB database
- Header and in-article images: the `dira-articles` folder in Cloudinary

Back up the MongoDB database and Cloudinary assets. On standalone server startup, if the legacy `data/articles.json` file is present and the MongoDB collection is empty, the server imports those articles once. Netlify does not deploy ignored local data/uploads; migrate any legacy local articles and images to MongoDB and Cloudinary before deploying.

## Hosting

### Deploying to Netlify

The repository includes `netlify.toml` and a Netlify Function adapter. Netlify serves the static pages and runs the existing article API and dynamic article routes as a function. Do not use `node server.js` as the Netlify start command.

1. Push this repository to GitHub/GitLab/Bitbucket and import it as a new Netlify site. Set the base directory to the repository root and leave the publish directory and functions directory to the values in `netlify.toml`.
2. In **Site configuration → Environment variables**, add `MONGODB_URI`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `SESSION_SECRET`. Set `SITE_URL` to the final HTTPS site URL (for example `https://example.netlify.app`). Do not upload `.env` or put secrets in `netlify.toml`.
3. Ensure the MongoDB network access rules allow connections from Netlify Functions (or use an appropriate MongoDB connectivity option). The serverless function reuses its MongoDB connection while its runtime instance remains warm.
4. Deploy the site. Netlify installs dependencies from `package-lock.json`; verify `/`, `/articles`, an article URL, and `/admin.html` on the deployed HTTPS domain.
5. Sign in at `/admin.html`, publish a test article and verify it appears on the homepage. Netlify sets secure session cookies and routes `/api/*` and `/articles/*` to the function.

Netlify Functions have a 6 MB buffered request limit. The admin editor compresses images in the browser before uploading; keep upload files modest so the encoded request fits the limit. Set the secrets in Netlify’s environment-variable UI for the deploy context you use (production and deploy previews as needed).

For other hosts, the standalone server can run on a Node.js host such as a VPS, Render, Railway or cPanel. Configure the MongoDB and Cloudinary environment variables on the host. A persistent local disk is not needed for new article content or images.

## Add the Articles link to your other pages

The new pages already include it. To show it on the existing pages, add this line after the "Our Work" item in the header menu, the mobile menu and the footer Quick Links:

```html
<li><a href="/articles">Articles</a></li>
```

## Optional search engine settings

- `/robots.txt` disallows admin and API paths and points to `/sitemap.xml`.
- The sitemap is generated from the public pages and published MongoDB articles. Set `SITE_URL` to the canonical production domain so its absolute URLs are correct.

## Security notes

- The admin password is stored as plain text in `.env`, so keep that file private and use a strong, unique password. The server never serves `.env`, `data/` or `server.js`; Netlify also blocks those paths and other deployment source files.
- After 5 wrong sign-in attempts from one address, sign-in is blocked for 15 minutes.
- Sessions use a signed, HttpOnly cookie and last `SESSION_HOURS` hours (12 by default).
- Use HTTPS on the live site.
