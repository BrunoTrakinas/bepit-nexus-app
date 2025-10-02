import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

const rootElement = document.getElementById("root");

if (!rootElement) {
  // Fallback de segurança caso o #root não exista no index.html
  const msg =
    "Elemento #root não encontrado no index.html. Verifique se existe <div id=\"root\"></div>.";
  console.error(msg);
  const body = document.body || document.getElementsByTagName("body")[0];
  const warn = document.createElement("pre");
  warn.textContent = msg;
  warn.style.padding = "16px";
  warn.style.background = "#fee2e2";
  warn.style.color = "#7f1d1d";
  warn.style.border = "1px solid #fecaca";
  warn.style.borderRadius = "8px";
  body.appendChild(warn);
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
