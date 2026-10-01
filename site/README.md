# FreeCAN Studio landing site

The marketing site for `freecanstudio.com`. The app itself is a separate deployment on `app.freecanstudio.com` (see the repository README).

It is plain static HTML with one shared stylesheet. There is no build step and no npm dependency, so a copy edit doesn't need Rust or wasm. The Cloudflare build watch paths in [CONTRIBUTING.md](../CONTRIBUTING.md) keep a site-only push from rebuilding the app.

## Layout

| Path | What |
|---|---|
| `public/index.html` | Home |
| `public/blf-viewer-online/`, `public/mf4-viewer-online/`, `public/dbc-viewer-online/`, `public/canalyzer-alternative/` | Content pages, one shared template: H1, button into the app, 3 steps, FAQ, links to the other pages |
| `public/pro/` | The planned Pro desktop app. No price and no sign-up until those are decided |
| `public/404.html` | Served for unknown paths (`not_found_handling: "404-page"`) |
| `public/site.css` | Every style. The tokens are copied from `web/src/styles.css`; keep them in step with [DESIGN.md](../DESIGN.md) |
| `public/fonts/` | IBM Plex Sans 400/500/600 and Mono 400/600, Latin subset, copied from `web/node_modules/@fontsource`, with their OFL licences |
| `public/logo.svg`, `public/favicon.svg` | The Twisted F, exported from `web/src/components/Logo.tsx` with the gaps painted Warm White |
| `public/og-image.png` | The 1200 x 630 social preview image |
| `public/_headers` | Content-Security-Policy and caching |
| `public/robots.txt`, `public/sitemap.xml` | For search engines. Add new pages to the sitemap |
| `wrangler.jsonc` | The `freecan-site` Workers static-assets project |

Each folder holds an `index.html`, so pages have clean URLs (`/blf-viewer-online/`).

## Rules

- No drop zone. A file dropped here can't be handed to the app on another origin, so every button sends people to the app to open files there.
- One amber primary button per page; everything else is an outline button or a text link.
- Copy stays truthful: only claim what the app does today (see [PRODUCT.md](../PRODUCT.md) and [COMPATIBILITY.md](../COMPATIBILITY.md)). No prices, dates, customers or usage numbers.
- No inline styles or scripts: the Content-Security-Policy allows only this origin.
- Analytics, a newsletter signup or video embeds are allowed here, by widening `public/_headers`, and never in the app, whose policy in `web/public/_headers` stays self-only. The site's policy allows Cloudflare Web Analytics, which Cloudflare injects and which sets no cookies. The app domain must be excluded from Web Analytics in the Cloudflare dashboard; its policy would block the beacon anyway.
- ASCII only in the source. Use HTML entities such as `&hellip;`, `&middot;` and `&rsquo;` for typographic characters.

## Preview locally

From `site/`, either of these serves the site:

```bash
npx wrangler dev
```

```bash
python3 -m http.server 8000 --directory public
```

`wrangler dev` applies `_headers`, clean-URL handling and the 404 page as Cloudflare will. `http.server` does not, but is enough for checking copy and layout. Buttons point at `https://app.freecanstudio.com/`, not at a local app.

## Deploy

Cloudflare Workers Builds runs `npx wrangler deploy` with `site` as the root directory. See "Deployment" in [CONTRIBUTING.md](../CONTRIBUTING.md) for both projects and their domains.
