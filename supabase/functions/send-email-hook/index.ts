// Plaza CRM — Supabase Auth "Send Email" Hook
//
// WHY THIS EXISTS
// Supabase's built-in SMTP client can only authenticate with a static
// username + password. The Plaza M365 tenant is OAuth-only (no password is
// stored anywhere; Microsoft has basic auth for SMTP disabled), so the SMTP
// route is a dead end. Instead, Supabase Auth calls THIS function whenever it
// wants to send an auth email, and we deliver it through Microsoft Graph using
// the same refresh-token flow graph-mail already uses.
//
// Result: auth mail (password reset, invites, email changes) leaves the real
// Plaza mailbox over an authenticated Graph call — no password, no basic auth,
// no third-party mail relay, and no rate-limited Supabase shared mailer.

const TENANT_ID = "7b4a88f5-2be6-4196-a2a3-2a114390b93e";
const CLIENT_ID = "fe9862cc-2672-4bc8-b64e-68d0f902061c";
const GRAPH = "https://graph.microsoft.com/v1.0";

// Address the mail is sent AS. Must be the mailbox itself or an alias M365
// accepts for it, otherwise Graph returns ErrorSendAsDenied.
const SEND_AS = Deno.env.get("AUTH_MAIL_FROM") || "william@plazaandassociates.com";
const SEND_AS_NAME = Deno.env.get("AUTH_MAIL_FROM_NAME") || "Plaza & Associates";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Exchange the stored refresh token for a short-lived Graph access token. */
async function graphToken(): Promise<string> {
  const rt = Deno.env.get("MS_REFRESH_TOKEN");
  if (!rt) throw new Error("MS_REFRESH_TOKEN secret not set");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: rt,
    scope:
      "offline_access openid profile https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
  });
  const r = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body },
  );
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

/**
 * Verify the Standard Webhooks signature Supabase Auth sends.
 * Signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`.
 * Secret arrives as `v1,whsec_<base64>`; only the base64 part is the key.
 */
