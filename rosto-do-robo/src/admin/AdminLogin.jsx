// rosto-do-robo/src/admin/AdminLogin.jsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminLoginWithKey, setAdminKey, clearAdminKey } from "./adminApi";

export default function AdminLogin() {
  const [key, setKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const navigate = useNavigate();

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMsg("");
    const trimmed = key.trim();
    if (!trimmed) {
      setErrorMsg("Digite a chave do administrador.");
      return;
    }

    setIsLoading(true);
    try {
      // Tenta login pelo endpoint /api/auth/login
      await adminLoginWithKey(trimmed);
      navigate("/admin");
    } catch (error) {
      // fallback: limpa e mostra erro
      clearAdminKey();
      setAdminKey("");
      const msg = error?.message || "Falha ao validar a chave.";
      setErrorMsg(msg);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4">
      <div className="bg-white dark:bg-gray-800 w-full max-w-sm rounded-xl shadow p-6">
        <div className="text-center mb-4">
          <img src="/bepit-logo.png" alt="BEPIT" className="mx-auto h-16 w-16" />
          <h1 className="text-xl font-bold mt-2 text-gray-900 dark:text-gray-100">
            Painel do Administrador
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Insira sua chave de administrador para continuar.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Chave</span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="mt-1 w-full border rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              placeholder="••••••••••••••"
            />
          </label>

          {errorMsg && (
            <div className="text-red-600 text-sm">{errorMsg}</div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2 rounded-md"
          >
            {isLoading ? "Validando..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
