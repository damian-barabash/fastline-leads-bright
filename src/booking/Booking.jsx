import { useEffect, useMemo, useState } from "react";
import { FUNCTIONS_URL } from "../config.js";
import "./booking.css";

// Publiczna strona /calendar?t=<token> — wybór terminu oddzwonienia.
// Działa na telefonie (omija DesktopOnly), biały motyw z czerwonymi akcentami.

const TZ = "Europe/Warsaw";
const DOW = ["PON", "WT", "ŚR", "CZW", "PT", "SOB", "NIE"];

function getTokenFromUrl() {
  const search = window.location.search || "?" + (window.location.hash.split("?")[1] || "");
  return new URLSearchParams(search).get("t") || "";
}

async function call(action, payload) {
  const res = await fetch(`${FUNCTIONS_URL}/booking`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data?.error || "server"); e.code = data?.error; throw e; }
  return data;
}

const fmtTime = (iso) => new Intl.DateTimeFormat("pl-PL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtFull = (iso) => new Intl.DateTimeFormat("pl-PL", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtDayTitle = (dateStr) => new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long" }).format(new Date(dateStr + "T12:00:00"));
const monthLabel = (y, m) => new Intl.DateTimeFormat("pl-PL", { month: "long", year: "numeric" }).format(new Date(y, m, 15));

