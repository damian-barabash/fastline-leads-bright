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
        <div className="padlock">🔒</div>
        <h2>Dostęp tylko z komputera</h2>
        <p>
          Panel Fastline Leads Bright jest dostępny wyłącznie na komputerze lub laptopie.
          Otwórz tę stronę na urządzeniu z większym ekranem, aby się zalogować.
        </p>
      </div>
    </div>
  );
}
