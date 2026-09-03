# White-label branding

The dashboard's identity — product name, the small "by …" credit, an optional
logo, the browser-tab suffix and the footer — is read from the environment at
startup (`src/branding.ts`). A licensee rebrands by setting variables in
`.env`; no fork, no template edits. Unset everything and you get the stock
**iOS Farm / by Handler** look.

| Variable | Default | Where it shows |
| --- | --- | --- |
| `PHONE_FARM_BRAND_NAME` | `iOS Farm` | Product name in the top bar (links to `/`) |
| `PHONE_FARM_BRAND_TITLE` | `Handler` | Suffix of every page `<title>` ("Devices · Envy") |
| `PHONE_FARM_BRAND_BY` | `by Handler` | Credit under the name. Set to an empty string to hide it |
| `PHONE_FARM_BRAND_BY_URL` | `https://gethandler.ai` | Where the credit links. Empty string = plain text |
| `PHONE_FARM_BRAND_LOGO` | — | Path to a `.png`, `.svg`, `.jpg` or `.webp`, shown left of the name (30 px tall, max 140 px wide) |
| `PHONE_FARM_FOOTER_TEXT` | — | Replaces the footer text. Plain text; HTML is escaped |
| `PHONE_FARM_BRAND_URL` | `https://agniverse.co` | Footer link target (with the stock footer, the "Agniverse" link; with a custom footer, the whole text is linked) |

## Example: Envy LLC

```sh
# .env
PHONE_FARM_BRAND_NAME=Envy Farm
PHONE_FARM_BRAND_TITLE=Envy
PHONE_FARM_BRAND_BY=by Envy LLC
PHONE_FARM_BRAND_BY_URL=https://envy.example
PHONE_FARM_BRAND_LOGO=static/brand/envy-logo.png
PHONE_FARM_FOOTER_TEXT=© 2026 Envy LLC · Powered by Phone Farm iOS Core
PHONE_FARM_BRAND_URL=https://envy.example
```

Brand artwork lives in `static/brand/` and is committed with the repository —
Envy's wordmark ships as `static/brand/envy-logo.png` (408 × 120, transparent
background; the source-resolution cut-out is `envy-logo-full.png`). The path may
also be absolute. Restart the `web` process; the logo is read once at startup
and served at `/assets/brand-logo?v=<content-hash>` with immutable caching,
like the other assets.

A dark top bar is the default theme, so a light-on-transparent logo (white or
pale mark, transparent background) reads best. Anything that renders cleanly at
30 px tall works; SVG scales best.

## What is and is not affected

- **Affected:** the four dashboard pages (`/`, `/devices/:udid`, `/tasks`,
  `/devices/register`), the fallback un-themed pages (`/docs`, error pages),
  the page titles, the footer.
- **Not affected:** the TikTok plugin id `com.git-agni.tiktok` (it is a
  persisted contract key — see `PLUGIN_DEVELOPMENT.md`), the npm package name
  `@git-agni/phone-farm-core`, and the `NOTICE` file. The Apache-2.0 licence
  requires `NOTICE` to travel with the code; rebranding the UI does not touch
  it.

## Verifying

```sh
npm test -- test/branding.test.ts      # unit + rendered-page assertions
curl -s http://127.0.0.1:3000/ | grep -o 'class="brand-name"[^<]*<'
curl -sI http://127.0.0.1:3000/assets/brand-logo | head -1        # 200 when a logo is configured
```

A misconfigured logo (missing file, unsupported extension) is not fatal: the
`web` process logs one `PHONE_FARM_BRAND_LOGO: …` warning at startup and renders
without it.
