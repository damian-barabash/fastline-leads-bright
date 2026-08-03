import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./index.css";
import App from "./App.jsx";
import { AuthProvider } from "./auth.jsx";
import DesktopOnly from "./components/DesktopOnly.jsx";
import Booking from "./booking/Booking.jsx";

// Publiczny kalendarz oddzwonień (/calendar?t=… albo #/calendar?t=…):
// działa też na telefonie — bez logowania i bez blokady desktop-only.
const isBooking =
  window.location.pathname.replace(/\/+$/, "") === "/calendar" ||
  window.location.hash.startsWith("#/calendar");

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isBooking ? (
      <Booking />
    ) : (
      <DesktopOnly>
        <HashRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </HashRouter>
      </DesktopOnly>
    )}
  </React.StrictMode>,
);
