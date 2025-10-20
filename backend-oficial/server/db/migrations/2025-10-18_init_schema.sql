-- ============================================================================
-- BEPIT Nexus - Schema Inicial
-- Criação de tabelas principais e auxiliares para parceiros, mídia e logs
-- ============================================================================

create extension if not exists "uuid-ossp";

create table if not exists public.parceiros (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  descricao text,
  categoria text,
  endereco text,
  contato text,
  faixa_preco text,
  horario_funcionamento text,
  beneficio_bepit text,
  tags text[],
  fotos_parceiros jsonb default '[]'::jsonb,
  links_cardapio_preco jsonb default '[]'::jsonb,
  ativo boolean default true,
  criado_em timestamptz default now()
);

create table if not exists public.audit_events (
  id uuid primary key default uuid_generate_v4(),
  event_type text not null, -- upload, delete, login, payment, etc
  entity text not null,
  entity_id uuid,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  ip text
);
