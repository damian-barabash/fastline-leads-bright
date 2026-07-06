import { createContext, useContext, useEffect, useState } from "react";
import { api, getToken, setToken, clearToken } from "./api.js";

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try {
          const { user } = await api("me");
          setUser(user);
        } catch { clearToken(); }
      }
      setLoading(false);
    })();
  }, []);

  const login = async (username, password) => {
    const { token, user } = await api("login", { username, password });
    setToken(token);
    setUser(user);
  };
  const logout = async () => {
    try { await api("logout"); } catch { /* ignore */ }
    clearToken();
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
