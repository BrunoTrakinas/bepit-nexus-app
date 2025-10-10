// src/App.jsx
import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import RegionSelection from "./pages/RegionSelection.jsx";
import ChatPage from "./pages/ChatPage.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Página inicial: seleção de região */}
        <Route path="/" element={<RegionSelection />} />
        {/* Chat principal (exige região no localStorage; valida dentro do componente) */}
        <Route path="/chat" element={<ChatPage />} />
        {/* Fallback simples */}
        <Route path="*" element={<RegionSelection />} />
      </Routes>
    </BrowserRouter>
  );
}
