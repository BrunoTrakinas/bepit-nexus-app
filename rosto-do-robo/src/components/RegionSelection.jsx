import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ThemeToggleButton from "./ThemeToggleButton.jsx";

/**
 * Tela de seleção de região
 * - Logo centralizada
 * - “Bepit Nexus” + “Escolha sua Região” centralizados
 * - Cartões (botões) de regiões centralizados, um embaixo do outro (responsivo)
 * - Botão de tema no topo direito
 */
export default function RegionSelection() {
  const navigate = useNavigate();

  // Exemplo de regiões disponíveis (ajuste conforme seu backend)
  const regions = [
    { slug: "regiao-dos-lagos", nome: "Região dos Lagos" },
    // adicione outras regiões aqui quando estiverem ativas
  ];

  const handleSelect = (region) => {
    try {
      // grava de forma compatível com telas que leem "name" OU "nome"
      const payload = { ...region, name: region?.nome || region?.name };
      localStorage.setItem("bepit_region", JSON.stringify(payload));
    } catch {}
    navigate("/chat");
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Top bar com toggle de tema */}
      <div className="w-full flex items-center justify-end px-4 py-3">
        <ThemeToggleButton />
      </div>

      {/* Conteúdo centralizado */}
      <main className="max-w-3xl mx-auto px-4">
        <div className="flex flex-col items-center justify-center text-center gap-6 sm:gap-8 pt-10 pb-16">
          {/* Logo */}
          <img
            src="/bepit-logo.png"
            alt="BEPIT"
            className="h-20 w-20 sm:h-24 sm:w-24 md:h-28 md:w-28 rounded-full shadow"
          />

          {/* Título “Bepit Nexus” */}
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">
            Bepit Nexus
          </h1>

          {/* Subtítulo */}
          <p className="text-base sm:text-lg md:text-xl text-slate-600 dark:text-slate-300">
            Escolha sua Região
          </p>

          {/* Lista de regiões */}
          <div className="w-full max-w-md flex flex-col items-stretch gap-3 mt-2">
            {regions.map((r) => (
              <button
                key={r.slug}
                onClick={() => handleSelect(r)}
                className="
                  w-full rounded-2xl border border-slate-200 bg-white px-5 py-4 text-lg font-semibold
                  shadow-sm hover:shadow transition
                  text-center
                  dark:border-slate-700 dark:bg-slate-900
                "
              >
                {r.nome || r.name}
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
