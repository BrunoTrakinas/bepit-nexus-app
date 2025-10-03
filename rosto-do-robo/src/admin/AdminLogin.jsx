// src/admin/AdminLogin.jsx
// ============================================================================
// Tela de login do Admin:
// - Chama POST /api/auth/login com { key }
// - Em caso de ok:true, salva "adminKey" no localStorage
// - Redireciona para /admin
// - Trabalha em conjunto com ProtectedRoute (expiração por inatividade).
// ============================================================================

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../lib/apiClient";

const STORAGE_KEY = "adminKey";
const LAST_ACTIVE_KEY = "adminLastActiveAt";

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
      // Valida a key no backend
      const resp = await apiClient.authLoginByKey(trimmed);
      if (resp?.ok === true) {
        // Persiste localmente (ProtectedRoute usa essa mesma chave)
        localStorage.setItem(STORAGE_KEY, trimmed);
        localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
        navigate("/admin");
      } else {
        setErrorMsg("Chave inválida.");
      }
    } catch (error) {
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
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Acesse com sua chave de administrador
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Chave</span>
            <input
              type="password"
              className="mt-1 w-full border rounded-md px-3 py-2"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Cole sua chave aqui"
            />
          </label>

          {errorMsg && <div className="text-sm text-red-600">{errorMsg}</div>}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 text-white py-2 rounded-md font-semibold disabled:opacity-50"
          >
            {isLoading ? "Validando..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
