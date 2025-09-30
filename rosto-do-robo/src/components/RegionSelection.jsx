// src/components/RegionSelection.jsx
import React from "react";

// Defina aqui suas regiões disponíveis
const regioes = [
  { nome: "Região dos Lagos", slug: "regiao-dos-lagos" },
  // { nome: "Outra Região", slug: "outra-regiao" },
];

export default function RegionSelection({ onRegionSelect, theme }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: theme.background,
      color: theme.text,
      textAlign: 'center'
    }}>
      <img src="/https://i.postimg.cc/8cx8ZVtL/bepit-logo.jpg" alt="Logo BEPIT Nexus" style={{ width: '150px', marginBottom: '40px' }} />
      <h1 style={{ marginBottom: '10px' }}>Bem-vindo ao BEPIT Nexus</h1>
      <p style={{ marginBottom: '40px', color: '#888' }}>Selecione sua região para começar</p>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        {regioes.map(regiao => (
          <button
            key={regiao.slug}
            onClick={() => onRegionSelect(regiao.slug)}
            style={{
              padding: '15px 30px',
              fontSize: '18px',
              borderRadius: '8px',
              border: `1px solid ${theme.inputBg}`,
              background: theme.headerBg,
              color: theme.text,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {regiao.nome}
          </button>
        ))}
      </div>
    </div>
  );
}