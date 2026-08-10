# Dropbox integration — one-time setup

The `dropbox-files` edge function needs a Dropbox app + refresh token stored as
Supabase secrets. ~10 minutes, done once.

## 1. Create the Dropbox app

1. Go to https://www.dropbox.com/developers/apps → **Create app**
2. Choose **Scoped access** → **Full Dropbox** (so it can see your existing
   `/Proposals/...` folders) → name it e.g. `Plaza CRM`
3. On the app's **Permissions** tab, enable:
   - `files.metadata.read`
   - `files.content.read`
   and click **Submit**
4. On the **Settings** tab, note the **App key** and **App secret**

## 2. Get a refresh token (one browser visit + one command)

1. Open this URL in your browser (replace `APP_KEY`):

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline
   ```

2. Approve → copy the authorization code it shows
3. Run (replace all three placeholders):

   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=AUTH_CODE -d grant_type=authorization_code \
     -u APP_KEY:APP_SECRET
   ```

4. Copy the `refresh_token` from the response (it does not expire)

## 3. Configure + deploy the function

With the Supabase CLI (`npm i -g supabase`, then `supabase login`):

```bash
cd plaza-crm
supabase link --project-ref zhxwkntrndaeqtkmbtsh
supabase secrets set DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_REFRESH_TOKEN=...
supabase functions deploy dropbox-files
```

(Or paste `index.ts` into a new `dropbox-files` function in the Supabase
dashboard's Edge Functions page and add the three secrets there.)

## 4. Use it

- On any deal, set **Dropbox folder** in the Edit tab (e.g. `/Proposals/Dome`)
- The **Files** tab lists that folder; **Open** gives a temporary link
- **Scan for value** on a proposal PDF extracts its text, finds dollar amounts
  (ranked toward "total / fee / lump sum" lines), and one click sets the deal's
  value with a `value_note` recording which file it came from + an audit-log row
