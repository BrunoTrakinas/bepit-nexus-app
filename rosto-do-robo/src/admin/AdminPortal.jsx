// F:\uber-chat-mvp\rosto-do-robo\src\admin\AdminPortal.jsx
import React, { useState } from "react";
import apiClient from "../lib/apiClient";

export default function AdminPortal() {
  const [form, setForm] = useState({
    regiaoSlug: "regiao-dos-lagos",
    cidadeSlug: "cabo-frio",
    tipo: "PARCEIRO", // ou "DICA"
    nome: "",
    descricao: "",
    categoria: "",
    beneficio_bepit: "",
    endereco: "",
    contato: "",
    tags: "",
    horario_funcionamento: "",
    faixa_preco: "",
    fotos: "" // separadas por vírgula
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
      regiaoSlug: form.regiaoSlug,
      cidadeSlug: form.cidadeSlug,
      tipo: form.tipo,
      nome: form.nome,
      descricao: form.descricao || null,
      categoria: form.categoria || null,
      beneficio_bepit: form.beneficio_bepit || null,
      endereco: form.endereco || null,
      contato: form.contato || null,
      tags: form.tags
        ? form.tags.split(",").map(t => t.trim()).filter(Boolean)
        : null,
      horario_funcionamento: form.horario_funcionamento || null,
      faixa_preco: form.faixa_preco || null,
      fotos: form.fotos
        ? form.fotos.split(",").map(u => u.trim()).filter(Boolean)
        : null,
      ativo: true
    };

    try {
      const { data } = await apiClient.post("/api/admin/parceiros", payload);
      setStatus(`Criado com sucesso: ${data?.data?.nome || ""}`);
    } catch (err) {
      console.error(err);
      setStatus(err?.response?.data?.error || "Erro ao criar");
    }
  }

  async function listar() {
    setStatus("Carregando lista...");
    try {
      const { data } = await apiClient.get(
        `/api/admin/parceiros/${form.regiaoSlug}/${form.cidadeSlug}`
      );
      setLista(data?.data || []);
      setStatus(`Carregado (${data?.data?.length || 0} itens)`);
    } catch (err) {
      console.error(err);
      setStatus(err?.response?.data?.error || "Erro ao listar");
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "20px auto", fontFamily: "sans-serif" }}>
      <h1>Admin Portal — BEPIT</h1>
      <p style={{ color: "#555" }}>
        Este painel usa o <b>backend</b> (com Service Role), então nenhuma chave sensível aparece no navegador.
      </p>

      <form onSubmit={criarParceiro} style={{ display: "grid", gap: 8 }}>
        <div>
          <label>Região (slug)</label>
          <input name="regiaoSlug" value={form.regiaoSlug} onChange={onChange} />
        </div>
        <div>
          <label>Cidade (slug)</label>
          <input name="cidadeSlug" value={form.cidadeSlug} onChange={onChange} />
        </div>
        <div>
          <label>Tipo</label>
          <select name="tipo" value={form.tipo} onChange={onChange}>
            <option value="PARCEIRO">PARCEIRO</option>
            <option value="DICA">DICA</option>
          </select>
        </div>
        <div>
          <label>Nome</label>
          <input name="nome" value={form.nome} onChange={onChange} required />
        </div>
        <div>
          <label>Descrição</label>
          <textarea name="descricao" value={form.descricao} onChange={onChange} />
        </div>
        <div>
          <label>Categoria</label>
          <input name="categoria" value={form.categoria} onChange={onChange} />
        </div>
        <div>
          <label>Benefício BEPIT</label>
          <input name="beneficio_bepit" value={form.beneficio_bepit} onChange={onChange} />
        </div>
        <div>
          <label>Endereço</label>
          <input name="endereco" value={form.endereco} onChange={onChange} />
        </div>
        <div>
          <label>Contato</label>
          <input name="contato" value={form.contato} onChange={onChange} />
        </div>
        <div>
          <label>Tags (sep. por vírgula)</label>
          <input name="tags" value={form.tags} onChange={onChange} />
        </div>
        <div>
          <label>Horário de funcionamento</label>
          <input name="horario_funcionamento" value={form.horario_funcionamento} onChange={onChange} />
        </div>
        <div>
          <label>Faixa de preço</label>
          <input name="faixa_preco" value={form.faixa_preco} onChange={onChange} />
        </div>
        <div>
          <label>Fotos (URLs, sep. por vírgula)</label>
          <input name="fotos" value={form.fotos} onChange={onChange} />
        </div>

        <button type="submit">Criar parceiro/dica</button>
      </form>

      <hr style={{ margin: "20px 0" }} />

      <button onClick={listar}>Listar por região/cidade</button>
      <div style={{ marginTop: 10, color: "#333" }}>{status}</div>

      <ul>
        {lista.map(item => (
          <li key={item.id}>
            <b>{item.nome}</b> — {item.tipo} — {item.categoria} — {item.endereco}
          </li>
        ))}
      </ul>
    </div>
  );
}
