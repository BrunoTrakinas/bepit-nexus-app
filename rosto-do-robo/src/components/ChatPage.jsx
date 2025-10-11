import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ThemeToggleButton from "./ThemeToggleButton.jsx";
import AvisosModal from "./AvisosModal.jsx";
import { fetchWithTimeout } from "../lib/fetchWithTimeout.js";

/**
 * Página do chat
 * - Cabeçalho: Voltar + logo + BEPIT (esquerda), Região (centro), Avisos + Tema (direita)
 * - Chips (Restaurantes, Passeios, Praias, Dicas) “sticky” sempre visíveis
 * - Mensagem de boas-vindas sugere consultar “Avisos da Região”
 * - Auto-scroll ao receber nova mensagem
 * - Input visível no mobile (sticky bottom) com espaço reservado no feed
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export default function ChatPage() {
  const navigate = useNavigate();
  const [region, setRegion] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("bepit_region") || "null");
    } catch {
      return null;
    }
  });

  // Redireciona se não tiver região
  useEffect(() => {
    if (!region?.slug) {
      navigate("/");
    }
  }, [region, navigate]);

  // Estado do chat
  const [messages, setMessages] = useState(() => {
    const nomeRegiao = (typeof region?.nome === "string" && region.nome) || "sua região";
    return [
      {
        id: "welcome-1",
        role: "assistant",
        text: `Olá! Eu sou o BEPIT, seu concierge IA em ${nomeRegiao}. Dica: antes de qualquer pergunta, vale checar os ⚠️ Avisos da Região (canto superior direito). Posso te ajudar com restaurantes, passeios, praias e dicas!`,
        ts: Date.now(),
      },
    ];
  });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // ConversationId persiste entre mensagens
  const [conversationId, setConversationId] = useState(() => {
    try {
      return localStorage.getItem("bepit_conversation_id") || "";
    } catch {
      return "";
    }
  });

  // Avisos (prefetch)
  const [avisosOpen, setAvisosOpen] = useState(false);
  const [avisosLoading, setAvisosLoading] = useState(false);
  const [avisosData, setAvisosData] = useState([]);

  // Prefetch de avisos ao montar
  useEffect(() => {
    let alive = true;
    async function loadAvisos() {
      if (!region?.slug) return;
      try {
        setAvisosLoading(true);
        const res = await fetchWithTimeout(`${API_BASE}/api/avisos/${region.slug}`, { timeout: 10000 });
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        const items = json?.data || json?.items || [];
        setAvisosData(Array.isArray(items) ? items : []);
      } catch {
        if (!alive) return;
        setAvisosData([]);
      } finally {
        if (alive) setAvisosLoading(false);
      }
    }
    loadAvisos();
    return () => {
      alive = false;
    };
  }, [region?.slug]);

  // Auto scroll no feed
  const listRef = useRef(null);
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // rola para o final com pequeno delay (render completo)
    setTimeout(() => {
      el.scrollTop = el.scrollHeight;
    }, 10);
  }, []);
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Envio de mensagem
  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending || !region?.slug) return;

    const myMsg = { id: `u-${Date.now()}`, role: "user", text, ts: Date.now() };
    setMessages((m) => [...m, myMsg]);
    setInput("");
    setSending(true);

    try {
      const body = {
        message: text,
        ...(conversationId ? { conversationId } : {}),
      };
      const res = await fetchWithTimeout(`${API_BASE}/api/chat/${region.slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));
      // Salva conversationId retornado (se houver)
      if (json?.conversationId && json.conversationId !== conversationId) {
        setConversationId(json.conversationId);
        try {
          localStorage.setItem("bepit_conversation_id", json.conversationId);
        } catch {}
      }

      const replyText =
        typeof json?.reply === "string" && json.reply.trim()
          ? json.reply.trim()
          : "Desculpe, não consegui te responder agora.";

      setMessages((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: "assistant", text: replyText, ts: Date.now() },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: "Tive um problema para responder agora. Pode tentar novamente?",
          ts: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleBackToRegions = () => {
    try {
      // se quiser manter a conversa ao voltar, não limpe o conversationId
      navigate("/");
    } catch {
      navigate("/");
    }
  };

  // Sugestões rápidas (chips)
  const suggestions = useMemo(
    () => [
      "Quero restaurantes",
      "Passeios de barco",
      "Melhores praias",
      "Dicas imperdíveis",
    ],
    []
  );
  const handleSuggestion = (s) => {
    setInput(s);
    // Se preferir, já enviar ao clicar:
    // setInput(""); setTimeout(handleSend, 0);
  };

  // classes utilitárias p/ mensagem
  const bubbleClasses = (role) =>
    role === "user"
      ? "self-end bg-sky-600 text-white"
      : "self-start bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100";

  return (
    <div className="min-h-screen flex flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* ======= HEADER ======= */}
      <header className="
        sticky top-0 z-20
        bg-white/90 backdrop-blur border-b border-slate-200
        dark:bg-slate-900/80 dark:border-slate-800
      ">
        <div className="mx-auto w-full max-w-5xl px-4 py-3 sm:py-4">
          <div className="relative flex items-center justify-between">
            {/* ESQUERDA: Voltar + Logo + BEPIT */}
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={handleBackToRegions}
                className="inline-flex items-center rounded-full border border-slate-200 px-3 py-1.5 text-sm font-medium
                           hover:bg-slate-50 active:scale-[0.98] transition
                           dark:border-slate-700 dark:hover:bg-slate-800"
              >
                ← Voltar
              </button>

              <img
                src="/bepit-logo.png"
                alt="BEPIT"
                className="h-7 w-7 sm:h-8 sm:w-8 md:h-9 md:w-9 rounded-full"
              />

              <span className="text-lg sm:text-xl md:text-2xl font-extrabold tracking-tight">
                BEPIT
              </span>
            </div>

            {/* CENTRO ABSOLUTO: Nome da Região */}
            <div className="
              absolute left-1/2 -translate-x-1/2
              text-center pointer-events-none
              text-base sm:text-lg md:text-xl font-semibold tracking-tight
              text-slate-800 dark:text-slate-200
              max-w-[60vw] truncate
            ">
              {region?.nome || "Região"}
            </div>

            {/* DIREITA: Avisos + Theme */}
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => setAvisosOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-amber-300/70 bg-amber-50/80 px-3 py-1.5 text-sm font-semibold
                           text-amber-800 hover:bg-amber-100 active:scale-[0.98] transition
                           dark:border-amber-600/50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
                title="Avisos da Região"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L1 21h22L12 2zm1 16h-2v-2h2v2zm0-4h-2V9h2v5z" />
                </svg>
                Avisos
              </button>
              <ThemeToggleButton />
            </div>
          </div>
        </div>
      </header>

      {/* ======= CHIPS STICKY ======= */}
      <div className="
        sticky top-16 z-10
        bg-white/80 backdrop-blur px-4 py-2
        border-b border-slate-100
        dark:bg-slate-900/70 dark:border-slate-800
      ">
        <div className="mx-auto w-full max-w-5xl flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => handleSuggestion(s)}
              className="rounded-full px-4 py-1.5 text-sm font-semibold border border-slate-200 bg-white hover:bg-slate-50
                         dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* ======= FEED ======= */}
      <div className="flex-1">
        <div
          ref={listRef}
          className="mx-auto w-full max-w-5xl px-4 py-4 overflow-y-auto"
          style={{ maxHeight: "calc(100vh - 12rem)" }} // reserva espaço para header+chips+input
        >
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${bubbleClasses(m.role)}`}
              >
                <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
              </div>
            ))}
            {sending && (
              <div className="max-w-[85%] self-start rounded-2xl px-4 py-3 shadow-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                <span className="inline-flex items-center gap-2">
                  <span>Digitando</span>
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">.</span>
                    <span className="animate-bounce [animation-delay:120ms]">.</span>
                    <span className="animate-bounce [animation-delay:240ms]">.</span>
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ======= INPUT (sticky) ======= */}
      <div className="
        sticky bottom-0 z-20
        bg-white/90 backdrop-blur border-t border-slate-200
        dark:bg-slate-900/80 dark:border-slate-800
      ">
        <div className="mx-auto w-full max-w-5xl px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Digite sua mensagem…"
              className="flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-3 text-base outline-none
                         focus:ring-2 focus:ring-sky-500/70 focus:border-sky-500
                         dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="inline-flex items-center justify-center rounded-2xl px-5 py-3 text-base font-semibold
                         bg-sky-600 text-white hover:bg-sky-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed
                         dark:bg-sky-500 dark:hover:bg-sky-600"
            >
              Enviar
            </button>
          </div>
        </div>
      </div>

      {/* ======= MODAL DE AVISOS ======= */}
      <AvisosModal
        open={avisosOpen}
        onClose={() => setAvisosOpen(false)}
        loading={avisosLoading}
        avisos={avisosData}
      />
    </div>
  );
}
