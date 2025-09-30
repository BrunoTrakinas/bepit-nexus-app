// src/App.jsx
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import RegionSelection from './components/RegionSelection';
import ChatPage from './components/ChatPage';
import AdminLogin from './admin/AdminLogin'; // A página de login
import AdminDashboard from './admin/AdminDashboard'; // O seu painel principal após o login

function App() {
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);

  // Este efeito roda uma vez e verifica se já existe uma chave de admin salva no navegador
  useEffect(() => {
    const adminKey = localStorage.getItem('adminKey');
    if (adminKey) {
      setIsAdminAuthenticated(true);
    }
  }, []);

  // Esta função será chamada pelo AdminLogin quando o login for um sucesso
  const handleAdminLogin = (key) => {
    localStorage.setItem('adminKey', key);
    setIsAdminAuthenticated(true);
  };

  return (
    <Router>
      <Routes>
        {/* Rotas Públicas */}
        <Route path="/" element={<RegionSelection />} />
        <Route path="/chat/:regiaoSlug" element={<ChatPage />} />
        
        {/* Rota de Login do Admin */}
        <Route 
          path="/admin/login" 
          element={<AdminLogin onLoginSuccess={handleAdminLogin} />} 
        />

        {/* Rota Protegida do Dashboard Principal do Admin */}
        <Route
          path="/admin"
          element={
            isAdminAuthenticated ? (
              <AdminDashboard /> // Se estiver logado, mostra o Dashboard
            ) : (
              <Navigate to="/admin/login" replace /> // Se NÃO estiver logado, redireciona para /admin/login
            )
          }
        />
        
      </Routes>
    </Router>
  );
}

export default App;