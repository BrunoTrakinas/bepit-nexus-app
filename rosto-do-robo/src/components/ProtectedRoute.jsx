// src/components/ProtectedRoute.jsx
// ============================================================================
// Protege rotas do Admin:
// - Redireciona para /admin/login se não houver adminKey válida no localStorage.
// - Expira a sessão após 15 minutos de inatividade (mouse/teclado/visibilidade).
// - Ao fechar/abrir novamente, exige novo login (limpando adminKey).
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

const STORAGE_KEY = "adminKey";
const LAST_ACTIVE_KEY = "adminLastActiveAt";
const MAX_IDLE_MS = 15 * 60 * 1000; // 15 minutos

export default function ProtectedRoute({ children }) {
  const [allowed, setAllowed] = useState(false);
  const [checking, setChecking] = useState(true);
  const idleTimer = useRef(null);

  useEffect(() => {
    // Se a aba for fechada ou recarregada, força logout (limpa adminKey).
    const handleUnload = () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LAST_ACTIVE_KEY);
      } catch {}
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  useEffect(() => {
    // Verifica credencial
    const key = localStorage.getItem(STORAGE_KEY) || "";
    if (!key) {
      setAllowed(false);
      setChecking(false);
      return;
    }

    // Controle de inatividade
    const now = Date.now();
    const lastActive = Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
    if (lastActive && now - lastActive > MAX_IDLE_MS) {
      // Expirou por inatividade
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LAST_ACTIVE_KEY);
      setAllowed(false);
      setChecking(false);
      return;
    }

    // Marca como ativo agora
    localStorage.setItem(LAST_ACTIVE_KEY, String(now));
    setAllowed(true);
    setChecking(false);

    const resetIdle = () => {
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    };

    // Eventos que contam como atividade
    const activityEvents = ["mousemove", "mousedown", "keypress", "touchstart", "visibilitychange"];
    activityEvents.forEach((ev) => window.addEventListener(ev, resetIdle));

    // Verificação periódica (safety net)
    idleTimer.current = setInterval(() => {
      const last = Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
      if (last && Date.now() - last > MAX_IDLE_MS) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LAST_ACTIVE_KEY);
        setAllowed(false);
      }
    }, 15000);

    return () => {
      activityEvents.forEach((ev) => window.removeEventListener(ev, resetIdle));
      if (idleTimer.current) clearInterval(idleTimer.current);
    };
  }, []);

  if (checking) return null; // evita flicker
  if (!allowed) return <Navigate to="/admin/login" replace />;

  return <>{children}</>;
}
