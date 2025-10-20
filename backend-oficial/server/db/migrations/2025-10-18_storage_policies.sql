-- ============================================================================
-- Policies e Estrutura de Storage
-- Bucket: fotos-parceiros (privado)
-- ============================================================================

-- 1) Criar bucket privado (via Supabase Dashboard ou SQL API)
insert into storage.buckets (id, name, public)
values ('fotos-parceiros', 'fotos-parceiros', false)
on conflict (id) do nothing;

-- 2) Policies: cada arquivo dentro de partners/{partner_id}/
--    só é visível/gravável pelo mesmo parceiro ou pelo admin

-- Apagar se já existirem
drop policy if exists "Parceiro lê próprias mídias" on storage.objects;
drop policy if exists "Parceiro envia mídias" on storage.objects;
drop policy if exists "Admin total" on storage.objects;

-- Leitura
create policy "Parceiro lê próprias mídias"
on storage.objects for select
using (
  bucket_id = 'fotos-parceiros'
  and (auth.uid()::text = (storage.foldername(name))[2] or auth.role() = 'service_role')
);

-- Escrita
create policy "Parceiro envia mídias"
on storage.objects for insert
with check (
  bucket_id = 'fotos-parceiros'
  and (auth.uid()::text = (storage.foldername(name))[2] or auth.role() = 'service_role')
);

-- Admin
create policy "Admin total"
on storage.objects
for all
using (auth.role() = 'service_role');
