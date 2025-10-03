// rosto-do-robo/src/admin/AdminPortal.jsx
import React, { useState } from "react";
import {
  adminLoginByKey,
  getAdminKey,
  clearAdminKey,
  adminPost,
  adminGet
} from "./adminApi";

export default function AdminPortal() {
  // -------------------- Login por chave --------------------
  const [adminKeyInput, setAdminKeyInput] = useState("");
  const [authMsg, setAuthMsg] = useState(getAdminKey() ? "Logado." : "Não logado.");

  async function fazerLogin(e) {
    e?.preventDefault?.();
    try {
      await adminLoginByKey(adminKeyInput);
      setAuthMsg("Logado.");
    } catch (err) {
      setAuthMsg("Erro ao logar: " + (err?.message || "desconhecido"));
    }
  }

  function fazerLogout() {
    clearAdminKey();
    setAuthMsg("Não logado.");
  }

  // -------------------- Form de criação --------------------
  const [form, setForm] = useState({
    regiaoSlug: "regiao-dos-lagos",
    cidadeSlug: "cabo-frio",
    tipo: "PARCEIRO", // ou "DICA"
    nome: "",
    descricao: "",
    categoria: "",
    endereco: "",
    contato: "",
    faixa_preco: "",
    horario_funcionamento: "",
    beneficio_bepit: "",
    tags: "",
    fotos: ""
  });

  const [status, setStatus] = useState("");
  const [lista, setLista] = useState([]);

  function onChange(e) {
    setForm((old) => ({ ...old, [e.target.name]: e.target.value }));
  }

  async function criarParceiro(e) {
    e.preventDefault();
    setStatus("Enviando...");

    const payload = {
      regiaoSlug: form.regiaoSlug.trim(),
      cidadeSlug: form.cidadeSlug.trim(),
      tipo: form.tipo,
      nome: form.nome,
      descricao: form.descricao || null,
      categoria: form.categoria || null,
      endereco: form.endereco || null,
      contato: form.contato || null,
      faixa_preco: form.faixa_preco || null,
      horario_funcionamento: form.horario_funcionamento || null,
      beneficio_bepit: form.beneficio_bepit || null, // o backend ignora promo; ok manter campo
      tags: form.tags
        ? form.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : null,
      fotos: form.fotos
        ? form.fotos.split(",").map((u) => u.trim()).filter(Boolean)
        : null,
      ativo: true
    };

    try {
      const data = await adminPost("/api/admin/parceiros", payload);
      setStatus(`Criado com sucesso: ${data?.data?.nome || ""}`);
      setForm((f) => ({ ...f, nome: "", descricao: "", categoria: "", endereco: "", contato: "", faixa_preco: "", horario_funcionamento: "", beneficio_bepit: "", tags: "", fotos: "" }));
    } catch (err) {
      setStatus(err?.message || "Erro ao criar");
    }
  }

  async function listar() {
    setStatus("Carregando lista...");
    try {
      const data = await adminGet(`/api/admin/parceiros/${encodeURIComponent(form.regiaoSlug)}/${encodeURIComponent(form.cidadeSlug)}`);
      setLista(Array.isArray(data?.data) ? data.data : []);
      setStatus(`Carregado (${Array.isArray(data?.data) ? data.data.length : 0} itens)`);
    } catch (err) {
      setStatus(err?.message || "Erro ao listar");
    }
  }

  return (
    <div style={{ maxWidth: 820, margin: "20px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Admin Portal — BEPIT</h1>

      {/* Login por chave administrativa */}
      <form onSubmit={fazerLogin} style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}>
        <input
          placeholder="Admin Key"
          value={adminKeyInput}
          onChange={(e) => setAdminKeyInput(e.target.value)}
          style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ccc" }}
        />
        <button type="submit" style={{ padding: "8px 12px", borderRadius: 6, background: "#0b74de", color: "#fff", border: "none" }}>
          Entrar
        </button>
        <button type="button" onClick={fazerLogout} style={{ padding: "8px 12px", borderRadius: 6, background: "#d9534f", color: "#fff", border: "none" }}>
          Sair
        </button>
      </form>
      <div style={{ marginBottom: 16, color: "#555" }}>{authMsg}</div>

      {/* Formulário de criação */}
      <form onSubmit={criarParceiro} style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>Região (slug)<input name="regiaoSlug" value={form.regiaoSlug} onChange={onChange} /></label>
          <label>Cidade (slug)<input name="cidadeSlug" value={form.cidadeSlug} onChange={onChange} /></label>
        </div>
        <label>Tipo
          <select name="tipo" value={form.tipo} onChange={onChange}>
            <option value="PARCEIRO">PARCEIRO</option>
            <option value="DICA">DICA</option>
          </select>
        </label>
        <label>Nome<input name="nome" value={form.nome} onChange={onChange} required /></label>
        <label>Descrição<textarea name="descricao" value={form.descricao} onChange={onChange} rows={3} /></label>
        <label>Categoria<input name="categoria" value={form.categoria} onChange={onChange} /></label>
        <label>Endereço<input name="endereco" value={form.endereco} onChange={onChange} /></label>
        <label>Contato<input name="contato" value={form.contato} onChange={onChange} /></label>
        <label>Horário de funcionamento<input name="horario_funcionamento" value={form.horario_funcionamento} onChange={onChange} /></label>
        <label>Faixa de preço<input name="faixa_preco" value={form.faixa_preco} onChange={onChange} /></label>
        <label>Benefício (texto livre — não será anunciado ao usuário)<input name="beneficio_bepit" value={form.beneficio_bepit} onChange={onChange} /></label>
        <label>Tags (sep. por vírgula)<input name="tags" value={form.tags} onChange={onChange} /></label>
        <label>Fotos (URLs, sep. por vírgula)<input name="fotos" value={form.fotos} onChange={onChange} /></label>

        <button type="submit" style={{ padding: "10px 16px", borderRadius: 6, background: "#2e7d32", color: "#fff", border: "none", fontWeight: 600 }}>
          Criar parceiro/dica
        </button>
      </form>

      <hr style={{ margin: "20px 0" }} />

      <button onClick={listar} style={{ padding: "8px 12px", borderRadius: 6, background: "#0b74de", color: "#fff", border: "none" }}>
        Listar por região/cidade
      </button>
      <div style={{ marginTop: 10, color: "#333" }}>{status}</div>

      <ul style={{ marginTop: 10 }}>
        {lista.map((item) => (
          <li key={item.id}>
            <b>{item.nome}</b> — {item.tipo} — {item.categoria} — {item.endereco || "—"}
          </li>
        ))}
      </ul>
    </div>
  );
}
