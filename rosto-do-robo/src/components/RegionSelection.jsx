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
      
      {/* --- APLIQUE AS MUDANÇAS DE ESTILO AQUI --- */}
      <h1 style={{ 
        marginBottom: '10px', 
        fontSize: '2.5rem', // Letra bem maior (40px)
        fontWeight: '700'     // Negrito forte
      }}>
        Bem-vindo ao BEPIT Nexus
      </h1>
      <p style={{ 
        marginBottom: '40px', 
        fontSize: '1.25rem', // Letra maior (20px)
        color: '#555'
      }}>
        Selecione sua região para começar
      </p>
      
      <div>
        {regioes.map(regiao => (
          <Link
            key={regiao.slug}
            to={`/chat/${regiao.slug}`}
            style={{ padding: '15px 30px', fontSize: '18px', borderRadius: '8px', border: `1px solid #ddd`, background: '#f0f0f0', color: '#222', cursor: 'pointer', fontWeight: 600, textDecoration: 'none' }}
          >
            {regiao.nome}
          </Link>
        ))}
      </div>
    </div>
  );
}