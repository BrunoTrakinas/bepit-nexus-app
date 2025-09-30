// src/App.jsx
import React, { useState } from "react";
import RegionSelection from "./components/RegionSelection";
import ChatPage from "./components/ChatPage";

// Cores para os temas
const themes = {
  light: {
    background: "#fff",
    text: "#222",
    headerBg: "#f8f8f8",
    inputBg: "#f0f0f0",
    assistantBubble: "#e9e9eb",
  },
  dark: {
    background: "#121212",
    text: "#e0e0e0",
    headerBg: "#1e1e1e",
    inputBg: "#2a2a2a",
    assistantBubble: "#2c2c2e",
  }
};

export default function App() {
  const [regiaoSlug, setRegiaoSlug] = useState(null);
  const [theme, setTheme] = useState("light");

  function handleRegionSelect(slug) {
    setRegiaoSlug(slug);
  }

  function toggleTheme() {
    setTheme(currentTheme => (currentTheme === "light" ? "dark" : "light"));
  }

  // Define as cores atuais com base no tema selecionado
  const currentTheme = themes[theme];

  if (!regiaoSlug) {
    return <RegionSelection onRegionSelect={handleRegionSelect} theme={currentTheme} />;
  }

  return <ChatPage regiaoSlug={regiaoSlug} theme={currentTheme} onToggleTheme={toggleTheme} />;
}