import React, { useEffect, useState } from "react";

/**
 * Botão de alternância Claro/Escuro compatível com Tailwind v4.
 * - Persiste em localStorage('theme'): 'light' | 'dark'
 * - Aplica/Remove a classe 'dark' no <html>
 * - Sem dependências externas; usa SVGs inline (sol/lua)
 */
export default function ThemeToggleButton() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    // tenta carregar do localStorage
    const saved = window.localStorage.getItem("theme");
    if (saved === "dark" || saved === "light") return saved;
    // fallback: se o sistema for dark, começa em dark
    const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return mq ? "dark" : "light";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try {
      window.localStorage.setItem("theme", theme);
    } catch {}
  }, [theme]);

  const toggle = () => setTheme(t => (t === "dark" ? "light" : "dark"));

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-2 rounded-full border border-gray-300/60 px-3 py-1.5 text-sm font-medium shadow-sm transition
                 hover:bg-gray-50 active:scale-[0.98] dark:border-gray-600 dark:hover:bg-gray-800"
      aria-label="Alternar tema claro/escuro"
      title={isDark ? "Modo claro" : "Modo escuro"}
    >
      {isDark ? (
        // Ícone Sol (para voltar ao claro)
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zm10.48 14.32l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM12 4V1h-0v3h0zm0 19v-3h0v3h0zM4 12H1v0h3v0zm19 0h-3v0h3v0zM6.76 19.16l-1.79 1.8 1.41 1.41 1.8-1.79-1.42-1.42zM18.36 5.64l1.8-1.79-1.41-1.41-1.79 1.8 1.4 1.4zM12 6a6 6 0 100 12A6 6 0 0012 6z" />
        </svg>
      ) : (
        // Ícone Lua (para ir ao escuro)
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12.74 2.01a1 1 0 00-1.38 1.15A8 8 0 1020.84 12.6a1 1 0 00-1.15-1.38 6 6 0 01-6.95-6.95z" />
        </svg>
      )}
      <span className="hidden sm:inline">{isDark ? "Claro" : "Escuro"}</span>
    </button>
  );
}
