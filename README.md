# Area 3 Room Booking — live (database-blocking) version

One page, two tabs:
- Book a room — the form, with live availability and real double-booking blocking.
- Dashboard — passcode-gated ops view (KPIs, week/day calendar, bookings table, view + cancel).

Both tabs share one database, so a booking made on the form appears on the dashboard, and
a cancel on the dashboard frees the slot on the form.

```
booking-live/
├─ index.html                     ← the two-tab page (FCC–Almabani branded, Area 3 pilot)
├─ netlify/functions/bookings.js  ← backend: availability + blocking + admin list/cancel
├─ schema.sql                     ← run once in the database
├─ package.json                   ← dependency (pg)
├─ netlify.toml
└─ README.md
```

Blocking is enforced by the database: a partial exclusion constraint means two CONFIRMED
bookings can't overlap the same room. Cancelling sets status='cancelled', which frees the slot.

---

## 1. Database (Neon — free, ~5 min)
1. neon.tech → sign in → create a project.
2. Open SQL Editor → paste all of `schema.sql` → Run.
3. Copy the connection string from Connection Details (starts `postgresql://…?sslmode=require`).
   That's your `DATABASE_URL`.

## 2. Deploy (GitHub → Netlify, the no-CLI flow you used before)
1. Put this folder's contents in a repo (index.html at the top, with the `netlify` folder beside it).
2. Netlify → Add new site → Import from Git → pick the repo. Publish directory: `.`
3. Set environment variables (Site configuration → Environment variables):

   | Key | Value | Required |
   |---|---|---|
   | `DATABASE_URL` | the Neon connection string | yes |
   | `DASH_PASSCODE` | the dashboard admin passcode you choose | yes |
   | `RESEND_API_KEY` | Resend API key (for confirmation emails) | optional |
   | `RESEND_FROM` | e.g. `Area 3 Booking <bookings@systemrapid.com>` | optional |
   | `ADMIN_EMAIL` | address to CC on confirmations | optional |

4. Deploy, then trigger one redeploy so the function picks up the variables.

Booking and blocking work with just `DATABASE_URL` + `DASH_PASSCODE`. Email is optional —
add the three Resend variables when you're ready (verify systemrapid.com in Resend first).

## 3. Test
- Book tab: pick a time, confirm → you get a reference. Try the same slot again → "just taken".
- Dashboard tab: enter the passcode → KPIs, calendar, table load. The passcode is checked by
  the server, not just the page, so the data can't be reached without it.
- Cancel a booking on the dashboard → it disappears from the calendar and the slot frees up on the form.

## Notes
- Times are KSA (Asia/Riyadh, UTC+03:00).
- Pilot is Area 3 only. To add rooms later: add `{id,name,hex}` entries to the `ROOMS` array
  in index.html (the database stores whatever room id you send — no backend change needed).
- The Microsoft Graph / Outlook version is parked. If Exchange ever registers the app's
  service principal, we can switch to it for native Outlook integration.