export default function Booking() {
  const token = getTokenFromUrl();
  const [state, setState] = useState("loading"); // loading | pick | booked | invalid | error
  const [data, setData] = useState(null);
  const [selDate, setSelDate] = useState(null);
  const [armed, setArmed] = useState(null); // iso slotu czekającego na potwierdzenie
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState("");
  const [cursor, setCursor] = useState(null); // {y, m} widocznego miesiąca

  const load = async () => {
    try {
      const d = await call("info", { t: token });
      setData(d);
      const firstAv = d.days.find((x) => x.slots.some((s) => !s.taken));
      const sel = selDate && d.days.some((x) => x.date === selDate) ? selDate : firstAv?.date ?? d.days[0]?.date ?? null;
      setSelDate(sel);
      if (!cursor && sel) setCursor({ y: +sel.slice(0, 4), m: +sel.slice(5, 7) - 1 });
      setState("pick");
    } catch (e) {
      setState(e.code === "invalid_link" ? "invalid" : "error");
    }
  };

  useEffect(() => {
    document.title = "Wybierz termin rozmowy — Fastline Racing Academy";
    document.body.classList.add("booking-mode");
    if (!token) { setState("invalid"); return; }
    load();
    return () => document.body.classList.remove("booking-mode");
  }, []);

  const byDate = useMemo(() => Object.fromEntries((data?.days ?? []).map((d) => [d.date, d.slots])), [data]);

  const monthGrid = useMemo(() => {
    if (!cursor) return [];
    const first = new Date(cursor.y, cursor.m, 1);
    const startOffset = (first.getDay() + 6) % 7; // poniedziałek = 0
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ d, ds, av: (byDate[ds] ?? []).some((s) => !s.taken) });
    }
    return cells;
  }, [cursor, byDate]);

  const monthBounds = useMemo(() => {
    const ds = data?.days ?? [];
    if (!ds.length) return null;
    const f = ds[0].date, l = ds[ds.length - 1].date;
    return { min: { y: +f.slice(0, 4), m: +f.slice(5, 7) - 1 }, max: { y: +l.slice(0, 4), m: +l.slice(5, 7) - 1 } };
  }, [data]);

  const canNav = (dir) => {
    if (!cursor || !monthBounds) return false;
    let { y, m } = cursor;
    m += dir; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    const v = y * 12 + m;
    return v >= monthBounds.min.y * 12 + monthBounds.min.m && v <= monthBounds.max.y * 12 + monthBounds.max.m;
  };
  const nav = (dir) => {
    if (!canNav(dir)) return;
    let { y, m } = cursor;
    m += dir; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    setCursor({ y, m });
  };

  const book = async (iso) => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await call("book", { t: token, slot: iso });
      setResult(r);
      setState("booked");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (e.code === "slot_taken") {
        setToast("Ten termin został właśnie zajęty — wybierz inny.");
        setTimeout(() => setToast(""), 3500);
        setArmed(null);
        await load();
      } else {
        setToast("Coś poszło nie tak. Spróbuj ponownie.");
        setTimeout(() => setToast(""), 3500);
      }
    } finally { setSaving(false); }
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div className="bk-wrap">
      <div className="bk-card">
        <div className="bk-head"><img src="/logo.webp" alt="Fastline Racing Academy" /></div>

        {state === "loading" && <div className="bk-spin" />}

        {state === "invalid" && (
          <div className="bk-center">
            <div className="bk-icon err">!</div>
            <h1>Link jest nieprawidłowy</h1>
            <p>Ten link do rezerwacji nie działa lub wygasł. Skorzystaj z linku otrzymanego w wiadomości e-mail lub SMS — albo po prostu odbierz nasz telefon.</p>
          </div>
        )}

        {state === "error" && (
          <div className="bk-center">
            <div className="bk-icon err">!</div>
            <h1>Coś poszło nie tak</h1>
            <p>Nie udało się załadować kalendarza. Odśwież stronę i spróbuj ponownie.</p>
            <button className="bk-again" onClick={() => { setState("loading"); load(); }}>Spróbuj ponownie</button>
          </div>
        )}

        {state === "booked" && result && (
          <div className="bk-center">
            <div className="bk-icon">✓</div>
            <h1>{result.demo ? "Tryb testowy — termin NIE został zapisany" : result.changed ? "Termin zmieniony!" : "Termin zarezerwowany!"}</h1>
            <div className="bk-when">{result.label}</div>
            <p>Zadzwonimy do Ciebie o wybranej godzinie. Jeśli plany się zmienią, w każdej chwili możesz wybrać inny termin — wystarczy ponownie otworzyć ten sam link.</p>
            <button className="bk-again" onClick={() => { setArmed(null); setResult(null); setState("loading"); load(); }}>Zmień termin</button>
          </div>
        )}

        {state === "pick" && data && (
          <>
            <div className="bk-title">
              <h1>{data.name ? `${data.name}, wybierz` : "Wybierz"} termin rozmowy</h1>
              <p>Oddzwonimy dokładnie wtedy, kiedy Ci pasuje.</p>
              <div className="bk-meta">
                <span>📞 <b>Rozmowa telefoniczna</b></span>
                <span>🕐 ok. 20 minut</span>
                <span>🇵🇱 czas polski (pon–pt 10:00–18:00)</span>
              </div>
            </div>

            {data.current && (
              <div className="bk-current">
                Twój obecny termin: <b>{fmtFull(data.current)}</b>. Wybór nowego terminu zastąpi obecny.
              </div>
            )}

            <div className="bk-body">
              <div className="bk-cal">
                <div className="bk-cal-top">
                  <b>{cursor ? monthLabel(cursor.y, cursor.m) : ""}</b>
                  <div className="bk-nav">
                    <button onClick={() => nav(-1)} disabled={!canNav(-1)} aria-label="Poprzedni miesiąc">‹</button>
                    <button onClick={() => nav(1)} disabled={!canNav(1)} aria-label="Następny miesiąc">›</button>
                  </div>
                </div>
                <div className="bk-grid">
                  {DOW.map((d) => <div key={d} className="bk-dow">{d}</div>)}
                  {monthGrid.map((c, i) => (
                    <div key={i} className="bk-day">
                      {c && (
                        <button
                          className={(c.av ? "av" : "") + (selDate === c.ds ? " sel" : "") + (c.ds === todayStr ? " today" : "")}
                          disabled={!c.av}
                          onClick={() => { setSelDate(c.ds); setArmed(null); }}
                        >{c.d}</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bk-slots">
                {selDate ? (
                  <>
                    <h2>{fmtDayTitle(selDate)}</h2>
                    <p className="bk-hint">Wybierz godzinę i potwierdź. Godziny w czasie polskim.</p>
                    <div className="bk-slot-list">
                      {(byDate[selDate] ?? []).map((s) => (
                        <div key={s.iso} className={"bk-slot" + (armed === s.iso ? " armed" : "")}>
                          <button className="time" disabled={s.taken || saving} onClick={() => setArmed(armed === s.iso ? null : s.iso)}>
                            {fmtTime(s.iso)}
                          </button>
                          {armed === s.iso && (
                            <button className="confirm" disabled={saving} onClick={() => book(s.iso)}>
                              {saving ? "Zapisuję…" : "Potwierdzam"}
                            </button>
                          )}
                        </div>
                      ))}
                      {!(byDate[selDate] ?? []).length && <div className="bk-empty">Brak wolnych godzin w tym dniu.</div>}
                    </div>
                  </>
                ) : (
                  <div className="bk-empty">Wybierz dzień z kalendarza.</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="bk-foot">
        Fastline Racing Academy · <a href="https://www.fastlineracingacademy.pl" target="_blank" rel="noreferrer">fastlineracingacademy.pl</a>
      </div>

      {toast && <div className="bk-toast">{toast}</div>}
    </div>
  );
}
