import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

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
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed })
      });

      if (!resp.ok) {
        const erro = await resp.json().catch(() => ({}));
        throw new Error(erro?.error === "invalid_key" ? "Chave inválida." : "Falha na validação.");
      }

      // Guarda a chave para o ProtectedRoute liberar /admin
      localStorage.setItem("adminKey", trimmed);

      // Navega para o dashboard
      navigate("/admin", { replace: true });
    } catch (error) {
      localStorage.removeItem("adminKey");
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
          {/* Logo interno servido via /public */}
          <img
            src="/bepit-logo.png"
            alt="BEPIT"
            className="mx-auto h-16 w-16"
          />
          <h1 className="text-xl font-bold mt-2 text-gray-900 dark:text-gray-100">
            Painel do Administrador
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Informe sua chave administrativa para acessar
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">
              Chave do Administrador
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="••••-••••-••••-••••"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {errorMsg && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-blue-600 text-white font-semibold py-2 hover:bg-blue-700 disabled:opacity-60"
          >
            {isLoading ? "Validando..." : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
