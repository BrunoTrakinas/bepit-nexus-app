// rosto-do-robo/src/admin/AuthProvider.jsx
// ============================================================================
// Provedor de autenticação do Admin:
// - Sessão fica em sessionStorage (some ao fechar a aba)
// - Auto-logout após 15 minutos de inatividade
// - Bloqueia acesso às rotas /admin* sem chave válida
// ============================================================================

import React, { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { clearAdminKey, getAdminKey, getLastActivityTs, touchAdminActivity } from "./adminApi";

export const AuthContext = createContext({
  isAuthenticated: false,
  adminKey: "",
  logout: () => {}
});

const IDLE_LIMIT_MS = 15 * 60 * 1000; // 15 minutos

export default function AuthProvider({ children }) {
  const [adminKey, setAdminKeyState] = useState(getAdminKey());

  const logout = useCallback(() => {
    clearAdminKey();
    setAdminKeyState("");
  }, []);

  // Monitora inatividade
  useEffect(() => {
    function checkIdle() {
      const ts = getLastActivityTs();
      if (!ts) return; // ainda não logado ou sem atividade registrada
      const inactive = Date.now() - ts;
      if (inactive > IDLE_LIMIT_MS) {
        logout();
      }
    }
    const id = setInterval(checkIdle, 15 * 1000); // checa a cada 15s
    return () => clearInterval(id);
  }, [logout]);

  // Atualiza atividade ao interagir com a página
  useEffect(() => {
    function onActive() {
      if (getAdminKey()) {
        touchAdminActivity();
      }
    }
    window.addEventListener("click", onActive);
    window.addEventListener("keydown", onActive);
    window.addEventListener("mousemove", onActive);
    window.addEventListener("scroll", onActive);
    return () => {
      window.removeEventListener("click", onActive);
      window.removeEventListener("keydown", onActive);
      window.removeEventListener("mousemove", onActive);
      window.removeEventListener("scroll", onActive);
    };
  }, []);

  // Observa mudanças no sessionStorage feitas por outros componentes (opcional)
  useEffect(() => {
    function onStorage() {
      setAdminKeyState(getAdminKey());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isAuthenticated = Boolean(adminKey);

  const value = useMemo(
    () => ({ isAuthenticated, adminKey, logout }),
    [isAuthenticated, adminKey, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
