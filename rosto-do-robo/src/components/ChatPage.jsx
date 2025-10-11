import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AvisosModal from "./AvisosModal";

const REGION_KEY = "bepit_region";
const THEME_KEY = "bepit_theme";

// helper de scroll
const useAutoScroll = (dep) => {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [dep]);
  return ref;
};

export default function ChatPage() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "light");
  const [region, setRegion] = useState(() => {
    try {
      const raw = localStorage.getItem(REGION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // redireciona se não houver região
  useEffect(() => {
    if (!region?.slug) navigate("/");
  }, [region, navigate]);

  // aplica tema
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // mensagens
  const welcome = useMemo(() => {
    const rname = region?.name || "sua região";
    return `Olá! Eu sou o BEPIT, seu concierge IA em ${rname}. Dica: antes de perguntar, vale a pena conferir os avisos da região — pode ter interdições, maré, trânsito ou eventos que impactam sua experiência.`;
  }, [region]);

  const [messages, setMessages] = useState(() => [
    { id: "welcome", from: "bot", text: welcome, ts: Date.now() },
  ]);

  // atualiza welcome se região mudar
  useEffect(() => {
    setMessages((prev) => {
      if (prev.length === 0 || prev[0].id !== "welcome") return prev;
      const clone = [...prev];
      clone[0] = { ...clone[0], text: welcome };
      return clone;
    });
  }, [welcome]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAvisos, setShowAvisos] = useState(false);

  const listRef = useAutoScroll(messages);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

  const sendMessage = async (text) => {
    if (!text.trim() || !region?.slug) return;
    const userMsg = { id: crypto.randomUUID(), from: "user", text, ts: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const resp = await fetch(`${API_BASE}/api/chat/${region.slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const json = await resp.json();
      const reply = json?.reply || "Algo deu errado. Tente novamente.";
      setMessages((m) => [...m, { id: crypto.randomUUID(), from: "bot", text: reply, ts: Date.now() }]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), from: "bot", text: "Erro de conexão. Tente novamente.", ts: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  // chips (sempre no topo)
  const chips = [
    "Restaurantes",
    "Passeios",
    "Praias",
    "Dicas",
  ];

  // tamanho maior no cabeçalho (logo, nome, região)
  const headerLogoClasses = "w-9 h-9 md:w-10 md:h-10";          // aumentado
  const headerBrandClasses = "text-lg md:text-xl font-bold";     // aumentado
  const headerRegionClasses = "text-base md:text-lg font-semibold"; // aumentado

  return (
    <div className="min-h-[100svh] bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex flex-col">
      {/* Cabeçalho */}
      <header className="sticky top-0 z-50 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-3 sm:px-4">
          <div className="grid grid-cols-3 items-center h-16">
            {/* Esquerda: Voltar + Logo + BEPIT */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigate("/")}
                className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-sm bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition"
              >
                ← Voltar
              </button>

              <div className="flex items-center gap-2">
                <img
                  src="/bepit-logo.png"
                  alt="BEPIT"
                  className={`${headerLogoClasses} rounded-full`}
                  draggable="false"
                />
                <span className={headerBrandClasses}>BEPIT</span>
              </div>
            </div>

            {/* Centro: Nome da região */}
            <div className="flex justify-center">
              <div className={headerRegionClasses}>
                {region?.name || "Região"}
              </div>
            </div>

            {/* Direita: Avisos + tema */}
            <div className="flex justify-end items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAvisos(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-sm bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition"
              >
                <span className="text-base">⚠️</span> Avisos
              </button>

              <button
                type="button"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className="inline-flex items-center justify-center rounded-xl border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-sm bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition"
                aria-label="Alternar tema"
              >
                🌓
              </button>
            </div>
          </div>
        </div>

        {/* Chips fixos (centralizados) */}
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80">
          <div className="max-w-5xl mx-auto px-3 sm:px-4">
            <div className="flex justify-center gap-2 py-2">
              {chips.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => sendMessage(c)}
                  className="px-3 py-1.5 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-700 text-sm"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Lista de mensagens */}
      <main
        ref={listRef}
        className="flex-1 overflow-y-auto max-w-5xl w-full mx-auto px-3 sm:px-4 pt-4 pb-28"
      >
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-3 shadow-sm ${
                m.from === "user"
                  ? "self-end bg-blue-600 text-white"
                  : "self-start bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700"
              }`}
            >
              <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
            </div>
          ))}

          {loading && (
            <div className="self-start max-w-[70%] rounded-2xl px-4 py-3 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
              <span className="inline-flex items-center gap-1">
                <span className="animate-bounce">•</span>
                <span className="animate-bounce [animation-delay:120ms]">•</span>
                <span className="animate-bounce [animation-delay:240ms]">•</span>
              </span>
            </div>
          )}
        </div>
      </main>

      {/* Input fixo (com safe-area) */}
      <form
        onSubmit={handleSubmit}
        className="sticky bottom-0 z-50 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-t border-neutral-200 dark:border-neutral-800"
      >
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Digite sua mensagem…"
              className="flex-1 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500/50"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-3 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-60"
            >
              Enviar
            </button>
          </div>
        </div>
      </form>

      {/* Modal de Avisos */}
      {showAvisos && (
        <AvisosModal
          regionSlug={region?.slug}
          onClose={() => setShowAvisos(false)}
        />
      )}
    </div>
  );
}
