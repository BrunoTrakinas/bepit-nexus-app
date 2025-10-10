// ajuste mínimo a fazer no App.jsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import RegionSelection from "./components/RegionSelection.jsx";
import ChatPage from "./components/ChatPage.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RegionSelection />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
