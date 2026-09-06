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
