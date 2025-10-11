import React, { useEffect, useMemo, useRef, useState } from "react";
import AvisosModal from "./AvisosModal";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "https://bepit-nexus-backend.onrender.com";

export default function ChatPage() {
  const [region, setRegion] = useState(() => {
    try {
      const raw = localStorage.getItem("bepit_region");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!region) window.location.replace("/");
  }, [region]);

  const [isDark, setIsDark] = useState(() => {
    try {
      const raw = localStorage.getItem("bepit_theme");
      return raw ? raw === "dark" : true;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const html = document.documentElement;
    if (isDark) {
      html.classList.add("dark");
      localStorage.setItem("bepit_theme", "dark");
    } else {
      html.classList.remove("dark");
      localStorage.setItem("bepit_theme", "light");
    }
  }, [isDark]);

  // --- NOVO: cache de avisos para abrir modal instantâneo
  const [avisosCache, setAvisosCache] = useState(null);
  const [avisosLoading, setAvisosLoading] = useState(false);
  const [isAvisosOpen, setIsAvisosOpen] = useState(false);

  async function fetchAvisos() {
    if (!region?.slug || avisosLoading) return;
    try {
      setAvisosLoading(true);
      const resp = await fetch(`${API_BASE}/api/avisos/${encodeURIComponent(region.slug)}`);
      const json = await resp.json();
      setAvisosCache(Array.isArray(json?.items) ? json.items : []);
    } catch {
      setAvisosCache([]);
    } finally {
      setAvisosLoading(false);
    }
  }

  // Prefetch ao montar a tela (deixa pronto para abrir rápido)
  useEffect(() => {
    if (region?.slug) fetchAvisos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region?.slug]);

  const [messages, setMessages] = useState(() => {
    const nomeRegiao = region?.name || "sua região";
    const welcome = `Olá! Eu sou o BEPIT, seu concierge IA em ${nomeRegiao}. Dica: antes de qualquer pergunta, vale checar os ⚠️ Avisos da Região — às vezes eles já respondem dúvidas importantes de hoje.`;
    return [{ id: "welcome", role: "assistant", text: welcome, ts: Date.now() }];
  });
  const [input, setInput] = useState("");

  const quickChips = useMemo(
    () => [
      { id: "chip-rest", label: "🍽️ Restaurantes", text: "Quero opções de restaurantes" },
      { id: "chip-passeios", label: "⛵ Passeios", text: "Quais passeios de barco você recomenda?" },
      { id: "chip-praias", label: "🏖️ Praias", text: "Quais praias imperdíveis?" },
      { id: "chip-dicas", label: "💡 Dicas", text: "Dicas rápidas para hoje" }
    ],
    []
  );

  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text) return;

    const userMsg = { id: crypto.randomUUID(), role: "user", text, ts: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");

    const typingId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: typingId, role: "assistant_typing", text: "•••", ts: Date.now() }]);

    try {
      const slug = region?.slug || "regiao-dos-lagos";
      const resp = await fetch(`${API_BASE}/api/chat/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });
      const data = await resp.json();
      setMessages(prev => prev.filter(m => m.id !== typingId));
      const reply = (data && data.reply) ? String(data.reply) : "Desculpe, não consegui responder agora.";
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: reply, ts: Date.now() }]);
    } catch {
      setMessages(prev => prev.filter(m => m.id !== typingId));
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: "Ops! Falha de conexão. Tente novamente.", ts: Date.now() }]);
    }
  }

  function handleChip(text) {
    setInput(text);
  }

  if (!region) return null;

  return (
    <div className="min-h-dvh bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 flex flex-col">
      {/* Cabeçalho */}
      <header className="border-b border-neutral-200/70 dark:border-neutral-800 sticky top-0 z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3 grid grid-cols-3 items-center">
          {/* Esquerda */}
          <div className="flex items-center gap-3 justify-start">
            <button
              type="button"
              onClick={() => window.location.replace("/")}
              className="px-3 py-1.5 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
              aria-label="Voltar"
              title="Voltar"
            >
              ← Voltar
            </button>
            <img
              src="/bepit-logo.png"
              alt="BEPIT"
              className="h-8 w-8 rounded-md object-contain"
              draggable="false"
            />
            <div className="text-xl font-semibold tracking-tight">BEPIT</div>
          </div>

          {/* Centro */}
          <div className="flex items-center justify-center text-base sm:text-lg font-medium truncate">
            {region?.name || "Região"}
          </div>

          {/* Direita */}
          <div className="flex items-center gap-3 justify-end">
            <button
              type="button"
              onMouseEnter={fetchAvisos}   // prefetch ao passar o mouse
              onFocus={fetchAvisos}
              onClick={() => {
                // abre o modal imediatamente; os dados já vão estar em cache (ou chegam em seguida)
                setIsAvisosOpen(true);
                if (!avisosCache && !avisosLoading) fetchAvisos();
              }}
              className="px-3 py-1.5 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition flex items-center gap-2"
              aria-label="Abrir avisos da região"
              title="Avisos da Região"
            >
              <span className="text-lg">⚠️</span>
              <span className="hidden sm:inline">{avisosLoading ? "Carregando..." : "Avisos"}</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDark(d => !d)}
              className="px-3 py-1.5 rounded-xl border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
              aria-label="Alternar tema"
              title="Alternar claro/escuro"
            >
              {isDark ? "🌙" : "☀️"}
            </button>
          </div>
        </div>

        {/* Chips (fixos no topo) */}
        <div className="max-w-5xl mx-auto px-4 pb-3">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {quickChips.map(chip => (
              <button
                key={chip.id}
                type="button"
                onClick={() => handleChip(chip.text)}
                className="px-3 py-1.5 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 text-sm transition"
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Chat */}
      <main className="flex-1">
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="space-y-3">
            {messages.map(msg => {
              if (msg.role === "assistant_typing") {
                return (
                  <div key={msg.id} className="flex">
                    <div className="px-3 py-2 rounded-2xl bg-neutral-100 dark:bg-neutral-800 animate-pulse">•••</div>
                  </div>
                );
              }
              const isUser = msg.role === "user";
              return (
                <div key={msg.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] sm:max-w-[70%] px-4 py-2 rounded-2xl ${
                      isUser
                        ? "bg-blue-600 text-white rounded-br-sm"
                        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-50 rounded-bl-sm"
                    }`}
                  >
                    <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </div>
      </main>

      {/* Input */}
      <footer className="sticky bottom-0 z-40 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-t border-neutral-200/70 dark:border-neutral-800">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-2">
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
              placeholder="Escreva sua mensagem..."
              className="flex-1 h-10 sm:h-11 px-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <button
              type="button"
              onClick={handleSend}
              className="h-10 sm:h-11 px-4 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition"
            >
              Enviar
            </button>
          </div>
        </div>
      </footer>

      {/* Modal de Avisos (abre com cache inicial) */}
      {isAvisosOpen && (
        <AvisosModal
          regionSlug={region?.slug}
          onClose={() => setIsAvisosOpen(false)}
          apiBase={API_BASE}
          initialItems={avisosCache || []}
        />
      )}
    </div>
  );
}
