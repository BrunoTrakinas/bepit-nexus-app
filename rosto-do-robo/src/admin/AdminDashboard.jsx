// F:\uber-chat-mvp\rosto-do-robo\src\admin\AdminDashboard.jsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminGet, adminPost, adminPut, clearAdminKey } from "./adminApi";

// ---------------- Abas do topo ----------------
function Tabs({ tab, setTab, navigate }) {
  const items = ["cadastro", "alterar", "inclusoes", "metricas", "logs"];
  return (
    <div className="flex flex-wrap gap-2 border-b pb-2">
      {items.map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`px-3 py-1 rounded-md text-sm md:text-base ${tab === t ? "bg-blue-600 text-white" : "bg-gray-200"}`}
        >
          {t.toUpperCase()}
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={() => {
          clearAdminKey();
          navigate("/admin/login");
        }}
        className="px-3 py-1 rounded-md bg-red-500 text-white text-sm md:text-base"
      >
        Sair
      </button>
    </div>
  );
}

// ------------- Cadastro de Parceiro/Dica -------------
function AbaCadastro() {
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
    tagsCSV: "",
    horario_funcionamento: "",
    faixa_preco: "",
    fotosCSV: "",
    ativo: true
  });
  const [msg, setMsg] = useState("");

  const salvar = async () => {
    setMsg("Salvando...");
    try {
      const fotosArray = form.fotosCSV
        ? form.fotosCSV.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

      const payload = {
        regiaoSlug: form.regiaoSlug.trim(),
        cidadeSlug: form.cidadeSlug.trim(),
        tipo: form.tipo,
        nome: form.nome,
        descricao: form.descricao || null,
        categoria: form.categoria || null,
        beneficio_bepit: form.beneficio_bepit || null,
        endereco: form.endereco || null,
        contato: form.contato || null,
        tags: form.tagsCSV
          ? form.tagsCSV.split(",").map((s) => s.trim()).filter(Boolean)
          : null,
        horario_funcionamento: form.horario_funcionamento || null,
        faixa_preco: form.faixa_preco || null,
        fotos: fotosArray,
        fotos_parceiros: fotosArray,
        ativo: Boolean(form.ativo)
      };

      const res = await adminPost("/api/admin/parceiros", payload);
      setMsg("Parceiro/Dica criado com sucesso!");
      console.log(res);
    } catch (e) {
      console.error(e);
      setMsg("Erro ao salvar: " + e.message);
    }
  };

  const Input = ({ label, ...p }) => (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input {...p} className="mt-1 w-full border rounded-md px-3 py-2" />
    </label>
  );

  const Textarea = ({ label, ...p }) => (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <textarea {...p} className="mt-1 w-full border rounded-md px-3 py-2" rows={3} />
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input label="Região (slug)" value={form.regiaoSlug} onChange={(e) => setForm((f) => ({ ...f, regiaoSlug: e.target.value }))} />
        <Input label="Cidade (slug)" value={form.cidadeSlug} onChange={(e) => setForm((f) => ({ ...f, cidadeSlug: e.target.value }))} />
        <label className="block">
          <span className="text-sm font-medium">Tipo</span>
          <select
            value={form.tipo}
            onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}
            className="mt-1 w-full border rounded-md px-3 py-2"
          >
            <option>PARCEIRO</option>
            <option>DICA</option>
          </select>
        </label>
        <Input label="Nome" value={form.nome} onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))} />
        <Input label="Categoria" value={form.categoria} onChange={(e) => setForm((f) => ({ ...f, categoria: e.target.value }))} />
        <Input label="Benefício BEPIT" value={form.beneficio_bepit} onChange={(e) => setForm((f) => ({ ...f, beneficio_bepit: e.target.value }))} />
        <Input label="Endereço" value={form.endereco} onChange={(e) => setForm((f) => ({ ...f, endereco: e.target.value }))} />
        <Input label="Contato" value={form.contato} onChange={(e) => setForm((f) => ({ ...f, contato: e.target.value }))} />
        <Input label="Faixa de preço" value={form.faixa_preco} onChange={(e) => setForm((f) => ({ ...f, faixa_preco: e.target.value }))} />
        <Input
          label="Horário de funcionamento"
          value={form.horario_funcionamento}
          onChange={(e) => setForm((f) => ({ ...f, horario_funcionamento: e.target.value }))}
        />
        <Input label="Tags (separe por vírgula)" value={form.tagsCSV} onChange={(e) => setForm((f) => ({ ...f, tagsCSV: e.target.value }))} />
        <Input
          label="Fotos (URLs separadas por vírgula)"
          value={form.fotosCSV}
          onChange={(e) => setForm((f) => ({ ...f, fotosCSV: e.target.value }))}
        />
      </div>
      <Textarea label="Descrição" value={form.descricao} onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))} />
      <label className="inline-flex items-center gap-2">
        <input type="checkbox" checked={form.ativo} onChange={(e) => setForm((f) => ({ ...f, ativo: e.target.checked }))} />
        <span>Ativo</span>
      </label>

      <div className="flex gap-2">
        <button onClick={salvar} className="bg-green-600 text-white px-4 py-2 rounded-md">
          Salvar
        </button>
        {msg && <div className="text-sm text-gray-600 self-center">{msg}</div>}
      </div>
    </div>
  );
}

