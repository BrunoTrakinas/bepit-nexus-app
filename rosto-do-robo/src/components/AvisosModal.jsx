// src/components/AvisosModal.jsx
import React, { useEffect, useMemo, useState } from "react";

/**
 * Modal de Avisos da Região
 *
 * Props:
 * - isOpen: boolean — controla a visibilidade.
 * - onClose: function — fecha o modal.
 * - regionSlug: string — slug da região (ex.: "regiao-dos-lagos").
 * - apiBaseUrl: string — base da API (ex.: import.meta.env.VITE_API_BASE_URL).
 *
 * Comportamento:
 * - Busca GET `${apiBaseUrl}/api/avisos/${regionSlug}`.
 * - Aceita tanto { data: [...] } quanto { items: [...] } do backend.
 * - Cria abas dinâmicas: "Geral" (cidade_id nulo) e uma aba por cidade.
 *   - Usa "cidade_nome" se o backend enviar; caso contrário,
 *     rotula como "Cidade <XXXX>" (prefixo do UUID) para não ficar vazio.
 */
export default function AvisosModal({
  isOpen,
  onClose,
  regionSlug,
  apiBaseUrl,
}) {
  const [loading, setLoading] = useState(false);
  const [avisos, setAvisos] = useState([]);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("Geral");

  // Fecha com ESC
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Carrega avisos quando abrir ou quando mudar a região
  useEffect(() => {
    if (!isOpen) return;
    if (!regionSlug || !apiBaseUrl) {
      setError("Configuração ausente: regionSlug ou apiBaseUrl.");
      return;
    }

    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/avisos/${encodeURIComponent(
          regionSlug
        )}`;
        const resp = await fetch(url, { method: "GET" });
        if (!resp.ok) {
          throw new Error(`Falha ao buscar avisos (${resp.status})`);
        }
        const json = await resp.json();

        // Aceita backend em { data: [...] } OU { items: [...] }
        const arr = Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.items)
          ? json.items
          : [];

        if (!cancelled) {
          setAvisos(Array.isArray(arr) ? arr : []);
          setActiveTab("Geral");
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e?.message ||
              "Não foi possível carregar os avisos. Tente novamente."
          );
          setAvisos([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, regionSlug, apiBaseUrl]);

  // Agrupa avisos por cidade (aba "Geral" = cidade nula)
  const grupos = useMemo(() => {
    const out = {
      Geral: [],
    };
    for (const a of avisos) {
      const rawId = a?.cidade_id || null;
      if (!rawId) {
        out.Geral.push(a);
        continue;
      }

      // Se o backend trouxer `cidade_nome`, usamos; senão um rótulo neutro
      const label =
        a?.cidade_nome ||
        a?.cidade ||
        `Cidade ${String(rawId).slice(0, 4).toUpperCase()}`;

      if (!out[label]) out[label] = [];
      out[label].push(a);
    }
    return out;
  }, [avisos]);

  // Lista de abas em ordem: "Geral" primeiro, depois cidades em ordem alfabética
  const abas = useMemo(() => {
    const keys = Object.keys(grupos).filter(Boolean);
    const others = keys.filter((k) => k !== "Geral").sort((a, b) => a.localeCompare(b, "pt-BR"));
    return ["Geral", ...others];
  }, [grupos]);

  // Conteúdo da aba ativa
  const itensAbaAtiva = useMemo(() => {
    return grupos[activeTab] || [];
  }, [grupos, activeTab]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="avisos-title"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl dark:bg-neutral-900">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between border-b border-neutral-200 p-4 dark:border-neutral-800">
          <h2
            id="avisos-title"
            className="text-lg font-semibold text-neutral-900 dark:text-neutral-100"
          >
            Avisos da Região
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="Fechar"
            type="button"
          >
            ✕
          </button>
        </div>

        {/* Abas */}
        <div className="flex flex-wrap gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          {abas.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={[
                  "rounded-full px-4 py-1.5 text-sm transition",
                  isActive
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700",
                ].join(" ")}
              >
                {tab}
                <span className="ml-2 rounded-full bg-black/10 px-2 py-0.5 text-[11px] text-black/70 dark:bg-white/10 dark:text-white/70">
                  {(grupos[tab] || []).length}
                </span>
              </button>
            );
          })}
        </div>

        {/* Corpo */}
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {/* Estados */}
          {loading && (
            <div className="py-8 text-center text-neutral-600 dark:text-neutral-300">
              Carregando avisos…
            </div>
          )}

          {!loading && error && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}

          {!loading && !error && itensAbaAtiva.length === 0 && (
            <div className="py-8 text-center text-neutral-600 dark:text-neutral-300">
              Nenhum aviso nesta aba.
            </div>
          )}

          {!loading &&
            !error &&
            itensAbaAtiva.length > 0 &&
            itensAbaAtiva.map((a) => (
              <div
                key={a.id}
                className="mb-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm last:mb-0 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  {/* Badge de cidade, se houver */}
                  {a?.cidade_nome ? (
                    <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                      {a.cidade_nome}
                    </span>
                  ) : a?.cidade_id ? (
                    <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                      Cidade {String(a.cidade_id).slice(0, 4).toUpperCase()}
                    </span>
                  ) : (
                    <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
                      Geral
                    </span>
                  )}
                </div>

                <h3 className="mb-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {a.titulo || "Aviso"}
                </h3>

                {a.descricao && (
                  <p className="mb-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
                    {a.descricao}
                  </p>
                )}

                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {/* Período (quando existir) */}
                  {a.periodo_inicio || a.periodo_fim ? (
                    <span>
                      {a.periodo_inicio
                        ? new Date(a.periodo_inicio).toLocaleString()
                        : "Início não informado"}
                      {" — "}
                      {a.periodo_fim
                        ? new Date(a.periodo_fim).toLocaleString()
                        : "Sem fim definido"}
                    </span>
                  ) : (
                    <span>Sem período definido</span>
                  )}
                </div>
              </div>
            ))}
        </div>

        {/* Rodapé */}
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
