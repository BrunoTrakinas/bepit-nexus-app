// src/App.jsx
import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import RegionSelection from './components/RegionSelection';
import ChatPage from './components/ChatPage';
import AdminLogin from './admin/AdminLogin';
import AdminDashboard from './admin/AdminDashboard';
import ProtectedRoute from './components/ProtectedRoute'; // Um novo componente de segurança

// Objeto de temas
const themes = {
  light: { background: "#fff", text: "#222", headerBg: "#f8f8f8", inputBg: "#f0f0f0", assistantBubble: "#e9e9eb" },
  dark: { background: "#121212", text: "#e0e0e0", headerBg: "#1e1e1e", inputBg: "#2a2a2a", assistantBubble: "#2c2c2e" }
};

function App() {
  const [theme, setTheme] = useState("light");

  const toggleTheme = () => {
    setTheme(current => (current === "light" ? "dark" : "light"));
  };
  
  const currentTheme = themes[theme];

  return (
    <Router>
      <div style={{ backgroundColor: currentTheme.background, color: currentTheme.text, minHeight: '100vh' }}>
        <Routes>
          <Route path="/" element={<RegionSelection theme={currentTheme} />} />
          <Route path="/chat/:regiaoSlug" element={<ChatPage theme={currentTheme} onToggleTheme={toggleTheme} />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route 
            path="/admin" 
            element={
              <ProtectedRoute>
                <AdminDashboard />
              </ProtectedRoute>
            } 
          />
        </Routes>
      </div>
    </Router>
  );
}

export default App;