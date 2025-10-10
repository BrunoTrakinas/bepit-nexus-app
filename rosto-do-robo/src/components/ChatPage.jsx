import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import AvisosModal from "./AvisosModal.jsx";
import SuggestionButtons from "./SuggestionButtons.jsx";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// Helper tema persistente
function useTheme() {
  useEffect(() => {
    const saved = localStorage.getItem("bepit_theme") || "light";
    document.documentElement.classList.toggle("dark", saved === "dark");
  }, []);
  const toggle = () => {
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("bepit_theme", next);
  };
  return { toggle };
}

// Boas-vindas dinâmicas com sugestão de checar avisos
function makeWelcome(regionName) {
  const nome = regionName || "sua região";
  return `Olá! Eu sou o BEPIT, seu concierge IA em ${nome}.
Antes de perguntar, recomendo tocar em “Avisos da Região” para ver alertas e novidades recentes. Como posso te ajudar?`;
}

// Typing Indicator (3 pontinhos)
function TypingDots() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="w-2 h-2 rounded-full bg-current opacity-60 animate-pulse"></span>
      <span className="w-2 h-2 rounded-full bg-current opacity-60 animate-[pulse_1s_0.2s_infinite]"></span>
      <span className="w-2 h-2 rounded-full bg-current opacity-60 animate-[pulse_1s_0.4s_infinite]"></span>
    </span>
  );
}

export default function ChatPage() {
  const navigate = useNavigate();
  const { toggle } = useTheme();

  // Região selecionada (obrigatória)
  const region = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("bepit_region") || "null");
    } catch {
      return null;
    }
  }, []);

  // Bloqueia acesso sem região
  useEffect(() => {
    if (!region?.slug || !region?.nome) navigate("/");
  }, [region, navigate]);

  // conversationId persistente
  const [conversationId, setConversationId] = useState(() => {
    const saved = localStorage.getItem("bepit_conversation_id");
    if (saved) return saved;
    const gen = crypto?.randomUUID?.() || String(Date.now());
    localStorage.setItem("bepit_conversation_id", gen);
    return gen;
  });

  // Estado do modal de avisos
  const [showAvisos, setShowAvisos] = useState(false);

  // Lista de mensagens e input
  const [messages, setMessages] = useState(() => {
    const initial = [];
    if (region?.nome) {
      initial.push({ id: "welcome", from: "assistant", text: makeWelcome(region.nome) });
    }
    return initial;
  });
  const [input, setInput] = useState("");

  // Loading/typing
  const [isTyping, setIsTyping] = useState(false);

  // Auto-scroll
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Envia uma mensagem
  const sendMessage = async (text) => {
    const content = text.trim();
    if (!content || !region?.slug) return;

    // Add mensagem do usuário
    const userMsg = { id: `u-${Date.now()}`, from: "user", text: content };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    try {
      const url = `${API_BASE}/api/chat/${encodeURIComponent(region.slug)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, conversationId })
      });

      const json = await resp.json().catch(() => ({}));
      const reply = (json && json.reply) ? String(json.reply) : "Desculpe, não consegui obter uma resposta agora.";

      // Add resposta
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, from: "assistant", text: reply }]);

      // Atualiza conversationId se backend devolver outro (opcional)
      if (json?.conversationId && json.conversationId !== conversationId) {
        localStorage.setItem("bepit_conversation_id", json.conversationId);
        setConversationId(json.conversationId);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          from: "assistant",
          text: "Tive um problema de rede ao falar com o servidor. Tente novamente."
        }
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  const onSuggestionClick = (text) => sendMessage(text);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/")}
              className="px-3 py-2 rounded-xl bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 transition"
              title="Trocar região"
            >
              ← Voltar
            </button>
            <img
              src="/bepit-logo.png"
              alt="BEPIT"
              className="h-8 w-auto"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <div className="font-medium">
              BEPIT • {region?.nome || "Região"}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAvisos(true)}
              className="px-3 py-2 rounded-xl bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:hover:bg-amber-500/30 transition"
              title="Avisos públicos da região"
            >
              ⚠️ Avisos da Região
            </button>
            <button
              onClick={toggle}
              className="px-3 py-2 rounded-xl bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 transition"
              title="Alternar tema"
            >
              🌓
            </button>
          </div>
        </div>
      </header>

      {/* Área do chat */}
      <main className="flex-1">
        <div className="max-w-4xl mx-auto px-4">
          {/* Lista de mensagens */}
          <div
            ref={scrollRef}
            className="mt-4 h-[calc(100vh-220px)] overflow-y-auto pr-1"
          >
            {messages.map((m) => (
              <div key={m.id} className={`w-full flex ${m.from === "user" ? "justify-end" : "justify-start"} mb-3`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 whitespace-pre-wrap leading-relaxed shadow-sm
                  ${m.from === "user"
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-bl-sm"}`}
                >
                  {m.text}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="w-full flex justify-start mb-3">
                <div className="max-w-[85%] rounded-2xl px-4 py-3 shadow-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800">
                  <TypingDots />
                </div>
              </div>
            )}

            {/* Sugestões (só enquanto está “no começo”) */}
            {messages.length <= 1 && (
              <div className="mt-3">
                <SuggestionButtons
                  onSelect={onSuggestionClick}
                  options={[
                    "Onde comer?",
                    "Passeios de barco",
                    "Melhores praias para família",
                    "Churrascaria com picanha"
                  ]}
                />
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Input */}
      <footer className="border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <form onSubmit={onSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Envie uma mensagem para o BEPIT em ${region?.nome || "sua região"}…`}
              className="flex-1 rounded-2xl px-4 py-3 bg-neutral-100 dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              className="px-4 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition"
              disabled={!input.trim()}
            >
              Enviar
            </button>
          </form>
        </div>
      </footer>

      {/* Modal de avisos */}
      {showAvisos && (
        <AvisosModal
          regionSlug={region?.slug}
          onClose={() => setShowAvisos(false)}
        />
      )}
    </div>
  );
}
