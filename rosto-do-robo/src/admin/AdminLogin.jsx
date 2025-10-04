// src/admin/AdminLogin.jsx
// ============================================================================
// Tela de login do Admin:
// - Chama apiClient.authLoginByKey(key) que já existe no seu projeto
// - Em caso de ok:true, salva a chave em localStorage E sessionStorage
//   * localStorage: persistência opcional
//   * sessionStorage ("bepit_admin_key"): lida pelo apiClient para enviar X-Admin-Key
// - Redireciona para /admin
// - Ajustes de acessibilidade/autofill (id/name/autoComplete).
// ============================================================================

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../lib/apiClient";

const STORAGE_KEY_LOCAL = "adminKey";            // compatibilidade com o que já usava
const STORAGE_KEY_SESSION = "bepit_admin_key";   // ***lido pelo apiClient para X-Admin-Key***
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
      // ✅ usa o helper existente no seu projeto
      const resp = await apiClient.authLoginByKey(trimmed);
      const ok = resp?.ok === true;

      if (ok) {
        // 1) Persistência opcional (como você já tinha)
        localStorage.setItem(STORAGE_KEY_LOCAL, trimmed);
        localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));

        // 2) ***Fundamental para o X-Admin-Key no interceptor***
        sessionStorage.setItem(STORAGE_KEY_SESSION, trimmed);

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

        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
          <label className="block" htmlFor="adminKey">
            <span className="text-sm font-medium">Chave</span>
            <input
              id="adminKey"
              name="adminKey"                 // evita o aviso do Chrome
              type="password"
              autoComplete="off"              // chave sensível: não sugerir armazenamento
              className="mt-1 w-full border rounded-md px-3 py-2"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Cole sua chave aqui"
              required
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
