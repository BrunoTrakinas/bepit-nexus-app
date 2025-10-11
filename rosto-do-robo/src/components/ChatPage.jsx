// src/components/ChatPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import AvisosModal from "./AvisosModal.jsx";
import ThemeToggleButton from "./ThemeToggleButton.jsx";
import SuggestionButtons from "./SuggestionButtons.jsx";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export default function ChatPage() {
  // ------------------- Região (pega do localStorage) -------------------
  const [regiao, setRegiao] = useState(() => {
    try {
      const raw = localStorage.getItem("bepit_regiao");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // ------------------- Estado do chat -------------------
  const [messages, setMessages] = useState(() => {
    // Mensagem de recepção dinâmica com sugestão de conferir avisos
    const nome = (() => {
      try {
        const raw = localStorage.getItem("bepit_regiao");
        return raw ? JSON.parse(raw)?.nome : "sua região";
      } catch {
        return "sua região";
      }
    })();

    return [
      {
        id: "welcome",
        role: "assistant",
        text:
          `Olá! Eu sou o BEPIT, seu concierge IA em ${nome}. ` +
          `Dica: antes de qualquer pergunta, vale checar os ⚠️ Avisos da Região — ` +
          `às vezes eles já respondem dúvidas importantes de hoje.`,
      },
    ];
  });

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [avisosOpen, setAvisosOpen] = useState(false);

  // chips fixos
  const chipsRef = useRef(null);
  const listRef = useRef(null);
  const bottomRef = useRef(null);

  const conversationIdRef = useRef(null);

  // ------------------- Guard rail: sem região -> volta -------------------
  useEffect(() => {
    if (!regiao || !regiao.slug) {
      window.location.replace("/");
    }
  }, [regiao]);

  // ------------------- Autoscroll -------------------
  const scrollToBottom = () => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  // ------------------- Chips de sugestões -------------------
  const suggestionItems = useMemo(
    () => [
      { label: "🍽️ Restaurantes", text: "Quero onde comer em " + (regiao?.nome || "Região") },
      { label: "⛵ Passeios", text: "Quais passeios de barco estão disponíveis?" },
      { label: "🏖️ Praias", text: "Quais praias para família perto?" },
      { label: "💡 Dicas", text: "Dicas rápidas para hoje" },
    ],
    [regiao?.nome]
  );

  const handleSuggestion = (text) => {
    setInput(text);
    // opcionalmente já envia:
    // handleSend(text);
  };

  // ------------------- Envio -------------------
  const handleSend = async (forcedText) => {
    const text = (forcedText ?? input).trim();
    if (!text || !regiao?.slug || isSending) return;

    setIsSending(true);
    setIsTyping(true);

    // adiciona mensagem do usuário
    const userMsg = { id: crypto.randomUUID(), role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    try {
      // garante conversationId estável
      if (!conversationIdRef.current) {
        conversationIdRef.current = crypto.randomUUID();
      }

      const url = `${API_BASE}/api/chat/${regiao.slug}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationId: conversationIdRef.current,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      const replyText =
        (data && data.reply) ||
        "Tive um problema para responder agora. Pode tentar novamente?";

      const botMsg = { id: crypto.randomUUID(), role: "assistant", text: replyText };
      setMessages((prev) => [...prev, botMsg]);
    } catch (e) {
      const botMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Falha de conexão. Verifique sua internet e tente novamente.",
      };
      setMessages((prev) => [...prev, botMsg]);
    } finally {
      setIsSending(false);
      setIsTyping(false);
      scrollToBottom();
    }
  };

  // ------------------- Render -------------------
  return (
    <div className="relative min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      {/* Cabeçalho: grid em 3 colunas SOMENTE no mobile;
          em >=sm mantemos o layout do desktop via classes sm:* existentes */}
      <header className="sticky top-0 z-30 border-b bg-white/80 dark:bg-neutral-900/80 backdrop-blur px-2 sm:px-4 py-2">
        <div className="grid grid-cols-3 items-center sm:flex sm:items-center sm:justify-between">
          {/* ESQUERDA (mobile: col 1) */}
          <div className="min-w-0 flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => window.location.href = "/"}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-white/70 dark:bg-neutral-800/70 hover:bg-white dark:hover:bg-neutral-800"
            >
              <span className="text-lg leading-none">←</span>
              <span className="text-sm sm:text-base">Voltar</span>
            </button>

            <img
              src="/bepit-logo.png"
              alt="BEPIT"
              className="shrink-0 h-7 w-7 sm:h-8 sm:w-8 rounded-full"
            />
            <span className="shrink-0 font-semibold text-base sm:text-lg tracking-wide">
              BEPIT
            </span>
          </div>

          {/* CENTRO (mobile: col 2) */}
          <div className="min-w-0 flex justify-center sm:flex-1">
            <h1
              className="max-w-[60vw] sm:max-w-none text-center font-medium text-sm sm:text-base whitespace-nowrap overflow-hidden text-ellipsis"
              title={regiao?.nome || ""}
            >
              {regiao?.nome || "Região"}
            </h1>
          </div>

          {/* DIREITA (mobile: col 3) */}
          <div className="min-w-0 flex items-center justify-end gap-2 sm:gap-3">
            <button
              onClick={() => setAvisosOpen(true)}
              className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-white/70 dark:bg-neutral-800/70 hover:bg-white dark:hover:bg-neutral-800"
            >
              <span className="text-lg leading-none">⚠️</span>
              <span className="hidden sm:inline text-sm">Avisos</span>
            </button>
            <ThemeToggleButton />
          </div>
        </div>

        {/* CHIPS — ficam sempre visíveis (também sticky) */}
        <div
          ref={chipsRef}
          className="mt-2 flex w-full items-center justify-center gap-2 flex-wrap"
        >
          {suggestionItems.map((s) => (
            <button
              key={s.label}
              onClick={() => handleSuggestion(s.text)}
              className="px-4 py-2 rounded-full border bg-white/70 dark:bg-neutral-800/70 hover:bg-white dark:hover:bg-neutral-800"
              title={s.text}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>

      {/* LISTA DE MENSAGENS */}
      <main
        ref={listRef}
        className="
          relative
          px-3 sm:px-4
          pt-3
          pb-[calc(88px+env(safe-area-inset-bottom))]   /* espaço para o input fixo */
          sm:pb-[calc(96px+env(safe-area-inset-bottom))]
          max-w-5xl mx-auto
        "
      >
        <div className="space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`
                max-w-[92%] sm:max-w-[70%]
                ${m.role === "user"
                  ? "ml-auto bg-blue-600 text-white"
                  : "mr-auto bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"}
                rounded-2xl px-4 py-3 shadow-sm border border-black/5 dark:border-white/10
              `}
            >
              <p className="leading-relaxed">{m.text}</p>
            </div>
          ))}

          {isTyping && (
            <div className="mr-auto bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-2xl px-4 py-3 border border-black/5 dark:border-white/10 w-24">
              <span className="inline-flex gap-1">
                <span className="animate-bounce">•</span>
                <span className="animate-bounce [animation-delay:100ms]">•</span>
                <span className="animate-bounce [animation-delay:200ms]">•</span>
              </span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      {/* INPUT FIXO NA BASE (com área segura) */}
      <div
        className="
          fixed inset-x-0 bottom-0 z-30
          bg-white/85 dark:bg-neutral-900/85 backdrop-blur
          border-t
          px-3 sm:px-4 py-2
          pb-[calc(10px+env(safe-area-inset-bottom))]
        "
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="max-w-5xl mx-auto flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escreva sua mensagem…"
            className="
              flex-1 rounded-2xl px-4 py-3
              bg-neutral-100 dark:bg-neutral-800
              border border-neutral-200 dark:border-neutral-700
              outline-none focus:ring-2 focus:ring-blue-500
            "
          />
          <button
            type="submit"
            disabled={isSending || !input.trim()}
            className="
              inline-flex items-center justify-center
              rounded-xl px-5 py-3
              bg-blue-600 text-white font-medium
              disabled:opacity-50 disabled:cursor-not-allowed
              hover:bg-blue-700
            "
          >
            Enviar
          </button>
        </form>
      </div>

      {/* MODAL DE AVISOS */}
      {avisosOpen && (
        <AvisosModal
          slugDaRegiao={regiao?.slug}
          onClose={() => setAvisosOpen(false)}
        />
      )}
    </div>
  );
}
