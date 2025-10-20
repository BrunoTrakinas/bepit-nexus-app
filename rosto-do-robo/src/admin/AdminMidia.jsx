import React, { useEffect, useState } from "react";
import { listarMidias, removerMidia } from "../services/api.parceiro.js";
import { useSearchParams, useParams } from "react-router-dom";

export default function AdminMidia(){
  const [partnerId, setPartnerId] = useState("");
  const [midias, setMidias] = useState({ fotos: [], cardapio: [], total: 0 });
  const LIMITE = 5;

  // Duas formas de chegar à página:
  // 1) /admin/midia?partner=UUID
  // 2) /admin/midia/UUID
  const [search] = useSearchParams();
  const urlPartner = search.get("partner");
  const { id: pathPartner } = useParams();

  useEffect(() => {
    const initial = pathPartner || urlPartner || "";
    if (initial) setPartnerId(initial);
  }, [pathPartner, urlPartner]);

  useEffect(() => { if (partnerId) carregar(); /* eslint-disable-next-line */ }, [partnerId]);

  async function carregar(){
    const data = await listarMidias(partnerId);
    setMidias(data);
  }

  async function onRemover(storageKey){
    if (!window.confirm("Remover esta mídia?")) return;
    await removerMidia(partnerId, storageKey);
    await carregar();
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-3">Admin • Mídias do Parceiro</h1>

      <div className="mb-4 flex gap-2">
        <input
          className="border p-2 rounded w-96"
          placeholder="Partner ID"
          value={partnerId}
          onChange={e=>setPartnerId(e.target.value)}
        />
        <button className="border px-3 py-2 rounded" onClick={carregar}>Carregar</button>
        <span className="text-sm text-gray-600">Total: <b>{midias.total}</b> / {LIMITE}</span>
      </div>

      <Secao titulo="Fotos de Ambiente">
        <Grade itens={midias.fotos} onRemover={onRemover} />
      </Secao>

      <Secao titulo="Cardápio / Preços">
        <Grade itens={midias.cardapio} onRemover={onRemover} />
      </Secao>
    </div>
  );
}

function Secao({ titulo, children }){
  return (
    <div className="mb-6">
      <h2 className="font-semibold mb-2">{titulo}</h2>
      {children}
    </div>
  );
}

function Grade({ itens, onRemover }){
  if (!itens?.length) return <div className="text-sm text-gray-500">Nenhum arquivo.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {itens.map(it => (
        <div key={it.storageKey} className="border rounded p-2">
          {it.signedUrl.includes(".pdf") ? (
            <a className="underline text-blue-700" href={it.signedUrl} target="_blank" rel="noreferrer">Abrir PDF</a>
          ) : (
            <img src={it.signedUrl} alt="mídia" className="w-full h-40 object-cover rounded" />
          )}
          <div className="flex justify-between items-center mt-2 text-xs">
            <span>{it.tipo}</span>
            <button className="border px-2 py-1 rounded" onClick={()=>onRemover(it.storageKey)}>Remover</button>
          </div>
        </div>
      ))}
    </div>
  );
}
