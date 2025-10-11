import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// Opcional: se você já tem um componente de avisos, pode trocar por import real.
// Aqui deixo um modal simples inline para não quebrar nada.
function AvisosModal({ open, onClose, regionSlug }) {
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState([]); // [{cidade: 'Cabo Frio', itens: [...]}, ...]
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    (async () => {
      try {
        setLoading(true);
        const base = import.meta.env.VITE_API_BASE_URL || "";
        const url = `${base}/api/avisos/${regionSlug}`;
        const r = await fetch(url);
        const json = await r.json();
        const data = Array.isArray(json?.data) ? json.data : [];

        // Agrupa por cidade (ou "Geral")
        const grupos = new Map();
        for (const a of data) {
          const chave =
            a?.cidade_nome ||
            a?.cidade ||
            a?.cidade_slug ||
            "Geral";
          if (!grupos.has(chave)) grupos.set(chave, []);
          grupos.get(chave).push(a);
        }
        const arr = Array.from(grupos.entries()).map(([cidade, itens]) => ({
          cidade,
          itens: itens.sort((a, b) =>
            String(b?.created_at || "").localeCompare(String(a?.created_at || ""))
          ),
        }));
        if (!cancel) {
          setTabs(arr);
          setActive(0);
        }
      } catch {
        if (!cancel) setTabs([]);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [open, regionSlug]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-lg">
        <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800">
          <h3 className="text-lg font-semibold">Avisos da Região</h3>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition text-sm"
          >
            Fechar
          </button>
        </div>

        <div className="px-4 pt-3">
          {/* Abas */}
          <div className="flex flex-wrap gap-2">
            {tabs.map((t, i) => (
              <button
                key={t.cidade + i}
                onClick={() => setActive(i)}
                className={`px-3 py-1.5 rounded-full border text-sm transition ${
                  active === i
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                }`}
              >
                {t.cidade}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="text-sm text-neutral-500">Carregando avisos…</div>
          ) : tabs.length === 0 ? (
            <div className="text-sm text-neutral-500">
              Nenhum aviso ativo no momento.
            </div>
          ) : (
            <ul className="space-y-3">
              {(tabs[active]?.itens || []).map((av) => (
                <li
                  key={av.id}
                  className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 bg-white dark:bg-neutral-900"
                >
                  <div className="text-sm font-medium">{av.titulo || "Aviso"}</div>
                  {av.descricao ? (
                    <p className="text-sm text-neutral-600 dark:text-neutral-300 mt-1 whitespace-pre-line">
                      {av.descricao}
                    </p>
                  ) : null}
                  {av.periodo_inicio || av.periodo_fim ? (
                    <div className="text-xs text-neutral-500 mt-2">
                      {av.periodo_inicio ? `Início: ${av.periodo_inicio}` : ""}
                      {av.periodo_inicio && av.periodo_fim ? " · " : ""}
                      {av.periodo_fim ? `Fim: ${av.periodo_fim}` : ""}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const navigate = useNavigate();

  // Região do localStorage
  const region = useMemo(() => {
    try {
      const raw = localStorage.getItem("bepit_region");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.slug && parsed.name ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  // Redireciona se não tiver região
  useEffect(() => {
    if (!region) navigate("/");
  }, [region, navigate]);

  // Tema salvo
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
    try {
      localStorage.setItem("bepit_theme", next);
    } catch {}
  }

  // Mensagens / chat
  const [messages, setMessages] = useState(() => {
    const name = region?.name || "Região";
    const welcome =
      `Olá! Eu sou o BEPIT, seu concierge IA em ${name}. ` +
      `Dica: antes de perguntar, vale a pena conferir os avisos da região — ` +
      `pode ter interdições, maré, trânsito ou eventos que impactam sua experiência.`;
    return [
      { id: "welcome", from: "bot", text: welcome, ts: Date.now() },
    ];
  });

  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef(null);

  // Auto scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999, behavior: "smooth" });
  }, [messages, typing]);

  // Envio
  async function sendMessage(text) {
    const content = (text ?? input ?? "").trim();
    if (!content || !region) return;

    // adiciona msg do usuário
    const userMsg = { id: crypto.randomUUID(), from: "user", text: content, ts: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setTyping(true);

    try {
      const base = import.meta.env.VITE_API_BASE_URL || "";
      const url = `${base}/api/chat/${region.slug}`;
      const body = { message: content };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      const reply = json?.reply || "Desculpe, não consegui responder agora.";
      const botMsg = { id: crypto.randomUUID(), from: "bot", text: reply, ts: Date.now() };
      setMessages((m) => [...m, botMsg]);
    } catch {
      const botMsg = {
        id: crypto.randomUUID(),
        from: "bot",
        text: "Algo saiu do previsto ao tentar falar com o servidor.",
        ts: Date.now(),
      };
      setMessages((m) => [...m, botMsg]);
    } finally {
      setTyping(false);
    }
  }

  // Sugestões rápidas (chips)
  const suggestions = [
    "Restaurantes",
    "Passeios",
    "Praias",
    "Dicas",
  ];
  function handleChipClick(label) {
    // Você pode mapear para prompts prontos se quiser
    sendMessage(label);
  }

  // Modal de avisos
  const [avisosOpen, setAvisosOpen] = useState(false);

  if (!region) return null;

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex flex-col">
      {/* HEADER — grid 3 colunas p/ centralizar o nome da região */}
      <header className="sticky top-0 z-50 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-5xl px-3 sm:px-4">
          <div className="grid grid-cols-3 items-center h-14">
            {/* ESQUERDA: Voltar + logo/nome */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/")}
                className="rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm hover:shadow transition"
              >
                ← Voltar
              </button>
              <div className="flex items-center gap-2">
                <img
                  src="/bepit-logo.png"
                  alt="BEPIT"
                  className="w-7 h-7 rounded-full object-cover"
                />
                <span className="font-semibold tracking-tight hidden sm:inline">
                  BEPIT
                </span>
              </div>
            </div>

            {/* CENTRO: Região */}
            <div className="flex items-center justify-center">
              <div className="text-sm sm:text-base font-medium truncate">
                {region.name}
              </div>
            </div>

            {/* DIREITA: Avisos + Tema */}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setAvisosOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700
                           bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm hover:shadow transition"
              >
                <span>⚠️</span> <span className="hidden sm:inline">Avisos</span>
              </button>

              <button
                onClick={toggleTheme}
                aria-label="Alternar tema"
                className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700
                           bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm hover:shadow transition"
              >
                <span className="text-base">{theme === "dark" ? "☀️" : "🌙"}</span>
                <span className="hidden sm:inline">
                  {theme === "dark" ? "Claro" : "Escuro"}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* CHIPS — centralizados e sticky logo abaixo do header */}
        <div className="sticky top-14 z-40 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
          <div className="mx-auto max-w-5xl px-3 sm:px-4 py-2">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => handleChipClick(s)}
                  className="px-4 py-2 rounded-full text-sm font-medium
                             bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700
                             hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow transition"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* LISTA DE MENSAGENS */}
      <div ref={scrollRef} className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-3">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`w-full flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] md:max-w-[70%] rounded-2xl border shadow-sm px-4 py-3 leading-relaxed ${
                m.from === "user"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border-neutral-200 dark:border-neutral-800"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {/* Indicador "digitando..." */}
        {typing && (
          <div className="w-full flex justify-start">
            <div className="max-w-[70%] rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-800 px-4 py-3">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce [animation-delay:-0ms]" />
                <span className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce [animation-delay:120ms]" />
                <span className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce [animation-delay:240ms]" />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* INPUT */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage();
        }}
        className="border-t border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur"
      >
        <div className="mx-auto max-w-3xl px-3 sm:px-4 py-3 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Digite sua mensagem…"
            className="flex-1 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-800 px-4 py-2.5 outline-none focus:ring-2 ring-blue-500/40"
          />
          <button
            type="submit"
            className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm transition"
          >
            Enviar
          </button>
        </div>
      </form>

      {/* MODAL DE AVISOS */}
      <AvisosModal
        open={avisosOpen}
        onClose={() => setAvisosOpen(false)}
        regionSlug={region.slug}
      />
    </div>
  );
}
