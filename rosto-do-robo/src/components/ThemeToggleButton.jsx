import React, { useEffect, useState } from "react";

/**
 * Botão Claro/Escuro estiloso (Tailwind v4).
 * - Persiste em localStorage('theme'): 'light' | 'dark'
 * - Alterna .dark no <html>
 * - Cores com leve gradiente e transições
 */
export default function ThemeToggleButton() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("theme");
    if (saved === "dark" || saved === "light") return saved;
    const prefersDark = window.matchMedia?.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { window.localStorage.setItem("theme", theme); } catch {}
  }, [theme]);

  const toggle = () => setTheme(t => (t === "dark" ? "light" : "dark"));
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      className="
        group inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold transition
        shadow-sm border 
        border-slate-200/80 bg-white/90 hover:bg-white 
        dark:border-slate-700/80 dark:bg-slate-900/80 dark:hover:bg-slate-900
      "
      aria-label="Alternar tema claro/escuro"
      title={isDark ? "Modo claro" : "Modo escuro"}
    >
      <span
        className="
          inline-flex h-5 w-5 items-center justify-center rounded-full
          bg-gradient-to-br from-amber-400 to-rose-400 text-white
          dark:from-sky-500 dark:to-indigo-500
          transition-transform group-active:scale-95
        "
      >
        {isDark ? (
          // Sol (para voltar ao claro)
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zm10.48 14.32l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM12 4V1h0v3h0zm0 19v-3h0v3h0zM4 12H1v0h3v0zm19 0h-3v0h3v0zM6.76 19.16l-1.79 1.8 1.41 1.41 1.8-1.79-1.42-1.42zM18.36 5.64l1.8-1.79-1.41-1.41-1.79 1.8 1.4 1.4zM12 6a6 6 0 100 12A6 6 0 0012 6z" />
          </svg>
        ) : (
          // Lua (para ir ao escuro)
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12.74 2.01a1 1 0 00-1.38 1.15A8 8 0 1020.84 12.6a1 1 0 00-1.15-1.38 6 6 0 01-6.95-6.95z" />
          </svg>
        )}
      </span>
      <span className="hidden sm:inline text-slate-700 dark:text-slate-200">
        {isDark ? "Claro" : "Escuro"}
      </span>
    </button>
  );
}
