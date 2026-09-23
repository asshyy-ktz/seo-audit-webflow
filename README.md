# seo-audit-webflow

A Webflow App that audits a site's static pages and CMS content for SEO issues,
scores them, and surfaces fixes inside the Designer. Node 20 + TypeScript +
Express + better-sqlite3 backend, Webflow Data API v2, OAuth2 install flow, and a
Designer Extension App Panel (plain JS, no chart library).

## What it does
- **Full audit** (`POST /api/sites/:siteId/runs`, the panel's "Run audit" button, or the optional in-process cron `AUDIT_INTERVAL_HOURS`): pulls every static page (+ its DOM) and every CMS item across all collections with pagination, runs the rule pipeline, stores findings and a scored run.
- **Incremental audits**: `page_created` and `collection_item_changed` webhooks re-check just that page/item and update its findings without re-crawling.
- **Fix-assist**: each finding carries a suggested value. CMS findings get "Apply suggested fix" (PATCH the item, optionally `/live`). Static-page findings (which the Data API cannot write) get manual steps plus a Designer jump ("Go to page" / "Select element").
- **Ignore rules**: ignore one finding, one item/page (all rules), or a rule everywhere. Ignored findings are excluded from scoring and can be restored from the Ignored tab.
- **Trend**: every run stores its score; the panel draws a Canvas sparkline with hover.
- **Uninstall**: `app_uninstall` webhook revokes the token and purges runs, findings, ignore rules.

## Rule catalog
| Rule id | Severity | Checks |
|---|---|---|
| `page.title.missing` | critical | No SEO title |
| `page.title.duplicate` | warning | Same title on several pages |
| `page.title.length` | warning | Title not 50-60 chars |
| `page.desc.missing` | warning | No meta description |
| `page.desc.duplicate` | warning | Same description on several pages |
| `page.desc.length` | info | Description not 120-160 chars |
| `page.og.image.missing` | warning | No Open Graph image |
| `page.content.duplicate-meta` | warning | Identical title + description on multiple pages |
| `page.h1.missing` | critical | No H1 in page DOM |
| `page.h1.multiple` | warning | More than one H1 (each extra is flagged) |
| `page.heading.skip` | info | Heading level jump (e.g. H2 -> H4) |
| `cms.seo.title-empty` | warning | SEO/meta title field empty |
| `cms.seo.description-empty` | warning | SEO/meta description field empty |
| `cms.slug.special-chars` | warning | Uppercase / special characters in slug |
| `cms.slug.stopwords` | info | Stopwords in slug |
| `cms.slug.too-long` | warning | Slug over 60 chars |
| `cms.image.alt-missing` | warning | Image / multi-image field without alt text |
| `cms.content.thin` | warning | Combined rich-text words below threshold (default 300, configurable in Settings) |
| `cms.slug.duplicate-pattern` | info | Slugs like `post-2` colliding with `post` |
| `site.robots.blocks-all` | critical | robots.txt disallows `/` for `*` |
| `site.robots.no-sitemap` | warning | No sitemap declared / robots.txt unreadable |
| `site.not-published` | warning | Site never published |
| `site.redirect.chain` | warning | 301 redirect with 2+ hops |
| `site.redirect.loop` | critical | 301 redirects that loop |
| `site.links.broken` | warning | Internal link matching no page, CMS item or redirect |

SEO title/description fields on CMS items are detected by slug (`seo-title`, `meta-title`, `meta-description`, ...).
Severities live in `shared/rule-catalog.ts`.

## Scoring formula
- Severity weights: critical 10, warning 4, info 1.
- Per subject (page, CMS item, or the site itself): `score = max(0, 100 - sum(weights of its open, non-ignored findings))`.
- Site score = mean of all subject scores; subjects without findings score 100. Denominator = audited pages + CMS items + 1 (site).
- Ignoring, resolving, applying a fix, or restoring re-scores the latest run immediately. Each run's score is kept for the trend chart.

## Data API endpoints used
- `GET /v2/sites/{siteId}` and `GET /v2/sites`
- `GET /v2/sites/{siteId}/pages` (paginated) and `GET /v2/pages/{pageId}/dom` (paginated)
- `GET /v2/sites/{siteId}/collections`, `GET /v2/collections/{id}`
- `GET /v2/collections/{id}/items` (paginated), `GET /v2/collections/{id}/items/{itemId}`
- `PATCH /v2/collections/{id}/items/{itemId}` and `.../live`
- `GET /v2/sites/{siteId}/redirects`, `GET /v2/sites/{siteId}/robots_txt`
- `POST /v2/sites/{siteId}/webhooks` (`page_created`, `collection_item_changed`, `app_uninstall`)
- OAuth: `POST /oauth/access_token`, `POST /oauth/revoke_authorization`

The client (`server/services/webflow-client.ts`) uses a per-site token bucket (60/min) and retries 429s with backoff.
Scopes: `sites:read`, `pages:read`, `cms:read`, `cms:write`.

## Limitations / notes
- The Data API does not expose page-level Open Graph images or write page SEO fields, so page findings are manual (with jump-to-fix).
- Incremental audits leave cross-item rules (`cms.slug.duplicate-pattern`, `site.links.broken`) at their last full-run state; run a full audit to refresh them.
- Changing a slug changes the live URL; add a 301 redirect after applying slug fixes.
- Webhook signatures are not verified in this version, and panel requests are not authenticated (same as sibling repos).
- Broken-link detection covers absolute-path (`/x`) and own-domain links; CMS URLs are inferred from collection slug / template page slug.

## Local dev
```bash
cp .env.example .env       # fill in WEBFLOW_CLIENT_ID / SECRET
npm install
npm run dev                # http://localhost:3000, migrates db/schema.sql at startup
```
Expose the server (e.g. ngrok) and set `APP_PUBLIC_URL` and the OAuth redirect URI, install via `/oauth/authorize`, then load `designer-extension/` as the App Panel (bundle URL `/designer-extension/index.html`).
