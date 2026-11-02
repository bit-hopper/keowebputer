/**
 * lively.calendar.CalendarImport
 *
 * Pure-data parsing module (no morphs, no DOM) — safe to reference from
 * anywhere, same rationale as lively.transit.BartData. Turns an uploaded
 * calendar file's raw text into a normalized {calendarName, events[]}
 * structure that lively.calendar.CalendarApp can render/import, regardless
 * of which of the three source formats it came from:
 *
 *   - iCalendar (.ics, RFC 5545)  — VERSION:2.0, BEGIN:VEVENT blocks
 *   - vCalendar (.vcs, v1.0)     — older format, same BEGIN:VEVENT/property
 *                                  line shape, just VERSION:1.0 and looser
 *                                  about UID/TZID — the line-unfolding and
 *                                  property parser below handle both without
 *                                  a separate code path
 *   - CSV                        — Google Calendar's classic export schema
 *                                  (Subject/Start Date/Start Time/End Date/
 *                                  End Time/All Day Event/Description/
 *                                  Location), matched by column headers
 *                                  case-insensitively, with a couple of
 *                                  common synonyms accepted
 *
 * Normalized event shape: { uid, title, start (Date), end (Date),
 * allDay (bool), location, description }. Recurring VEVENTs (RRULE) are
 * expanded into individual occurrence events up front, each with a
 * derived uid of "<uid>#<n>" — bounded (see EXPAND_CAP) so a runaway/
 * unbounded RRULE can't hang the import or blow up memory.
 */

