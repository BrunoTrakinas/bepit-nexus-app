// src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import RegionSelection from './components/RegionSelection';
import ChatPage from './components/ChatPage';
import AdminPortal from './admin/AdminPortal'; // Verifique se este é o seu componente principal do admin

function App() {
  // O App agora apenas define as rotas do site.
  return (
    <Router>
      <Routes>
        <Route path="/" element={<RegionSelection />} />
        <Route path="/chat/:regiaoSlug" element={<ChatPage />} />
        <Route path="/admin" element={<AdminPortal />} />
        {/* Adicione outras rotas do admin se necessário, ex: <Route path="/admin/dashboard" ... /> */}
      </Routes>
    </Router>
  );
}

export default App;