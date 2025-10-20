// trecho dentro da /frontend/src/components/financeiro/FichaFinanceira.jsx
import React, { useState } from "react";
import AdminFichaMidia from "../admin/AdminFichaMidia.jsx";

export default function FichaFinanceira({ data, onClose }){
  const { partnerId, account, invoices } = data;
  const [showMidia, setShowMidia] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-4 w-full max-w-2xl">
        {/* ... cabeçalho e infos ... */}
        <div className="mt-3">
          <button className="border px-3 py-2 rounded" onClick={()=>setShowMidia(true)}>
            Ver Mídia (Fotos & Cardápio)
          </button>
        </div>

        {/* tabela de faturas etc... */}
      </div>

      {showMidia && (
        <AdminFichaMidia partnerId={partnerId} onClose={()=>setShowMidia(false)} />
      )}
    </div>
  );
}
