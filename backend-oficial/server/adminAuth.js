// server/adminAuth.js
// Middleware que valida o header X-Admin-Key contra a env ADMIN_PASS (ou ADMIN_KEY, se existir)

export function requireAdminKey(req, res, next) {
  const incoming = req.header("X-Admin-Key") || "";

  // Lê ADMIN_PASS; mantém compatibilidade se você ainda tiver ADMIN_KEY setada.
  const expected =
    process.env.ADMIN_PASS ||
    process.env.ADMIN_KEY || // fallback opcional
    "";

  if (!expected) {
    return res.status(500).json({
      error: "ADMIN_PASS (ou ADMIN_KEY) não configurada no servidor.",
    });
  }
  if (!incoming || incoming !== expected) {
    return res.status(401).json({
      error: "Chave de administrador inválida ou ausente.",
    });
  }
  next();
}
