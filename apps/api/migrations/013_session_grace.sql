-- v1.17: a refresh token that was just replaced stays usable for a few seconds, so two requests renewing
-- the login at the same moment (two tabs, app + browser) no longer end the session.
alter table sessions add column if not exists prev_refresh_hash text;
alter table sessions add column if not exists rotated_at timestamptz;
