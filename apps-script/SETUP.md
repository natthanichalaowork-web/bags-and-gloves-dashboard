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
   - Everyone in `PEOPLE` is also BCC'd (`BCC_WHOLE_TEAM: true`); set it to `false` to copy only the manager and marketing@
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

## Designer Automation ⇄ Tasks sync (added later)
`syncFromDesigner` keeps the Tasks tab in step with the Designer Automation sheet (Communication Calendar tab):
- **Adds** every designer task published on/after 20 Sep 2026 that is not cancelled and not in Tasks yet (project, assignee, due = Design_Due, priority, publish date, Designer ID). Notes start with `Designer sheet ·`.
- **Updates** those rows when the designer sheet changes: status, due date, assignee, title, publish date.
- **Rows you linked by hand** (you typed a Designer ID on a row such as "Marketing: finalise internal newsletter") only get their **Status** updated — your wording is kept.
- A linked task cancelled in the designer sheet gets `CANCELLED ·` in Notes and disappears from the dashboard. Cancelled tasks are never added.
- The dashboard no longer shows a designer task twice: a task already in the Tasks tab (same Designer ID) replaces the direct designer feed copy.

Setup (once):
1. Paste the new `Code.gs` over the old one (keep your email addresses) and run **`setup`** — it adds **Designer ID** and **Publish date** columns to the Tasks tab.
2. Run **`syncFromDesigner`** and approve the permission to read the designer sheet. The first run adds the whole backlog (about 140 rows) in one go.
3. Run **`installDesignerSync`** once so it repeats every 15 minutes.
4. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**, so the web app also exposes the two new columns to the dashboard.

Status mapping: Briefed → To do · In Design → In progress · Draft Submitted / Revision / Deadline Change Requested → Review ·
Approved / Scheduled / Published → Done. The sync overwrites those fields on rows it manages, so change designer tasks in the designer sheet, not in Tasks.

## Live calendar (added later)
The dashboard Calendar tab reads natthanicha@bagglove.com through the same web app (`?action=calendar`), refreshed every 5 minutes.
1. Paste the new `Code.gs` over the old one (keep your email addresses). Calendar permission was already granted by `setup`; if Google asks again, approve it.
2. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** (the web app URL stays the same).
3. Open `https://script.google.com/macros/s/…/exec?action=calendar` once — you should see `{"ok":true,"events":[…]}`.

What is shared: only events whose **title** matches a rule in `CAL_RULES` (e.g. `[LINE]…`, `POST…`, `PREP…`, `[ADS]…`, `Marketing…` meetings) — title, date, time, category and the first names of invited team members. Descriptions, locations, guest emails and every other event stay private. To show a new kind of event, add a title pattern to `CAL_RULES`; to use another calendar, change `CALENDAR_ID`.
Until the new version is deployed the dashboard keeps showing its saved copy of the calendar.

## Change a task's status from the dashboard (added later)
Click any task on the dashboard → a panel opens with **To do / In progress / Review / Done** buttons. The status changes on screen immediately and is saved to the sheet.
1. Paste the new `Code.gs` over the old one (keep your email addresses) and redeploy: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
2. **Project settings (gear) → Script properties → Add script property**: name `EDIT_PASSCODE`, value = a passcode for the team (letters and numbers, not your Google password). Without it editing stays switched off.
3. Give the passcode to the team. The dashboard asks once per device and remembers it (the panel has a "Forget passcode" link).

How it saves: tasks that come from the Designer Automation sheet (they have a Designer ID) are written to the **designer sheet** (To do → Briefed, In progress → In Design, Review → Draft Submitted, Done → Approved) and to the Tasks row; all other tasks are written to their Tasks row (found by Request ID, else by exact name). After 10 wrong passcodes the endpoint locks for 10 minutes.
To change the passcode, edit the script property; devices with the old one are asked again.

## Safety features (script version 2026-11-03)
After pasting the new `Code.gs`: run **`setup`**, then **`selfTest`** (View → Logs / Execution log). It prints a ✔/✘ checklist: Tasks columns, `EDIT_PASSCODE`, designer sheet access, sync trigger, calendar access, email quota, email addresses. Fix every ✘, then redeploy (**Deploy → Manage deployments → ✏️ → New version**).
`…/exec?action=health` shows the same checklist as ✔/✘ only (no details) and the deployed version — handy to confirm the redeploy worked.

What protects your data:
- **Backups**: before the sync writes, it copies the Tasks tab to a tab named `Backup yyyy-MM-dd` (once a day, newest 7 kept). To undo a bad sync, copy values back from the latest backup.
- **Sync log** tab: every sync run (added / updated / OK, PARTIAL or ERROR). **Audit log** tab: every status change made from the dashboard (time, device, task, from → to, where).
- **Failure email**: if the sync fails, the script owner gets one email a day with the reason.
- **Empty-sheet guard**: if the designer tab looks empty or lost its columns, the sync stops without touching Tasks.
- **No formulas**: everything the script writes (sync, requests, status) is stored as plain text, so a cell starting with `=` can never run.
- **Locking**: sync, requests and status changes never write at the same moment; if busy they wait or report "Busy, try again".
- **Time budget**: a sync run stops after 4 minutes and the next run (every 15 min) carries on.
- **Passcode lockout**: 10 wrong tries per device (60 overall) in 10 minutes, so one stranger cannot lock the team out.
- **Email quota**: a request still lands on the dashboard if the daily email quota is used up; the Requests tab shows "FAILED: quota".
- `removeDesignerSync` switches the automatic sync off; `installDesignerSync` switches it back on.
