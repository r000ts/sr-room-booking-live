// ============================================================
//  Netlify Function: /.netlify/functions/bookings
//
//  PUBLIC (booking form):
//    GET  ?room=<id>&date=YYYY-MM-DD        -> { bookings:[{start,end,name}] }   (confirmed only)
//    POST { room,name,email,date,start,end,attendees,purpose }
//          -> 200 { ok, ref } | 409 { error:"conflict" }
//
//  ADMIN (dashboard) — requires header  x-dash-pass: <DASH_PASSCODE> :
//    GET  ?admin=1&from=YYYY-MM-DD&to=YYYY-MM-DD -> { bookings:[ full rows ] }
//    POST { action:"cancel", ref }               -> 200 { ok }
//
//  Blocking is enforced by the database exclusion constraint (see schema.sql):
//  two confirmed bookings cannot overlap the same room. Concurrent requests are
//  serialised by Postgres, so no double-booking is possible.
// ============================================================
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const TZ = "+03:00";                 // KSA, fixed (no DST)
const DASH_PASSCODE = process.env.DASH_PASSCODE || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Area 3 Booking <bookings@systemrapid.com>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";   // optional CC for confirmations
const ORG_NAME = process.env.ORG_NAME || "FCC\u2013Almabani Joint Venture";
const SITE_URL = process.env.SITE_URL || "https://booking.systemrapid.com";
const crypto = require("crypto");

const ROOM_NAMES = { area3: "Area 3 Board Room" };   // for emails; UI has its own labels

function json(code, body) {
  return {
    statusCode: code,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-dash-pass",
    },
    body: JSON.stringify(body),
  };
}

function ksaParts(ts) {
  const d = new Date(ts);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const tp = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const hm = tp.find(p => p.type === "hour").value + ":" + tp.find(p => p.type === "minute").value;
  return { date, hm };
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Generate occurrence dates (YYYY-MM-DD) from a start date + repeat rule.
// monthly = same weekday position (e.g. 2nd Tuesday). Cap handled by caller.
function occurrenceDates(startDate, repeat, count) {
  const [y, m, d] = startDate.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (repeat === "none" || count <= 1) return [startDate];
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const out = [];
  if (repeat === "daily" || repeat === "weekly" || repeat === "biweekly") {
    const step = repeat === "daily" ? 1 : repeat === "weekly" ? 7 : 14;
    for (let i = 0; i < count; i++) {
      const dt = new Date(base); dt.setUTCDate(base.getUTCDate() + i * step); out.push(fmt(dt));
    }
    return out;
  }
  if (repeat === "monthly") {
    const weekday = base.getUTCDay();                  // 0..6
    const nth = Math.ceil(d / 7);                      // which occurrence of that weekday (1..5)
    for (let i = 0; i < count; i++) {
      const mo = new Date(Date.UTC(y, m - 1 + i, 1));
      // find the nth <weekday> of this month
      let day = 1 + ((7 + weekday - mo.getUTCDay()) % 7); // first matching weekday
      day += (nth - 1) * 7;
      const cand = new Date(Date.UTC(mo.getUTCFullYear(), mo.getUTCMonth(), day));
      if (cand.getUTCMonth() !== mo.getUTCMonth()) continue; // 5th weekday may not exist; skip month
      out.push(fmt(cand));
    }
    return out;
  }
  return [startDate];
}

async function sendSeriesEmail(b, booked, skipped, ref, token, seriesId) {
  if (!RESEND_API_KEY) return;
  const roomName = ROOM_NAMES[b.room] || b.room;
  const fmtLong = (iso) => new Date(`${iso}T00:00:00${TZ}`).toLocaleDateString("en-GB",
    { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Riyadh" });
  const list = booked.map(x => `<li style="margin:2px 0">${fmtLong(x.date)} · ${b.start}–${b.end}</li>`).join("");
  const skippedHtml = skipped.length
    ? `<p style="color:#9a5b00;font-size:13px;margin-top:10px">These dates were already taken and were not booked: ${skipped.map(fmtLong).join("; ")}.</p>` : "";
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;color:#152233;max-width:560px">
    <div style="background:#0b478d;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <strong style="font-size:16px">${ORG_NAME}</strong><br><span style="opacity:.85">Recurring booking — confirmed</span></div>
    <div style="border:1px solid #d8dee7;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
      <p>Hi ${esc(b.name)}, your recurring booking for <strong>${esc(roomName)}</strong> is confirmed for these dates:</p>
      <ul style="font-size:14px;padding-left:18px;margin:8px 0">${list}</ul>
      ${skippedHtml}
      <div style="margin-top:16px"><a href="${SITE_URL}/?manage=${encodeURIComponent(ref)}&token=${encodeURIComponent(token||"")}"
        style="display:inline-block;background:#0b478d;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px;font-size:14px">Manage this booking</a></div>
      <p style="color:#5a6675;font-size:12px;margin-top:12px">From the manage page you can cancel a single date or the whole series.</p>
    </div></div>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM, to: [b.email], cc: ADMIN_EMAIL ? [ADMIN_EMAIL] : undefined,
        subject: `Recurring booking confirmed — ${roomName} — ${booked.length} dates`,
        html,
      }),
    });
  } catch (e) { console.error("series email failed (bookings still valid):", e.message); }
}

