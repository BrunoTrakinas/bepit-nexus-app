import React, { useEffect, useMemo, useRef, useState } from "react";
import ThemeToggleButton from "./ThemeToggleButton.jsx";
import AvisosModal from "./AvisosModal.jsx";
import { supabase } from "../lib/supabaseClient.js";

/** HTTP com timeout para chamadas ao backend do chat */
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 45000, ...rest } = options; // ⬅️ 45s para dar folga ao backend
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(resource, { ...rest, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/** Resolve o ID da região:
 *  1) usa o que estiver salvo (id/regiao_id/region_id)
 *  2) se não houver, procura por slug em `regioes_publicas` e salva de volta
 */
async function resolveRegionId(regionInfo) {
  const saved =
    regionInfo?.id ||
    regionInfo?.regiao_id ||
    regionInfo?.region_id ||
    null;

  if (saved) return String(saved);

  const slug = regionInfo?.slug;
  if (!slug) return null;

  const { data, error } = await supabase
    .from("regioes_publicas")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.warn("[Região] Falha ao resolver id por slug:", error.message);
    return null;
  }
  if (!data?.id) return null;

  try {
    const merged = { ...regionInfo, id: data.id, regiao_id: data.id, region_id: data.id };
    localStorage.setItem("bepit_region", JSON.stringify(merged));
  } catch {}
  return String(data.id);
}

export default function ChatPage() {
  // Região do localStorage
  const regionInfo = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("bepit_region") || "{}");
    } catch {
      return {};
    }
  }, []);

  const apiBase    = import.meta.env.VITE_API_BASE_URL || "";
  const regionSlug = regionInfo?.slug || "";
  const regionName = regionInfo?.name || regionInfo?.nome || "Região dos Lagos";

  // Se não tem região salva, volta para seleção
  useEffect(() => {
    if (!regionSlug) {
      window.location.replace("/");
    }
  }, [regionSlug]);

  // ===== Conversa: ID persistente por região =====
  // Recupera/gera um conversationId que persiste por região
  const initialConversationId = useMemo(() => {
    try {
      const savedId = localStorage.getItem("bepit_conversation_id");
      const savedRegion = localStorage.getItem("bepit_conversation_region");
      if (savedId && savedRegion === regionSlug) return savedId;
      const fresh = crypto.randomUUID();
      localStorage.setItem("bepit_conversation_id", fresh);
      localStorage.setItem("bepit_conversation_region", regionSlug || "");
      return fresh;
    } catch {
      return crypto.randomUUID();
    }
  }, [regionSlug]);

  const [conversationId, setConversationId] = useState(initialConversationId);

  // Se a região mudar durante a sessão, renova o conversationId
  useEffect(() => {
    const savedRegion = localStorage.getItem("bepit_conversation_region");
    if (savedRegion !== regionSlug) {
      const fresh = crypto.randomUUID();
      setConversationId(fresh);
      try {
        localStorage.setItem("bepit_conversation_id", fresh);
        localStorage.setItem("bepit_conversation_region", regionSlug || "");
      } catch {}
    }
  }, [regionSlug]);

  // Estado do chat
  const [messages, setMessages] = useState(() => {
    const welcome = `Olá! Eu sou o BEPIT, seu concierge IA em ${regionName}.
Dica: antes de perguntar, vale clicar em ⚠️ Avisos para ver se há algo importante acontecendo na região. Como posso te ajudar hoje?`;
    return [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: welcome,
        ts: Date.now()
      }
    ];
  });
  const [userInput, setUserInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  // Avisos (Supabase)
  const [showAvisos, setShowAvisos] = useState(false);
  const [avisosLoading, setAvisosLoading] = useState(false);
  const [avisos, setAvisos] = useState([]);

  // Auto-scroll
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isTyping, showAvisos]);

  // Ações de UI
  const openAvisosModal = () => setShowAvisos(true);
  const closeAvisosModal = () => setShowAvisos(false);

  const pushMessage = (msg) => {
    setMessages((prev) => [...prev, { ...msg, id: msg.id || crypto.randomUUID(), ts: Date.now() }]);
  };

  // “Chips” — perguntas rápidas (passa pelo mesmo fluxo do sendMessage)
  const handleQuickAsk = (text) => {
    if (!text) return;
    setUserInput("");
    sendMessage(text);
  };

  // Enviar mensagem (preserva conversationId estável + chaves alternativas)
  const sendMessage = async (rawText) => {
    const text = (rawText ?? userInput).trim();
    if (!text || !regionSlug) return;

    pushMessage({ role: "user", text });
    setIsTyping(true);

    try {
      const url = `${apiBase.replace(/\/$/, "")}/api/chat/${encodeURIComponent(regionSlug)}`;

      // Payload envia o id em 3 chaves — servidor usa a que conhecer.
      const payload = {
        message: text,
        conversationId,               // nome comum
        threadId: conversationId,     // alternativa comum
        sessionId: conversationId     // outra alternativa comum
      };

      if (import.meta.env.DEV) {
        console.debug("[Chat →]", url, payload);
      }

      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 45000
      });

      let replyText = "Desculpe, não consegui obter uma resposta agora.";
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));

        // Se o backend devolver algum id oficial de conversa, passamos a usá-lo.
        const serverId =
          data?.conversationId || data?.threadId || data?.sessionId || null;
        if (serverId && typeof serverId === "string" && serverId !== conversationId) {
          setConversationId(serverId);
          try {
            localStorage.setItem("bepit_conversation_id", serverId);
            localStorage.setItem("bepit_conversation_region", regionSlug || "");
          } catch {}
          if (import.meta.env.DEV) {
            console.debug("[Chat] server conversation id ->", serverId);
          }
        }

        if (data?.reply) {
          replyText = String(data.reply);
        } else if (data?.message) {
          replyText = String(data.message);
        }
      } else {
        replyText = `Tive um problema ao buscar uma resposta (HTTP ${resp.status}).`;
      }

      pushMessage({ role: "assistant", text: replyText });
    } catch (e) {
      pushMessage({
        role: "assistant",
        text:
          "Ops, a conexão parece ter oscilado. Tente novamente em instantes. Se preferir, descreva com mais detalhes o que deseja."
      });
      if (import.meta.env.DEV) {
        console.warn("[Chat erro]", e);
      }
    } finally {
      setIsTyping(false);
      setUserInput("");
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };

  // ======= Avisos (via VIEW) =======
  async function carregarAvisos() {
    setAvisosLoading(true);
    try {
      const regionId = await resolveRegionId(regionInfo);
      if (!regionId) {
        setAvisos([]);
        return;
      }

      const { data, error } = await supabase
        .from("avisos_publicos_view")
        .select("id, regiao_id, cidade_id, cidade_nome, titulo, descricao, periodo_inicio, periodo_fim, ativo, prioridade, tipo_aviso, created_at")
        .eq("ativo", true)
        .eq("regiao_id", regionId)
        .order("periodo_inicio", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw error;

      setAvisos(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[Avisos] Falha ao carregar:", err?.message || err);
      setAvisos([]);
    } finally {
      setAvisosLoading(false);
    }
  }

  // Quando abrir o modal, carrega avisos
  useEffect(() => {
    if (showAvisos) {
      carregarAvisos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAvisos, regionSlug]);

  // Render
  return (
    <div className="min-h-dvh bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 flex flex-col">
      {/* Cabeçalho */}
      <header className="sticky top-0 z-30 bg-white/80 dark:bg-neutral-900/80 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4">
          <div className="grid grid-cols-3 items-center h-16 sm:h-20">
            {/* ESQUERDA: Voltar + logo + BEPIT */}
            <div className="flex items-center gap-3 sm:gap-4">
              <button
                type="button"
                onClick={() => window.history.back()}
                className="inline-flex items-center justify-center rounded-full border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-base hover:bg-neutral-100 dark:hover:bg-neutral-800"
                aria-label="Voltar"
                title="Voltar"
              >
                ←
              </button>

              <img
                src="/bepit-logo.png"
                alt="BEPIT"
                className="h-10 w-10 sm:h-12 sm:w-12 rounded"
                loading="lazy"
              />
              <span className="font-extrabold text-neutral-900 dark:text-neutral-100 text-lg sm:text-2xl">
                BEPIT
              </span>
            </div>

            {/* CENTRO: Nome da Região (dinâmico) */}
            <div className="flex items-center justify-center">
              <span className="truncate font-bold text-neutral-800 dark:text-neutral-200 text-base sm:text-xl">
                {regionName}
              </span>
            </div>

            {/* DIREITA: Avisos + Tema */}
            <div className="flex items-center justify-end gap-2 sm:gap-4">
              <button
                type="button"
                onClick={openAvisosModal}
                className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 text-amber-800 px-4 py-2 text-base hover:bg-amber-100 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-200"
                title="Avisos da Região"
              >
                <span className="text-xl leading-none">⚠️</span>
                <span className="hidden sm:inline font-semibold">Avisos</span>
              </button>
              <ThemeToggleButton />
            </div>
          </div>
        </div>
      </header>

      {/* CHIPS FIXOS */}
      <div className="sticky top-16 sm:top-20 z-20 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4 py-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => handleQuickAsk("Quero opções de restaurantes")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Restaurantes"
            >
              🍽️ <span>Restaurantes</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quero sugestões de passeios (barco, trilha, bugre)")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Passeios"
            >
              🚤 <span>Passeios</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quais são as melhores praias agora?")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Praias"
            >
              🏖️ <span>Praias</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quero dicas gerais de hoje")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Dicas"
            >
              💡 <span>Dicas</span>
            </button>
          </div>
        </div>
      </div>

      {/* ÁREA DO CHAT */}
      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4">
          <div className="pt-3 sm:pt-4 pb-24 sm:pb-28">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`mb-3 sm:mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={
                    "max-w-[85%] sm:max-w-[70%] rounded-2xl px-4 py-2 text-sm sm:text-base " +
                    (m.role === "user"
                      ? "bg-blue-600 text-white rounded-br-md"
                      : "bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-100 rounded-bl-md")
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="mb-3 sm:mb-4 flex justify-start">
                <div className="max-w-[70%] rounded-2xl px-4 py-2 bg-neutral-100 dark:bg-neutral-800">
                  <span className="inline-flex gap-1 items-center">
                    <span className="animate-bounce">●</span>
                    <span className="animate-bounce [animation-delay:150ms]">●</span>
                    <span className="animate-bounce [animation-delay:300ms]">●</span>
                  </span>
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>
        </div>
      </main>

      {/* INPUT */}
      <div className="sticky bottom-0 z-30 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4 py-2 sm:py-3">
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <textarea
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Digite sua mensagem…"
              rows={1}
              className="flex-1 resize-none rounded-2xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
            />
            <button
              type="submit"
              disabled={!userInput.trim() || isTyping}
              className="inline-flex items-center justify-center rounded-2xl bg-blue-600 text-white px-4 py-2 text-sm sm:text-base hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Enviar"
            >
              Enviar
            </button>
          </form>
        </div>
      </div>

      {/* MODAL DE AVISOS */}
      {showAvisos && (
        <AvisosModal
          open={showAvisos}
          onClose={closeAvisosModal}
          loading={avisosLoading}
          avisos={avisos}
          onRefresh={carregarAvisos}
        />
      )}
    </div>
  );
}
