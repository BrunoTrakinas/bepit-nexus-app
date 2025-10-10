import { useEffect, useMemo, useRef, useState } from "react";
import AvisosModal from "./AvisosModal.jsx";
import SuggestionButtons from "./SuggestionButtons.jsx";

// Chamada ao backend
async function enviarMensagemParaChat(slug, body) {
  const base = import.meta.env.VITE_API_BASE_URL || "";
  const url = `${base}/api/chat/${encodeURIComponent(slug)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Falha no chat: ${resp.status} ${resp.statusText} ${t}`);
  }
  return await resp.json();
}

export default function ChatPage() {
  const [region, setRegion] = useState(null);          // { slug, name }
  const [messages, setMessages] = useState([]);        // { id, role: 'assistant'|'user', text, photos?: string[] }
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [showAvisos, setShowAvisos] = useState(false);

  const inputRef = useRef(null);
  const endRef = useRef(null);

  // Garante região do localStorage; se não houver, volta para seleção
  useEffect(() => {
    try {
      const raw = localStorage.getItem("bepit:region");
      if (!raw) {
        window.location.replace("/");
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.slug || !parsed?.name) {
        window.location.replace("/");
        return;
      }
      setRegion(parsed);

      // carrega conversationId salvo para a região (se existir)
      const convKey = `bepit:conv:${parsed.slug}`;
      const savedConv = localStorage.getItem(convKey);
      if (savedConv) setConversationId(savedConv);
    } catch {
      window.location.replace("/");
    }
  }, []);

  // Mensagem de boas-vindas (inclui sugestão de checar avisos)
  const welcomeMessage = useMemo(() => {
    const nome = region?.name || "sua região";
    return (
      `Olá! Eu sou o BEPIT, seu concierge IA em ${nome}.\n\n` +
      `Dica rápida: antes de perguntar, vale checar se existem **avisos da região** (obras, interdições, bandeira de praia, eventos). ` +
      `Clique em "⚠️ Avisos da Região" no topo quando quiser.`
    );
  }, [region]);

  // Inicializa o chat com a mensagem de boas-vindas
  useEffect(() => {
    if (!region) return;
    setMessages([
      { id: crypto.randomUUID(), role: "assistant", text: welcomeMessage }
    ]);
  }, [region, welcomeMessage]);

  // Scroll automático sempre que a lista muda
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  async function handleSend(text) {
    if (!region || !text?.trim()) return;
    const msg = text.trim();

    // Renderiza a mensagem do usuário
    const userMsg = { id: crypto.randomUUID(), role: "user", text: msg };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const body = { message: msg };
      if (conversationId) body.conversationId = conversationId;

      const json = await enviarMensagemParaChat(region.slug, body);

      // Guarda conversationId para a região
      if (json?.conversationId && json.conversationId !== conversationId) {
        setConversationId(json.conversationId);
        localStorage.setItem(`bepit:conv:${region.slug}`, json.conversationId);
      }

      // Resposta do assistente
      const iaMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: json?.reply || "Não consegui responder agora. Tente novamente.",
        photos: Array.isArray(json?.photoLinks) ? json.photoLinks : []
      };
      setMessages(prev => [...prev, iaMsg]);
    } catch (e) {
      console.error("[Chat] Erro:", e);
      setMessages(prev => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", text: "Tive um problema para responder agora. Você pode tentar novamente?" }
      ]);
    } finally {
      setIsLoading(false);
      if (inputRef.current) {
        inputRef.current.value = "";
        inputRef.current.focus();
      }
    }
  }

  function handleSuggestionClick(hint) {
    if (isLoading || !hint) return;
    handleSend(hint);
  }

  if (!region) return null; // evita flicker antes do redirect/storage

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateRows: "auto 1fr auto", background: "#f6f7fb" }}>
      {/* Header */}
      <header style={{ position: "sticky", top: 0, background: "#fff", borderBottom: "1px solid #e5e7eb", zIndex: 10 }}>
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>BEPIT • {region.name}</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              onClick={() => setShowAvisos(true)}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "#fff",
                cursor: "pointer",
                fontSize: 14
              }}
              title="Abrir avisos da região"
            >
              ⚠️ Avisos da Região
            </button>
          </div>
        </div>
      </header>

      {/* Corpo do chat */}
      <main style={{ maxWidth: 980, width: "100%", margin: "0 auto", padding: 16 }}>
        <div style={{ display: "grid", gap: 14 }}>
          {messages.map(m => (
            <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div
                style={{
                  maxWidth: "80%",
                  whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "#0ea5e9" : "#fff",
                  color: m.role === "user" ? "#fff" : "#111827",
                  border: m.role === "user" ? "1px solid #0ea5e9" : "1px solid #e5e7eb",
                  padding: "10px 12px",
                  borderRadius: 12,
                  boxShadow: "0 6px 18px rgba(0,0,0,0.05)"
                }}
              >
                {m.text}
                {Array.isArray(m.photos) && m.photos.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {m.photos.map((src, i) => (
                      <img
                        key={`${m.id}-photo-${i}`}
                        src={src}
                        alt="foto"
                        style={{ width: 140, height: 100, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }}
                        loading="lazy"
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Sugestões iniciais (abaixo da mensagem de boas-vindas) */}
          <SuggestionButtons
            isLoading={isLoading}
            onSuggestionClick={handleSuggestionClick}
            suggestions={[
              "Onde comer?",
              "Passeios de barco",
              "Praias com estrutura",
              "Churrascaria com picanha"
            ]}
          />

          <div ref={endRef} />
        </div>
      </main>

      {/* Input */}
      <footer style={{ background: "#fff", borderTop: "1px solid #e5e7eb", position: "sticky", bottom: 0 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!inputRef.current) return;
            handleSend(inputRef.current.value);
          }}
          style={{ maxWidth: 980, margin: "0 auto", padding: 12, display: "flex", gap: 8 }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Escreva sua pergunta…"
            autoFocus
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid #e5e7eb",
              fontSize: 15
            }}
          />
          <button
            type="submit"
            disabled={isLoading}
            style={{
              padding: "12px 18px",
              borderRadius: 12,
              background: isLoading ? "#93c5fd" : "#0ea5e9",
              color: "#fff",
              border: "none",
              cursor: isLoading ? "default" : "pointer",
              fontSize: 15,
              fontWeight: 600
            }}
          >
            {isLoading ? "Enviando…" : "Enviar"}
          </button>
        </form>
      </footer>

      {/* Modal de avisos */}
      <AvisosModal
        open={showAvisos}
        onClose={() => setShowAvisos(false)}
        regionSlug={region.slug}
        theme="light"
      />
    </div>
  );
}
