-- v1.10 survey app: close-up photos per wall, obstruction pins on the wall photo
alter table walls add column if not exists extra_photos jsonb not null default '[]'::jsonb;
alter table wall_obstructions add column if not exists px real;
alter table wall_obstructions add column if not exists py real;
