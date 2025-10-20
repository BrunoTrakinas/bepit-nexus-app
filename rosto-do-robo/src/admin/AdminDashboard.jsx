// src/admin/AdminDashboard.jsx
// ============================================================================
// Painel do Administrador — BEPIT Nexus
// - Rótulos leigos (sem "slug", sem "tags")
// - Selects para Região/Cidade
// - Abas: Cadastro, Alterações, Avisos, Métricas, Logs
// - Compatível com o adminApi.js ESTENDIDO que te enviei
// ============================================================================

import React, { useEffect, useMemo, useState } from "react";
import {
  // base
  getRegioes, createRegiao,
  getCidades, createCidade,
  // parceiros
  getParceiros, createParceiro, updateParceiro, deleteParceiro,
  // dicas
  getDicas, createDica, updateDica, deleteDica,
  // avisos
  getAvisos, createAviso,
  // métricas e logs
  getMetricsSummary, getLogs,
  // utils
  toOptions, byId,
} from "./adminApi";

function Box({ title, children }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "8px 0" }}>
      <div style={{ minWidth: 180, color: "#333" }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Input(props) {
  return (
    <input
      {...props}
      style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
    />
  );
}

function Textarea(props) {
  return (
    <textarea
      {...props}
      style={{
        width: "100%",
        padding: 10,
        borderRadius: 8,
        border: "1px solid #ccc",
        minHeight: 100,
      }}
    />
  );
}

function Select({ options = [], value, onChange, placeholder = "Selecione...", allowEmpty = true }) {
  return (
    <select
      value={value || ""}
      onChange={(e) => onChange(e.target.value || null)}
      style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
    >
      {allowEmpty && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function MultiSelect({ options = [], values = [], onChange, placeholder = "Selecione..." }) {
  return (
    <select
      multiple
      value={values}
      onChange={(e) => {
        const arr = Array.from(e.target.selectedOptions).map((o) => o.value);
        onChange(arr);
      }}
      style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc", height: 120 }}
    >
      {options.length === 0 ? <option disabled>— {placeholder} —</option> : null}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export default function AdminDashboard() {
  const [aba, setAba] = useState("cadastro");

  // bases
  const [regioes, setRegioes] = useState([]);
  const [cidades, setCidades] = useState([]);

  // feedback
  const [msg, setMsg] = useState(null);
  const note = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 5000);
  };

  async function carregarBases() {
    const [r1, r2] = await Promise.all([getRegioes(), getCidades()]);
    if (r1.ok) setRegioes(r1.data?.regioes || r1.data || []);
    if (r2.ok) setCidades(r2.data?.cidades || r2.data || []);
  }

  useEffect(() => {
    carregarBases();
  }, []);

  const opRegioes = useMemo(() => toOptions(regioes, "nome"), [regioes]);
  const opCidades = useMemo(() => toOptions(cidades, "nome"), [cidades]);

  // ------------------------ ABA: CADASTRO -----------------------------------

  // regiões
  const [regiaoNome, setRegiaoNome] = useState("");

  async function salvarRegiao() {
    if (!regiaoNome.trim()) return note("Informe o nome da Região.");
    const r = await createRegiao({ nome: regiaoNome.trim() });
    if (!r.ok) return note(`Erro: ${r.error}`);
    setRegiaoNome("");
    await carregarBases();
    note("Região cadastrada com sucesso.");
  }

  // cidades
  const [cidadeNome, setCidadeNome] = useState("");
  const [cidadeRegiaoId, setCidadeRegiaoId] = useState(null);

  async function salvarCidade() {
    if (!cidadeNome.trim() || !cidadeRegiaoId) {
      return note("Informe Cidade e Região.");
    }
    const r = await createCidade({ nome: cidadeNome.trim(), regiaoId: cidadeRegiaoId });
    if (!r.ok) return note(`Erro: ${r.error}`);
    setCidadeNome("");
    setCidadeRegiaoId(null);
    await carregarBases();
    note("Cidade cadastrada com sucesso.");
  }

  // parceiros (criação)
  const [p, setP] = useState({
    nome: "",
    cidadeId: null,
    logradouro: "",
    numero: "",
    bairro: "",
    cep: "",
    descricao: "",
    categoria: "",
    referencias: "",
    contato: "",
  });

  async function salvarParceiro() {
    const obrig = ["nome", "cidadeId", "logradouro", "numero"];
    for (const k of obrig) {
      if (!String(p[k] || "").trim()) {
        return note("Preencha: Nome, Cidade, Rua/Avenida e Número.");
      }
    }
    const r = await createParceiro(p);
    if (!r.ok) return note(`Erro: ${r.error}`);
    setP({
      nome: "",
      cidadeId: null,
      logradouro: "",
      numero: "",
      bairro: "",
      cep: "",
      descricao: "",
      categoria: "",
      referencias: "",
      contato: "",
    });
    note("Parceiro cadastrado com sucesso.");
  }

  // dicas (criação)
  const [d, setD] = useState({ cidadeId: null, titulo: "", conteudo: "", categoria: "" });

  async function salvarDica() {
    if (!d.cidadeId || !d.titulo.trim() || !d.conteudo.trim()) {
      return note("Informe Cidade, Título e Conteúdo.");
    }
    const r = await createDica(d);
    if (!r.ok) return note(`Erro: ${r.error}`);
    setD({ cidadeId: null, titulo: "", conteudo: "", categoria: "" });
    note("Dica cadastrada com sucesso.");
  }

  // ------------------------ ABA: ALTERAÇÕES ---------------------------------

  // filtros e listas
  const [filtroNomeParceiro, setFiltroNomeParceiro] = useState("");
  const [filtroCidadeParceiro, setFiltroCidadeParceiro] = useState(null);
  const [listaParceiros, setListaParceiros] = useState([]);

  async function buscarParceiros() {
    const r = await getParceiros({
      nome: filtroNomeParceiro || undefined,
      cidadeId: filtroCidadeParceiro || undefined,
      limit: 100,
    });
    if (!r.ok) return note(`Erro ao buscar: ${r.error}`);
    setListaParceiros(r.data?.parceiros || r.data || []);
  }

  // edição
  const [editId, setEditId] = useState(null);
  const [editObj, setEditObj] = useState({});

  async function salvarEdicaoParceiro() {
    const r = await updateParceiro(editId, editObj);
    if (!r.ok) return note(`Erro ao salvar: ${r.error}`);
    setEditId(null);
    setEditObj({});
    await buscarParceiros();
    note("Parceiro atualizado com sucesso.");
  }

  async function excluirParceiro(id) {
    if (!window.confirm("Tem certeza que deseja excluir este parceiro?")) return;
    const r = await deleteParceiro(id);
    if (!r.ok) return note(`Erro ao excluir: ${r.error}`);
    await buscarParceiros();
    note("Parceiro excluído.");
  }

  // dicas (alterar/excluir)
  const [filtroCidadeDica, setFiltroCidadeDica] = useState(null);
  const [filtroTituloDica, setFiltroTituloDica] = useState("");
  const [listaDicas, setListaDicas] = useState([]);
  const [editDicaId, setEditDicaId] = useState(null);
  const [editDicaObj, setEditDicaObj] = useState({});

  async function buscarDicas() {
    const r = await getDicas({
      cidadeId: filtroCidadeDica || undefined,
      titulo: filtroTituloDica || undefined,
      limit: 100,
    });
    if (!r.ok) return note(`Erro ao buscar: ${r.error}`);
    setListaDicas(r.data?.dicas || r.data || []);
  }

  async function salvarEdicaoDica() {
    const r = await updateDica(editDicaId, editDicaObj);
    if (!r.ok) return note(`Erro ao salvar: ${r.error}`);
    setEditDicaId(null);
    setEditDicaObj({});
    await buscarDicas();
    note("Dica atualizada com sucesso.");
  }

  async function excluirDica(id) {
    if (!window.confirm("Tem certeza que deseja excluir esta dica?")) return;
    const r = await deleteDica(id);
    if (!r.ok) return note(`Erro ao excluir: ${r.error}`);
    await buscarDicas();
    note("Dica excluída.");
  }

  // ------------------------ ABA: AVISOS -------------------------------------

  const [avTitulo, setAvTitulo] = useState("");
  const [avMensagem, setAvMensagem] = useState("");
  const [avRegiaoId, setAvRegiaoId] = useState(null);
  const [avCidadeIds, setAvCidadeIds] = useState([]);
  const [avisos, setAvisos] = useState([]);

  async function carregarAvisos() {
    const r = await getAvisos({});
    if (r.ok) setAvisos(r.data?.avisos || r.data || []);
  }

  async function salvarAviso() {
    if (!avTitulo.trim() || !avMensagem.trim()) {
      return note("Informe Título e Mensagem do aviso.");
    }
    const payload = {
      titulo: avTitulo.trim(),
      mensagem: avMensagem.trim(),
      cidadeIds: avCidadeIds,
      regiaoId: avCidadeIds.length ? null : avRegiaoId || null,
    };
    const r = await createAviso(payload);
    if (!r.ok) return note(`Erro ao publicar aviso: ${r.error}`);
    setAvTitulo("");
    setAvMensagem("");
    setAvRegiaoId(null);
    setAvCidadeIds([]);
    await carregarAvisos();
    note("Aviso publicado com sucesso.");
  }

  useEffect(() => {
    carregarAvisos();
  }, []);

  // ------------------------ ABA: MÉTRICAS -----------------------------------

  const [metrics, setMetrics] = useState(null);

  async function carregarMetrics() {
    const r = await getMetricsSummary();
    if (r.ok) setMetrics(r.data || {});
  }

  useEffect(() => {
    carregarMetrics();
  }, []);

  // ------------------------ ABA: LOGS ---------------------------------------

  const [logTipo, setLogTipo] = useState("");
  const [logLimit, setLogLimit] = useState(100);
  const [logs, setLogs] = useState([]);

  async function carregarLogs() {
    const r = await getLogs({ tipo: logTipo || undefined, limit: logLimit || 100 });
    if (r.ok) setLogs(r.data?.logs || r.data || []);
  }

  useEffect(() => {
    carregarLogs();
  }, []);

  // --------------------------------- UI -------------------------------------

  return (
    <div style={{ maxWidth: 1100, margin: "24px auto", padding: 16 }}>
      <h1 style={{ marginBottom: 8 }}>Painel do Administrador — BEPIT</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Aqui você cadastra e gerencia conteúdos do aplicativo, sem termos técnicos.
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 8, margin: "16px 0 24px" }}>
        {["cadastro", "alteracoes", "avisos", "metricas", "logs"].map((t) => (
          <button
            key={t}
            onClick={() => setAba(t)}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ccc",
              background: aba === t ? "#007bff" : "#f8f8f8",
              color: aba === t ? "#fff" : "#333",
              cursor: "pointer",
            }}
          >
            {t === "cadastro" && "Cadastro"}
            {t === "alteracoes" && "Alterações"}
            {t === "avisos" && "Avisos"}
            {t === "metricas" && "Métricas"}
            {t === "logs" && "Logs"}
          </button>
        ))}
      </div>

      {msg && (
        <div
          style={{
            background: "#eef7ee",
            border: "1px solid #bfe5bf",
            padding: 10,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          {msg}
        </div>
      )}

      {/* ------------------------- ABA CADASTRO ------------------------------ */}
      {aba === "cadastro" && (
        <>
          <Box title="Cadastrar Região">
            <Row label="Nome da Região">
              <Input
                value={regiaoNome}
                onChange={(e) => setRegiaoNome(e.target.value)}
                placeholder="Ex.: Região dos Lagos"
              />
            </Row>
            <button
              onClick={salvarRegiao}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Salvar Região
            </button>
          </Box>

          <Box title="Cadastrar Cidade">
            <Row label="Cidade">
              <Input
                value={cidadeNome}
                onChange={(e) => setCidadeNome(e.target.value)}
                placeholder="Ex.: Cabo Frio"
              />
            </Row>
            <Row label="Região">
              <Select
                options={opRegioes}
                value={cidadeRegiaoId}
                onChange={setCidadeRegiaoId}
                placeholder="Escolha a região"
              />
            </Row>
            <button
              onClick={salvarCidade}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Salvar Cidade
            </button>
          </Box>

          <Box title="Cadastrar Parceiro">
            <Row label="Nome do Parceiro *">
              <Input
                value={p.nome}
                onChange={(e) => setP({ ...p, nome: e.target.value })}
                placeholder="Ex.: Passeios do Zé"
              />
            </Row>
            <Row label="Cidade *">
              <Select
                options={opCidades}
                value={p.cidadeId}
                onChange={(v) => setP({ ...p, cidadeId: v })}
                placeholder="Escolha a cidade"
              />
            </Row>
            <Row label="Endereço (Rua/Avenida) *">
              <Input
                value={p.logradouro}
                onChange={(e) => setP({ ...p, logradouro: e.target.value })}
                placeholder="Ex.: Rua A"
              />
            </Row>
            <Row label="Número *">
              <Input
                value={p.numero}
                onChange={(e) => setP({ ...p, numero: e.target.value })}
                placeholder="Ex.: 123"
              />
            </Row>
            <Row label="Bairro">
              <Input
                value={p.bairro}
                onChange={(e) => setP({ ...p, bairro: e.target.value })}
                placeholder="Ex.: Centro"
              />
            </Row>
            <Row label="CEP">
              <Input
                value={p.cep}
                onChange={(e) => setP({ ...p, cep: e.target.value })}
                placeholder="Ex.: 28900-000"
              />
            </Row>
            <Row label="Descrição">
              <Textarea
                value={p.descricao}
                onChange={(e) => setP({ ...p, descricao: e.target.value })}
                placeholder="Um pequeno resumo sobre o parceiro..."
              />
            </Row>
            <Row label="Categoria">
              <Input
                value={p.categoria}
                onChange={(e) => setP({ ...p, categoria: e.target.value })}
                placeholder="Ex.: Restaurante, Passeio, Hospedagem..."
              />
            </Row>
            <Row label="Referências">
              <Input
                value={p.referencias}
                onChange={(e) => setP({ ...p, referencias: e.target.value })}
                placeholder="Palavras separadas por vírgula"
              />
            </Row>
            <Row label="Contato (telefone/site)">
              <Input
                value={p.contato}
                onChange={(e) => setP({ ...p, contato: e.target.value })}
                placeholder="(22) 99999-9999 / site"
              />
            </Row>
            <button
              onClick={salvarParceiro}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Salvar Parceiro
            </button>
          </Box>

          <Box title="Cadastrar Dica">
            <Row label="Cidade">
              <Select
                options={opCidades}
                value={d.cidadeId}
                onChange={(v) => setD({ ...d, cidadeId: v })}
                placeholder="Escolha a cidade"
              />
            </Row>
            <Row label="Título">
              <Input
                value={d.titulo}
                onChange={(e) => setD({ ...d, titulo: e.target.value })}
                placeholder="Ex.: Onde ver o pôr do sol"
              />
            </Row>
            <Row label="Conteúdo">
              <Textarea
                value={d.conteudo}
                onChange={(e) => setD({ ...d, conteudo: e.target.value })}
                placeholder="Escreva a dica completa..."
              />
            </Row>
            <Row label="Categoria (opcional)">
              <Input
                value={d.categoria}
                onChange={(e) => setD({ ...d, categoria: e.target.value })}
                placeholder="Ex.: Natureza, Gastronomia..."
              />
            </Row>
            <button
              onClick={salvarDica}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Salvar Dica
            </button>
          </Box>
        </>
      )}

      {/* ------------------------- ABA ALTERAÇÕES ----------------------------- */}
      {aba === "alteracoes" && (
        <>
          <Box title="Buscar Parceiros para Editar/Excluir">
            <Row label="Nome (opcional)">
              <Input
                value={filtroNomeParceiro}
                onChange={(e) => setFiltroNomeParceiro(e.target.value)}
                placeholder="Ex.: Picolino"
              />
            </Row>
            <Row label="Cidade (opcional)">
              <Select
                options={opCidades}
                value={filtroCidadeParceiro}
                onChange={setFiltroCidadeParceiro}
                placeholder="Escolha a cidade"
              />
            </Row>
            <button
              onClick={buscarParceiros}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Buscar
            </button>

            <div style={{ marginTop: 16 }}>
              {(listaParceiros || []).map((it) => (
                <div
                  key={it.id}
                  style={{
                    border: "1px solid #eee",
                    borderRadius: 10,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  {editId === it.id ? (
                    <>
                      <Row label="Nome">
                        <Input
                          value={editObj.nome ?? it.nome ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, nome: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Cidade">
                        <Select
                          options={opCidades}
                          value={editObj.cidadeId ?? it.cidade_id ?? ""}
                          onChange={(v) =>
                            setEditObj({ ...editObj, cidadeId: v })
                          }
                        />
                      </Row>
                      <Row label="Endereço (Rua/Avenida)">
                        <Input
                          value={editObj.logradouro ?? it.endereco_logradouro ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, logradouro: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Número">
                        <Input
                          value={editObj.numero ?? it.endereco_numero ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, numero: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Bairro">
                        <Input
                          value={editObj.bairro ?? it.bairro ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, bairro: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="CEP">
                        <Input
                          value={editObj.cep ?? it.cep ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, cep: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Descrição">
                        <Textarea
                          value={editObj.descricao ?? it.descricao ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, descricao: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Categoria">
                        <Input
                          value={editObj.categoria ?? it.categoria ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, categoria: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Referências">
                        <Input
                          value={editObj.referencias ?? it.referencias ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, referencias: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Contato">
                        <Input
                          value={editObj.contato ?? it.contato ?? ""}
                          onChange={(e) =>
                            setEditObj({ ...editObj, contato: e.target.value })
                          }
                        />
                      </Row>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={salvarEdicaoParceiro}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 8,
                            cursor: "pointer",
                          }}
                        >
                          Salvar
                        </button>
                        <button
                          onClick={() => {
                            setEditId(null);
                            setEditObj({});
                          }}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 8,
                            cursor: "pointer",
                            background: "#eee",
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600 }}>{it.nome}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>
                        Cidade: {byId(cidades, it.cidade_id)?.nome || it.cidade_id} • Endereço:{" "}
                        {it.endereco_logradouro || "—"}
                        {it.endereco_numero ? `, ${it.endereco_numero}` : ""}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          onClick={() => {
                            setEditId(it.id);
                            setEditObj({});
                          }}
                          style={{ padding: "8px 12px", borderRadius: 8, cursor: "pointer" }}
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => excluirParceiro(it.id)}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 8,
                            cursor: "pointer",
                            background: "#ffe7e7",
                          }}
                        >
                          Excluir
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </Box>

          <Box title="Editar/Excluir Dicas">
            <Row label="Cidade (opcional)">
              <Select
                options={opCidades}
                value={filtroCidadeDica}
                onChange={setFiltroCidadeDica}
                placeholder="Escolha a cidade"
              />
            </Row>
            <Row label="Título (opcional)">
              <Input
                value={filtroTituloDica}
                onChange={(e) => setFiltroTituloDica(e.target.value)}
                placeholder="trecho do título..."
              />
            </Row>
            <button
              onClick={buscarDicas}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Buscar
            </button>

            <div style={{ marginTop: 16 }}>
              {(listaDicas || []).map((it) => (
                <div
                  key={it.id}
                  style={{
                    border: "1px solid #eee",
                    borderRadius: 10,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  {editDicaId === it.id ? (
                    <>
                      <Row label="Cidade">
                        <Select
                          options={opCidades}
                          value={editDicaObj.cidadeId ?? it.cidade_id ?? ""}
                          onChange={(v) =>
                            setEditDicaObj({ ...editDicaObj, cidadeId: v })
                          }
                        />
                      </Row>
                      <Row label="Título">
                        <Input
                          value={editDicaObj.titulo ?? it.titulo ?? ""}
                          onChange={(e) =>
                            setEditDicaObj({ ...editDicaObj, titulo: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Conteúdo">
                        <Textarea
                          value={editDicaObj.conteudo ?? it.conteudo ?? ""}
                          onChange={(e) =>
                            setEditDicaObj({ ...editDicaObj, conteudo: e.target.value })
                          }
                        />
                      </Row>
                      <Row label="Categoria">
                        <Input
                          value={editDicaObj.categoria ?? it.categoria ?? ""}
                          onChange={(e) =>
                            setEditDicaObj({ ...editDicaObj, categoria: e.target.value })
                          }
                        />
                      </Row>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={salvarEdicaoDica}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 8,
                            cursor: "pointer",
                          }}
                        >
                          Salvar
                        </button>
                        <button
                          onClick={() => {
                            setEditDicaId(null);
                            setEditDicaObj({});
                          }}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 8,
                            cursor: "pointer",
                            background: "#eee",
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600 }}>{it.titulo}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>
                        Cidade: {byId(cidades, it.cidade_id)?.nome || it.cidade_id} • Categoria:{" "}
                        {it.categoria || "—"}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          onClick={() => {
                            setEditDicaId(it.id);
                            setEditDicaObj({});
                          }}
                          style={{ padding: "8px 12px", borderRadius: 8, cursor: "pointer" }}
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => excluirDica(it.id)}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 8,
                            cursor: "pointer",
                            background: "#ffe7e7",
                          }}
                        >
                          Excluir
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </Box>
        </>
      )}

      {/* ------------------------- ABA AVISOS -------------------------------- */}
      {aba === "avisos" && (
        <>
          <Box title="Publicar Aviso">
            <Row label="Título">
              <Input
                value={avTitulo}
                onChange={(e) => setAvTitulo(e.target.value)}
                placeholder="Ex.: Mar agitado hoje"
              />
            </Row>
            <Row label="Mensagem">
              <Textarea
                value={avMensagem}
                onChange={(e) => setAvMensagem(e.target.value)}
                placeholder="Escreva o aviso completo..."
              />
            </Row>
            <Row label="Região (opcional)">
              <Select
                options={opRegioes}
                value={avRegiaoId}
                onChange={setAvRegiaoId}
                placeholder="Escolha uma região (opcional)"
              />
            </Row>
            <Row label="Cidades (opcional — selecione várias se quiser)">
              <MultiSelect
                options={opCidades}
                values={avCidadeIds}
                onChange={setAvCidadeIds}
                placeholder="Selecione uma ou mais cidades"
              />
            </Row>
            <div style={{ color: "#666", marginBottom: 8 }}>
              Dica: se selecionar cidades, o aviso será publicado <b>somente nelas</b>. Se não
              selecionar cidades e escolher uma Região, o aviso vale para <b>todas</b> as cidades da
              Região.
            </div>
            <button
              onClick={salvarAviso}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Publicar Aviso
            </button>
          </Box>

          <Box title="Avisos Publicados (mais recentes)">
            {(avisos || []).length === 0 ? (
              <div>Nenhum aviso cadastrado ainda.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {avisos.map((a) => (
                  <div key={a.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{a.titulo}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      {new Date(a.created_at || a.data || Date.now()).toLocaleString()}
                    </div>
                    <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{a.mensagem}</div>
                    {!!(a.cidades && a.cidades.length) && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
                        Cidades: {a.cidades.map((id) => byId(cidades, id)?.nome || id).join(", ")}
                      </div>
                    )}
                    {a.regiao_id && (
                      <div style={{ marginTop: 4, fontSize: 12, color: "#555" }}>
                        Região: {byId(regioes, a.regiao_id)?.nome || a.regiao_id}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Box>
        </>
      )}

      {/* ------------------------- ABA MÉTRICAS ------------------------------- */}
      {aba === "metricas" && (
        <>
          <Box title="Resumo de Consumo — APIs e Sistema">
            {!metrics ? (
              <div>Carregando...</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>OpenWeather</div>
                  <div>Chamadas: {metrics.openweather?.calls ?? "—"}</div>
                  <div>Custo estimado: {metrics.openweather?.cost ?? "—"}</div>
                </div>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>Stormglass</div>
                  <div>Chamadas: {metrics.stormglass?.calls ?? "—"}</div>
                  <div>Custo estimado: {metrics.stormglass?.cost ?? "—"}</div>
                </div>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>Gemini</div>
                  <div>Chamadas: {metrics.gemini?.calls ?? "—"}</div>
                  <div>Custo estimado: {metrics.gemini?.cost ?? "—"}</div>
                </div>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>Upstash</div>
                  <div>GET/SET: {metrics.upstash?.ops ?? "—"}</div>
                  <div>Erros: {metrics.upstash?.errors ?? "—"}</div>
                </div>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>Supabase</div>
                  <div>Queries: {metrics.supabase?.queries ?? "—"}</div>
                  <div>Erros: {metrics.supabase?.errors ?? "—"}</div>
                </div>
                <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                  <div style={{ fontWeight: 600 }}>Conversas</div>
                  <div>Total (hoje): {metrics.conversas?.today ?? "—"}</div>
                  <div>Sem resposta: {metrics.conversas?.noAnswer ?? "—"}</div>
                </div>
              </div>
            )}
          </Box>
        </>
      )}

      {/* ------------------------- ABA LOGS ----------------------------------- */}
      {aba === "logs" && (
        <>
          <Box title="Filtrar Logs">
            <Row label="Tipo (opcional)">
              <Select
                value={logTipo}
                onChange={setLogTipo}
                options={[
                  { value: "", label: "Todos" },
                  { value: "coletor", label: "Coletor de Clima" },
                  { value: "erro", label: "Erros do Sistema" },
                  { value: "cache", label: "Cache/Upstash" },
                  { value: "publicacao", label: "Publicações (avisos/dicas)" },
                  { value: "cadastro", label: "Cadastros/Edições/Exclusões" },
                ]}
                allowEmpty={false}
              />
            </Row>
            <Row label="Quantidade">
              <Input
                type="number"
                min={10}
                max={500}
                value={logLimit}
                onChange={(e) => setLogLimit(Number(e.target.value) || 100)}
              />
            </Row>
            <button
              onClick={carregarLogs}
              style={{ padding: "10px 14px", borderRadius: 8, cursor: "pointer" }}
            >
              Atualizar Logs
            </button>
          </Box>

          <Box title="Últimos Eventos">
            {(logs || []).length === 0 ? (
              <div>Nenhum log disponível.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {logs.map((lg, idx) => (
                  <div key={lg.id || idx} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{lg.tipo || "Evento"}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      {new Date(lg.created_at || lg.data || Date.now()).toLocaleString()}
                    </div>
                    <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                      {lg.mensagem || lg.msg || lg.message || "-"}
                    </div>
                    {lg.contexto ? (
                      <pre style={{ marginTop: 8, background: "#fafafa", padding: 8, borderRadius: 6, overflowX: "auto" }}>
                        {JSON.stringify(lg.contexto, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Box>
        </>
      )}
    </div>
  );
}
