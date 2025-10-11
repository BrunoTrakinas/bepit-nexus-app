import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * AvisosModal — Modal de avisos com:
 * - Abas dinâmicas: "Geral" + 1 aba por cidade (se houver), com contadores
 * - Busca local (título/descrição)
 * - Filtro "Somente ativos"
 * - Ordenação por período (início desc)
 * - Skeleton loader durante `loading`
 * - Acessibilidade: ESC fecha, ARIA, focus inicial, "trap" simples de tabulação
 *
 * PROPS:
 *  - open: boolean
 *  - onClose: function
 *  - loading: boolean
 *  - avisos: array
 *  - onRefresh?: function  (opcional — exibir botão "Atualizar")
 *
 * CAMPOS DE CADA AVISO (usados aqui):
 *  - id (uuid/string)
 *  - titulo (string)
 *  - descricao (string)
 *  - ativo (boolean)
 *  - cidade_nome (string|null) — ou cidade?.nome
 *  - periodo_inicio (timestamp|null)
 *  - periodo_fim (timestamp|null)
 *  - created_at (timestamp|null)
 */

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

function formatDateTime(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
  } catch {
    return null;
  }
}

function toCityLabel(item) {
  // Tenta cidade_nome direto; depois item.cidade?.nome; senão "Geral"
  const direct = typeof item?.cidade_nome === "string" && item.cidade_nome.trim();
  if (direct) return direct;
  const nested = typeof item?.cidade?.nome === "string" && item.cidade.nome.trim();
  if (nested) return nested;
  return "Geral";
}

function sortByPeriodDesc(a, b) {
  const ai = a?.periodo_inicio ? new Date(a.periodo_inicio).getTime() : 0;
  const bi = b?.periodo_inicio ? new Date(b.periodo_inicio).getTime() : 0;
  if (bi !== ai) return bi - ai;
  // fallback secundário: created_at
  const ac = a?.created_at ? new Date(a.created_at).getTime() : 0;
  const bc = b?.created_at ? new Date(b.created_at).getTime() : 0;
  return bc - ac;
}

function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [
    item?.titulo || "",
    item?.descricao || "",
    toCityLabel(item) || "",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q.toLowerCase());
}

