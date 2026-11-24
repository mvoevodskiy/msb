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
