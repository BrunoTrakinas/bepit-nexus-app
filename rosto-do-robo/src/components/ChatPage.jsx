import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ThemeToggleButton from "./ThemeToggleButton.jsx";
import AvisosModal from "./AvisosModal.jsx";
import { supabase } from "../lib/supabaseClient.js";

/** HTTP com timeout e um retry leve para o backend do chat */
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 45000, retries = 0, ...rest } = options;
  const attempt = async () => {
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
  };
  try {
    return await attempt();
  } catch (e) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 600)); // backoff curto
      return await fetchWithTimeout(resource, { timeout, retries: retries - 1, ...rest });
    }
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

/** Heurística simples para sugerir tópico ao backend (opcional) */
function inferTopic(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("restaurante") || t.includes("comida") || t.includes("gastr")) return "restaurants";
  if (t.includes("passeio") || t.includes("trilha") || t.includes("barco") || t.includes("bugre")) return "tours";
  if (t.includes("praia")) return "beaches";
  if (t.includes("hotel") || t.includes("hosped")) return "lodging";
  return "general";
}

export default function ChatPage() {
  const navigate = useNavigate();

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

  // ===== Chips: agora o texto já pede "5 opções" para evitar resposta única =====
  const handleQuickAsk = (text) => {
    if (!text) return;
    setUserInput("");
    // injeta o nome da região no chip (ajuda o LLM a entender o contexto)
    const enriched = text.replace("{regiao}", regionName).replace("{região}", regionName);
    sendMessage(enriched);
  };

  // Enviar mensagem (preserva conversationId, tenta enriquecer o payload)
  const sendMessage = async (rawText) => {
    const text = (rawText ?? userInput).trim();
    if (!text || !regionSlug) return;

    pushMessage({ role: "user", text });
    setIsTyping(true);

    try {
      const url = `${apiBase.replace(/\/$/, "")}/api/chat/${encodeURIComponent(regionSlug)}`;

      const payload = {
        message: text,
        // IDs aceitos por diferentes backends; o servidor usa o que conhecer:
        conversationId,
        threadId: conversationId,
        sessionId: conversationId,
        // Dicas Opcionais (servidor pode ignorar sem quebrar):
        limit: 6,
        topK: 6,
        topic: inferTopic(text),
        region: regionName,
        regionSlug
      };

      if (import.meta.env.DEV) console.debug("[Chat →]", url, payload);

      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 45000,
        retries: 1
      });

      let replyText = "Desculpe, não consegui obter uma resposta agora.";
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));

        // Se o backend devolver um id oficial, passamos a usar
        const serverId = data?.conversationId || data?.threadId || data?.sessionId || null;
        if (serverId && typeof serverId === "string" && serverId !== conversationId) {
          setConversationId(serverId);
          try {
            localStorage.setItem("bepit_conversation_id", serverId);
            localStorage.setItem("bepit_conversation_region", regionSlug || "");
          } catch {}
          if (import.meta.env.DEV) console.debug("[Chat] server conversation id ->", serverId);
        }

        if (data?.reply) replyText = String(data.reply);
        else if (data?.message) replyText = String(data.message);
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
      if (import.meta.env.DEV) console.warn("[Chat erro]", e);
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
      <header className="sticky top-0 z-40 grid grid-cols-[auto,1fr,auto] items-center gap-2 border-b border-neutral-200 bg-white/95 px-3 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95 sm:gap-3 sm:px-4 sm:py-3">
        {/* ESQUERDA: Voltar + Logo + BEPIT */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            onClick={() => navigate("/")}
            className="rounded-full border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-100 active:scale-[0.99] dark:border-neutral-700 dark:hover:bg-neutral-800 sm:px-4"
            aria-label="Voltar para seleção de região"
          >
            ← Voltar
          </button>

          <img
            src="/bepit-logo.png"
            alt="BEPIT"
            className="h-7 w-7 shrink-0 rounded-full sm:h-8 sm:w-8"
          />
          <span className="shrink-0 text-base font-semibold sm:text-lg md:text-xl">
            BEPIT
          </span>
        </div>

        {/* CENTRO: Nome da região (trunca no mobile) */}
        <div className="min-w-0 text-center">
          <div className="mx-auto max-w-[70vw] truncate text-sm font-medium sm:max-w-[60vw] sm:text-base md:text-lg">
            {regionName}
          </div>
        </div>

        {/* DIREITA: Avisos + Tema */}
        <div className="flex items-center justify-end gap-2 sm:gap-3">
          <button
            onClick={openAvisosModal}
            className="flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-100 active:scale-[0.99] dark:border-neutral-700 dark:hover:bg-neutral-800 sm:px-4"
            aria-label="Abrir avisos da região"
          >
            <span className="text-base">⚠️</span>
            <span className="hidden sm:inline">Avisos</span>
          </button>
          <ThemeToggleButton />
        </div>
      </header>

      {/* CHIPS FIXOS */}
      <div className="sticky top-16 sm:top-20 z-20 bg-white/90 dark:bg-neutral-900/90 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4 py-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => handleQuickAsk("Quero 5 opções de restaurantes variados em {região}, com nome e bairro")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Restaurantes"
            >
              🍽️ <span>Restaurantes</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quero 5 sugestões de passeios em {região} (barco, trilha, bugre), com ponto de partida")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Passeios"
            >
              🚤 <span>Passeios</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quais são as melhores praias agora em {região}? Considere vento e ondas")}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-base border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              title="Praias"
            >
              🏖️ <span>Praias</span>
            </button>

            <button
              type="button"
              onClick={() => handleQuickAsk("Quero dicas gerais para hoje em {região} (clima, trânsito, eventos)")}
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
