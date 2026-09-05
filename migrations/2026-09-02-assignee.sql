-- Assignee: every live card has exactly one owner — 'Steve', 'Davis' or 'Bots'.
-- Steve's decision, 2026-09-02. Applied to the tracker project the same day.
--
-- Three parts:
--   1. normalize_assignee()  — folds every historical spelling onto the three values
--                              ('fix-bot fleet', 'local fix fleet (Steve Claude)' -> Bots;
--                              'davis' -> Davis). Unknown strings pass through unchanged
--                              rather than being destroyed.
--   2. default_assignee()    — who a blank card belongs to, by column:
--                              Review -> Steve (he tests and closes), Questions -> Steve
--                              (he triages the column and re-routes to Davis),
--                              Bugs / Features / In Progress -> Bots, Closed -> nobody.
--   3. bugs_assign_owner     — BEFORE INSERT OR UPDATE trigger. An explicit assignment
--                              always wins. Otherwise a status change re-derives the owner
--                              (a bot finishing a card hands it to Steve for review; Steve
--                              answering a question hands it back to the bots), and a
--                              blank is filled from the column. Closed cards keep whatever
--                              they had.
-- Then a one-off backfill of the existing rows with the updated_at and activity
-- triggers held off so 300 rows do not all light up as "changed just now".

create or replace function public.normalize_assignee(raw text)
returns text language sql immutable as $$
  select case
    when raw is null or btrim(raw) = '' then null
    when lower(raw) like '%fleet%' or lower(raw) like '%bot%'
      or lower(raw) like '%claude%' or lower(raw) like '%fix-%' then 'Bots'
    when lower(raw) like '%davis%' then 'Davis'
    when lower(raw) like '%steve%' then 'Steve'
    else btrim(raw)
  end
$$;

create or replace function public.default_assignee(st text)
returns text language sql immutable as $$
  select case st
    when 'in-review'     then 'Steve'
    when 'questions'     then 'Steve'
    when 'open'          then 'Bots'
    when 'features-open' then 'Bots'
    when 'in-progress'   then 'Bots'
    else null
  end
$$;

create or replace function public.bugs_assign_owner()
returns trigger language plpgsql as $$
declare
  old_norm text;
begin
  new.assigned_to := public.normalize_assignee(new.assigned_to);

  if tg_op = 'INSERT' then
    if new.assigned_to is null then
      new.assigned_to := public.default_assignee(new.status);
    end if;
    return new;
  end if;

  old_norm := public.normalize_assignee(old.assigned_to);

  -- 1. An explicit reassignment in this write always wins.
  if new.assigned_to is not null and new.assigned_to is distinct from old_norm then
    return new;
  end if;

  -- 2. The card moved columns: the owner follows the column.
  if new.status is distinct from old.status then
    if new.status = 'in-review' then
      new.assigned_to := 'Steve';
    elsif new.status in ('open', 'features-open', 'in-progress') then
      new.assigned_to := 'Bots';
    elsif new.status = 'questions' then
      -- A question stays with the human who already owned it; a bot's or an
      -- unowned card's question lands on Steve, who re-routes to Davis.
      if new.assigned_to is null or new.assigned_to = 'Bots' then
        new.assigned_to := 'Steve';
      end if;
    end if;
    -- closed: keep whatever it had
    return new;
  end if;

  -- 3. Same column, still blank: fill from the column.
  if new.assigned_to is null then
    new.assigned_to := public.default_assignee(new.status);
  end if;
  return new;
end
$$;

drop trigger if exists bugs_assign_owner on public.bugs;
create trigger bugs_assign_owner
  before insert or update on public.bugs
  for each row execute function public.bugs_assign_owner();

-- ── one-off backfill ───────────────────────────────────────────────────────
alter table public.bugs disable trigger bugs_set_updated_at;
alter table public.bugs disable trigger bugs_log_activity;

update public.bugs set assigned_to = case
  when status = 'closed'    then public.normalize_assignee(assigned_to)
  when status = 'in-review' then 'Steve'
  when status = 'questions' then coalesce(
    case when public.normalize_assignee(assigned_to) in ('Davis', 'Steve')
         then public.normalize_assignee(assigned_to) end, 'Steve')
  else coalesce(public.normalize_assignee(assigned_to), 'Bots')
end;

alter table public.bugs enable trigger bugs_set_updated_at;
alter table public.bugs enable trigger bugs_log_activity;

-- ── 2026-09-05: log_bug_activity attachments fix ─────────────────────────────
-- `v_changed || 'attachments'` resolved as array || array and tried to parse the
-- word as an array literal, so EVERY change to bugs.attachments failed with
-- 22P02 "malformed array literal" -- the board's screenshot upload included.
-- Applied to the tracker project the same day (typed array_append). Full body of
-- the fixed function lives in the tracker's migration history:
-- fix_log_bug_activity_attachments_array_append.
