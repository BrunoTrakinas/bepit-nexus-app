// rosto-do-robo/src/admin/RequireAuth.jsx
// ============================================================================
// Componente de rota protegida para /admin*
// - Se não autenticado, redireciona para /admin/login
// ============================================================================

import React, { useContext } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AuthContext } from "./AuthProvider";

export default function RequireAuth({ children }) {
  const { isAuthenticated } = useContext(AuthContext);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace state={{ from: location }} />;
  }

  return children;
}