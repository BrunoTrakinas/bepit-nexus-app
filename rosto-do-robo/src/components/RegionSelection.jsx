// src/components/RegionSelection.jsx
import React from "react";
import ThemeToggleButton from "./ThemeToggleButton.jsx";

/**
 * Seleção de Região
 * - Centraliza logo, título "BEPIT", subtítulo "Escolha sua Região" e os botões das regiões.
 * - Salva { slug, nome } no localStorage com a chave "bepit_regiao".
 * - Redireciona para /chat após a seleção.
 * - Mantém compatibilidade mobile/tablet/desktop e modo escuro.
 */

const REGIOES_DISPONIVEIS = [
  { slug: "regiao-dos-lagos", nome: "Região dos Lagos" },
  // Adicione mais regiões aqui quando quiser:
  // { slug: "costa-verde", nome: "Costa Verde" },
  // { slug: "serra-fluminense", nome: "Serra Fluminense" },
];

export default function RegionSelection() {
  function handleSelect(regiao) {
    try {
      localStorage.setItem("bepit_regiao", JSON.stringify(regiao));
    } catch {
      // ignore
    }
    // redireciona
    window.location.href = "/chat";
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 relative">
      {/* Topbar mínima: apenas o ThemeToggle à direita (não atrapalha o centro) */}
      <div className="absolute right-3 top-3 sm:right-4 sm:top-4 z-20">
        <ThemeToggleButton />
      </div>

      {/* Conteúdo centralizado vertical e horizontal */}
      <div className="max-w-3xl mx-auto px-4 w-full min-h-screen flex flex-col items-center justify-center">
        {/* LOGO */}
        <img
          src="/bepit-logo.png"
          alt="BEPIT"
          className="h-16 w-16 sm:h-20 sm:w-20 rounded-full shadow-sm mb-4"
        />

        {/* TÍTULO */}
        <h1 className="text-2xl sm:text-3xl font-bold tracking-wide mb-1">
          BEPIT Nexus
        </h1>

        {/* SUBTÍTULO */}
        <p className="text-base sm:text-lg opacity-80 mb-8">
          Escolha sua Região
        </p>

        {/* BOTÕES DAS REGIÕES */}
        <div className="w-full max-w-md flex flex-col items-stretch gap-3">
          {REGIOES_DISPONIVEIS.map((r) => (
            <button
              key={r.slug}
              onClick={() => handleSelect(r)}
              className="
                w-full
                rounded-xl border border-neutral-200 dark:border-neutral-700
                bg-white/80 dark:bg-neutral-800/80
                hover:bg-white dark:hover:bg-neutral-800
                px-5 py-4
                text-center
                text-base sm:text-lg font-medium
                shadow-sm
                transition
                focus:outline-none focus:ring-2 focus:ring-blue-500
              "
            >
              {r.nome}
            </button>
          ))}
        </div>

        {/* Espaço seguro inferior p/ iOS/Android */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}