module("lively.calendar.CalendarImport")
  .requires()
  .toRun(function () {

    var EXPAND_CAP = 500;      // hard cap on generated occurrences per RRULE
    var HORIZON_YEARS = 3;     // how far past the event's own start to expand when neither COUNT nor UNTIL bounds it

    // ─── shared helpers ───────────────────────────────────────────────

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    function unescapeText(s) {
      return (s || "")
        .replace(/\\n/gi, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\");
    }

    // ─── iCalendar / vCalendar (.ics / .vcs) ───────────────────────────

    function unfoldLines(text) {
      var rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      var lines = [];
      rawLines.forEach(function (line) {
        if ((line[0] === " " || line[0] === "\t") && lines.length) {
          lines[lines.length - 1] += line.slice(1);
        } else if (line.length) {
          lines.push(line);
        }
      });
      return lines;
    }

    function parsePropertyLine(line) {
      var colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      var left = line.slice(0, colonIdx);
      var value = line.slice(colonIdx + 1);
      var parts = left.split(";");
      var name = parts[0].toUpperCase();
      var params = {};
      parts.slice(1).forEach(function (p) {
        var eq = p.indexOf("=");
        if (eq === -1) return;
        params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).toUpperCase();
      });
      return { name: name, params: params, value: value };
    }

    // Returns { date: Date, allDay: bool } or null if unparseable.
    function parseDateValue(value, params) {
      var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
      if (!m) return null;
      var y = +m[1], mo = +m[2], d = +m[3];
      var isAllDay = !m[4] || (params && params.VALUE === "DATE");
      if (isAllDay) return { date: new Date(y, mo - 1, d), allDay: true };
      var hh = +m[4], mm = +m[5], ss = +m[6];
      var date = m[7]
        ? new Date(Date.UTC(y, mo - 1, d, hh, mm, ss))
        : new Date(y, mo - 1, d, hh, mm, ss); // TZID (if any) intentionally ignored — treated as local wall-clock time
      return { date: date, allDay: false };
    }

    // Minimal ISO-8601 duration subset actually seen in DURATION properties: P<n>D, PT<n>H, PT<n>M, PT<n>S, and combinations like P1DT2H30M.
    function parseDuration(value) {
      var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || "");
      if (!m) return 0;
      var days = +(m[1] || 0), hours = +(m[2] || 0), mins = +(m[3] || 0), secs = +(m[4] || 0);
      return ((days * 24 + hours) * 60 + mins) * 60000 + secs * 1000;
    }

    function parseRRule(value) {
      var rule = { freq: null, interval: 1, count: null, until: null, byday: null };
      value.split(";").forEach(function (part) {
        var eq = part.indexOf("=");
        if (eq === -1) return;
        var key = part.slice(0, eq).toUpperCase();
        var val = part.slice(eq + 1);
        if (key === "FREQ") rule.freq = val.toUpperCase();
        else if (key === "INTERVAL") rule.interval = Math.max(1, parseInt(val, 10) || 1);
        else if (key === "COUNT") rule.count = parseInt(val, 10) || null;
        else if (key === "UNTIL") { var d = parseDateValue(val, {}); rule.until = d ? d.date : null; }
        else if (key === "BYDAY") rule.byday = val.split(",").map(function (s) { return s.toUpperCase(); });
      });
      return rule;
    }

    var DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

    function addMonthsClamped(date, delta) {
      var d = new Date(date.getTime());
      var day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
      var daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, daysInTarget));
      return d;
    }

    // Expands a recurring VEVENT into concrete occurrence start dates (each
    // still carrying the original time-of-day), honoring FREQ/INTERVAL and
    // whichever of COUNT/UNTIL is present; falls back to a HORIZON_YEARS
    // window past dtstart when the rule is otherwise unbounded. Always
    // capped at EXPAND_CAP as a last-resort safety net.
    function expandOccurrences(dtstart, rrule) {
      var out = [];
      var horizon = new Date(dtstart.getTime());
      horizon.setFullYear(horizon.getFullYear() + HORIZON_YEARS);
      var until = rrule.until || horizon;
      var limit = rrule.count || EXPAND_CAP;

      if (rrule.freq === "WEEKLY" && rrule.byday && rrule.byday.length) {
        var weekStart = new Date(dtstart.getTime());
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        var week = 0;
        while (out.length < limit && out.length < EXPAND_CAP) {
          var anyInWindow = false;
          for (var i = 0; i < rrule.byday.length; i++) {
            var dow = DAY_CODES.indexOf(rrule.byday[i]);
            if (dow === -1) continue;
            var occ = new Date(weekStart.getTime());
            occ.setDate(occ.getDate() + dow);
            occ.setHours(dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds(), 0);
            if (occ < dtstart) continue;
            if (occ > until) continue;
            anyInWindow = true;
            out.push(occ);
            if (out.length >= limit || out.length >= EXPAND_CAP) break;
          }
          week += rrule.interval;
          weekStart = new Date(dtstart.getTime());
          weekStart.setDate(weekStart.getDate() - weekStart.getDay() + week * 7);
          if (weekStart > until && !anyInWindow) break;
          if (weekStart.getTime() - dtstart.getTime() > (HORIZON_YEARS + 1) * 365 * 86400000) break;
        }
        return out.slice(0, rrule.count || out.length);
      }

      var cur = new Date(dtstart.getTime());
      while (out.length < limit && out.length < EXPAND_CAP && cur <= until) {
        out.push(new Date(cur.getTime()));
        if (rrule.freq === "DAILY") cur.setDate(cur.getDate() + rrule.interval);
        else if (rrule.freq === "WEEKLY") cur.setDate(cur.getDate() + 7 * rrule.interval);
        else if (rrule.freq === "MONTHLY") cur = addMonthsClamped(cur, rrule.interval);
        else if (rrule.freq === "YEARLY") cur = addMonthsClamped(cur, 12 * rrule.interval);
        else break; // unknown FREQ — treat as a single non-recurring event
      }
      return out;
    }

    function parseICS(text) {
      var lines = unfoldLines(text);
      var calendarName = null;
      var events = [];
      var block = null;

      lines.forEach(function (line) {
        if (/^BEGIN:VEVENT$/i.test(line)) { block = {}; return; }
        if (/^END:VEVENT$/i.test(line)) {
          if (block) events.push(block);
          block = null;
          return;
        }
        var prop = parsePropertyLine(line);
        if (!prop) return;
        if (!block) {
          if (prop.name === "X-WR-CALNAME") calendarName = unescapeText(prop.value);
          return;
        }
        switch (prop.name) {
          case "UID": block.uid = prop.value; break;
          case "SUMMARY": block.title = unescapeText(prop.value); break;
          case "DESCRIPTION": block.description = unescapeText(prop.value); break;
          case "LOCATION": block.location = unescapeText(prop.value); break;
          case "DTSTART": block.dtstart = parseDateValue(prop.value, prop.params); break;
          case "DTEND": block.dtend = parseDateValue(prop.value, prop.params); break;
          case "DURATION": block.durationMs = parseDuration(prop.value); break;
          case "RRULE": block.rrule = parseRRule(prop.value); break;
          case "EXDATE":
            block.exdates = block.exdates || [];
            prop.value.split(",").forEach(function (v) {
              var d = parseDateValue(v, prop.params);
              if (d) block.exdates.push(d.date.getTime());
            });
            break;
        }
      });

      var normalized = [];
      events.forEach(function (b, blockIdx) {
        if (!b.dtstart) return; // unparseable/malformed VEVENT — skip rather than guess
        var start = b.dtstart.date;
        var allDay = b.dtstart.allDay;
        var durationMs = b.durationMs != null ? b.durationMs
          : (b.dtend ? b.dtend.date.getTime() - start.getTime()
            : (allDay ? 86400000 : 3600000));
        var uid = b.uid || ("ics-import-" + blockIdx + "-" + start.getTime());

        var starts = b.rrule ? expandOccurrences(start, b.rrule) : [start];
        var exSet = {};
        (b.exdates || []).forEach(function (t) { exSet[t] = true; });

        starts.forEach(function (occStart, i) {
          if (exSet[occStart.getTime()]) return;
          normalized.push({
            uid: starts.length > 1 ? uid + "#" + i : uid,
            title: b.title || "(untitled event)",
            start: occStart,
            end: new Date(occStart.getTime() + durationMs),
            allDay: allDay,
            location: b.location || "",
            description: b.description || "",
          });
        });
      });

      return { calendarName: calendarName, events: normalized };
    }

    // ─── CSV (Google Calendar classic export schema) ──────────────────

    function parseCSVRows(text) {
      var rows = [];
      var row = [];
      var field = "";
      var inQuotes = false;
      var s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (inQuotes) {
          if (c === '"') {
            if (s[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += c;
      }
      if (field.length || row.length) { row.push(field); rows.push(row); }
      return rows.filter(function (r) { return r.some(function (f) { return f.trim().length; }); });
    }

    function findCol(header, names) {
      for (var i = 0; i < header.length; i++) {
        var h = header[i].trim().toLowerCase();
        if (names.indexOf(h) !== -1) return i;
      }
      return -1;
    }

    // Accepts "1/15/2026" / "01/15/2026" / "2026-01-15" and, separately,
    // "9:00 AM" / "09:00" style time-of-day strings — the shapes Google
    // Calendar's own CSV export and most hand-built test files use.
    function parseCSVDate(dateStr, timeStr) {
      dateStr = (dateStr || "").trim();
      var y, mo, d;
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr);
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else {
        m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr);
        if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; }
      }
      if (y == null) return null;

      var hh = 0, mm = 0;
      timeStr = (timeStr || "").trim();
      if (timeStr) {
        var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(timeStr);
        if (tm) {
          hh = +tm[1]; mm = +tm[2];
          var ampm = tm[4] ? tm[4].toUpperCase() : null;
          if (ampm === "PM" && hh < 12) hh += 12;
          if (ampm === "AM" && hh === 12) hh = 0;
        }
      }
      return new Date(y, mo - 1, d, hh, mm, 0);
    }

    function parseCSV(text) {
      var rows = parseCSVRows(text);
      if (!rows.length) return { calendarName: null, events: [] };
      var header = rows[0];

      var col = {
        title: findCol(header, ["subject", "title", "summary", "event"]),
        startDate: findCol(header, ["start date", "start"]),
        startTime: findCol(header, ["start time"]),
        endDate: findCol(header, ["end date", "end"]),
        endTime: findCol(header, ["end time"]),
        allDay: findCol(header, ["all day event", "all day", "allday"]),
        description: findCol(header, ["description", "notes"]),
        location: findCol(header, ["location"]),
      };

      var events = [];
      rows.slice(1).forEach(function (r, idx) {
        var title = col.title !== -1 ? r[col.title] : "";
        var startDateStr = col.startDate !== -1 ? r[col.startDate] : "";
        if (!title && !startDateStr) return;

        var allDayFlag = col.allDay !== -1 && /^(true|yes|1)$/i.test((r[col.allDay] || "").trim());
        var start = parseCSVDate(startDateStr, col.startTime !== -1 ? r[col.startTime] : null);
        if (!start) return;
        var end = null;
        if (col.endDate !== -1 && r[col.endDate]) {
          end = parseCSVDate(r[col.endDate], col.endTime !== -1 ? r[col.endTime] : null);
        }
        if (allDayFlag) {
          start = new Date(start.getFullYear(), start.getMonth(), start.getDate());
          end = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)
            : new Date(start.getTime() + 86400000);
        } else if (!end) {
          end = new Date(start.getTime() + 3600000);
        }

        events.push({
          uid: "csv-import-" + idx + "-" + start.getTime(),
          title: title || "(untitled event)",
          start: start,
          end: end,
          allDay: allDayFlag,
          location: col.location !== -1 ? (r[col.location] || "") : "",
          description: col.description !== -1 ? (r[col.description] || "") : "",
        });
      });

      return { calendarName: null, events: events };
    }

    // ─── format detection + public entry point ─────────────────────────

    lively.calendar.CalendarImport = {

      parseFile: function (text, fileName) {
        var isICS = /^\s*BEGIN:VCALENDAR/i.test(text);
        var isCSVExt = /\.csv$/i.test(fileName || "");
        if (isICS && !isCSVExt) return parseICS(text);
        if (isCSVExt || !isICS) return parseCSV(text);
        return parseICS(text);
      },

      // exposed for the sample-data/testing paths and for unit-style checks
      _parseICS: parseICS,
      _parseCSV: parseCSV,
    };

  }); // end module('lively.calendar.CalendarImport')