// ------------- Alterar (lista + editar) -------------
function AbaAlterar() {
  const [filtro, setFiltro] = useState({ regiaoSlug: "regiao-dos-lagos", cidadeSlug: "cabo-frio" });
  const [lista, setLista] = useState([]);
  const [selecionado, setSelecionado] = useState(null);
  const [msg, setMsg] = useState("");

  const carregar = async () => {
    setMsg("Carregando...");
    try {
      const data = await adminGet(`/api/admin/parceiros/${filtro.regiaoSlug}/${filtro.cidadeSlug}`);
      const arr = Array.isArray(data?.data) ? data.data : [];

      const normalizado = arr.map((p) => ({
        ...p,
        fotos_parceiros: Array.isArray(p.fotos_parceiros)
          ? p.fotos_parceiros
          : Array.isArray(p.fotos)
          ? p.fotos
          : []
      }));

      setLista(normalizado);
      setMsg(`Encontrados: ${normalizado.length}`);
    } catch (e) {
      setMsg("Erro: " + e.message);
    }
  };

  useEffect(() => {
    // carregar(); // Descomente para carregar automaticamente ao abrir a aba
  }, []);

  const salvarEdicao = async () => {
    if (!selecionado?.id) return;
    setMsg("Salvando alterações...");
    try {
      const body = {
        nome: selecionado.nome || null,
        categoria: selecionado.categoria || null,
        descricao: selecionado.descricao || null,
        beneficio_bepit: selecionado.beneficio_bepit || null,
        endereco: selecionado.endereco || null,
        contato: selecionado.contato || null,
        tags: Array.isArray(selecionado.tags) ? selecionado.tags : null,
        horario_funcionamento: selecionado.horario_funcionamento || null,
        faixa_preco: selecionado.faixa_preco || null,
        fotos: Array.isArray(selecionado.fotos_parceiros) ? selecionado.fotos_parceiros : null,
        fotos_parceiros: Array.isArray(selecionado.fotos_parceiros) ? selecionado.fotos_parceiros : null,
        ativo: selecionado.ativo !== false
      };

      await adminPut(`/api/admin/parceiros/${selecionado.id}`, body);
      setMsg("Alterado com sucesso!");
    } catch (e) {
      setMsg("Erro ao salvar: " + e.message);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="space-y-2">
        <input
          className="w-full border rounded-md px-3 py-2"
          placeholder="regiaoSlug"
          value={filtro.regiaoSlug}
          onChange={(e) => setFiltro((f) => ({ ...f, regiaoSlug: e.target.value }))}
        />
        <input
          className="w-full border rounded-md px-3 py-2"
          placeholder="cidadeSlug"
          value={filtro.cidadeSlug}
          onChange={(e) => setFiltro((f) => ({ ...f, cidadeSlug: e.target.value }))}
        />
        <button onClick={carregar} className="bg-blue-600 text-white px-3 py-2 rounded-md w-full">
          Buscar
        </button>
        <div className="text-sm text-gray-600">{msg}</div>

        <div className="border rounded-md divide-y max-h-80 overflow-auto">
          {lista.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelecionado(JSON.parse(JSON.stringify(p)))}
              className={`w-full text-left px-3 py-2 hover:bg-gray-100 ${selecionado?.id === p.id ? "bg-gray-200" : ""}`}
            >
              <div className="font-semibold">{p.nome}</div>
              <div className="text-xs text-gray-600">
                {p.categoria} · {p.endereco || "—"}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="md:col-span-2">
        {!selecionado ? (
          <div className="text-gray-500">Selecione um item à esquerda para editar.</div>
        ) : (
          <div className="space-y-2">
            <input
              className="w-full border rounded-md px-3 py-2"
              value={selecionado.nome || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, nome: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="categoria"
              value={selecionado.categoria || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, categoria: e.target.value }))}
            />
            <textarea
              className="w-full border rounded-md px-3 py-2"
              rows={3}
              placeholder="descricao"
              value={selecionado.descricao || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, descricao: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="beneficio_bepit"
              value={selecionado.beneficio_bepit || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, beneficio_bepit: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="endereco"
              value={selecionado.endereco || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, endereco: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="contato"
              value={selecionado.contato || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, contato: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="faixa_preco"
              value={selecionado.faixa_preco || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, faixa_preco: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="horario_funcionamento"
              value={selecionado.horario_funcionamento || ""}
              onChange={(e) => setSelecionado((s) => ({ ...s, horario_funcionamento: e.target.value }))}
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="tags (a,b,c)"
              value={Array.isArray(selecionado.tags) ? selecionado.tags.join(", ") : ""}
              onChange={(e) =>
                setSelecionado((s) => ({
                  ...s,
                  tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean)
                }))
              }
            />
            <input
              className="w-full border rounded-md px-3 py-2"
              placeholder="fotos (urls separadas por vírgula)"
              value={
                Array.isArray(selecionado.fotos_parceiros)
                  ? selecionado.fotos_parceiros.join(", ")
                  : ""
              }
              onChange={(e) =>
                setSelecionado((s) => ({
                  ...s,
                  fotos_parceiros: e.target.value.split(",").map((x) => x.trim()).filter(Boolean)
                }))
              }
            />

            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={selecionado.ativo !== false}
                onChange={(e) => setSelecionado((s) => ({ ...s, ativo: e.target.checked }))}
              />
              <span>Ativo</span>
            </label>

            <button onClick={salvarEdicao} className="bg-green-600 text-white px-4 py-2 rounded-md">
              Salvar alterações
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------- Inclusões (Regiões e Cidades) -------------
function AbaInclusoes() {
  const [reg, setReg] = useState({ nome: "", slug: "", ativo: true, msg: "" });
  const [cid, setCid] = useState({
    regiaoSlug: "regiao-dos-lagos",
    nome: "",
    slug: "",
    ativo: true,
    msg: ""
  });

  const criarRegiao = async () => {
    try {
      setReg((r) => ({ ...r, msg: "Salvando..." }));
      await adminPost("/api/admin/regioes", {
        nome: reg.nome,
        slug: reg.slug,
        ativo: reg.ativo
      });
      setReg((r) => ({ ...r, msg: "Região criada!" }));
    } catch (e) {
      setReg((r) => ({ ...r, msg: "Erro: " + e.message }));
    }
  };

  const criarCidade = async () => {
    try {
      setCid((s) => ({ ...s, msg: "Salvando..." }));
      await adminPost("/api/admin/cidades", {
        regiaoSlug: cid.regiaoSlug,
        nome: cid.nome,
        slug: cid.slug,
        ativo: cid.ativo
      });
      setCid((s) => ({ ...s, msg: "Cidade criada!" }));
    } catch (e) {
      setCid((s) => ({ ...s, msg: "Erro: " + e.message }));
    }
  };

  const Line = ({ label, value, onChange, type = "text" }) => (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input type={type} value={value} onChange={onChange} className="mt-1 w-full border rounded-md px-3 py-2" />
    </label>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <h3 className="font-bold mb-2">Criar Região</h3>
        <div className="space-y-2">
          <Line label="Nome" value={reg.nome} onChange={(e) => setReg((r) => ({ ...r, nome: e.target.value }))} />
          <Line label="Slug" value={reg.slug} onChange={(e) => setReg((r) => ({ ...r, slug: e.target.value }))} />
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={reg.ativo} onChange={(e) => setReg((r) => ({ ...r, ativo: e.target.checked }))} />
            <span>Ativo</span>
          </label>
          <button onClick={criarRegiao} className="bg-blue-600 text-white px-3 py-2 rounded-md">
            Salvar Região
          </button>
          <div className="text-sm text-gray-600">{reg.msg}</div>
        </div>
      </div>

      <div>
        <h3 className="font-bold mb-2">Criar Cidade</h3>
        <div className="space-y-2">
          <Line
            label="Região (slug)"
            value={cid.regiaoSlug}
            onChange={(e) => setCid((s) => ({ ...s, regiaoSlug: e.target.value }))}
          />
          <Line label="Nome" value={cid.nome} onChange={(e) => setCid((s) => ({ ...s, nome: e.target.value }))} />
          <Line label="Slug" value={cid.slug} onChange={(e) => setCid((s) => ({ ...s, slug: e.target.value }))} />
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={cid.ativo} onChange={(e) => setCid((s) => ({ ...s, ativo: e.target.checked }))} />
            <span>Ativo</span>
          </label>
          <button onClick={criarCidade} className="bg-green-600 text-white px-3 py-2 rounded-md">
            Salvar Cidade
          </button>
          <div className="text-sm text-gray-600">{cid.msg}</div>
        </div>
      </div>
    </div>
  );
}

// ------------- Métricas -------------
function AbaMetricas() {
  const [q, setQ] = useState({ regiaoSlug: "regiao-dos-lagos", cidadeSlug: "" });
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState("");

  const carregar = async () => {
    setMsg("Carregando...");
    try {
      const qs = q.cidadeSlug
        ? `?regiaoSlug=${encodeURIComponent(q.regiaoSlug)}&cidadeSlug=${encodeURIComponent(q.cidadeSlug)}`
        : `?regiaoSlug=${encodeURIComponent(q.regiaoSlug)}`;
      const res = await adminGet(`/api/admin/metrics/summary${qs}`);
      setData(res);
      setMsg("");
    } catch (e) {
      setMsg("Erro: " + e.message);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="border rounded-md px-3 py-2"
          placeholder="regiaoSlug"
          value={q.regiaoSlug}
          onChange={(e) => setQ((s) => ({ ...s, regiaoSlug: e.target.value }))}
        />
        <input
          className="border rounded-md px-3 py-2"
          placeholder="(opcional) cidadeSlug"
          value={q.cidadeSlug}
          onChange={(e) => setQ((s) => ({ ...s, cidadeSlug: e.target.value }))}
        />
        <button onClick={carregar} className="bg-blue-600 text-white px-3 py-2 rounded-md">
          Ver métricas
        </button>
      </div>

      {msg && <div className="text-sm text-gray-600">{msg}</div>}

      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-4 rounded-md border">
            <div className="text-xs text-gray-500">Parceiros Ativos</div>
            <div className="text-2xl font-bold">{data.total_parceiros_ativos}</div>
          </div>
          <div className="p-4 rounded-md border">
            <div className="text-xs text-gray-500">Buscas</div>
            <div className="text-2xl font-bold">{data.total_buscas}</div>
          </div>
          <div className="p-4 rounded-md border">
            <div className="text-xs text-gray-500">Interações</div>
            <div className="text-2xl font-bold">{data.total_interacoes}</div>
          </div>

          <div className="md:col-span-3 p-4 rounded-md border">
            <div className="font-semibold mb-2">Top 5 parceiros por views</div>
            <div className="divide-y">
              {data.top5_parceiros_por_views?.length
                ? data.top5_parceiros_por_views.map((x) => (
                    <div key={x.parceiro_id} className="py-2 flex justify-between">
                      <div>
                        <div className="font-medium">{x.nome}</div>
                        <div className="text-xs text-gray-500">{x.categoria}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold">{x.views_total}</div>
                        <div className="text-xs text-gray-500">{x.last_view_at}</div>
                      </div>
                    </div>
                  ))
                : <div className="text-sm text-gray-500">Sem dados.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------- Logs -------------
function AbaLogs() {
  const [tipo, setTipo] = useState("");
  const [limit, setLimit] = useState(50);
  const [lista, setLista] = useState([]);
  const [msg, setMsg] = useState("");

  const carregar = async () => {
    setMsg("Carregando...");
    try {
      const q = [];
      if (tipo) q.push(`tipo=${encodeURIComponent(tipo)}`);
      if (limit) q.push(`limit=${encodeURIComponent(limit)}`);
      const qs = q.length ? `?${q.join("&")}` : "";
      const data = await adminGet(`/api/admin/logs${qs}`);
      setLista(Array.isArray(data?.data) ? data.data : []);
      setMsg("");
    } catch (e) {
      setMsg("Erro: " + e.message);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="border rounded-md px-3 py-2"
          placeholder="tipo (opcional)"
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
        />
        <input
          className="border rounded-md px-3 py-2"
          type="number"
          placeholder="limit"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value || 50))}
        />
        <button onClick={carregar} className="bg-blue-600 text-white px-3 py-2 rounded-md">
          Carregar
        </button>
      </div>

      {msg && <div className="text-sm text-gray-600">{msg}</div>}

      <div className="border rounded-md max-h-96 overflow-auto divide-y">
        {lista.length ? (
          lista.map((row, i) => (
            <div key={i} className="p-2">
              <div className="text-xs text-gray-500">{row.created_at || "—"}</div>
              <div className="font-medium">{row.tipo_evento}</div>
              <pre className="text-xs bg-gray-100 p-2 rounded">{JSON.stringify(row.payload, null, 2)}</pre>
            </div>
          ))
        ) : (
          <div className="p-2 text-sm text-gray-500">Sem logs.</div>
        )}
      </div>
    </div>
  );
}

// ------------- Componente principal -------------
export default function AdminDashboard() {
  const [tab, setTab] = useState("cadastro");
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="max-w-5xl mx-auto p-4">
        <div className="flex items-center gap-4 mb-4">
          <img
            src="https://i.postimg.cc/mD8q5fJb/bepit-logo.png"
            alt="Logo BEPIT"
            className="h-12 w-12"
          />
          <h1 className="text-2xl font-bold">Painel do Administrador</h1>
        </div>

        <Tabs tab={tab} setTab={setTab} navigate={navigate} />

        <div className="bg-white dark:bg-gray-800 rounded-md shadow p-4 mt-3">
          {tab === "cadastro" && <AbaCadastro />}
          {tab === "alterar" && <AbaAlterar />}
          {tab === "inclusoes" && <AbaInclusoes />}
          {tab === "metricas" && <AbaMetricas />}
          {tab === "logs" && <AbaLogs />}
        </div>
      </div>
    </div>
  );
}