export default function AvisosModal({ open, onClose, loading, avisos, onRefresh }) {
  // Estado de busca e filtro de "somente ativos"
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);

  // Fechar com ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Agrupa por aba (Geral + cidades)
  const grouped = useMemo(() => {
    const map = new Map(); // key: aba -> itens
    map.set("Geral", []);

    const items = Array.isArray(avisos) ? avisos.slice() : [];
    items.forEach((it) => {
      const tab = toCityLabel(it);
      if (!map.has(tab)) map.set(tab, []);
      map.get(tab).push(it);
    });

    // Ordena cada aba
    for (const [k, arr] of map.entries()) {
      arr.sort(sortByPeriodDesc);
      map.set(k, arr);
    }

    return map;
  }, [avisos]);

  // Abas ordenadas: Geral primeiro, depois cidades em ordem alfabética
  const tabs = useMemo(() => {
    const keys = Array.from(grouped.keys());
    const others = keys.filter((k) => k !== "Geral").sort((a, b) => a.localeCompare(b));
    return ["Geral", ...others];
  }, [grouped]);

  // Ativa a aba "Geral" por padrão, ou a primeira disponível
  const [activeTab, setActiveTab] = useState(() => "Geral");

  useEffect(() => {
    // Se a aba ativa sumiu (dados mudaram), readequa
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0] || "Geral");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.join("|")]);

  // Aplica filtros/busca por aba
  const filteredPerTab = useMemo(() => {
    const out = new Map();
    tabs.forEach((t) => {
      let arr = grouped.get(t) || [];
      if (onlyActive) arr = arr.filter((x) => x?.ativo === true);
      if (query.trim()) arr = arr.filter((x) => matchesQuery(x, query));
      out.set(t, arr);
    });
    return out;
  }, [grouped, tabs, onlyActive, query]);

  // Contadores por aba (após filtro "onlyActive" e "query")
  const counters = useMemo(() => {
    const map = new Map();
    tabs.forEach((t) => {
      const arr = filteredPerTab.get(t) || [];
      map.set(t, arr.length);
    });
    return map;
  }, [tabs, filteredPerTab]);

  // Referências para A11y (focus inicial + trap)
  const closeBtnRef = useRef(null);
  const modalRef = useRef(null);

  // Foco inicial no botão fechar
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        closeBtnRef.current?.focus?.();
      }, 20);
    }
  }, [open]);

  // Focus trap simples (ciclo dentro do modal)
  useEffect(() => {
    if (!open) return;
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const trap = (e) => {
      if (e.key !== "Tab") return;
      const root = modalRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll(sel)).filter(
        (el) => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden")
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [open]);

  if (!open) return null;

  const activeList = filteredPerTab.get(activeTab) || [];
  const hasAny = (Array.isArray(avisos) && avisos.length > 0) || false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      aria-modal="true"
      role="dialog"
      aria-labelledby="avisos-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Container */}
      <div
        ref={modalRef}
        className="
          relative w-full sm:max-w-4xl
          sm:rounded-2xl sm:shadow-xl
          bg-white dark:bg-slate-900
          border-t sm:border border-slate-200 dark:border-slate-700
          animate-[fadeIn_180ms_ease-out]
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
              {/* ícone alerta */}
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L1 21h22L12 2zm1 16h-2v-2h2v2zm0-4h-2V9h2v5z" />
              </svg>
            </div>
            <h2 id="avisos-title" className="text-lg sm:text-xl font-bold tracking-tight">
              Avisos da Região
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {typeof onRefresh === "function" && (
              <button
                type="button"
                onClick={onRefresh}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 active:scale-[0.98] transition dark:border-slate-700 dark:hover:bg-slate-800"
                title="Atualizar avisos"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M17.65 6.35A7.95 7.95 0 0012 4V1L7 6l5 5V7c2.76 0 5 2.24 5 5 0 .65-.13 1.27-.35 1.84l1.46 1.46A7.932 7.932 0 0020 12c0-2.21-.9-4.21-2.35-5.65zM6.35 17.65A7.95 7.95 0 0012 20v3l5-5-5-5v3c-2.76 0-5-2.24-5-5 0-.65.13-1.27.35-1.84L4.89 6.7A7.932 7.932 0 004 12c0 2.21.9 4.21 2.35 5.65z" />
                </svg>
                Atualizar
              </button>
            )}
            <button
              type="button"
              ref={closeBtnRef}
              onClick={onClose}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 active:scale-[0.98] transition dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Fechar
            </button>
          </div>
        </div>

        {/* Toolbar: busca + filtro */}
        <div className="px-4 sm:px-6 py-2 border-b border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <div className="flex-1">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por título, descrição ou cidade…"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
          <label className="inline-flex select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
            />
            Somente ativos
          </label>
        </div>

        {/* Tabs */}
        <div className="px-3 sm:px-6 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 overflow-x-auto">
          {tabs.map((t) => {
            const count = counters.get(t) || 0;
            const active = activeTab === t;
            return (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={classNames(
                  "whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold border transition",
                  active
                    ? "bg-amber-500 text-white border-amber-600"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-700"
                )}
              >
                {t}
                <span
                  className={classNames(
                    "ml-2 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                    active
                      ? "bg-white/20 text-white"
                      : "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100"
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Conteúdo */}
        <div className="max-h-[70vh] overflow-y-auto px-4 sm:px-6 py-4">
          {/* Loading skeleton */}
          {loading && (
            <ul className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <li
                  key={`sk-${i}`}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
                >
                  <div className="h-5 w-2/3 bg-slate-200 dark:bg-slate-700 rounded mb-3 animate-pulse" />
                  <div className="h-4 w-full bg-slate-200 dark:bg-slate-700 rounded mb-2 animate-pulse" />
                  <div className="h-4 w-4/5 bg-slate-200 dark:bg-slate-700 rounded mb-3 animate-pulse" />
                  <div className="flex gap-3">
                    <div className="h-4 w-24 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
                    <div className="h-4 w-32 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Sem dados */}
          {!loading && !hasAny && (
            <div className="py-10 text-center text-slate-600 dark:text-slate-300">
              Nenhum aviso no momento.
            </div>
          )}

          {/* Sem itens na aba ativa após filtros */}
          {!loading && hasAny && activeList.length === 0 && (
            <div className="py-10 text-center text-slate-600 dark:text-slate-300">
              Sem avisos para “{activeTab}” {onlyActive && "(filtrado por ativos)"}.
            </div>
          )}

          {/* Lista */}
          {!loading && activeList.length > 0 && (
            <ul className="space-y-3">
              {activeList.map((a) => {
                const inicio = formatDateTime(a?.periodo_inicio);
                const fim = formatDateTime(a?.periodo_fim);
                const ativo = a?.ativo === true;

                return (
                  <li
                    key={a.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="text-base sm:text-lg font-bold leading-snug">
                        {a?.titulo || "Sem título"}
                      </h3>
                      <span
                        className={classNames(
                          "text-xs sm:text-sm font-semibold rounded-full px-2 py-0.5 shrink-0",
                          ativo
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
                            : "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100"
                        )}
                        title={ativo ? "Aviso Ativo" : "Aviso Inativo"}
                      >
                        {ativo ? "Ativo" : "Inativo"}
                      </span>
                    </div>

                    {a?.descricao && (
                      <p className="mt-2 text-sm sm:text-base text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                        {a.descricao}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                      {toCityLabel(a) !== "Geral" && <span>📍 {toCityLabel(a)}</span>}
                      {inicio && <span>🗓 Início: {inicio}</span>}
                      {fim && <span>⏳ Fim: {fim}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  );
}
