import React, { useEffect, useMemo, useState } from "react";

/**
 * Modal de avisos públicos por região
 * - Busca: GET /api/avisos/:slugDaRegiao  -> { items: [...] }
 * - Recebe initialItems (prefetch) para abrir instantâneo
 * - Abas dinâmicas por cidade; “Geral” quando cidade_id = null
 */
export default function AvisosModal({ regionSlug, onClose, apiBase, initialItems = [] }) {
  const [loading, setLoading] = useState(false);
  const [avisos, setAvisos] = useState(initialItems || []);
  const [activeTab, setActiveTab] = useState("geral"); // “geral” = avisos sem cidade

  // Se initialItems mudar (primeira abertura), sincroniza
  useEffect(() => {
    if (Array.isArray(initialItems)) {
      setAvisos(initialItems);
    }
  }, [initialItems]);

  // Fetch em background para atualizar após abrir (se necessário)
  useEffect(() => {
    let mounted = true;
    async function run() {
      try {
        setLoading(true);
        const slug = regionSlug || "regiao-dos-lagos";
        const resp = await fetch(`${apiBase}/api/avisos/${encodeURIComponent(slug)}`);
        const data = await resp.json();
        if (!mounted) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        setAvisos(items);
      } catch {
        if (!mounted) return;
      } finally {
        if (mounted) setLoading(false);
      }
    }
    // Só busca se ainda não temos nada (ou se quiser atualizar sempre, force run())
    if (!initialItems || initialItems.length === 0) {
      run();
    } else {
      // atualiza em background depois de abrir
      run();
    }
    return () => { mounted = false; };
  }, [regionSlug, apiBase]); // (intenção: atualizar se slug mudar)

  // Agrupa por cidade (null => "geral") usando campos já enviados pelo backend
  const grupos = useMemo(() => {
    const map = new Map(); // key: string (slug da cidade, nome da cidade ou "geral")
    for (const a of avisos) {
      const key =
        a.cidade_id
          ? (a.cidade_slug || a.cidade_nome || a.cidade_id)
          : "geral";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return map;
  }, [avisos]);

  // Ordenação por prioridade (alta > media > baixa) e por periodo_inicio desc
  function prioridadeRank(p) {
    const v = String(p || "").toLowerCase();
    if (v.includes("alta")) return 3;
    if (v.includes("media") || v.includes("média")) return 2;
    return 1; // baixa ou outro
  }

  const tabs = useMemo(() => {
    const arr = [];
    if (grupos.has("geral")) {
      arr.push({ id: "geral", label: "Geral" });
    }
    for (const key of grupos.keys()) {
      if (key === "geral") continue;
      // usar nome legível se tivermos
      const sample = grupos.get(key)?.[0];
      const label = sample?.cidade_nome || key;
      arr.push({ id: key, label });
    }
    if (!arr.length) arr.push({ id: "geral", label: "Geral" });
    return arr;
  }, [grupos]);

  useEffect(() => {
    const exists = tabs.some(t => t.id === activeTab);
    if (!exists) setActiveTab(tabs[0]?.id || "geral");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);

  const lista = useMemo(() => {
    const arr = grupos.get(activeTab) || grupos.get("geral") || [];
    return arr
      .slice()
      .sort((a, b) => {
        const pr = prioridadeRank(b.prioridade) - prioridadeRank(a.prioridade);
        if (pr !== 0) return pr;
        const tA = new Date(a.periodo_inicio || a.created_at || 0).getTime();
        const tB = new Date(b.periodo_inicio || b.created_at || 0).getTime();
        return tB - tA;
      });
  }, [grupos, activeTab]);

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
        aria-label="Fechar avisos"
        title="Fechar"
      />
      {/* Caixa */}
      <div className="relative z-[1000] w-[95vw] max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xl">
        {/* Cabeçalho */}
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="text-lg font-semibold">⚠️ Avisos da Região</div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            Fechar
          </button>
        </div>

        {/* Abas */}
        <div className="px-4 pt-3">
          <div className="flex flex-wrap gap-2">
            {tabs.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1.5 rounded-full border text-sm transition ${
                  activeTab === t.id
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-50 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Conteúdo */}
        <div className="px-4 pb-4 pt-2 overflow-y-auto max-h-[65vh]">
          {loading ? (
            <div className="py-10 text-center text-sm opacity-80">Carregando avisos…</div>
          ) : lista.length === 0 ? (
            <div className="py-10 text-center text-sm opacity-80">Nenhum aviso no momento.</div>
          ) : (
            <ul className="space-y-3">
              {lista.map((a) => (
                <li key={a.id} className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                  <div className="text-sm opacity-80 mb-1">
                    {a.periodo_inicio ? new Date(a.periodo_inicio).toLocaleString() : ""}
                    {a.periodo_fim ? ` — ${new Date(a.periodo_fim).toLocaleString()}` : ""}
                    {a.cidade_nome ? ` · ${a.cidade_nome}` : ""}
                  </div>
                  <div className="text-base font-semibold mb-1">
                    {a.titulo || "Aviso"}
                    {a.prioridade ? (
                      <span className="ml-2 text-xs px-2 py-0.5 rounded-full border border-neutral-300 dark:border-neutral-700">
                        {String(a.prioridade).toUpperCase()}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap">
                    {a.descricao || ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