// Build an ICS calendar file (UTC times) so any mail client offers "add to calendar".
function buildICS(b, ref, roomName) {
  const toUTC = (date, hm) => {
    // date=YYYY-MM-DD, hm=HH:MM, in KSA (+03:00) -> UTC basic format YYYYMMDDTHHMMSSZ
    const d = new Date(`${date}T${hm}:00${TZ}`);
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };
  const dtStart = toUTC(b.date, b.start);
  const dtEnd = toUTC(b.date, b.end);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const fold = (s) => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SystemRapid//Room Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ref}@systemrapid.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${fold(roomName + " — " + (b.purpose && b.purpose !== "—" ? b.purpose : "Meeting"))}`,
    `LOCATION:${fold(roomName)}`,
    `DESCRIPTION:${fold("Booking reference " + ref + ". Booked by " + b.name + ".")}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

async function sendEmail(b, ref, token) {
  if (!RESEND_API_KEY) return;
  const pretty = new Date(`${b.date}T00:00:00${TZ}`).toLocaleDateString("en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" });
  const roomName = ROOM_NAMES[b.room] || b.room;
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;color:#152233;max-width:560px">
    <div style="background:#0b478d;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <strong style="font-size:16px">${ORG_NAME}</strong><br><span style="opacity:.85">Meeting Room Booking — confirmed</span></div>
    <div style="border:1px solid #d8dee7;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
      <p>Hi ${esc(b.name)}, your booking is confirmed.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="color:#5a6675;padding:6px 0">Reference</td><td style="text-align:right;font-weight:700">${ref}</td></tr>
        <tr><td style="color:#5a6675;padding:6px 0">Room</td><td style="text-align:right;font-weight:700">${esc(roomName)}</td></tr>
        <tr><td style="color:#5a6675;padding:6px 0">Date</td><td style="text-align:right;font-weight:700">${pretty}</td></tr>
        <tr><td style="color:#5a6675;padding:6px 0">Time</td><td style="text-align:right;font-weight:700">${b.start} – ${b.end} (KSA)</td></tr>
        ${b.phone?`<tr><td style="color:#5a6675;padding:6px 0">Mobile</td><td style="text-align:right;font-weight:700">${esc(b.phone)}</td></tr>`:""}
      </table>
      <div style="margin-top:16px"><a href="${SITE_URL}/?manage=${encodeURIComponent(ref)}&token=${encodeURIComponent(token||"")}"
        style="display:inline-block;background:#0b478d;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px;font-size:14px">Change or cancel this booking</a></div>
      <p style="color:#5a6675;font-size:12px;margin-top:12px">A calendar file is attached — open it to add this meeting to Outlook, Google or Apple Calendar.</p>
      <p style="color:#5a6675;font-size:12px;margin-top:6px">If you didn't make this booking, you can ignore this email.</p>
      </div></div>`;
  const ics = buildICS(b, ref, roomName);
  const icsB64 = Buffer.from(ics, "utf8").toString("base64");
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [b.email],
        cc: ADMIN_EMAIL ? [ADMIN_EMAIL] : undefined,
        subject: `Room booking confirmed — ${roomName} — ${b.start}–${b.end}`,
        html,
        attachments: [
          { filename: `booking-${ref}.ics`, content: icsB64, content_type: "text/calendar; method=PUBLISH" },
        ],
      }),
    });
  } catch (e) { console.error("email failed (booking still valid):", e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  const q = event.queryStringParameters || {};
  const pass = event.headers["x-dash-pass"] || event.headers["X-Dash-Pass"];

  try {
    // ---------------- SELF-SERVICE: look up own booking (ref + token) ----------------
    if (event.httpMethod === "GET" && q.manage) {
      const ref = q.manage, token = q.token || "";
      if (!ref || !token) return json(400, { error: "missing ref or token" });
      const { rows } = await pool.query(
        `select ref, room, series_id, booker_name, attendees, purpose, starts_at, ends_at, status
           from bookings where ref=$1 and manage_token=$2`, [ref, token]);
      if (!rows.length) return json(404, { error: "not found" });
      const r = rows[0];
      const s = ksaParts(r.starts_at), e = ksaParts(r.ends_at);
      let seriesCount = 0;
      if (r.series_id) {
        const c = await pool.query(
          `select count(*)::int n from bookings where series_id=$1 and status='confirmed'`, [r.series_id]);
        seriesCount = c.rows[0].n;
      }
      return json(200, { booking: {
        ref: r.ref, room: r.room, name: r.booker_name,
        attendees: r.attendees || "—", purpose: r.purpose || "—",
        date: s.date, start: s.hm, end: e.hm, status: r.status,
        series_id: r.series_id || null, series_count: seriesCount } });
    }

    // ---------------- ADMIN: list all ----------------
    if (event.httpMethod === "GET" && q.admin === "1") {
      if (!DASH_PASSCODE || pass !== DASH_PASSCODE) return json(401, { error: "unauthorised" });
      const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : null;
      const to   = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : null;
      const params = [];
      let where = "true";
      if (from) { params.push(`${from}T00:00:00${TZ}`); where += ` and starts_at >= $${params.length}`; }
      if (to)   { params.push(`${to}T23:59:59${TZ}`);   where += ` and starts_at <= $${params.length}`; }
      const { rows } = await pool.query(
        `select ref, room, series_id, booker_name, booker_email, phone, attendees, purpose, starts_at, ends_at, status
           from bookings where ${where} order by starts_at`, params);
      const bookings = rows.map(r => {
        const s = ksaParts(r.starts_at), e = ksaParts(r.ends_at);
        return { ref: r.ref, room: r.room, series_id: r.series_id || null, name: r.booker_name, email: r.booker_email,
          phone: r.phone || "—", attendees: r.attendees || "—", purpose: r.purpose || "—",
          date: s.date, start: s.hm, end: e.hm, status: r.status };
      });
      return json(200, { bookings });
    }

    // ---------------- ADMIN: cancel ----------------
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON" }); }

      if (body.action === "selfcancel") {
        if (!body.ref || !body.token) return json(400, { error: "missing ref or token" });
        // verify ownership of this ref/token first
        const own = await pool.query(`select series_id from bookings where ref=$1 and manage_token=$2`, [body.ref, body.token]);
        if (!own.rows.length) return json(404, { error: "not found" });
        if (body.scope === "series" && own.rows[0].series_id) {
          const { rowCount } = await pool.query(
            `update bookings set status='cancelled' where series_id=$1 and status='confirmed'`, [own.rows[0].series_id]);
          return json(200, { ok: true, cancelled: rowCount });
        }
        const { rowCount } = await pool.query(
          `update bookings set status='cancelled' where ref=$1 and manage_token=$2 and status='confirmed'`,
          [body.ref, body.token]);
        if (!rowCount) return json(404, { error: "not found or already cancelled" });
        return json(200, { ok: true, cancelled: 1 });
      }

      if (body.action === "cancel") {
        if (!DASH_PASSCODE || pass !== DASH_PASSCODE) return json(401, { error: "unauthorised" });
        if (!body.ref) return json(400, { error: "missing ref" });
        if (body.scope === "series") {
          const s = await pool.query(`select series_id from bookings where ref=$1`, [body.ref]);
          const sid = s.rows[0] && s.rows[0].series_id;
          if (sid) {
            const { rowCount } = await pool.query(`update bookings set status='cancelled' where series_id=$1`, [sid]);
            return json(200, { ok: true, cancelled: rowCount });
          }
        }
        await pool.query(`update bookings set status='cancelled' where ref=$1`, [body.ref]);
        return json(200, { ok: true, cancelled: 1 });
      }

      // ---------------- PUBLIC: create (single or recurring) ----------------
      const b = body;
      for (const k of ["room", "name", "email", "date", "start", "end"]) {
        if (!b[k]) return json(400, { error: `missing field: ${k}` });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end)) {
        return json(400, { error: "bad date or time format" });
      }
      if (!(b.start < b.end)) return json(400, { error: "end must be after start" });

      // Build the list of dates for this booking (1 = single; >1 = recurring series)
      const repeat = b.repeat || "none";
      let count = parseInt(b.count, 10);
      if (!Number.isFinite(count) || count < 1) count = 1;
      if (count > 26) count = 26;                          // hard cap
      const dates = occurrenceDates(b.date, repeat, count); // array of YYYY-MM-DD

      // Single booking: keep original behaviour (clean 409 on clash)
      if (dates.length === 1) {
        const startsAt = `${b.date}T${b.start}:00${TZ}`;
        const endsAt = `${b.date}T${b.end}:00${TZ}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const ref = "BK-" + Math.random().toString(36).toUpperCase().slice(2, 7);
          const token = crypto.randomBytes(18).toString("hex");
          try {
            await pool.query(
              `insert into bookings (ref, manage_token, room, booker_name, booker_email, phone, attendees, purpose, starts_at, ends_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [ref, token, b.room, b.name, b.email, b.phone || null, b.attendees || null, b.purpose || null, startsAt, endsAt]);
            await sendEmail(b, ref, token);
            return json(200, { ok: true, ref });
          } catch (e) {
            if (e.code === "23P01") return json(409, { error: "conflict" });
            if (e.code === "23505" && attempt === 0) continue;
            throw e;
          }
        }
        return json(500, { error: "could not allocate reference" });
      }

      // Recurring: insert each occurrence; skip clashes, book the rest.
      const seriesId = "S-" + crypto.randomBytes(6).toString("hex");
      const booked = [], skipped = [];
      let firstRef = null, firstToken = null;
      for (const d of dates) {
        const sAt = `${d}T${b.start}:00${TZ}`;
        const eAt = `${d}T${b.end}:00${TZ}`;
        let placed = false;
        for (let attempt = 0; attempt < 2 && !placed; attempt++) {
          const ref = "BK-" + Math.random().toString(36).toUpperCase().slice(2, 7);
          const token = crypto.randomBytes(18).toString("hex");
          try {
            await pool.query(
              `insert into bookings (ref, manage_token, series_id, room, booker_name, booker_email, phone, attendees, purpose, starts_at, ends_at)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [ref, token, seriesId, b.room, b.name, b.email, b.phone || null, b.attendees || null, b.purpose || null, sAt, eAt]);
            booked.push({ ref, date: d });
            if (!firstRef) { firstRef = ref; firstToken = token; }
            placed = true;
          } catch (e) {
            if (e.code === "23P01") { skipped.push(d); placed = true; }   // clash: skip this date
            else if (e.code === "23505" && attempt === 0) { /* retry ref */ }
            else throw e;
          }
        }
      }

      if (booked.length === 0) return json(409, { error: "conflict", skipped });
      // one confirmation email summarising the series
      await sendSeriesEmail(b, booked, skipped, firstRef, firstToken, seriesId);
      return json(200, { ok: true, ref: firstRef, series_id: seriesId,
        booked: booked.map(x => x.date), skipped });
    }

    // ---------------- PUBLIC: availability ----------------
    if (event.httpMethod === "GET") {
      const room = q.room, date = q.date;
      if (!room || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json(400, { error: "room and date required" });
      const { rows } = await pool.query(
        `select ref, booker_name, starts_at, ends_at from bookings
          where room=$1 and status='confirmed'
            and starts_at >= $2::timestamptz and starts_at < $3::timestamptz
          order by starts_at`, [room, `${date}T00:00:00${TZ}`, `${date}T23:59:59${TZ}`]);
      const bookings = rows.map(r => ({ start: ksaParts(r.starts_at).hm, end: ksaParts(r.ends_at).hm, name: r.booker_name }));
      return json(200, { bookings });
    }

    return json(405, { error: "method not allowed" });
  } catch (err) {
    console.error("bookings error:", err.message);
    return json(500, { error: "server error" });
  }
};
