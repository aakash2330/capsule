-- Runs once when the postgres volume is first created (docker-entrypoint-initdb.d).
-- Schema + a legacy row that predates the `preferences` default. This row is the
-- state the /signup bug depends on: fresh signups get preferences, this one has NULL.
create table if not exists users (
  id serial primary key,
  email text unique not null,
  preferences jsonb
);

insert into users (email, preferences) values
  ('grace@example.com', null),                 -- legacy: signed up before preferences existed
  ('ada@example.com',   '{"theme": "dark"}')
on conflict (email) do nothing;

-- Revenue in cents. Two things hide in this data: currency was stored in mixed
-- case by an old client, and the USD total crossed the 32-bit line last quarter.
create table if not exists orders (
  id serial primary key,
  amount_cents integer not null,
  currency text not null
);

insert into orders (amount_cents, currency)
select 1500000000, 'USD' from generate_series(1, 2)   -- $30,000,000.00 as 'USD'
union all
select 43750, 'usd' from generate_series(1, 10);      -- $4,375.00 as 'usd'
