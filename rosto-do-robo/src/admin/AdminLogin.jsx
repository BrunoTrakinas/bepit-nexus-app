// F:\uber-chat-mvp\rosto-do-robo\src\admin\AdminLogin.jsx

// 1. IMPORTS: Adicionamos o 'useNavigate' para navegar sem recarregar a página
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminGet, setAdminKey } from "./adminApi";

// 2. ASSINATURA: A função agora recebe 'onLoginSuccess' do App.jsx
export default function AdminLogin({ onLoginSuccess }) {
  const [key, setKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  
  // 3. NAVEGAÇÃO: Preparamos o hook de navegação do React
  const navigate = useNavigate();

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMsg("");

    const trimmed = key.trim();
    if (trimmed.length === 0) {
      setErrorMsg("Digite a chave do administrador.");
      return;
    }

    setIsLoading(true);
    try {
      setAdminKey(trimmed);
      await adminGet("/api/admin/logs?limit=1");

      // 4. A GRANDE MUDANÇA: Substituímos o window.location.href
      // Se chegou aqui, a chave funcionou. Agora avisamos o App.jsx e navegamos.
      onLoginSuccess(trimmed); // Avisa o componente pai que o login foi um sucesso
      navigate("/admin");      // Navega para o painel principal do admin sem recarregar a página

    } catch (error) {
      setAdminKey("");
      const msg = error?.message || "Falha ao validar a chave.";
      setErrorMsg(msg);
    } finally {
      setIsLoading(false);
    }
  }

  // O seu JSX (a parte visual) continua exatamente o mesmo, sem nenhuma alteração.
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4">
      <div className="bg-white dark:bg-gray-800 w-full max-w-sm rounded-xl shadow p-6">
        <div className="text-center mb-4">
          <img src="https://i.postimg.cc/mD8q5fJb/bepit-logo.png" alt="BEPIT" className="mx-auto h-16 w-16" />
          <h1 className="text-xl font-bold mt-2 text-gray-900 dark:text-gray-100">
            Painel do Administrador
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Insira a sua chave de administrador para continuar.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
              Chave do Admin
            </span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Cole aqui a chave definida no Render (.env)"
              className="mt-1 w-full border dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit(e);
              }}
            />
          </label>

          {errorMsg && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-md py-2 font-semibold transition-colors"
          >
            {isLoading ? "Validando..." : "Entrar"}
          </button>

          <a
            href="/"
            className="block text-center text-sm text-gray-500 dark:text-gray-300 hover:underline"
          >
            Voltar
          </a>
        </form>
      </div>
    </div>
  );
}