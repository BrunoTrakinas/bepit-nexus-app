// src/pages/ChatPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../lib/apiClient.js";
import SuggestionButtons from "../components/SuggestionButtons.jsx";
import AvisosModal from "../components/AvisosModal.jsx"; // abre quando clicar no botão de avisos

/**
 * Componente principal do chat do BEPIT.
 * - Garante região no localStorage (redireciona se faltar)
 * - Mostra mensagem de boas-vindas dinâmica com sugestão de ver os avisos
 * - Botão "⚠️ Avisos da Região" para abrir o modal
 * - Sugestões iniciais e envio de mensagens pro backend
 */
export default function ChatPage() {
  const navigate = useNavigate();

  // Carrega a região do localStorage:
  const region = useMemo(() => {
    try {
      const raw = localStorage.getItem("bepit:region");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, []);

  // Se não houver região salva, volta para a seleção
  useEffect(() => {
    if (!region?.slug) {
      navigate("/", { replace: true });
    }
  }, [region, navigate]);

  // ConversationId persistente por região (pra continuar conversas):
  const [conversationId, setConversationId] = useState(() => {
    if (!region?.slug) return "";
    try {
      const key = `bepit:conv:${region.slug}`;
      const v = localStorage.getItem(key);
      return v || "";
    } catch {
      return "";
    }
  });

  const saveConversationId = (id) => {
    if (!region?.slug || !id) return;
    try {
      const key = `bepit:conv:${region.slug}`;
      localStorage.setItem(key, id);
    } catch {}
    setConversationId(id);
  };

  // Estado do chat:
  const [messages, setMessages] = useState(() => {
    const nome = region?.nome || "sua região";
    const boasVindas =
      `Olá! Eu sou o BEPIT, seu concierge IA em ${nome}.\n\n` +
      `Dica: antes de perguntar qualquer coisa, vale conferir os ⚠️ avisos da região — às vezes eles já respondem dúvidas sobre tráfego, horários de passeios, condições do mar, etc. Quando quiser, clique no botão “⚠️ Avisos da Região” aqui em cima.`;

    return [
      {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        text: boasVindas,
        meta: { type: "welcome" },
      },
    ];
  });

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const listEndRef = useRef(null);

  // Modal de avisos
  const [avisosOpen, setAvisosOpen] = useState(false);

  // Auto-scroll ao final quando chegam mensagens
  useEffect(() => {
    if (listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  async function enviarMensagem(texto) {
    if (!region?.slug || !texto?.trim() || isLoading) return;

    const userMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      text: texto.trim(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const body = {
        message: texto.trim(),
        ...(conversationId ? { conversationId } : {}),
      };

      const resp = await apiClient.enviarMensagemParaChat(region.slug, body);
      // Esperado do backend v4.0:
      // { reply: string, conversationId: string, partners?: [], photoLinks?: [] }
      const assistantText = resp?.reply || "…";
      const convId = resp?.conversationId || conversationId || "";
      if (convId && convId !== conversationId) saveConversationId(convId);

      const assistantMsg = {
        id: `a-${Date.now()}`,
        role: "assistant",
        text: assistantText,
        meta: {
          partners: resp?.partners || [],
          photos: resp?.photoLinks || [],
          intent: resp?.intent || "",
        },
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      const errMsg = e?.message || "Falha ao contatar o BEPIT.";
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text: `Ops! ${errMsg}`,
          meta: { error: true },
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  function onSuggestionClick(textoSugestao) {
    // Você pode personalizar estes textos para mapear diretamente a intenções:
    let prompt = textoSugestao;

    // Exemplos simples:
    if (/restaurante/i.test(textoSugestao)) {
      prompt = "Onde comer?";
    } else if (/passeio/i.test(textoSugestao)) {
      prompt = "Quais passeios de barco você recomenda?";
    } else if (/praia/i.test(textoSugestao)) {
      prompt = "Quais praias visitar?";
    } else if (/dica/i.test(textoSugestao)) {
      prompt = "Tem dicas locais imperdíveis?";
    }

    enviarMensagem(prompt);
  }

  // Defesa: se a região ainda não foi carregada, evita flicker:
  if (!region?.slug) {
    return null; // o useEffect já redireciona
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        background: "#f6f7fb",
      }}
    >
      {/* Header com botão de avisos */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "#ffffff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
        }}
      >
        <div style={{ fontWeight: 800 }}>
          BEPIT · {region?.nome || "Região"}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setAvisosOpen(true)}
            style={btnAvisosStyle}
            title="Ver avisos públicos da região"
          >
            ⚠️ Avisos da Região
          </button>
        </div>
      </header>

      {/* Lista de mensagens */}
      <main
        style={{
          padding: 16,
          display: "grid",
          alignContent: "start",
          gap: 10,
        }}
      >
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} meta={m.meta} />
        ))}
        <div ref={listEndRef} />
      </main>

      {/* Caixa de texto + sugestões */}
      <footer
        style={{
          background: "#ffffff",
          borderTop: "1px solid #e5e7eb",
        }}
      >
        {/* Sugestões logo acima do input (sob a 1ª mensagem) */}
        <SuggestionButtons
          onSuggestionClick={onSuggestionClick}
          isLoading={isLoading}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 8,
            padding: 12,
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Digite sua mensagem…"
            rows={2}
            style={inputStyle}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim()) enviarMensagem(input);
              }
            }}
          />
          <button
            onClick={() => enviarMensagem(input)}
            disabled={!input.trim() || isLoading}
            style={enviarStyle}
          >
            {isLoading ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </footer>

      {/* Modal de avisos (central) */}
      <AvisosModal
        open={avisosOpen}
        onClose={() => setAvisosOpen(false)}
        regionSlug={region.slug}
        theme={{
          background: "#fff",
          text: "#111827",
          inputBg: "#e5e7eb",
          headerBg: "#f9fafb",
          assistantBubble: "#f3f4f6",
        }}
      />
    </div>
  );
}

/* ---------------------------------- UI ---------------------------------- */

function Bubble({ role, text, meta }) {
  const isUser = role === "user";
  return (
    <div
      style={{
        display: "grid",
        justifyContent: isUser ? "end" : "start",
      }}
    >
      <div
        style={{
          maxWidth: "min(740px, 92vw)",
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          background: isUser ? "#dbeafe" : "#ffffff",
        }}
      >
        {text}
      </div>

      {/* Anexos simples — se o backend mandar links de fotos ou parceiros */}
      {Array.isArray(meta?.photos) && meta.photos.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {meta.photos.map((url, i) => (
            <img
              key={`${url}-${i}`}
              src={url}
              alt="foto"
              style={{
                width: 160,
                height: 100,
                objectFit: "cover",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const btnAvisosStyle = {
  background: "#fef3c7",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 10,
  padding: "8px 10px",
  fontWeight: 800,
  cursor: "pointer",
};

const inputStyle = {
  width: "100%",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  padding: 10,
  resize: "vertical",
  outline: "none",
  font: "inherit",
  background: "#fff",
};

const enviarStyle = {
  background: "#0ea5e9",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  padding: "0 16px",
  fontWeight: 800,
  cursor: "pointer",
  minWidth: 110,
};