async function verifySignature(
  raw: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;

  // Reject stale deliveries (replay protection), 5 minute window.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const b64key = secret.replace(/^v1,\s*/, "").replace(/^whsec_/, "");
  const keyBytes = Uint8Array.from(atob(b64key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${raw}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Header may carry several space-separated `v1,<sig>` values.
  for (const part of sigHeader.split(" ")) {
    const got = part.replace(/^v1,/, "").trim();
    if (got.length === expected.length) {
      let diff = 0;
      for (let i = 0; i < got.length; i++) {
        diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      if (diff === 0) return true;
    }
  }
  return false;
}

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Subject + HTML body per auth action type. */
function compose(actionType: string, link: string, otp: string) {
  // ---- Plazacore design tokens (must stay identical to site/index.html :root) ----
  const BLACK = "#020000";
  const INK = "#333333";
  const GRAY_200 = "#E5E5E5";
  const GRAY_400 = "#888888";
  const GRAY_500 = "#666666";
  const GRAY_50 = "#FAFAFA";
  const ACCENT = "#1f6581";
  const RADIUS = "4px";
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  // High-res mark (906x502 source, rendered at 150px = ~6x density on retina).
  // Raster PNG, not inline SVG: Outlook and Gmail do not render inline SVG.
  const LOGO = "https://crm.plazaandassociates.com/assets/plaza-logo@3x.png";

  const header = `
    <tr><td style="padding:34px 40px 0 40px">
      <img src="${LOGO}" width="150" alt="PLAZA &amp; ASSOCIATES"
           style="width:150px;max-width:150px;height:auto;display:block;border:0;outline:none">
    </td></tr>`;

  const brand = `
    <tr><td style="padding:0 40px 34px 40px">
      <div style="border-top:1px solid ${GRAY_200};padding-top:18px;
                  font:12px/1.6 ${FONT};color:${GRAY_500}">
        <b style="color:${BLACK};letter-spacing:.4px">PLAZA &amp; ASSOCIATES</b><br>
        2222 Ponce de Leon Boulevard, Coral Gables, Florida 33134<br>
        O: (786) 310-5428 ext. 1<br>
        <a href="https://www.plazaandassociates.com"
           style="color:${ACCENT};text-decoration:none">www.plazaandassociates.com</a>
      </div>
    </td></tr>`;

  // Bulletproof button: table-based so Outlook renders the full background.
  const button = (label: string) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           style="margin:26px 0 22px 0">
      <tr><td align="center" bgcolor="${BLACK}" style="border-radius:${RADIUS}">
        <a href="${esc(link)}"
           style="display:inline-block;padding:14px 30px;font:600 15px ${FONT};
                  color:#FFFFFF;text-decoration:none;border-radius:${RADIUS}">${label}</a>
      </td></tr>
    </table>
    <p style="font:12.5px/1.6 ${FONT};color:${GRAY_500};margin:0 0 4px">
      If the button doesn't work, paste this address into your browser:</p>
    <p style="font:12px/1.6 ${FONT};color:${ACCENT};word-break:break-all;margin:0">
      ${esc(link)}</p>`;

  const codeBlock = otp
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
              style="margin:22px 0">
         <tr><td style="background:${GRAY_50};border:1px solid ${GRAY_200};
                        border-radius:${RADIUS};padding:14px 18px">
           <span style="font:12px ${FONT};color:${GRAY_400};text-transform:uppercase;
                        letter-spacing:1.4px">Verification code</span><br>
           <b style="font:600 22px ${FONT};letter-spacing:5px;color:${BLACK}">${esc(otp)}</b>
         </td></tr>
       </table>`
    : "";

  const shell = (heading: string, intro: string, label: string) => `
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#F4F4F4">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background:#F4F4F4;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
             style="max-width:600px;width:100%;background:#FFFFFF;
                    border:1px solid ${GRAY_200};border-radius:${RADIUS}">
        ${header}
        <tr><td style="padding:26px 40px 0 40px">
          <div style="font:11px ${FONT};color:${GRAY_400};text-transform:uppercase;
                      letter-spacing:2.5px;margin-bottom:14px">Deal CRM</div>
          <h1 style="font:600 22px/1.3 ${FONT};color:${BLACK};margin:0 0 12px">
            ${heading}</h1>
          <p style="font:15px/1.65 ${FONT};color:${INK};margin:0">${intro}</p>
          ${button(label)}
          ${codeBlock}
          <p style="font:12.5px/1.6 ${FONT};color:${GRAY_400};margin:22px 0 30px">
            This link expires in 60 minutes and can only be used once.
            If you didn't request it, you can safely ignore this message.</p>
        </td></tr>
        ${brand}
      </table>
    </td></tr>
  </table>
</body></html>`;

  switch (actionType) {
    case "recovery":
      return {
        subject: "Reset your Plaza CRM password",
        html: shell(
          "Reset your password",
          "We received a request to reset the password for your Plaza CRM account.",
          "Set a new password",
        ),
      };
    case "invite":
      return {
        subject: "You've been invited to Plaza CRM",
        html: shell(
          "You're invited",
          "An administrator has invited you to access the Plaza &amp; Associates CRM.",
          "Accept invitation",
        ),
      };
    case "signup":
    case "email_change":
    case "email_change_current":
    case "email_change_new":
      return {
        subject: "Confirm your email address — Plaza CRM",
        html: shell(
          "Confirm your email address",
          "Please confirm this email address for your Plaza CRM account.",
          "Confirm email",
        ),
      };
    case "magiclink":
      return {
        subject: "Your Plaza CRM sign-in link",
        html: shell(
          "Sign in to Plaza CRM",
          "Use the link below to sign in to your account.",
          "Sign in",
        ),
      };
    default:
      return {
        subject: "Plaza CRM account notification",
        html: shell(
          "Account notification",
          "Use the link below to continue.",
          "Continue",
        ),
      };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const raw = await req.text();

  // Auth hooks are called by Supabase, not the browser: the only trust anchor
  // is the shared webhook secret. Refuse anything unsigned.
  const secret = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
  if (!secret) return json({ error: { message: "hook secret not configured" } }, 500);
  if (!(await verifySignature(raw, req.headers, secret))) {
    return json({ error: { message: "invalid webhook signature" } }, 401);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: { message: "invalid JSON" } }, 400);
  }

  const to = body?.user?.email;
  const ed = body?.email_data ?? {};
  const actionType = String(ed.email_action_type ?? "");
  if (!to) return json({ error: { message: "no recipient in payload" } }, 400);

  // Supabase gives us the hashed token; we build the verify URL ourselves so the
  // user lands on the CRM with a real session in the URL fragment.
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const redirect = ed.redirect_to || "https://crm.plazaandassociates.com/";
  const link =
    `${base}/auth/v1/verify?token=${encodeURIComponent(ed.token_hash ?? "")}` +
    `&type=${encodeURIComponent(actionType)}` +
    `&redirect_to=${encodeURIComponent(redirect)}`;

  const { subject, html } = compose(actionType, link, String(ed.token ?? ""));

  try {
    const tok = await graphToken();
    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(SEND_AS)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          from: { emailAddress: { address: SEND_AS, name: SEND_AS_NAME } },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error("graph sendMail failed", r.status, detail);
      // Non-2xx tells Supabase Auth the send failed, so it surfaces an error
      // instead of silently pretending the mail went out.
      return json({ error: { message: `graph ${r.status}: ${detail.slice(0, 300)}` } }, 502);
    }
  } catch (e) {
    console.error("hook error", e);
    return json({ error: { message: String(e).slice(0, 300) } }, 500);
  }

  // Empty object = "handled, don't also send your own copy".
  return json({});
});
