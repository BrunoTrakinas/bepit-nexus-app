import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function RegionSelection() {
  const navigate = useNavigate();

  const [theme, setTheme] = useState(() => {
    try {
      const t = localStorage.getItem("bepit_theme");
      return t === "dark" || t === "light" ? t : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("bepit_theme", next); } catch {}
  }

  const regions = [
    { slug: "regiao-dos-lagos", name: "Região dos Lagos" },
    // adicione outras regiões aqui
  ];

  function selectRegion(r) {
    try {
      localStorage.setItem("bepit_region", JSON.stringify(r));
    } catch {}
    navigate("/chat");
  }

  return (
    <div className="min-h-[100svh] bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex flex-col items-center">
      {/* Header simples com tema */}
      <div className="w-full max-w-4xl px-4 py-3 flex items-center justify-end">
        <button
          onClick={toggleTheme}
          className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm hover:shadow transition"
        >
          <span className="text-base">{theme === "dark" ? "☀️" : "🌙"}</span>
          <span className="hidden sm:inline">{theme === "dark" ? "Claro" : "Escuro"}</span>
        </button>
      </div>

      {/* Logo */}
      <div className="mt-2 flex flex-col items-center">
        <img src="/bepit-logo.png" alt="BEPIT" className="w-20 h-20 rounded-full object-cover" />
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Bepit Nexus</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">Escolha sua Região</p>
      </div>

      {/* Lista de regiões */}
      <div className="mt-6 w-full max-w-md px-4 space-y-3">
        {regions.map((r) => (
          <button
            key={r.slug}
            onClick={() => selectRegion(r)}
            className="w-full text-center px-4 py-3 rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 hover:shadow transition font-medium"
          >
            {r.name}
          </button>
        ))}
      </div>
    </div>
  );
}
