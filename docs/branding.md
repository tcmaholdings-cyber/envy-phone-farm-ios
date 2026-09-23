# White-label branding

The dashboard's identity — product name, the small "by …" credit, an optional
logo, the browser-tab suffix and the footer — is read from the environment at
startup (`src/branding.ts`). A licensee rebrands by setting variables in
`.env`; no fork, no template edits. Unset everything and you get the stock
**iOS Farm / by Handler** look.

| Variable | Default | Where it shows |
| --- | --- | --- |
| `PHONE_FARM_BRAND_NAME` | `iOS Farm` | Product name: the logo's alt text, the fallback pages' nav, startup logs |
| `PHONE_FARM_BRAND_LABEL` | the name | Text beside the logo in the top bar (links to `/`). With a wordmark logo, set just the product ("Phone Farm") so the bar does not read "ENVY Envy Phone Farm" |
| `PHONE_FARM_BRAND_TITLE` | `Handler` | Suffix of every page `<title>` ("Devices · Envy") |
| `PHONE_FARM_BRAND_BY` | `by Handler` | Credit under the name. Set to an empty string to hide it |
| `PHONE_FARM_BRAND_BY_URL` | `https://gethandler.ai` | Where the credit links. Empty string = plain text |
| `PHONE_FARM_BRAND_LOGO` | — | Path to a `.png`, `.svg`, `.jpg` or `.webp`, shown left of the label (22 px tall, max 96 px wide) |
| `PHONE_FARM_FOOTER_TEXT` | — | Replaces the footer text. Plain text; HTML is escaped |
| `PHONE_FARM_BRAND_URL` | `https://agniverse.co` | Footer link target (with the stock footer, the "Agniverse" link; with a custom footer, the whole text is linked) |

## Example: Envy Phone Farm

The Envy deployment, matching [envyllc.ai](https://www.envyllc.ai):

```sh
# .env
PHONE_FARM_BRAND_NAME=Envy Phone Farm
PHONE_FARM_BRAND_LABEL=Phone Farm
PHONE_FARM_BRAND_TITLE=Envy Phone Farm
PHONE_FARM_BRAND_BY=
PHONE_FARM_BRAND_LOGO=static/brand/envy-logo.png
PHONE_FARM_FOOTER_TEXT=© 2026 Envy LLC · envyllc.ai
PHONE_FARM_BRAND_URL=https://www.envyllc.ai
```

The top bar then reads **ENVY | PHONE FARM** (wordmark, hairline, label), tabs
read "Devices · Envy Phone Farm", and the footer links to the Envy site. An
empty `PHONE_FARM_BRAND_BY` hides the small credit.
`.env.example` ships this block uncommented. Set all of it, including
`PHONE_FARM_FOOTER_TEXT`: without it the footer falls back to the stock
"Built by Agniverse" credit, and that link would then point at `PHONE_FARM_BRAND_URL`.

Brand artwork lives in `static/brand/` and is committed with the repository —
Envy's wordmark ships as `static/brand/envy-logo.png` (414 × 120, transparent
background; the source-resolution cut-out is `envy-logo-full.png`, 817 × 237).
The path may also be absolute. Restart the `web` process; the logo is read once
at startup and served at `/assets/brand-logo?v=<content-hash>` with immutable
caching, like the other assets.

The logo renders 22 px tall on the dark top bar, so a bright mark on a
transparent background reads best. SVG scales best. The current PNG's pink is
about `#ff69b4`; re-exporting it in the site's `#ff2d8e` would match the live
site exactly (optional).

## The visual theme

`static/dashboard/styles.css` **is the Envy theme**: graphite surfaces, one
hot-pink accent (`#ff2d8e`, with `#d6166f` for filled buttons so white text
passes AA contrast), Oswald uppercase for structure and Poppins for reading.
Every colour, radius, spacing step, font stack and duration is a custom
property in its `:root` block, and a test (`test/styles-lint.test.ts`) fails if
a raw colour appears anywhere else. Another deployment re-skins the dashboard
by editing that `:root` block alone; there is deliberately no theme switch.

Status colours are reserved for status (green ready, amber attention, red
fault, blue queued, grey offline or idle) and always pair a dot with a text
label. Pink never means a status; it marks what you can act on, what is
selected, and the live video frame.

### Fonts

Oswald (variable, 400–700) and Poppins (400, 500, 600) are self-hosted as
latin-subset WOFF2 files in `static/dashboard/fonts/`, served from a whitelist
at `/assets/fonts/:file`. Nothing is fetched from Google Fonts or any other
host, so the dashboard works offline, over an SSH tunnel and on loopback, and
an operator's IP is never sent anywhere. Both families are licensed under the
SIL Open Font License 1.1; the licence text is `static/dashboard/fonts/OFL.txt`
and the attribution is in `NOTICE`. Until the files load, metric-matched local
fallbacks (Arial Narrow, Avenir Next or Helvetica Neue) hold the layout steady.

## What is and is not affected

- **Affected:** the four dashboard pages (`/`, `/devices/:udid`, `/tasks`,
  `/devices/register`), the fallback un-themed pages (`/docs`, error pages;
  they use the product name and a dark copy of the theme tokens), the page
  titles, the footer.
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
