import { useEffect, useState } from "react";

// Blocks phones/tablets. Panel is desktop-only per requirement.
const MIN_WIDTH = 1024;

function isDesktop() {
  const wide = window.innerWidth >= MIN_WIDTH;
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent);
  return wide && !coarse && !mobileUA;
}

export default function DesktopOnly({ children }) {
  const [ok, setOk] = useState(isDesktop());
  useEffect(() => {
    const on = () => setOk(isDesktop());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  if (ok) return children;
  return (
    <div className="lock">
      <div>
        <div className="padlock">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--red-2, #ff3b47)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="1" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </div>
        <h2>Dostęp tylko z komputera</h2>
        <p>
          Panel Fastline Leads Bright jest dostępny wyłącznie na komputerze lub laptopie.
          Otwórz tę stronę na urządzeniu z większym ekranem, aby się zalogować.
        </p>
      </div>
    </div>
  );
}
