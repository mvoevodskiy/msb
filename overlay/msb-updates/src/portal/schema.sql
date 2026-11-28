-- Схема Портала. Установщик по-прежнему пишет JSON.
-- Эти таблицы пустые, пока CRM, тикеты и тарифы не начнут в них писать.

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY,
  tg_user_id bigint UNIQUE,
  username text,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id text PRIMARY KEY,
  client_id uuid REFERENCES clients (id),
  owner_tg_user_id bigint,
  origin text NOT NULL,
  provider text,
  host text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY,
  client_id uuid REFERENCES clients (id),
  installation_id text REFERENCES installations (id),
  source text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets (id),
  direction text NOT NULL,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  ticket_id uuid REFERENCES tickets (id),
  kind text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installation_capabilities (
  installation_id text NOT NULL REFERENCES installations (id),
  capability text NOT NULL,
  valid_until timestamptz,
  PRIMARY KEY (installation_id, capability)
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tg_user_id bigint;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS case_revision integer NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS operation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_open_tg
  ON tickets (tg_user_id)
  WHERE status = 'open' AND tg_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_operation
  ON outbox (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backup_accounts (
  installation_id text PRIMARY KEY REFERENCES installations (id),
  schedule text,
  last_success_at timestamptz,
  object_ref text,
  restore_requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
