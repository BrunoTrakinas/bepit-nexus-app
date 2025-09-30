// src/components/RegionSelection.jsx
import React from "react";
import { Link } from 'react-router-dom'; // Importe o Link

const regioes = [
  { nome: "Região dos Lagos", slug: "regiao-dos-lagos" },
];

// Removi o 'theme' por simplicidade agora, podemos adicionar depois
export default function RegionSelection({ onRegionSelect }) { 
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', textAlign: 'center' }}>
      {/* A tag <img> que vamos corrigir no próximo passo */}
      <img src="https://i.postimg.cc/8cx8ZVtL/bepit-logo.jpg" alt="Logo BEPIT Nexus" style={{ width: '150px', marginBottom: '40px' }} />
      <h1>Bem-vindo ao BEPIT Nexus</h1>
      <p style={{ marginBottom: '40px' }}>Selecione sua região para começar</p>
      
      <div>
        {regioes.map(regiao => (
          // TROQUE O <button> POR ESTE <Link>
          <Link
            key={regiao.slug}
            to={`/chat/${regiao.slug}`} // O link agora leva para a rota do chat
            style={{ padding: '15px 30px', fontSize: '18px', borderRadius: '8px', border: `1px solid #ddd`, background: '#f0f0f0', color: '#222', cursor: 'pointer', fontWeight: 600, textDecoration: 'none' }}
          >
            {regiao.nome}
          </Link>
        ))}
      </div>
    </div>
  );
}