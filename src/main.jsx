import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./index.css";
import App from "./App.jsx";
import { AuthProvider } from "./auth.jsx";
import DesktopOnly from "./components/DesktopOnly.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DesktopOnly>
      <HashRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </HashRouter>
    </DesktopOnly>
  </React.StrictMode>,
);
