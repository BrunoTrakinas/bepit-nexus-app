// /backend-oficial/services/storage.service.js
import crypto from "crypto";
import { supabase } from "../lib/supabaseAdmin.js"; // services ↔ lib são irmãos

const BUCKET = "fotos-parceiros";
const MAX_BY_KIND = 5; // limite total por tipo (foto / cardapio)

function guessContentType(name) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function getPartner(parceiroId) {
  const { data, error } = await supabase
    .from("parceiros")
    .select("*")
    .eq("id", parceiroId)
    .single();
  if (error) throw error;
  return data;
}

async function savePartnerMediaList(parceiroId, kind, list) {
  const field = kind === "foto" ? "fotos_parceiros" : "links_cardapio_preco";
  const { error } = await supabase
    .from("parceiros")
    .update({ [field]: list })
    .eq("id", parceiroId);
  if (error) throw error;
}

export async function uploadPartnerMedia({ partnerId, kind, base64, filename }) {
  if (!partnerId) throw new Error("partnerId obrigatório");
  if (!base64 || !filename) throw new Error("Envie base64 e filename");

  const partner = await getPartner(partnerId);
  const field = kind === "foto" ? "fotos_parceiros" : "links_cardapio_preco";
  const current = Array.isArray(partner?.[field]) ? partner[field] : [];

  if (current.length >= MAX_BY_KIND) {
    throw new Error(
      `Limite de ${MAX_BY_KIND} ${kind === "foto" ? "fotos" : "itens"} atingido`
    );
  }

  const fileBuf = Buffer.from(base64, "base64");
  const hash = sha256(fileBuf).slice(0, 16);
  const path = `partners/${partnerId}/${kind}s/${Date.now()}_${hash}_${filename}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, fileBuf, {
      contentType: guessContentType(filename),
      upsert: false,
    });
  if (upErr) throw upErr;

  // guarda metadados no JSON da tabela parceiros
  const entry = {
    storageKey: path,
    filename,
    kind,
    uploadedAt: new Date().toISOString(),
  };
  const newList = [entry, ...current].slice(0, MAX_BY_KIND);
  await savePartnerMediaList(partnerId, kind, newList);

  // link assinado (10 minutos) para exibir imediatamente
  const { data: signed } = await supabase
    .storage.from(BUCKET)
    .createSignedUrl(path, 60 * 10);

  return { storageKey: path, signedUrl: signed?.signedUrl || null, kind };
}

export async function listarMidias(partnerId) {
  const partner = await getPartner(partnerId);
  const fotos = Array.isArray(partner?.fotos_parceiros)
    ? partner.fotos_parceiros
    : [];
  const card = Array.isArray(partner?.links_cardapio_preco)
    ? partner.links_cardapio_preco
    : [];

  async function withSigned(list) {
    const out = [];
    for (const it of list) {
      const { data } = await supabase
        .storage.from(BUCKET)
        .createSignedUrl(it.storageKey, 60 * 10);
      out.push({ ...it, signedUrl: data?.signedUrl || null });
    }
    return out;
  }

  const fotosSigned = await withSigned(fotos);
  const cardSigned = await withSigned(card);

  return {
    total: fotosSigned.length + cardSigned.length,
    fotos: fotosSigned,
    cardapio: cardSigned,
  };
}

export async function removerMidia({ partnerId, storageKey }) {
  if (!storageKey) throw new Error("storageKey obrigatório");

  const partner = await getPartner(partnerId);
  const fotos = Array.isArray(partner?.fotos_parceiros)
    ? partner.fotos_parceiros
    : [];
  const card = Array.isArray(partner?.links_cardapio_preco)
    ? partner.links_cardapio_preco
    : [];

  const newFotos = fotos.filter((x) => x.storageKey !== storageKey);
  const newCard = card.filter((x) => x.storageKey !== storageKey);

  // remove arquivo físico
  await supabase.storage.from(BUCKET).remove([storageKey]);

  // persiste JSON atualizado (chama duas vezes para simplificar)
  await savePartnerMediaList(partnerId, "foto", newFotos);
  await savePartnerMediaList(partnerId, "cardapio", newCard);

  return { ok: true };
}
