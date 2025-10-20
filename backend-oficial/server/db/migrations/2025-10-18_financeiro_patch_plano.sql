-- ============================================================================
-- BEPIT Nexus - Financeiro PATCH (padroniza 'plano' e 'valor_mensal')
-- - Adiciona colunas ausentes em finance_accounts (plano, valor_mensal, ativo)
-- - Backfill a partir de nomes alternativos (plan_name, plan, price_cents, etc.)
-- - Recria view vw_partner_finance_status referenciando apenas colunas padronizadas
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
  criado_em timestamptz not null default now()
);

-- 1) Garantir colunas padronizadas
alter table public.finance_accounts add column if not exists plano text;
alter table public.finance_accounts add column if not exists valor_mensal numeric(10,2);
alter table public.finance_accounts add column if not exists ativo boolean;

-- Defaults seguros
alter table public.finance_accounts alter column ativo set default true;

-- 2) Backfill a partir de nomes alternativos existentes (idempotente)
do $$
declare
  has_plan_name    boolean;
  has_plan         boolean;
  has_price_value  boolean;
  has_mensalidade  boolean;
  has_valor_plano  boolean;
  has_price_cents  boolean;
begin
  -- Fonte para PLANO
  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='plan_name'
  ) into has_plan_name;

  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='plan'
  ) into has_plan;

  if has_plan_name then
    execute 'update public.finance_accounts set plano = coalesce(plano, plan_name)';
  end if;

  if has_plan then
    execute 'update public.finance_accounts set plano = coalesce(plano, plan)';
  end if;

  -- Fonte para VALOR_MENSAL
  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='price_value'
  ) into has_price_value;

  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='mensalidade'
  ) into has_mensalidade;

  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='valor_plano'
  ) into has_valor_plano;

  select exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='price_cents'
  ) into has_price_cents;

  if has_price_value then
    execute 'update public.finance_accounts set valor_mensal = coalesce(valor_mensal, price_value) where valor_mensal is null';
  end if;

  if has_mensalidade then
    execute 'update public.finance_accounts set valor_mensal = coalesce(valor_mensal, mensalidade) where valor_mensal is null';
  end if;

  if has_valor_plano then
    execute 'update public.finance_accounts set valor_mensal = coalesce(valor_mensal, valor_plano) where valor_mensal is null';
  end if;

  if has_price_cents then
    execute 'update public.finance_accounts set valor_mensal = coalesce(valor_mensal, price_cents/100.0) where valor_mensal is null';
  end if;

  -- Garante 'ativo' true quando nulo
  execute 'update public.finance_accounts set ativo = coalesce(ativo, true)';
end $$;

-- 3) Garantir estrutura de invoices base (para a view funcionar)
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

alter table public.invoices add column if not exists account_id uuid;
alter table public.invoices add column if not exists partner_id uuid;
alter table public.invoices add column if not exists competencia date;
alter table public.invoices add column if not exists valor numeric(10,2);
alter table public.invoices add column if not exists vencimento date;
alter table public.invoices add column if not exists pago boolean not null default false;
alter table public.invoices add column if not exists pago_em timestamptz;
alter table public.invoices add column if not exists created_at timestamptz not null default now();

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

create index if not exists idx_finance_accounts_partner on public.finance_accounts(partner_id);
create index if not exists idx_invoices_account on public.invoices(account_id);
create index if not exists idx_invoices_partner on public.invoices(partner_id);
create index if not exists idx_invoices_vencimento on public.invoices(vencimento);

-- 4) View de status (usa SOMENTE colunas padronizadas: plano, valor_mensal)
drop view if exists public.vw_partner_finance_status;

create or replace view public.vw_partner_finance_status as
select
  p.id              as partner_id,
  p.nome            as partner_name,
  fa.plano          as plan_name,
  fa.valor_mensal   as price_value,
  coalesce(fa.ativo, true) as account_active,
  i.vencimento      as due_date,
  i.valor           as last_amount,
  i.pago            as last_paid,
  case
    when i.id is null then 'N/D'
    when i.pago then 'PAGO'
    when now()::date > i.vencimento then 'VENCIDO'
    when i.vencimento - now()::date <= 10 then 'A VENCER (<10d)'
    else 'EM DIA'
  end as status_label
from public.parceiros p
left join public.finance_accounts fa
  on fa.partner_id = p.id
left join lateral (
  select inv.*
  from public.invoices inv
  where
    (fa.id is not null and inv.account_id = fa.id)
    or inv.partner_id = p.id
  order by inv.vencimento desc nulls last
  limit 1
) i on true;

-- FIM PATCH
