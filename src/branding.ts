/**
 * White-label branding for the dashboard.
 *
 * Everything a deployment shows about *who runs it* — the product name in the
 * top bar, the "by …" credit, an optional logo, the browser-tab suffix and the
 * footer — comes from the environment, so a licensee can rebrand without
 * forking. Unset variables reproduce the stock "iOS Farm / by Handler" look.
 *
 * | Variable                  | Default                       | Shown as |
 * | ------------------------- | ----------------------------- | -------- |
 * | PHONE_FARM_BRAND_NAME     | `iOS Farm`                    | product name in the top bar (links to `/`) |
 * | PHONE_FARM_BRAND_TITLE    | `Handler`                     | suffix of every page `<title>` |
 * | PHONE_FARM_BRAND_BY       | `by Handler`                  | small credit under the name; empty string hides it |
 * | PHONE_FARM_BRAND_BY_URL   | `https://gethandler.ai`       | where the credit links; empty string = plain text |
 * | PHONE_FARM_BRAND_LOGO     | —                             | path to a PNG/SVG/JPEG/WebP shown left of the name, served at `/assets/brand-logo` |
 * | PHONE_FARM_FOOTER_TEXT    | —                             | replaces the footer text (escaped; no HTML) |
 * | PHONE_FARM_BRAND_URL      | `https://agniverse.co`        | footer link target |
 */
import path from 'node:path';

export interface Branding {
    name: string;
    title: string;
    by: string;
    byUrl: string;
    url: string;
    footerText: string | null;
    logoPath: string | null;
}

export const DEFAULT_BRANDING: Branding = {
    name: 'iOS Farm',
    title: 'Handler',
    by: 'by Handler',
    byUrl: 'https://gethandler.ai',
    url: 'https://agniverse.co',
    footerText: null,
    logoPath: null,
};

const LOGO_TYPES: Record<string, string> = {
    '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

export function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

function pick(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
    const value = env[key];
    return value === undefined ? fallback : value.trim();
}

export function brandingFromEnv(env: NodeJS.ProcessEnv = process.env): Branding {
    const logo = env.PHONE_FARM_BRAND_LOGO?.trim();
    const footer = env.PHONE_FARM_FOOTER_TEXT?.trim();
    return {
        name: pick(env, 'PHONE_FARM_BRAND_NAME', DEFAULT_BRANDING.name) || DEFAULT_BRANDING.name,
        title: pick(env, 'PHONE_FARM_BRAND_TITLE', DEFAULT_BRANDING.title) || DEFAULT_BRANDING.title,
        by: pick(env, 'PHONE_FARM_BRAND_BY', DEFAULT_BRANDING.by),
        byUrl: pick(env, 'PHONE_FARM_BRAND_BY_URL', DEFAULT_BRANDING.byUrl),
        url: pick(env, 'PHONE_FARM_BRAND_URL', DEFAULT_BRANDING.url),
        footerText: footer ? footer : null,
        logoPath: logo ? path.resolve(logo) : null,
    };
}

/** MIME type for a configured logo path, or null when the extension is not an image we serve. */
export function logoContentType(logoPath: string): string | null {
    return LOGO_TYPES[path.extname(logoPath).toLowerCase()] ?? null;
}

/** The `<div class="brand">` block in the dashboard top bar. `logoSrc` is the (versioned) URL of the served logo, if any. */
export function brandHtml(branding: Branding, logoSrc: string | null = null): string {
    const logo = logoSrc
        ? `<img class="brand-logo" src="${escapeHtml(logoSrc)}" alt="${escapeHtml(branding.name)} logo">`
        : '';
    const by = branding.by
        ? (branding.byUrl
            ? `<a class="brand-by" href="${escapeHtml(branding.byUrl)}" target="_blank" rel="noopener">${escapeHtml(branding.by)}</a>`
            : `<span class="brand-by">${escapeHtml(branding.by)}</span>`)
        : '';
    return `<div class="brand">${logo}<div class="brand-text"><a class="brand-name" href="/">${escapeHtml(branding.name)}</a>${by}</div></div>`;
}

/** Footer text. Stock: the Agniverse credit. With PHONE_FARM_FOOTER_TEXT: that text, linked to PHONE_FARM_BRAND_URL when set. */
export function footerHtml(branding: Branding): string {
    if (branding.footerText === null) {
        return `Built by <a href="${escapeHtml(branding.url || DEFAULT_BRANDING.url)}" target="_blank" rel="noopener">Agniverse</a>, with love and curry &#10084;&#65039;`;
    }
    const text = escapeHtml(branding.footerText);
    return branding.url
        ? `<a href="${escapeHtml(branding.url)}" target="_blank" rel="noopener">${text}</a>`
        : text;
}
