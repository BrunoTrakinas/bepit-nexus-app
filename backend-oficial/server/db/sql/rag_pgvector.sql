-- ============================================================================
-- Self-RAG - Embeddings + Similaridade
-- ============================================================================

create extension if not exists vector;

create table if not exists public.partner_vectors (
  id uuid primary key default uuid_generate_v4(),
  partner_id uuid references public.parceiros(id) on delete cascade,
  chunk text not null,
  embedding vector(1536),
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_partner_vectors_partner on public.partner_vectors(partner_id);
create index if not exists idx_partner_vectors_embedding on public.partner_vectors using ivfflat (embedding vector_cosine_ops);

create or replace function public.match_partner_vectors(
  query_embedding vector(1536),
  match_count int default 8,
  filter_partner uuid default null
)
returns table(
  id uuid,
  partner_id uuid,
  chunk text,
  similarity float
)
language sql stable as $$
  select pv.id, pv.partner_id, pv.chunk,
         1 - (pv.embedding <=> query_embedding) as similarity
  from public.partner_vectors pv
  where filter_partner is null or pv.partner_id = filter_partner
  order by pv.embedding <=> query_embedding
  limit match_count;
$$;
