// /frontend/src/components/admin/AdminFichaMidia.jsx
import React, { useEffect, useState } from "react";
import { listarMidias, removerMidia } from "../../services/api.parceiro.js";

export default function AdminFichaMidia({ partnerId, onClose }){
  const [midias, setMidias] = useState({ fotos: [], cardapio: [], total: 0 });

  useEffect(() => { carregar(); /* eslint-disable-next-line */ }, [partnerId]);

  async function carregar(){
    const data = await listarMidias(partnerId);
    setMidias(data);
  }

  async function onRemover(key){
    if (!window.confirm("Remover esta mídia?")) return;
    await removerMidia(partnerId, key);
    await carregar();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-4 w-full max-w-3xl">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-xl font-bold">Mídias do Parceiro</h2>
          <button className="border px-2 py-1 rounded" onClick={onClose}>Fechar</button>
        </div>
        <div className="text-sm text-gray-600 mb-2">
          Partner ID: <b>{partnerId}</b> • Total: <b>{midias.total}</b> / 5
        </div>

        <Secao titulo="Fotos de Ambiente">
          <Grade itens={midias.fotos} onRemover={onRemover} />
        </Secao>

        <Secao titulo="Cardápio / Preços">
          <Grade itens={midias.cardapio} onRemover={onRemover} />
        </Secao>
      </div>
    </div>
  );
}

function Secao({ titulo, children }){
  return (
    <div className="mb-4">
      <h3 className="font-semibold mb-2">{titulo}</h3>
      {children}
    </div>
  );
}

function Grade({ itens, onRemover }){
  if (!itens?.length) return <div className="text-sm text-gray-500">Nenhum arquivo.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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
