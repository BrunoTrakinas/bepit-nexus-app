import React from "react";
import { useNavigate } from "react-router-dom";
import ThemeToggleButton from "./ThemeToggleButton.jsx";

/**
 * Se você já carrega as regiões via API, pode substituir este array
 * pelo seu map. Mantive só para o arquivo ficar auto-suficiente.
 */
const REGIONS = [
  { slug: "regiao-dos-lagos", nome: "Região dos Lagos" },
  // Adicione outras regiões aqui, se quiser.
];

export default function RegionSelection() {
  const navigate = useNavigate();

  const handleSelectRegion = (regionObj) => {
    try {
      if (regionObj && regionObj.slug && regionObj.nome) {
        localStorage.setItem(
          "bepit_region",
          JSON.stringify({ slug: regionObj.slug, nome: regionObj.nome })
        );
      }
    } catch {
      // Se o localStorage falhar, seguimos mesmo assim.
    }
    navigate("/chat");
  };

  return (
    <main className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Topbar (toggle) — mantém o seu tema claro/escuro */}
      <div className="flex w-full items-center justify-end gap-2 px-4 py-3">
        <ThemeToggleButton />
      </div>

      {/* Centro da página (logo + títulos + botões) */}
      <section className="mx-auto flex min-h-[calc(100vh-64px)] max-w-3xl flex-col items-center justify-center px-4 pb-8 pt-0">
        {/* Logo */}
        <img
          src="/bepit-logo.png"
          alt="BEPIT"
          className="mb-4 h-16 w-16 rounded-full sm:h-20 sm:w-20"
        />

        {/* Títulos */}
        <h1 className="mb-1 text-center text-2xl font-extrabold tracking-tight sm:text-3xl">
          BEPIT Nexus
        </h1>
        <h2 className="mb-6 text-center text-base font-medium text-neutral-600 dark:text-neutral-300 sm:text-lg">
          Escolha sua Região
        </h2>

        {/* Lista de regiões (uma por linha, centralizadas) */}
        <div className="flex w-full max-w-xl flex-col items-stretch gap-3">
          {REGIONS.map((r) => (
            <button
              key={r.slug}
              type="button"
              onClick={() => handleSelectRegion(r)}
              className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-center text-base font-semibold shadow-sm hover:bg-neutral-50 active:scale-[0.99] dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
            >
              {r.nome}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
