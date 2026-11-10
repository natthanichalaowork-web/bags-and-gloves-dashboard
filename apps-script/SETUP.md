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

## Changing a status now updates every sheet (version 2026-11-05)
- Saving a status writes **both** the Tasks tab and the Designer Automation sheet whenever the task exists in both: matched by Designer ID, or — for a task without one — by an exact match of its name with a designer "Content" (only if that match is unique; the Audit log says "matched by name").
- The dashboard now reads the designer sheet through the script (`?action=designer`) instead of Google's cached CSV export, so a status you just saved is already there on the next refresh. The CSV is only a fallback.
- A status you just saved stays on screen for up to 10 minutes or until the sheets show it, so a slow copy of a sheet can never flip it back.
- **The health link belongs to the script, not the dashboard**: open `https://script.google.com/macros/s/…/exec?action=health` (your web app URL ending in `/exec`), not the github.io address. Add `?action=designer` to the same URL to see the live designer rows.
- After pasting the new `Code.gs`: **Deploy → Manage deployments → ✏️ → New version → Deploy**.

## Edits typed in a sheet reach the other sheet immediately (version 2026-11-05b)
Before: a status you typed in the **Tasks** sheet for a task that is also in the Designer sheet was undone by the next sync (the designer sheet wins), and a status changed in the **Designer** sheet reached the Tasks sheet only every 15 minutes.
Now, after pasting the new `Code.gs`:
1. Run **`installEditSync`** once and approve the permissions (it adds two edit triggers: one on the Tasks sheet, one on the Designer sheet).
2. Deploy a new version (**Deploy → Manage deployments → ✏️ → New version → Deploy**).
3. Run **`selfTest`** — the new line "Edit sync installed" should show ✔; `?action=health` on the script URL now says version `2026-11-05b`.

What happens: typing a status (To do / In progress / Review / Done) in the Tasks sheet writes the matching designer status (Briefed / In Design / Draft Submitted / Approved) at once, matched by Designer ID or, if there is none, by a unique exact name; changing the Status in the Designer sheet updates the linked Tasks row at once. Cancelled designer tasks are never touched, unknown text is ignored, and every copy is recorded in the Audit log (device "sheet edit").
Limits: Google only fires these triggers for edits typed by a person, not for changes another script makes (e.g. the Google Chat bot) — the 15-minute sync still catches those, and the dashboard shows the designer sheet's status straight away. `removeEditSync` switches it off.

## More stages: Blocked, Postponed, Cancelled (version 2026-11-06)
Real work does not only go To do → Done. Click a task and, under **"Something changed? Mark it as"**, choose:
- **Blocked** — waiting on someone or something (reason required). Kept on the **Tasks** sheet only; the designer sheet has no such status, and the 15-minute sync leaves "Blocked" alone until the designer sheet says Approved/Published.
- **Postponed** — moved to a new date (reason + new date required). The Tasks row gets the new due date. For a designer task the designer sheet's own **deadline-change** columns are filled (`Status = Deadline Change Requested`, `Requested_Design_Due`, `Deadline_Request_Reason`, `Deadline_Request_Status = Pending`, `By = Dashboard`, `At`), so your designer can approve or reject it in their usual flow.
- **Cancelled** — dropped (reason required). Written to the Tasks row and to the designer sheet (`Cancelled`). A cancelled designer task cannot be moved back from the dashboard — change it in the designer sheet.
The reason is kept in a new Tasks column **Status note** (added by `setup` or the next sync) and shown on the card and in the panel. Blocked/Postponed/Cancelled show in a **"Blocked · Postponed · Cancelled"** section under the Task board (cancelled tasks do not count as open, overdue or in progress percentages).
Typing the same words in the Tasks sheet works too (`Blocked`, `On hold`, `Postponed`, `Cancelled`): Cancelled is copied to the designer sheet; Blocked and Postponed stay in the Tasks sheet (Postponed needs a date, so use the dashboard for designer tasks). A designer task whose status becomes `Deadline Change Requested` shows as **Postponed**.
To update: paste the new `Code.gs`, run `setup`, then **Deploy → Manage deployments → ✏️ → New version → Deploy**.

## Every stage + email notifications (version 2026-11-07)
**Stages** (click a task): *To do · In progress · Review · Done*, then **Along the way**: *Needs rework · Waiting approval · Ready*, and **Paused or closed**: *Blocked · Waiting for info · On hold · Postponed · Cancelled*. A short reason is required for Needs rework, Blocked, Waiting for info, On hold, Postponed (also a new date) and Cancelled; it is optional for Waiting approval and Ready. Reasons are kept in the **Status note** column and shown on the card.
Designer sheet mapping: To do ↔ Briefed · In progress ↔ In Design · Review ↔ Draft Submitted · **Needs rework ↔ Revision** · Done ↔ Approved/Published · **Postponed ↔ Deadline Change Requested** · **Cancelled ↔ Cancelled**. *Waiting approval, Ready, Blocked, Waiting for info, On hold* exist only on the Tasks sheet; the 15-minute sync leaves them alone until the designer sheet says Approved/Published/Cancelled.

**Emails.** When a task moves to one of these statuses the script emails the people who need to know (the assignee is **To**; the manager and `ALWAYS_CC` are **CC**; *Waiting approval* goes **To the manager**, CC the assignee):
Needs rework · Waiting approval · Ready · Done · Blocked · Waiting for info · On hold · Postponed · Cancelled.
Routine moves (To do / In progress / Review) are not emailed. Change the list in `CONFIG.NOTIFY_STATUSES`, or switch everything off with `NOTIFY_ON_STATUS: false`. The panel has an **"Email the team about this change"** tick box (remembered per device) and says who was emailed. Statuses typed directly in the Tasks sheet (up to 3 rows at a time, never on a big paste) are emailed too. Duplicate emails for the same task and status within 2 minutes are skipped, and a full daily email quota never blocks the status change.
The assignee name in the Tasks row must match a person in `CONFIG.PEOPLE` (e.g. `Prateap`, `Natthanicha`, `Content Creator`); otherwise the email goes to the manager.
Also fixed: "You can't set the number format of cells in a typed column" — typed (dropdown/table) columns are now written without a number format.
To update: paste the new `Code.gs`, run `setup` then `selfTest` (new line "Status emails"), then **Deploy → Manage deployments → ✏️ → New version → Deploy**.

## Saves are checked, and every sheet is updated (version 2026-11-10)
After you change a status on the dashboard the script now:
1. writes it to the **Tasks** row and, when the task exists there, to the **Designer** sheet (as before), and also to the private **Requests** log for tasks that came from the request form (new columns *Status* and *Status updated*, added automatically);
2. **reads the cells back** and tells the dashboard exactly what the sheets now hold — the panel shows "Saved in: Tasks sheet, row 12 · Designer sheet, row 41 · Requests log, row 5". If a sheet still shows the old value the panel says so, and the `Sync log` tab gets a line "WRITE NOT VISIBLE …";
3. the dashboard looks again 25 seconds later; if a bot or another script has put the old status back it warns you ("the sheets changed back").
Also: a task is now found by name even when the project name sent by the dashboard differs (for example the Thai translation), and `setup` widens the Tasks **Status dropdown** to every status the dashboard uses (if your table refuses a rule it tells you in the log; then add the values to the dropdown by hand: To do, In progress, Review, Needs rework, Waiting approval, Ready, Done, Blocked, Waiting for info, On hold, Postponed, Cancelled).
To update: paste the new `Code.gs`, run `setup` (look at the log line about the dropdown), then **Deploy → Manage deployments → ✏️ → New version → Deploy**.
