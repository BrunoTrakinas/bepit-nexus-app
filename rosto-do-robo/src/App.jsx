// src/App.jsx
import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

// Páginas existentes
import RegionSelection from "./components/RegionSelection.jsx";
import ChatPage from "./components/ChatPage.jsx";

// ADMIN
import AdminLogin from "./admin/AdminLogin.jsx";     // login (não protegido)
import AdminPortal from "./admin/AdminPortal.jsx";   // portal (protegido)
import AdminMidia from "./admin/AdminMidia.jsx";     // mídia (protegido)

// Proteção de rotas do Admin (usa children)
import ProtectedRoute from "./components/ProtectedRoute.jsx";

/**
 * Aplica a classe 'dark' no <html> conforme preferência salva.
 * Mantém o comportamento centralizado para evitar “flash” de tema errado.
 */
function useApplyThemeFromStorage() {
  useEffect(() => {
    try {
      const pref = localStorage.getItem("bepit_theme"); // "dark" | "light"
      const html = document.documentElement;
      if (pref === "dark") {
        html.classList.add("dark");
      } else {
        html.classList.remove("dark");
      }
    } catch {
      // se falhar (privacy mode), ignora
    }
  }, []);
}

/** Sempre rola pro topo quando a rota muda (UX melhor em mobile/desktop). */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    // scroll suave e compatível
    window.scrollTo({ top: 0, left: 0, behavior: "instant" in window ? "instant" : "auto" });
  }, [pathname]);
  return null;
}

function AppRoutes() {
  useApplyThemeFromStorage();

  return (
    <>
      <ScrollToTop />
      <Routes>
        {/* Tela inicial: seleção de região */}
        <Route path="/" element={<RegionSelection />} />

        {/* Tela do chat */}
        <Route path="/chat" element={<ChatPage />} />

        {/* ===================== ADMIN (NÃO PROTEGIDO) ===================== */}
        {/* Tela de login do Admin */}
        <Route path="/admin/login" element={<AdminLogin />} />

        {/* ===================== ADMIN (PROTEGIDO) ===================== */}
        {/* Portal principal do Admin */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute>
              <AdminPortal />
            </ProtectedRoute>
          }
        />

        {/* Página Admin para consultar mídias por Partner ID */}
        {/* Aceita:
            - /admin/midia                  (digita o Partner ID e clica "Carregar")
            - /admin/midia/:id              (abre direto por path param)
            - /admin/midia?partner=<UUID>   (abre por querystring) */}
        <Route
          path="/admin/midia"
          element={
            <ProtectedRoute>
              <AdminMidia />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/midia/:id"
          element={
            <ProtectedRoute>
              <AdminMidia />
            </ProtectedRoute>
          }
        />

        {/* Fallback: qualquer outra rota volta pra home */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
