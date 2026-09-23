import { Router } from "express";
import { db } from "../db";
import { webflowClient } from "../services/webflow-client";

const router = Router();

const CLIENT_ID = process.env.WEBFLOW_CLIENT_ID || "";
const CLIENT_SECRET = process.env.WEBFLOW_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.WEBFLOW_REDIRECT_URI || "http://localhost:3000/oauth/callback";
const SCOPES = process.env.WEBFLOW_SCOPES || "sites:read,pages:read,cms:read,cms:write";
const APP_BASE_URL = process.env.APP_PUBLIC_URL || "http://localhost:3000";

router.get("/authorize", (_req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  res.redirect(`https://webflow.com/oauth/authorize?${params.toString()}`);
});

router.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    const tokenRes = await fetch("https://api.webflow.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      res.status(502).send(`Token exchange failed: ${await tokenRes.text()}`);
      return;
    }

    const tokenJson = (await tokenRes.json()) as { access_token: string; scope?: string };

    const sitesRes = await fetch("https://api.webflow.com/v2/sites", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const sitesJson = (await sitesRes.json()) as { sites: Array<{ id: string }> };
    const siteId = sitesJson.sites?.[0]?.id;

    if (!siteId) {
      res.status(502).send("No site returned for this installation");
      return;
    }

    db.prepare(
      `INSERT INTO installations (site_id, access_token, scopes, installed_at, uninstalled_at)
       VALUES (?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(site_id) DO UPDATE SET access_token = excluded.access_token, scopes = excluded.scopes, uninstalled_at = NULL`
    ).run(siteId, tokenJson.access_token, tokenJson.scope || SCOPES);

    const hooks: Array<[string, string]> = [
      ["page_created", "/webhooks/page-created"],
      ["collection_item_changed", "/webhooks/collection-item-changed"],
      ["app_uninstall", "/webhooks/app-uninstalled"],
    ];
    for (const [trigger, path] of hooks) {
      try {
        await webflowClient.registerWebhook(siteId, trigger, `${APP_BASE_URL}${path}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`Webhook ${trigger} registration failed:`, err instanceof Error ? err.message : err);
      }
    }

    res.redirect(`/designer-extension/index.html?installed=1&site=${siteId}`);
  } catch (err) {
    res.status(500).send(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

export default router;
