# Request Desk — one-time setup (about 10 minutes)

The dashboard is a static page, so it cannot send email or write to your Google Sheet by itself.
This small Google Apps Script does that. It runs under your Google account and uses the same
Tasks sheet the dashboard already reads.

1. Open the **Tasks Google Sheet** → **Extensions → Apps Script**.
2. Delete the sample code, paste in all of `Code.gs` from this folder.
3. At the top, replace every `REPLACE_WITH_…` with a real email address:
   - `MANAGER_EMAIL` — the marketing manager (always CC'd)
   - `PEOPLE.nat / prateap / creator` — the people requests can be assigned to
   - `marketing@bagglove.com` is already CC'd on every request (`ALWAYS_CC`)
4. Select the function **`setup`** → **Run**. Approve the permissions (Sheets + sending email).
   It adds the missing columns (Type, Requested by, Hours, Affects, Request ID) to the Tasks tab
   and creates a private **Requests** tab that keeps every full request.
5. Select **`testEmail`** → **Run** to confirm email works (it mails the manager only).
6. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the Web app URL.
7. In `index.html`, paste that URL into `SETTINGS.apiUrl` and commit. (Or send it to Claude to do.)

## Calendar (added later)
Each request also creates an all-day event on its deadline in the assignee's Google Calendar (they are invited as a
guest, so it shows on their calendar without a second email). To switch it on for an existing setup:
1. Paste the new `Code.gs` over the old one (keep your email addresses).
2. Run **`setup`** again and approve the new **Google Calendar** permission. It also adds a "Calendar" column to the Requests tab.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** The web app URL stays the same.
Set `ADD_TO_CALENDAR: false` to turn it off. The Content Creator role uses the shared marketing@ inbox, which may not
have a calendar; if so the event is skipped for them and the Requests tab shows the reason.

## Notes
- **Live updates:** with `apiUrl` set, the dashboard checks for changes every 15 seconds (while the tab is
  open and visible). Edits in the Tasks sheet and new requests appear without reloading.
  Without it, it falls back to the published CSV, which Google only refreshes every few minutes.
- **Emails** are sent from the Google account that deployed the script (limit ~100/day on a free
  Gmail account, ~1,500 on Google Workspace). Replies go straight to the requester.
- **Requester confirmation:** requesters get a short confirmation email. Set
  `CONFIRM_TO_REQUESTER: false` to turn it off.
- **Privacy:** the dashboard feed only returns the task columns that were already public.
  Requester email/phone and request details stay in the private **Requests** tab and the emails.
- **Anyone can submit:** the web app must be open to anyone so people outside the department can use the
  form. Protection: hidden spam trap, input validation, and 10 requests/hour per email address.
- **Changing the code later:** Deploy → *Manage deployments* → edit → *New version*. The URL stays the same.
- To change who handles which request type, or lead times, edit `REQUEST_TYPES` in `index.html`.
