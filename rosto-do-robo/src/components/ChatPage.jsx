// src/components/ChatPage.jsx
import React, { useEffect, useRef, useState } from "react";
import { useParams } from 'react-router-dom';
import SuggestionButtons from "./SuggestionButtons.jsx";

export default function ChatPage({ theme, onToggleTheme }) {
  // 1. A MUDANÇA PRINCIPAL: Pegamos o 'regiaoSlug' direto da URL.
  const { regiaoSlug } = useParams(); 
  
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, photos]);

  async function enviarMensagem(textoManual) {
    const texto = (textoManual ?? input).trim();
    if (!texto || loading) return;

    const novaMsgUser = { role: "user", text: texto };
    setMessages(prev => [...prev, novaMsgUser]);
    setInput("");
    setLoading(true);
    setPhotos([]); // Melhoria: Limpa fotos antigas ao enviar nova mensagem

    try {
      const resp = await fetch(`/api/chat/${encodeURIComponent(regiaoSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: texto, conversationId })
      });

      if (!resp.ok) {
        const erro = await resp.json().catch(() => ({}));
        throw new Error(erro?.error || `Falha HTTP ${resp.status}`);
      }

      const data = await resp.json();
      if (!conversationId && data?.conversationId) {
        setConversationId(data.conversationId);
      }

      setMessages(prev => [...prev, { role: "assistant", text: data?.reply || "..." }]);
      setPhotos(Array.isArray(data?.photoLinks) ? data.photoLinks : []);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", text: `Desculpe, ocorreu um erro: ${e.message}` }]);
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
    // A função original já estava correta, mas deixei explícito
    // que ao clicar na sugestão, o texto vai para o input e já envia.
    setInput(texto);
    enviarMensagem(texto);
  }

  // Função para formatar o slug para um nome legível (ex: regiao-dos-lagos -> Região dos Lagos)
  const formatSlug = (slug) => {
    return slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", height: "100vh", overflow: "hidden", backgroundColor: theme.background, color: theme.text }}>
      <header style={{ padding: 12, borderBottom: `1px solid ${theme.inputBg}`, display: "flex", gap: 12, alignItems: "center", backgroundColor: theme.headerBg }}>
        <div style={{ fontWeight: 700 }}>BEPIT Nexus</div>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={onToggleTheme} style={{ background: 'none', border: `1px solid ${theme.inputBg}`, color: theme.text, padding: '6px 10px', borderRadius: '6px', cursor: 'pointer' }}>
            {theme.background === '#fff' ? '🌙 Escuro' : '☀️ Claro'}
          </button>
        </div>
      </header>

      <main style={{ position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <SuggestionButtons onSuggestionClick={onSuggestionClick} isLoading={loading} theme={theme} />
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: 'flex', flexDirection: 'column' }}>
          {messages.map((m, idx) => (
            <div key={idx} style={{ 
                marginBottom: 12, 
                padding: '8px 12px',
                borderRadius: '12px',
                backgroundColor: m.role === 'assistant' ? theme.assistantBubble : 'transparent',
                maxWidth: '80%',
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}>
              {/* Melhoria: Cor do texto se adapta ao tema */}
              <div style={{ fontSize: 12, color: theme.text, opacity: 0.7, fontWeight: 'bold', marginBottom: '4px' }}>{m.role === "user" ? "Você" : "BEPIT"}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
            </div>
          ))}
          {photos?.length > 0 && (
             <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginTop: 12 }}>
                {photos.map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noreferrer" style={{ display: "block", border: `1px solid ${theme.inputBg}`, borderRadius: 8, overflow: "hidden" }}>
                    <img src={src} alt={`foto-${i + 1}`} style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
                  </a>
                ))}
              </div>
          )}
        </div>
      </main>

      <footer style={{ padding: 12, borderTop: `1px solid ${theme.inputBg}`, backgroundColor: theme.headerBg }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onEnterEnviar}
            // Melhoria: Placeholder dinâmico
            placeholder={`Pergunte sobre a ${formatSlug(regiaoSlug || "")}...`}
            rows={2}
            style={{ resize: "none", padding: 10, borderRadius: 8, border: `1px solid ${theme.inputBg}`, backgroundColor: theme.inputBg, color: theme.text }}
          />
          <button onClick={() => enviarMensagem()} disabled={loading || !input.trim()} style={{ padding: "0 18px", borderRadius: 8, border: "none", background: loading ? "#555" : "#007aff", color: "#fff", cursor: loading ? "not-allowed" : "pointer", fontWeight: 600 }}>
            {loading ? "..." : "Enviar"}
          </button>
        </div>
      </footer>
    </div>
  );
}