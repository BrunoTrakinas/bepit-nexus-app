-- ============================================================================
-- BEPIT Nexus - Financeiro PATCH (colunas e view padronizadas)
-- - Garante colunas padronizadas em invoices: vencimento (date), valor (numeric)
-- - Backfill condicional a partir de nomes alternativos (due_date, amount_cents, etc.)
-- - Compatível com account_id OU partner_id
-- - Recria a view vw_partner_finance_status
-- - Assume que o patch "financeiro_patch_plano.sql" já rodou (plano/valor_mensal/ativo)
-- ============================================================================

create extension if not exists "uuid-ossp";

-- Tabelas base mínimas (não sobrescrevem o que já existe)
create table if not exists public.parceiros (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  ativo boolean default true
);

create table if not exists public.finance_accounts (
  id uuid primary key default uuid_generate_v4(),
  partner_id uuid not null references public.parceiros(id) on delete cascade,
  plano text,
  valor_mensal numeric(10,2),
  ativo boolean default true,
  criado_em timestamptz not null default now()
);

create index if not exists idx_finance_accounts_partner
  on public.finance_accounts(partner_id);

-- Tabela invoices (idempotente)
create table if not exists public.invoices (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid,
  partner_id uuid,
  competencia date,
  valor numeric(10,2),
  vencimento date,
  pago boolean not null default false,
  pago_em timestamptz,
  created_at timestamptz not null default now()
);

-- Garante colunas exigidas (se não existirem)
alter table public.invoices add column if not exists account_id uuid;
alter table public.invoices add column if not exists partner_id uuid;
alter table public.invoices add column if not exists competencia date;
alter table public.invoices add column if not exists valor numeric(10,2);
alter table public.invoices add column if not exists vencimento date;
alter table public.invoices add column if not exists pago boolean not null default false;
alter table public.invoices add column if not exists pago_em timestamptz;
alter table public.invoices add column if not exists created_at timestamptz not null default now();

-- FKs (apenas se não existirem)
do $$
begin
  if not exists (select 1 from pg_constraint where conname='invoices_account_id_fkey') then
    alter table public.invoices
      add constraint invoices_account_id_fkey
      foreign key (account_id) references public.finance_accounts(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname='invoices_partner_id_fkey') then
    alter table public.invoices
      add constraint invoices_partner_id_fkey
      foreign key (partner_id) references public.parceiros(id) on delete set null;
  end if;
end $$;

create index if not exists idx_invoices_account on public.invoices(account_id);
create index if not exists idx_invoices_partner on public.invoices(partner_id);
create index if not exists idx_invoices_vencimento on public.invoices(vencimento);

-- Backfill condicional (usa EXECUTE com strings
