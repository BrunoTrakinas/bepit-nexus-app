import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * ChatPage.jsx
 * - Cabeçalho com: Voltar (esquerda), Logo + BEPIT (esquerda), nome da Região (centro),
 *   e botões (direita): Avisos e Tema claro/escuro.
 * - Chips fixas no topo: Restaurantes, Passeios, Praias, Dicas (sempre visíveis).
 * - Mensagem de boas-vindas com sugestão para checar avisos.
 * - Auto-scroll ao enviar/receber.
 * - Indicador de "digitando..." (três pontinhos).
 * - Consome backend v4.0 via VITE_API_BASE_URL.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const TYPING_MIN_MS = 450; // delay mínimo p/ mostrar "digitando"
const STORAGE_REGION_KEY = "bepit_region";
const STORAGE_THEME_KEY = "bepit_theme";

function ensureThemeClass(theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

function useThemeState() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_THEME_KEY);
      return saved === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_THEME_KEY, theme);
    } catch {}
    ensureThemeClass(theme);
  }, [theme]);

  return { theme, setTheme };
}

export default function ChatPage({ onOpenAvisos }) {
  const navigate = useNavigate();
  const { theme, setTheme } = useThemeState();

  const [region, setRegion] = useState(null);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState(() => {
    // Inicia sem mensagens; boas-vindas entram após carregar região
    return [];
  });

  const scrollRef = useRef(null);

  // Carrega região do localStorage; se ausente, volta para seleção
  useEffect(() => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_REGION_KEY) || "null");
    } catch {}
    if (!saved || !saved.slug || !saved.name) {
      navigate("/");
      return;
    }
    setRegion(saved);

    // Mensagem de boas-vindas dinâmica + dica de avisos
    const welcome = {
      id: "welcome",
      role: "assistant",
      text: `Olá! Eu sou o BEPIT, seu concierge IA em ${saved.name}. Dica: antes de perguntar, vale a pena conferir os avisos da região — pode ter interdições, maré, trânsito ou eventos que impactam sua experiência.`,
      ts: Date.now(),
    };
    setMessages([welcome]);
  }, [navigate]);

  // Auto-scroll ao fim sempre que mensagens mudarem
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll suave (com classe CSS que dá inércia no iOS)
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isTyping]);

  const chips = useMemo(
    () => [
      { key: "restaurantes", label: "Restaurantes", prompt: "Onde comer em " },
      { key: "passeios", label: "Passeios", prompt: "Quero passeios em " },
      { key: "praias", label: "Praias", prompt: "Quais praias em " },
      { key: "dicas", label: "Dicas", prompt: "Dicas gerais em " },
    ],
    []
  );

  async function sendMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || !region) return;

    // Adiciona mensagem do usuário
    const userMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    const start = Date.now();
    try {
      const endpoint = `${API_BASE}/api/chat/${encodeURIComponent(
        region.slug
      )}`;

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversationId: conversationId || undefined,
        }),
      });

      const data = await resp.json();
      const elapsed = Date.now() - start;
      const waitMore = Math.max(0, TYPING_MIN_MS - elapsed);
      await new Promise((r) => setTimeout(r, waitMore));

      if (resp.ok) {
        if (data?.conversationId && !conversationId) {
          setConversationId(data.conversationId);
        }
        const botMsg = {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: data?.reply || "…",
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, botMsg]);
      } else {
        const errMsg = {
          id: `e-${Date.now()}`,
          role: "assistant",
          text:
            "Tive um probleminha para responder agora. Pode tentar novamente?",
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } catch (e) {
      const errMsg = {
        id: `e-${Date.now()}`,
        role: "assistant",
        text:
          "Sem conexão no momento. Verifique sua internet e tente de novo, por favor.",
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleChipClick(chip) {
    if (!region) return;
    const phrase = `${chip.prompt}${region.name}`;
    sendMessage(phrase);
  }

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  function goBack() {
    // apenas navega; se quiser limpar a região, descomente abaixo
    // try { localStorage.removeItem(STORAGE_REGION_KEY); } catch {}
    navigate("/");
  }

  if (!region) {
    return null; // durante redirecionamento inicial
  }

  return (
    <div className="min-h-dvh flex flex-col bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-30 backdrop-blur bg-white/80 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center gap-2">
          {/* Esquerda: voltar + logo + BEPIT */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={goBack}
              className="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Voltar"
            >
              ← Voltar
            </button>
            <img
              src="/bepit-logo.png"
              alt="BEPIT"
              className="w-8 h-8 rounded"
            />
            <span className="font-extrabold tracking-tight text-lg">
              BEPIT
            </span>
          </div>

          {/* Centro: nome da região */}
          <div className="flex-1 text-center truncate">
            <span className="text-sm md:text-base font-medium opacity-80">
              {region.name}
            </span>
          </div>

          {/* Direita: avisos + tema */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => (onOpenAvisos ? onOpenAvisos() : null)}
              className="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2"
              title="Avisos da Região"
            >
              <span>⚠️</span>
              <span className="hidden sm:inline">Avisos</span>
            </button>

            <button
              onClick={toggleTheme}
              className="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              title="Alternar claro/escuro"
            >
              {theme === "dark" ? "🌙" : "☀️"}
            </button>
          </div>
        </div>

        {/* Chips fixas (sempre visíveis no topo do chat) */}
        <div className="border-t border-slate-200 dark:border-slate-800">
          <div className="max-w-5xl mx-auto px-3 py-2 flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c.key}
                onClick={() => handleChipClick(c)}
                className="px-3 py-1.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow transition text-sm"
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Área rolável do chat */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scroll-smooth-touch"
      >
        <div className="max-w-3xl mx-auto w-full px-3 py-4 space-y-3">
          {messages.map((m) => (
            <ChatBubble key={m.id} role={m.role} text={m.text} />
          ))}

          {isTyping && <TypingIndicator />}
        </div>
      </div>

      {/* Input */}
      <footer className="sticky bottom-0 z-20 bg-white/80 dark:bg-slate-900/80 backdrop-blur border-t border-slate-200 dark:border-slate-800">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto w-full px-3 py-2 flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Digite sua mensagem…"
            className="flex-1 px-4 py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-sky-400"
          />
          <button
            type="submit"
            className="px-4 py-3 rounded-2xl bg-sky-600 hover:bg-sky-700 text-white font-medium"
          >
            Enviar
          </button>
        </form>
      </footer>
    </div>
  );
}

function ChatBubble({ role, text }) {
  const isUser = role === "user";
  return (
    <div
      className={`w-full flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[85%] md:max-w-[75%] px-4 py-3 rounded-2xl shadow
          ${isUser
            ? "bg-sky-600 text-white rounded-br-sm"
            : "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-bl-sm"
          }`}
      >
        <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="w-full flex justify-start">
      <div className="px-4 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow">
        <Dots />
      </div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-1">
      <Dot delay="0ms" />
      <Dot delay="120ms" />
      <Dot delay="240ms" />
    </span>
  );
}

function Dot({ delay }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce"
      style={{ animationDelay: delay }}
    />
  );
}
