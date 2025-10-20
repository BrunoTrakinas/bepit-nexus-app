-- ============================================================================
-- BEPIT Nexus - Financeiro (FINAL / COMPATÍVEL / IDEMPOTENTE)
-- - Padroniza finance_accounts (plano, valor_mensal, ativo)
-- - Garante invoices (account_id|partner_id, vencimento, valor, pago...)
-- - Backfill a partir de colunas antigas (due_date, amount, *_cents, etc.)
-- - Cria payments (se faltar)
-- - Recria view vw_partner_finance_status consolidada
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- Base mínima
create table if not exists public.parceiros (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  ativo boolean default true
);

-- ============ finance_accounts ============
create table if not exists public.finance_accounts (
  id uuid primary key default uuid_generate_v4(),
  partner_id uuid not null references public.parceiros(id) on delete cascade,
  criado_em timestamptz not null default now()
);

-- Colunas padronizadas
alter table public.finance_accounts add column if not exists plano text;
alter table public.finance_accounts add column if not exists valor_mensal numeric(10,2);
alter table public.finance_accounts add column if not exists ativo boolean;

-- Defaults seguros
alter table public.finance_accounts alter column ativo set default true;

-- Backfill a partir de nomes alternativos (se existirem)
do $$
declare
  has_plan_name    boolean;
  has_plan         boolean;
  has_price_value  boolean;
  has_mensalidade  boolean;
  has_valor_plano  boolean;
  has_price_cents  boolean;
  has_active       boolean;
begin
  -- plano
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='plan_name') into has_plan_name;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='plan') into has_plan;

  if has_plan_name then
    execute 'update public.finance_accounts set plano = coalesce(plano, plan_name)';
  end if;
  if has_plan then
    execute 'update public.finance_accounts set plano = coalesce(plano, plan)';
  end if;

  -- valor_mensal
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='price_value') into has_price_value;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='mensalidade') into has_mensalidade;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='valor_plano') into has_valor_plano;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='price_cents') into has_price_cents;

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

  -- ativo a partir de active
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='finance_accounts' and column_name='active') into has_active;

  if has_active then
    execute 'update public.finance_accounts set ativo = coalesce(ativo, active, true)';
  else
    execute 'update public.finance_accounts set ativo = coalesce(ativo, true)';
  end if;
end $$;

create index if not exists idx_finance_accounts_partner on public.finance_accounts(partner_id);

-- ============ invoices ============
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

-- Garante colunas padrão
alter table public.invoices add column if not exists account_id uuid;
alter table public.invoices add column if not exists partner_id uuid;
alter table public.invoices add column if not exists competencia date;
alter table public.invoices add column if not exists valor numeric(10,2);
alter table public.invoices add column if not exists vencimento date;
alter table public.invoices add column if not exists pago boolean not null default false;
alter table public.invoices add column if not exists pago_em timestamptz;
alter table public.invoices add column if not exists created_at timestamptz not null default now();

-- FKs se faltarem
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

-- Backfill condicional para vencimento/valor de colunas antigas
do $$
declare
  has_due_date       boolean;
  has_data_venc      boolean;
  has_dt_venc        boolean;
  has_valor_total    boolean;
  has_amount         boolean;
  has_amount_cents   boolean;
  has_valor_centavos boolean;
begin
  -- vencimento
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='due_date') into has_due_date;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='data_vencimento') into has_data_venc;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='dt_vencimento') into has_dt_venc;

  if has_due_date then
    execute 'update public.invoices set vencimento = coalesce(vencimento, due_date) where vencimento is null and due_date is not null';
  end if;
  if has_data_venc then
    execute 'update public.invoices set vencimento = coalesce(vencimento, data_vencimento) where vencimento is null and data_vencimento is not null';
  end if;
  if has_dt_venc then
    execute 'update public.invoices set vencimento = coalesce(vencimento, dt_vencimento) where vencimento is null and dt_vencimento is not null';
  end if;

  -- valor
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='valor_total') into has_valor_total;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='amount') into has_amount;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='amount_cents') into has_amount_cents;
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='invoices' and column_name='valor_centavos') into has_valor_centavos;

  if has_valor_total then
    execute 'update public.invoices set valor = coalesce(valor, valor_total) where valor is null and valor_total is not null';
  end if;
  if has_amount then
    execute 'update public.invoices set valor = coalesce(valor, amount) where valor is null and amount is not null';
  end if;
  if has_amount_cents then
    execute 'update public.invoices set valor = coalesce(valor, amount_cents/100.0) where valor is null and amount_cents is not null';
  end if;
  if has_valor_centavos then
    execute 'update public.invoices set valor = coalesce(valor, valor_centavos/100.0) where valor is null and valor_centavos is not null';
  end if;

  -- backfill account_id a partir de partner_id, se aplicável
  execute '
    update public.invoices i
       set account_id = fa.id
      from public.finance_accounts fa
     where i.account_id is null
       and i.partner_id is not null
       and fa.partner_id = i.partner_id
  ';
end $$;

-- ============ payments ============
create table if not exists public.payments (
  id uuid primary key default uuid_generate_v4(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  valor_pago numeric(10,2) not null,
  metodo text not null, -- PIX | CREDITO | BOLETO
  pago_em timestamptz not null default now(),
  observacao text
);

create index if not exists idx_payments_invoice on public.payments(invoice_id);

-- ============ VIEW ============
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

-- FIM
