// src/App.jsx
import React, { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

// Ajuste estes paths se seus arquivos estiverem em outro lugar:
import RegionSelection from "./components/RegionSelection.jsx";
import ChatPage from "./components/ChatPage.jsx";

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
