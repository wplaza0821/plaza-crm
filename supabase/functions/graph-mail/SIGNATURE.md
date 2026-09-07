# Outbound email signature

Mail sent from the CRM goes out through Microsoft Graph, which bypasses the
signature Outlook applies on the client. `graph-mail` appends one itself, to
both **send** and **reply**.

The signature lives in the `GRAPH_SIGNATURE_HTML` secret, not in the source, so
it can be corrected without a deploy and kept in step with the Outlook original.
If the secret is unset, a short fallback block is used — that fallback is NOT
the formal signature.

## Updating it

1. Get the exact HTML Outlook uses (see below) and save it as `signature.html`.
2. Set the secret — quoting matters, the HTML contains spaces and quotes:

   ```bash
   supabase secrets set --project-ref zhxwkntrndaeqtkmbtsh \
     GRAPH_SIGNATURE_HTML="$(cat signature.html)"
   ```

3. Redeploy so the function picks it up:

   ```bash
   supabase functions deploy graph-mail --project-ref zhxwkntrndaeqtkmbtsh
   ```

4. Send yourself a test from a deal's **Compose follow-up** tab and compare it
   against a message sent from Outlook.
5. Delete `signature.html` — it is gitignored, but there is no reason to keep it.

## Getting the HTML out of Outlook

**Outlook on the web** (most reliable, since Mac Outlook stores signatures
server-side now):

1. https://outlook.office.com → Settings (gear) → Mail → Compose and reply
2. Select the signature text, copy it
3. Paste into a rich-text-capable editor and save as HTML — or simply send
   yourself an email containing only the signature, then in Outlook use
   **File → Save As → HTML**, and take the body of that file

**From a message already sent**: open one of your Outlook-sent emails in the
CRM's Email thread tab, view page source, and copy the signature markup from
the message body. This is the most faithful source, since it is exactly what
your clients received.

## Images

An image in an HTML signature must be an absolute URL — a local file path
renders as a broken image for the recipient. The firm's email logos are already
published with the platform site and can be referenced directly:

    https://plazacore.plazaandassociates.com/email-logo.png
    https://plazacore.plazaandassociates.com/email-logo-white.png

Keep the `<img>` sized explicitly (`width`/`height` attributes, not just CSS) —
several mail clients ignore CSS sizing and will render the image at full size.

## Constraints worth knowing

- Inline styles only. `<style>` blocks are stripped by Outlook and Gmail.
- Tables lay out more reliably than flexbox or grid in mail clients.
- Keep it under ~50 KB of HTML or Gmail will clip the message.
