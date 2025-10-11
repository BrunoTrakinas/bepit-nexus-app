import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Tela de seleção de região
 * - Logo centralizada em tamanho padrão
 * - Títulos centralizados
 * - Botões de regiões empilhados, responsivos
 * - Alternância de tema (claro/escuro) com persistência em localStorage
 * - Ao selecionar: salva no localStorage e navega para /chat
 */
export default function RegionSelection() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState("light");

  // Aplica tema salvo ou padrão
  useEffect(() => {
    try {
      const saved = localStorage.getItem("bepit_theme");
      const initial = saved === "dark" || saved === "light" ? saved : "light";
      setTheme(initial);
      document.documentElement.classList.toggle("dark", initial === "dark");
    } catch {
      // fallback seguro
      document.documentElement.classList.remove("dark");
    }
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("bepit_theme", next);
    } catch {}
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  // Ajuste/expanda conforme for adicionando mais regiões
  const regions = [
    { name: "Região dos Lagos", slug: "regiao-dos-lagos" },
    // { name: "Outra Região", slug: "outra-regiao" },
  ];

  function handleSelectRegion(region) {
    try {
      localStorage.setItem(
        "bepit_region",
        JSON.stringify({ slug: region.slug, name: region.name })
      );
    } catch {}
    navigate("/chat");
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex items-center justify-center px-4">
      {/* Header fino com botão de tema */}
      <div className="absolute top-3 right-3">
        <button
          onClick={toggleTheme}
          aria-label="Alternar tema"
          className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700
                     bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-medium shadow-sm
                     hover:shadow-md hover:border-neutral-300 dark:hover:border-neutral-600 transition"
        >
          <span className="text-lg">{theme === "dark" ? "☀️" : "🌙"}</span>
          <span>{theme === "dark" ? "Claro" : "Escuro"}</span>
        </button>
      </div>

      <div className="w-full max-w-2xl flex flex-col items-center gap-6 md:gap-8">
        {/* Logo em tamanho padrão */}
        <img
          src="/bepit-logo.png"
          alt="BEPIT logo"
          className="w-24 h-24 md:w-28 md:h-28 object-contain select-none pointer-events-none"
          draggable="false"
        />

        {/* Títulos */}
        <div className="text-center">
          <h1 className="font-semibold tracking-tight text-3xl md:text-4xl">
            Bepit Nexus
          </h1>
          <p className="mt-2 text-base md:text-lg text-neutral-600 dark:text-neutral-300">
            Escolha sua Região
          </p>
        </div>

        {/* Lista de regiões */}
        <div className="w-full max-w-md flex flex-col gap-3">
          {regions.map((r) => (
            <button
              key={r.slug}
              onClick={() => handleSelectRegion(r)}
              className="w-full rounded-2xl px-5 py-4 text-base md:text-lg font-medium
                         bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700
                         shadow-sm hover:shadow-md hover:border-neutral-300 dark:hover:border-neutral-600
                         transition-all text-left"
            >
              {r.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
