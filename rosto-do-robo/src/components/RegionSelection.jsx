import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Página de seleção da região
 * - Centraliza vertical e horizontalmente: logo, título e botões das regiões
 * - Persiste o tema (claro/escuro) em localStorage
 * - Ao clicar em uma região, salva { slug, name } e navega para /chat
 */

const REGIONS = [
  { slug: "regiao-dos-lagos", name: "Região dos Lagos" },
  // adicione outras regiões aqui quando necessário
];

const THEME_KEY = "bepit_theme";
const REGION_KEY = "bepit_region";

export default function RegionSelection() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "light");

  // aplica/remover classe 'dark' no html
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // seletor de tema (opcional na tela)
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleSelect = (region) => {
    localStorage.setItem(REGION_KEY, JSON.stringify(region));
    navigate("/chat");
  };

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      {/* Container centralizado vertical/horizontal */}
      <div className="mx-auto max-w-xl px-4 min-h-screen flex flex-col items-center justify-center gap-8">
        {/* Logo */}
        <img
          src="/bepit-logo.png"
          alt="BEPIT"
          className="w-20 h-20 rounded-full shadow-sm"
          draggable="false"
        />

        {/* Títulos */}
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">BEPIT Nexus</h1>
          <p className="text-base mt-2 opacity-80">Escolha sua Região</p>
        </div>

        {/* Lista de regiões */}
        <div className="w-full flex flex-col gap-3">
          {REGIONS.map((r) => (
            <button
              key={r.slug}
              onClick={() => handleSelect(r)}
              className="w-full py-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition text-center font-medium"
            >
              {r.name}
            </button>
          ))}
        </div>

        {/* Alternador de tema (opcional aqui) */}
        <button
          onClick={toggleTheme}
          className="mt-2 inline-flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 px-3 py-2 text-sm bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition"
          aria-label="Alternar tema"
          type="button"
        >
          <span className="text-lg">🌓</span>
          {theme === "dark" ? "Modo claro" : "Modo escuro"}
        </button>
      </div>
    </div>
  );
}
