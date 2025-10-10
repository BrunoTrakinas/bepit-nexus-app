// src/components/ChatPage.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SuggestionButtons from "./SuggestionButtons.jsx";
import apiClient from "../lib/apiClient.js";
import AvisosModal from "./AvisosModal.jsx";

export default function ChatPage({ theme, onToggleTheme }) {
  const navigate = useNavigate();

  // região vinda do localStorage
  const [regiao, setRegiao] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAvisos, setShowAvisos] = useState(false);

  const listRef = useRef(null);

  // Carrega a região do localStorage e configura a mensagem de boas-vindas
  useEffect(() => {
    try {
      const raw = localStorage.getItem("bepit.regiao");
      if (!raw) {
        navigate("/");
        return;
      }
      const obj = JSON.parse(raw);
      if (!obj || !obj.slug || !obj.nome) {
        navigate("/");
        return;
      }
      setRegiao(obj);

      // mensagem de boas-vindas dinâmica
      const welcome = {
        role: "assistant",
        text: `Olá! Eu sou o BEPIT, seu concierge IA em ${obj.nome}.`
      };
      setMessages([welcome]);
    } catch {
      navigate("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rolagem automática ao final quando chegam mensagens/fotos ou estado de "digitando..."
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, photos, loading]);

  async function enviarMensagem(textoManual) {
    if (!regiao || !regiao.slug) return;

    const texto = (textoManual ?? input).trim();
    if (!texto || loading) return;

    const novaMsgUser = { role: "user", text: texto };
    setMessages((prev) => [...prev, novaMsgUser]);
    setInput("");
    setLoading(true);
    setPhotos([]);

    try {
      const data = await apiClient.enviarMensagemParaChat(regiao.slug, {
        message: texto,
        conversationId
      });

      if (!conversationId && data?.conversationId) {
        setConversationId(data.conversationId);
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data?.reply || "..." }
      ]);
      setPhotos(Array.isArray(data?.photoLinks) ? data.photoLinks : []);
    } catch (e) {
      const detalhes =
        e?.data?.error ||
        e?.message ||
        "Falha ao enviar sua mensagem. Tente novamente.";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Desculpe, ocorreu um erro: ${detalhes}` }
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onEnterEnviar(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviarMensagem();
    }
  }

  function onSuggestionClick(texto) {
    setInput(texto);
    enviarMensagem(texto);
  }

  const assistantBubbleBg =
    theme?.assistantBubble || (theme.background === "#fff" ? "#f5f7fb" : "#20242c");
  const assistantBorder = theme.background === "#fff" ? "#e6e8ee" : "#2a2f3a";
  const userBubbleBg = "#0b74de";
  const userTextColor = "#fff";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: theme.background,
        color: theme.text,
        fontFamily: "'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      }}
    >
      {/* HEADER */}
      <header
        style={{
          padding: 14,
          borderBottom: `1px solid ${theme.inputBg}`,
          display: "flex",
          gap: 12,
          alignItems: "center",
          backgroundColor: theme.headerBg
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{
            background: "none",
            border: `1px solid ${theme.inputBg}`,
            color: theme.text,
            padding: "8px 12px",
            borderRadius: "10px",
            cursor: "pointer",
            fontWeight: 600
          }}
        >
          ← Trocar Região
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img
            src="/bepit-logo.png"
            alt="BEPIT"
            style={{ width: 28, height: 28, objectFit: "contain" }}
          />
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>BEPIT Concierge</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {regiao?.nome || "—"}
            </div>
          </div>
        </div>

        {/* Botão de Avisos da Região */}
        <button
          onClick={() => setShowAvisos(true)}
          style={{
            marginLeft: "auto",
            background: "none",
            border: `1px solid ${theme.inputBg}`,
            color: theme.text,
            padding: "8px 12px",
            borderRadius: "10px",
            cursor: "pointer",
            fontWeight: 700
          }}
          title="Ver avisos por cidade"
        >
          ⚠️ Avisos da Região
        </button>

        <div>
          <button
            onClick={onToggleTheme}
            style={{
              background: "none",
              border: `1px solid ${theme.inputBg}`,
              color: theme.text,
              padding: "8px 12px",
              borderRadius: "10px",
              cursor: "pointer",
              fontWeight: 600,
              marginLeft: 8
            }}
          >
            {theme.background === "#fff" ? "🌙 Escuro" : "☀️ Claro"}
          </button>
        </div>
      </header>

      {/* MAIN */}
      <main
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }}
      >
        {/* Botões de sugestão logo abaixo da mensagem de boas-vindas */}
        <SuggestionButtons
          onSuggestionClick={onSuggestionClick}
          isLoading={loading}
          theme={theme}
        />

        {/* LISTA DE MENSAGENS */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10
          }}
        >
          {messages.map((m, idx) => {
            const isAssistant = m.role !== "user";
            return (
              <div
                key={idx}
                style={{
                  display: "flex",
                  justifyContent: isAssistant ? "flex-start" : "flex-end"
                }}
              >
                <div
                  style={{
                    maxWidth: "80%",
                    borderRadius: 16,
                    padding: "10px 14px",
                    boxShadow: isAssistant
                      ? "0 1px 2px rgba(0,0,0,0.06)"
                      : "0 1px 2px rgba(0,0,0,0.12)",
                    backgroundColor: isAssistant ? assistantBubbleBg : userBubbleBg,
                    border: isAssistant ? `1px solid ${assistantBorder}` : "none",
                    color: isAssistant ? theme.text : userTextColor
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      opacity: 0.8,
                      fontWeight: 600,
                      marginBottom: 6
                    }}
                  >
                    {isAssistant ? "BEPIT" : "Você"}
                  </div>
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: 15,
                      lineHeight: 1.6,
                      fontWeight: 400
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              </div>
            );
          })}

          {/* INDICADOR DE “DIGITANDO…” */}
          {loading && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div
                style={{
                  backgroundColor: assistantBubbleBg,
                  border: `1px solid ${assistantBorder}`,
                  color: theme.text,
                  maxWidth: "60%",
                  borderRadius: 16,
                  padding: "10px 14px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    opacity: 0.8,
                    fontWeight: 600
                  }}
                >
                  BEPIT
                </span>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 6,
                      background: theme.text,
                      opacity: 0.35,
                      animation: "bepitBlink 1s infinite"
                    }}
                  />
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 6,
                      background: theme.text,
                      opacity: 0.35,
                      animation: "bepitBlink 1s infinite 0.2s"
                    }}
                  />
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 6,
                      background: theme.text,
                      opacity: 0.35,
                      animation: "bepitBlink 1s infinite 0.4s"
                    }}
                  />
                </span>
              </div>
            </div>
          )}

          {/* GALERIA DE FOTOS */}
          {photos?.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: 10,
                marginTop: 4
              }}
            >
              {photos.map((src, i) => (
                <a
                  key={i}
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "block",
                    border: `1px solid ${assistantBorder}`,
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#000"
                  }}
                >
                  <img
                    src={src}
                    alt={`foto-${i + 1}`}
                    style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }}
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* FOOTER */}
      <footer
        style={{
          padding: 14,
          borderTop: `1px solid ${theme.inputBg}`,
          backgroundColor: theme.headerBg
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 10,
            alignItems: "end"
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onEnterEnviar}
              placeholder={`Pergunte sobre ${regiao?.nome || "a região"}...`}
              rows={2}
              style={{
                resize: "none",
                padding: 12,
                borderRadius: 12,
                border: `1px solid ${theme.inputBg}`,
                backgroundColor: theme.inputBg,
                color: theme.text,
                fontFamily: "'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                fontSize: 15,
                lineHeight: 1.5
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              Pressione <b>Enter</b> para enviar · <b>Shift + Enter</b> para nova linha
            </div>
          </div>

          <button
            onClick={() => enviarMensagem()}
            disabled={loading || !input.trim()}
            style={{
              padding: "12px 18px",
              borderRadius: 12,
              border: "none",
              background: loading ? "#657786" : "#0b74de",
              color: "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 600,
              minWidth: 120,
              boxShadow: loading ? "none" : "0 6px 12px rgba(11,116,222,0.25)",
              transition: "transform 0.06s ease"
            }}
            onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
            onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          >
            {loading ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </footer>

      {/* Modal de Avisos */}
      <AvisosModal
        open={showAvisos}
        onClose={() => setShowAvisos(false)}
        regionSlug={regiao?.slug || ""}
        theme={theme}
      />

      {/* ANIMAÇÃO do indicador */}
      <style>{`
        @keyframes bepitBlink {
          0% { opacity: 0.2; transform: translateY(0); }
          50% { opacity: 0.8; transform: translateY(-2px); }
          100% { opacity: 0.2; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
