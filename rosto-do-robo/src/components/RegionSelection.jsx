// src/components/RegionSelection.jsx
import React from "react";
import { Link } from 'react-router-dom';

const regioes = [
  { nome: "Região dos Lagos", slug: "regiao-dos-lagos" },
];

export default function RegionSelection({ theme }) { 
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      textAlign: 'center',
      padding: '20px',
      backgroundColor: theme.background, // Usa a cor de fundo do tema
      color: theme.text,             // Usa a cor do texto do tema
    }}>
      <img src="https://i.postimg.cc/mD8q5fJb/bepit-logo.png" alt="Logo BEPIT Nexus" style={{ width: '150px', marginBottom: '40px' }} />
      
      <h1 style={{ marginBottom: '10px', fontSize: '2.5rem', fontWeight: '700' }}>
        Bem-vindo ao BEPIT Nexus
      </h1>
      <p style={{ marginBottom: '40px', fontSize: '1.25rem', color: '#888' }}>
        Selecione sua região para começar
      </p>
      
      <div>
        {regioes.map(regiao => (
          <Link
            key={regiao.slug}
            to={`/chat/${regiao.slug}`}
            style={{ 
              padding: '15px 30px', 
              fontSize: '18px', 
              borderRadius: '8px', 
              border: `1px solid ${theme.inputBg}`, // Usa a cor do tema
              background: theme.headerBg,         // Usa a cor do tema
              color: theme.text,                  // Usa a cor do tema
              cursor: 'pointer', 
              fontWeight: 600, 
              textDecoration: 'none' 
            }}
          >
            {regiao.nome}
          </Link>
        ))}
      </div>
    </div>
  );
}