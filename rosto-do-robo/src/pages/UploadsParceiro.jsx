import React, { useEffect, useState } from 'react';
import { uploadFoto, uploadCardapio, listarMidias, removerMidia } from '../services/api.parceiro.js';

export default function UploadsParceiro(){
  const [partnerId, setPartnerId] = useState('');
  const [midias, setMidias] = useState({ fotos: [], cardapio: [], total: 0 });
  const LIMITE = 5;

  useEffect(() => {
    if (partnerId) carregar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  async function carregar(){
    const data = await listarMidias(partnerId);
    setMidias(data);
  }

  async function escolherEEnviar(tipo){
    // confere limite antes de sequer abrir o seletor
    if (midias.total >= LIMITE) {
      alert('Limite total de 5 mídias atingido');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = tipo === 'ambiente' ? 'image/*' : 'application/pdf,image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      // confere de novo (pode ter corrido race-condition)
      if (midias.total >= LIMITE) {
        alert('Limite total de 5 mídias atingido');
        return;
      }
      const base64 = await fileToBase64(file);
      if (tipo === 'ambiente') {
        await uploadFoto(partnerId, { base64: base64.split(',')[1], filename: file.name });
      } else {
        await uploadCardapio(partnerId, { base64: base64.split(',')[1], filename: file.name });
      }
      await carregar();
      alert('Enviado com sucesso!');
    };
    input.click();
  }

  async function onRemover(storageKey){
    if (!window.confirm('Remover esta mídia?')) return;
    await removerMidia(partnerId, storageKey);
    await carregar();
  }

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Uploads do Parceiro</h1>

      <input
        className="border p-2 rounded w-full mb-3"
        placeholder="Partner ID"
        value={partnerId}
        onChange={e=>setPartnerId(e.target.value)}
      />

      <div className="flex items-center gap-2 mb-4">
        <button className="border px-3 py-2 rounded" onClick={()=>escolherEEnviar('ambiente')}>Enviar Foto (Ambiente)</button>
        <button className="border px-3 py-2 rounded" onClick={()=>escolherEEnviar('cardapio')}>Enviar Cardápio</button>
        <span className="text-sm text-gray-600">Total: <b>{midias.total}</b> / {LIMITE}</span>
      </div>

      <h2 className="font-semibold mb-2">Fotos de Ambiente</h2>
      <GradeImagens itens={midias.fotos} onRemover={onRemover} />

      <h2 className="font-semibold mt-6 mb-2">Cardápio / Preços</h2>
      <GradeImagens itens={midias.cardapio} onRemover={onRemover} />
    </div>
  );
}

function GradeImagens({ itens, onRemover }){
  if (!itens?.length) return <div className="text-sm text-gray-500 mb-4">Nenhum arquivo.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {itens.map(it => (
        <div key={it.storageKey} className="border rounded p-2">
          {it.signedUrl?.includes('.pdf') ? (
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

function fileToBase64(file){
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res(rd.result);
    rd.onerror = rej;
    rd.readAsDataURL(file);
  });
}
